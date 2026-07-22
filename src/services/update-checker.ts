// Plain-fetch client for GitHub's public Releases API — same "no HTTP client
// library, just fetch" convention as src/services/github.ts, and same
// unauthenticated access: MULLION_UPDATE_REPO (src/plugins/env.ts) defaults
// to this project's own public repo, so no token is needed just to check
// for a newer release (unlike github.ts's per-project integration, which
// authenticates as the connected user to read private repos too).

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 5_000;
const USER_AGENT = "mullion-session-manager";

// A release check is a background/settings-page concern, not something a
// user is staring at waiting for — cache generously (unlike github.ts's
// 60s TTL for an actively-polled Dock widget) to keep GitHub's unauthenticated
// rate limit (60/hr per IP) out of reach even with several installs sharing
// one egress IP.
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class UpdateCheckError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "UpdateCheckError";
  }
}

export interface UpdateCheckResult {
  currentVersion: string;
  // null when the latest release's tag couldn't be parsed as a version —
  // still a successful check (updateAvailable is conservatively false), not
  // an error.
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  // browser_download_url of the release's .tgz asset, or null if the
  // release has no such asset yet (e.g. CI's build-tarball job hasn't
  // finished, or an older release predates this feature).
  assetUrl: string | null;
  // browser_download_url of the release's sha256sum-format checksum file
  // (see release-please.yml's build-tarball job) — self-update.sh verifies
  // the downloaded tarball against this before extracting it (Hermes
  // review, PR #54: "no integrity verification of the downloaded tarball").
  // null under the same conditions as assetUrl.
  checksumUrl: string | null;
  // Whether this install is even capable of applying an update — i.e.
  // MULLION_HOME is configured (a versioned-release layout, not a dev
  // checkout). Threaded in by the caller rather than read from process.env
  // here, so this stays a pure, easily-testable function like
  // github.ts's getRepoStatus.
  applyAvailable: boolean;
  // Epoch ms of when GitHub was actually last queried for this result — set
  // once when the result is fetched and preserved verbatim across cache hits
  // (see checkForUpdate), so the frontend can show real staleness ("Last
  // checked: 59 minutes ago") instead of every result looking equally fresh
  // (issue #123).
  checkedAt: number;
}

interface CacheEntry {
  ts: number;
  result: UpdateCheckResult;
}

// Keyed by "owner/repo" — in practice always one entry (MULLION_UPDATE_REPO
// doesn't change at runtime), but keyed the same way as github.ts's cache
// for consistency and to keep tests that use distinct repo strings isolated
// from each other.
const cache = new Map<string, CacheEntry>();

