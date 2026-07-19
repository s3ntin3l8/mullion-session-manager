// Plain-fetch client for GitHub's public Releases API — same "no HTTP client
// library, just fetch" convention as src/services/github.ts, and same
// unauthenticated access: TESSERA_UPDATE_REPO (src/plugins/env.ts) defaults
// to this project's own public repo, so no token is needed just to check
// for a newer release (unlike github.ts's per-project integration, which
// authenticates as the connected user to read private repos too).

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 5_000;
const USER_AGENT = "tessera-session-manager";

// A release check is a background/settings-page concern, not something a
// user is staring at waiting for — cache generously (unlike github.ts's
// 60s TTL for an actively-polled Dock widget) to keep GitHub's unauthenticated
// rate limit (60/hr per IP) out of reach even with several installs sharing
// one egress IP.
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

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
  // Whether this install is even capable of applying an update — i.e.
  // TESSERA_HOME is configured (a versioned-release layout, not a dev
  // checkout). Threaded in by the caller rather than read from process.env
  // here, so this stays a pure, easily-testable function like
  // github.ts's getRepoStatus.
  applyAvailable: boolean;
}

interface CacheEntry {
  ts: number;
  result: UpdateCheckResult;
}

// Keyed by "owner/repo" — in practice always one entry (TESSERA_UPDATE_REPO
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
}

/** Strips an optional leading "v" and parses MAJOR.MINOR.PATCH. Returns null
 * for anything else (a pre-release suffix, a malformed tag, etc.) — callers
 * treat that as "can't compare," not as a crash. */
function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True only when `latest` parses and is strictly greater than `current`
 * component-wise (major, then minor, then patch). Any parse failure on
 * either side is treated as "not newer" — a conservative default, since a
 * false "update available" nags the user into applying a broken/unparseable
 * release. */
function isNewer(latestRaw: string, currentRaw: string): boolean {
  const latest = parseVersion(latestRaw);
  const current = parseVersion(currentRaw);
  if (!latest || !current) return false;
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== current[i]) return latest[i] > current[i];
  }
  return false;
}

function findTarballAsset(assets: GitHubReleaseAsset[] | undefined): GitHubReleaseAsset | null {
  return assets?.find((a) => a.name.endsWith(".tgz")) ?? null;
}

/**
 * Fetches the latest published GitHub Release for `repoSlug` ("owner/repo")
 * and compares its tag to `currentVersion`. Cached per repoSlug for
 * CACHE_TTL_MS. Throws UpdateCheckError on network failure or a non-2xx
 * response (including 404, which a repo with no releases yet returns) —
 * callers decide how to surface that (see src/routes/updates.ts).
 */
export async function checkForUpdate(
  repoSlug: string,
  currentVersion: string,
  applyAvailable: boolean,
): Promise<UpdateCheckResult> {
  const cached = cache.get(repoSlug);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    // applyAvailable reflects this process's own config, not GitHub state —
    // recompute it fresh even on a cache hit rather than serving a stale
    // value from whatever it was the first time this repoSlug was checked.
    return { ...cached.result, applyAvailable };
  }

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}/repos/${repoSlug}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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

  const data = (await res.json()) as GitHubReleaseApiResponse;
  const latestVersion = data.tag_name?.replace(/^v/, "") ?? null;
  const asset = findTarballAsset(data.assets);

  const result: UpdateCheckResult = {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion !== null && isNewer(latestVersion, currentVersion),
    releaseUrl: data.html_url ?? null,
    assetUrl: asset?.browser_download_url ?? null,
    applyAvailable,
  };

  cache.set(repoSlug, { ts: Date.now(), result });
  return result;
}