/** Test-only introspection/reset — mirrors github.ts's getCacheSizeForTests. */
export function clearUpdateCheckCacheForTests(): void {
  cache.clear();
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubReleaseApiResponse {
  tag_name?: string;
  html_url?: string;
  assets?: GitHubReleaseAsset[];
  draft?: boolean;
  prerelease?: boolean;
}

/** Strips an optional leading "v" and parses MAJOR.MINOR.PATCH. Returns null
 * for anything else (a pre-release suffix, a malformed tag, etc.) — callers
 * treat that as "can't compare," not as a crash. */
function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True only when `a` is strictly greater than `b`, component-wise (major,
 * then minor, then patch). Shared by isNewer (raw-string tags) and
 * selectLatestRelease (already-parsed tags) — Hermes review, PR #130. */
function isHigherVersion(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** True only when `latest` parses and is strictly greater than `current`.
 * Any parse failure on either side is treated as "not newer" — a
 * conservative default, since a false "update available" nags the user into
 * applying a broken/unparseable release. */
function isNewer(latestRaw: string, currentRaw: string): boolean {
  const latest = parseVersion(latestRaw);
  const current = parseVersion(currentRaw);
  if (!latest || !current) return false;
  return isHigherVersion(latest, current);
}

/**
 * Picks the "latest" release out of a `/releases` list response, mirroring
 * what `/releases/latest` promises (the newest published, non-draft,
 * non-prerelease release) but computed client-side against the list
 * endpoint — which GitHub's CDN caches far less aggressively than
 * `/releases/latest`, the root cause of issue #123's stale-result bug.
 * Drafts and prereleases are excluded, matching `/releases/latest`'s own
 * semantics. Among the rest, the highest semver (via parseVersion) wins; a
 * parseable tag always beats an unparseable one regardless of array
 * position (Hermes review, PR #130: an earlier release with e.g. a
 * "nightly" tag must not permanently shadow a later, properly-tagged
 * release). Among unparseable candidates only, the first survives by array
 * order (GitHub returns the list newest-created-first) — the same
 * conservative "can't compare, don't crash" stance as isNewer. Returns null
 * when nothing qualifies (e.g. a repo with only draft/prerelease releases,
 * or none at all), which callers treat as a successful check with no
 * comparable release rather than an error.
 */
function selectLatestRelease(
  releases: GitHubReleaseApiResponse[],
): GitHubReleaseApiResponse | null {
  let best: GitHubReleaseApiResponse | null = null;
  let bestVersion: [number, number, number] | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = release.tag_name ? parseVersion(release.tag_name) : null;
    if (!best) {
      best = release;
      bestVersion = version;
      continue;
    }
    // A parseable candidate always beats an unparseable current best, even
    // if it can't (yet) be compared by isHigherVersion against it.
    if (version && (!bestVersion || isHigherVersion(version, bestVersion))) {
      best = release;
      bestVersion = version;
    }
  }
  return best;
}

function findTarballAsset(assets: GitHubReleaseAsset[] | undefined): GitHubReleaseAsset | null {
  return assets?.find((a) => a.name.endsWith(".tgz")) ?? null;
}

function findChecksumAsset(assets: GitHubReleaseAsset[] | undefined): GitHubReleaseAsset | null {
  return assets?.find((a) => a.name.endsWith(".sha256")) ?? null;
}

// Comfortably covers a repo's recent release history (this project cuts
// releases far less often than 10 times between checks) while staying a
// small, fast response — no pagination needed.
const RELEASES_PAGE_SIZE = 10;

/**
 * Fetches the latest published GitHub Release for `repoSlug` ("owner/repo")
 * and compares its tag to `currentVersion`. Cached per repoSlug for
 * CACHE_TTL_MS unless `force` is true (skips the cache and always hits
 * GitHub). Throws UpdateCheckError on network failure or a non-2xx response.
 * Uses the `/releases` list endpoint rather than `/releases/latest` — the
 * latter is aggressively CDN-cached by GitHub and can keep returning a
 * previous release for several minutes after a new one is published
 * (issue #123); the list endpoint doesn't have that lag, so "latest" is
 * resolved here via selectLatestRelease instead of trusting GitHub's own
 * `/latest` resolution.
 */
export async function checkForUpdate(
  repoSlug: string,
  currentVersion: string,
  applyAvailable: boolean,
  force = false,
): Promise<UpdateCheckResult> {
  if (!force) {
    const cached = cache.get(repoSlug);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      // applyAvailable reflects this process's own config, not GitHub state —
      // recompute it fresh even on a cache hit rather than serving a stale
      // value from whatever it was the first time this repoSlug was checked.
      // checkedAt is left untouched: it should reflect when GitHub was
      // actually last queried, not when this cache hit happened.
      return { ...cached.result, applyAvailable };
    }
  }

  let res: Response;
  try {
    res = await fetch(
      `${GITHUB_API_BASE}/repos/${repoSlug}/releases?per_page=${RELEASES_PAGE_SIZE}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch (err) {
    throw new UpdateCheckError(
      `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  if (!res.ok) {
    throw new UpdateCheckError(
      `GitHub releases lookup failed for ${repoSlug} (HTTP ${res.status})`,
      res.status,
    );
  }

  const releases = (await res.json()) as GitHubReleaseApiResponse[];
  const latest = selectLatestRelease(releases);
  const latestVersion = latest?.tag_name?.replace(/^v/, "") ?? null;
  const asset = findTarballAsset(latest?.assets);
  const checksumAsset = findChecksumAsset(latest?.assets);

  const result: UpdateCheckResult = {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion !== null && isNewer(latestVersion, currentVersion),
    releaseUrl: latest?.html_url ?? null,
    assetUrl: asset?.browser_download_url ?? null,
    checksumUrl: checksumAsset?.browser_download_url ?? null,
    applyAvailable,
    checkedAt: Date.now(),
  };

  cache.set(repoSlug, { ts: Date.now(), result });
  return result;
}
