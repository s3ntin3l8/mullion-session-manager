import crypto from "node:crypto";
import { validateGitHubRepoRef } from "./github.js";

// #489 — GitHub App installation tokens, configured independently of the
// shared PAT/OAuth token in github-integration.ts. This is a deliberate,
// narrowly-scoped reversal of a prior decision (docs/roadmap.md's issue #60
// "GitHub App investigation," resolved by #384 in favor of PAT-registered
// webhooks + adaptive polling). Two permission flavors are minted per repo:
// "write" for Task Master's own write paths (task-github-sync.ts,
// task-promote.ts, git-push.ts) plus its issue ingest reads, and "read" for
// the base GitHub integration's own reads (repo-status widget, PR/CI
// poller). Both fall back to the shared PAT/OAuth token when the App isn't
// configured, isn't installed on a given owner, or a mint fails. Webhook
// registration is the one exception that stays on the PAT/OAuth token
// unconditionally — a GitHub App doesn't create per-repo hooks, it receives
// events by installation, so there's no App-token equivalent to fall back
// *to*.
//
// A GitHub App installation token scopes to a *repository* + a permission
// set, never to an individual issue/task — "per-task" in practice means
// minted fresh per task, limited to that task's repo and the minimum
// permission set, short-lived (~1h), not a token bound to one issue number.

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "mullion-session-manager";
const REQUEST_TIMEOUT_MS = 5_000;
// GitHub rejects an app JWT with `exp` more than 10 minutes out; 9 minutes
// leaves margin for clock skew between this host and GitHub's.
const APP_JWT_TTL_SECONDS = 9 * 60;

export class GitHubAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAppError";
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Signs a GitHub App JWT (RS256) per GitHub's own spec: `iat` backdated 60s
 * to tolerate clock skew, `exp` within the 10-minute ceiling, `iss` the
 * numeric App id. Uses `node:crypto` directly rather than a JWT library —
 * the claim set is fixed and tiny, not worth a dependency.
 *
 * Hermes review, PR #504: deliberately single-key only — no `kid` header
 * claim. GitHub only requires `kid` when an App has more than one *active*
 * private key at once, which happens mid-rotation under GitHub's own
 * recommended flow (add a new key, wait, then remove the old one). Mullion
 * stores exactly one key (`setGitHubApp` overwrites, it doesn't add), so
 * this is a real but narrow limitation: mint requests during that
 * multi-key window could 401 and silently fall back to the PAT. Multi-key
 * support would mean storing/selecting among several keys — larger scope
 * than a single credential slot takes on; documented here rather than
 * silently dropped.
 */
export function signAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + APP_JWT_TTL_SECONDS, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  let signature: Buffer;
  try {
    signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKeyPem);
  } catch {
    // Hermes review, PR #504: deliberately drops the underlying error's
    // own message — some Node/OpenSSL versions echo key material back in
    // a signing error string, and this error is both logged
    // (app.log.warn in resolveGitHubToken) and surfaced to callers, so
    // there's no safe place downstream to redact it. A fixed message is
    // the only sanitization that actually holds.
    throw new GitHubAppError("Failed to sign GitHub App JWT — check the configured private key");
  }
  return `${signingInput}.${base64url(signature)}`;
}

interface InstallationSummary {
  id: number;
  login: string;
}

/**
 * Lists this App's installations, so a repo owner can be resolved to an
 * installation id. Not cached — called only on a cache miss in
 * `resolveGitHubToken`, at most once per (owner, repo) per token TTL.
 *
 * Hermes review, PR #504: capped at the first 100 installations (one
 * page, no `Link`-header pagination) — deliberately, matching
 * `github.ts`'s own "glance list, not an exhaustive report" scope for
 * `listLabeledIssues`. An App installed on more than 100 accounts would
 * silently fail to resolve an owner past that page, falling back to the
 * shared PAT — acceptable for now given the intended usage (a handful of
 * repos/orgs an install actually writes to), but a real limit if this
 * ever needs to scale past it.
 */
export async function listInstallations(appJwt: string): Promise<InstallationSummary[]> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}/app/installations?per_page=100`, {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Hermes review, PR #504 (round 7): a raw network failure or the
    // AbortSignal timeout firing must surface as a `GitHubAppError` too,
    // not a bare `TypeError`/`DOMException` — `resolveGitHubToken`
    // (github-integration.ts) narrows its own catch to this error type
    // specifically so it can tell "the GitHub App path failed in an
    // expected, fall-back-to-the-PAT way" apart from an actual bug in its
    // own code, and that only works if every expected failure mode here
    // is consistently wrapped.
    throw new GitHubAppError(
      `GitHub App installations list request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new GitHubAppError(`GitHub App installations list failed (HTTP ${res.status})`);
  }
  const items = (await res.json()) as Array<{ id: number; account?: { login?: string } }>;
  return items
    .filter((item) => item.account?.login)
    .map((item) => ({ id: item.id, login: item.account!.login! }));
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

// #489 (round 2, issue #489 remaining scope) — two permission sets, not
// one widened one. Task Master's write paths need exactly WRITE_PERMISSIONS
// and nothing more; the base integration's read-only surfaces (repo-status
// widget, PR/CI poller) need Actions/PRs read access WRITE_PERMISSIONS
// doesn't grant. Minting a single token with the union of both would hand
// every Task Master *write* an `actions` scope it has no use for —
// undermining the least-privilege property #489 shipped for in the first
// place. Permission names verified against GitHub's own
// permissions-required-for-github-apps reference: GET /repos/{o}/{r} needs
// Metadata:read, the Actions run/job/log endpoints all need Actions:read
// (one permission covers all three), and list-PRs needs Pull requests:read.
export const WRITE_PERMISSIONS = {
  issues: "write",
  pull_requests: "write",
  contents: "write",
} as const;
export const READ_PERMISSIONS = {
  actions: "read",
  metadata: "read",
  pull_requests: "read",
} as const;

export type InstallationTokenScope = "write" | "read";

/**
 * Exchanges an App JWT for a short-lived installation token, narrowed to
 * exactly one repository and the minimum permission set the given `scope`
 * needs — never the installation's full repository/permission grant.
 * Takes `owner`/`repo` separately (not a pre-joined string) so
 * `validateGitHubRepoRef` can run right at the point of the outbound
 * request — `owner`/`repo` ultimately trace back to a project's
 * `.git/config` (file data), the same "file data reaching an outbound
 * request" shape `github.ts`'s own request functions guard against
 * (CodeQL's js/file-access-to-http query, dismissed as won't-fix on this
 * request specifically — see the PR history — since it's the intended,
 * expected shape of a GitHub integration).
 */
export async function mintInstallationToken(
  appJwt: string,
  installationId: number,
  owner: string,
  repo: string,
  scope: InstallationTokenScope = "write",
): Promise<InstallationToken> {
  validateGitHubRepoRef(owner, repo);
  // Hermes review, PR #504: GitHub's `repositories` field takes BARE repo
  // names ("Hello-World"), not "owner/repo" — `owner` is already fixed by
  // the installation id in the URL path. Sending "owner/repo" here matches
  // no real repository: the exchange either 422s (silent PAT fallback) or
  // mints a token scoped to nothing, cached for ~1h, 404ing every write.
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [repo],
        permissions: scope === "write" ? WRITE_PERMISSIONS : READ_PERMISSIONS,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // See the matching comment in listInstallations above — same reason.
    throw new GitHubAppError(
      `GitHub App installation token exchange request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    // A mint may only request a SUBSET of what the installation was
    // granted at install time (#489 remaining scope) — an App configured
    // before `actions`/`metadata` permissions existed on it will 422 here
    // for scope:"read" specifically until an admin re-approves the App
    // with the wider grant. That's an expected, not-a-bug outcome
    // (getInstallationToken's caller falls back to the PAT), so this
    // stays a plain GitHubAppError rather than a distinct error class —
    // the caller can't act on "which permission was missing" differently
    // from any other mint failure.
    throw new GitHubAppError(
      `GitHub App installation token exchange failed (HTTP ${res.status}) for installation ${installationId} (scope: ${scope})`,
    );
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: new Date(body.expires_at) };
}

// Hermes review, PR #504 (round 7): the shared owner-matching logic behind
// both `resolveInstallationId` (below, uncached — exercised directly by
// tests) and `resolveInstallationIdCached` (production's actual call path)
// — a single implementation so the two can't drift against each other.
async function findInstallationMatch(
  appJwt: string,
  owner: string,
): Promise<{ installationId: number | null; installationsChecked: number }> {
  const installations = await listInstallations(appJwt);
  const match = installations.find((i) => i.login.toLowerCase() === owner.toLowerCase());
  return { installationId: match?.id ?? null, installationsChecked: installations.length };
}

/**
 * Resolves `owner` to an installation id by listing every installation of
 * this App and matching on the account login (case-insensitive — GitHub
 * logins are case-preserving but not case-sensitive). Returns `null` when
 * the App isn't installed on that owner's account at all — the caller's
 * job to fall back, not this function's.
 */
export async function resolveInstallationId(appJwt: string, owner: string): Promise<number | null> {
  const { installationId } = await findInstallationMatch(appJwt, owner);
  return installationId;
}

// (appId, scope, owner, repo) -> cached token, evicted 60s before actual
// expiry so a caller never hands out a token GitHub is about to reject
// mid-flight. Keyed by owner/repo rather than installationId/repo
// specifically so a cache hit skips resolveInstallationId's own fetch
// entirely — see getInstallationToken below.
//
// Hermes review, PR #504: appId is part of the key, not just owner/repo —
// swapping which App is configured (a different appId) within the old
// App's token TTL must not keep serving that stale token. Combined with
// clearInstallationTokenCacheForApp below (called from
// setGitHubApp/clearGitHubApp), so reconfiguring the App never inherits a
// leftover entry either.
//
// #489 remaining scope — `scope` ("write"/"read") is now part of the key
// too: the same (appId, owner, repo) can legitimately hold two live
// tokens at once, one per permission set, and they must not overwrite each
// other. A NEGATIVE entry (`ok: false`) is cached the same way the
// installation-id lookup below already caches "not installed" — an App
// that hasn't been re-approved with the `actions`/`metadata` permissions
// `scope: "read"` needs would otherwise re-attempt (and re-fail) that mint
// on every single call, one HTTPS round trip per read, forever.
interface CachedToken {
  ok: true;
  token: string;
  expiresAt: Date;
}
interface CachedTokenFailure {
  ok: false;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken | CachedTokenFailure>();
const CACHE_SAFETY_MARGIN_MS = 60_000;
// Same TTL as the installation-id negative cache below — GitHub gives no
// cheaper signal for "did this App's granted permissions change" than
// re-attempting the mint, so this is a deliberate cap on how often a
// known-doomed scope gets retried, not a measured value.
const TOKEN_FAILURE_CACHE_TTL_MS = 60 * 60_000;

function cacheKey(
  appId: string,
  scope: InstallationTokenScope,
  owner: string,
  repo: string,
): string {
  return `${appId}:${scope}:${owner}/${repo}`;
}

// Hermes review, PR #504 (round 7): both module-level caches only ever
// replace an entry on a repeat access to that same key — an (appId, owner,
// repo)/(appId, owner) combination visited once and never revisited (e.g. a
// project renamed or removed) would otherwise sit expired-but-present for
// the life of the process. These entries are tiny and this is a
// single-install-per-process app, so unbounded growth was never a real
// resource risk, but pruning is nearly free — done opportunistically on
// every write into either cache rather than on a timer, so it costs nothing
// on an install that never triggers it.
function pruneExpiredTokens(): void {
  const now = Date.now();
  for (const [key, value] of tokenCache) {
    const expiresAtMs = value.ok ? value.expiresAt.getTime() : value.expiresAt;
    if (expiresAtMs <= now) tokenCache.delete(key);
  }
}

// (appId, owner) -> resolved installation id, INCLUDING a cached `null`
// ("this App has no installation covering this owner"). Hermes review, PR
// #504: without caching the negative result, every write to a not-covered
// owner re-runs the full `listInstallations` HTTPS round trip (up to the
// 5s timeout) before falling back to the PAT — a per-write tax on an
// expected, supported steady state (an App deliberately scoped to only
// some repos). Same TTL as an installation token's own lifetime, since
// GitHub's own token-mint response doesn't give a cheaper signal for "did
// the installation set change."
const installationIdCache = new Map<
  string,
  { installationId: number | null; installationsChecked: number; expiresAt: number }
>();
const INSTALLATION_CACHE_TTL_MS = 60 * 60_000;

function installationCacheKey(appId: string, owner: string): string {
  return `${appId}:${owner}`;
}

function pruneExpiredInstallationLookups(): void {
  const now = Date.now();
  for (const [key, value] of installationIdCache) {
    if (value.expiresAt <= now) installationIdCache.delete(key);
  }
}

interface InstallationLookup {
  installationId: number | null;
  // Hermes review, PR #504 (round 6): how many installations `listInstallations`
  // actually returned when this was resolved (from cache or fresh) — lets a
  // caller logging a `null` result distinguish "this App genuinely isn't
  // installed on this owner" from "the 100-installation page cap (see
  // `listInstallations` above) truncated the list before it got here."
  installationsChecked: number;
}

async function resolveInstallationIdCached(
  appJwt: string,
  appId: string,
  owner: string,
): Promise<InstallationLookup> {
  const key = installationCacheKey(appId, owner);
  const cached = installationIdCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      installationId: cached.installationId,
      installationsChecked: cached.installationsChecked,
    };
  }
  const { installationId, installationsChecked } = await findInstallationMatch(appJwt, owner);
  pruneExpiredInstallationLookups();
  installationIdCache.set(key, {
    installationId,
    installationsChecked,
    expiresAt: Date.now() + INSTALLATION_CACHE_TTL_MS,
  });
  return { installationId, installationsChecked };
}

export interface InstallationTokenResult {
  token: string | null;
  // Only meaningful when `token` is null — see `InstallationLookup` above.
  installationsChecked: number | null;
}

/**
 * Mints (or returns a cached, still-valid) installation token for
 * `owner/repo`. The only entry point `github-integration.ts`'s
 * `resolveGitHubToken` calls — everything above is plumbing this
 * orchestrates. Returns a null `token` when the App has no installation
 * covering `owner`, letting the caller fall back to the shared PAT rather
 * than failing the write outright. `scope` defaults to `"write"` — Task
 * Master's own write paths, the original #489 slice; `"read"` is for the
 * base integration's read-only surfaces (#489 remaining scope), which need
 * a different, non-overlapping permission set (see WRITE_PERMISSIONS/
 * READ_PERMISSIONS above).
 */
export async function getInstallationToken(
  appId: string,
  privateKeyPem: string,
  owner: string,
  repo: string,
  scope: InstallationTokenScope = "write",
): Promise<InstallationTokenResult> {
  // Cached by (appId, scope, owner, repo), not (installationId, repo) — on
  // a cache hit this must skip `resolveInstallationId` entirely, not just
  // the mint call, or every cache "hit" would still cost a
  // `listInstallations` fetch.
  const key = cacheKey(appId, scope, owner, repo);
  const cached = tokenCache.get(key);
  if (cached) {
    if (cached.ok && cached.expiresAt.getTime() - CACHE_SAFETY_MARGIN_MS > Date.now()) {
      return { token: cached.token, installationsChecked: null };
    }
    if (!cached.ok && cached.expiresAt > Date.now()) {
      // A previously-doomed mint for this scope (e.g. the App hasn't been
      // re-approved with the `actions`/`metadata` permissions `"read"`
      // needs) — don't re-attempt it every call within the negative TTL.
      return { token: null, installationsChecked: null };
    }
  }

  const appJwt = signAppJwt(appId, privateKeyPem);
  const { installationId, installationsChecked } = await resolveInstallationIdCached(
    appJwt,
    appId,
    owner,
  );
  if (installationId === null) return { token: null, installationsChecked };

  try {
    const minted = await mintInstallationToken(appJwt, installationId, owner, repo, scope);
    pruneExpiredTokens();
    tokenCache.set(key, { ok: true, token: minted.token, expiresAt: minted.expiresAt });
    return { token: minted.token, installationsChecked: null };
  } catch (err) {
    pruneExpiredTokens();
    tokenCache.set(key, { ok: false, expiresAt: Date.now() + TOKEN_FAILURE_CACHE_TTL_MS });
    throw err;
  }
}

/**
 * Evicts every cached token AND cached installation-id lookup for one App
 * id — called from `github-integration.ts`'s `setGitHubApp`/
 * `clearGitHubApp` so reconfiguring or removing the App can never keep
 * serving a token (or a stale "not installed" negative result) from a
 * previous configuration.
 */
export function clearInstallationTokenCacheForApp(appId: string): void {
  const tokenPrefix = `${appId}:`;
  for (const key of tokenCache.keys()) {
    if (key.startsWith(tokenPrefix)) tokenCache.delete(key);
  }
  const installationPrefix = `${appId}:`;
  for (const key of installationIdCache.keys()) {
    if (key.startsWith(installationPrefix)) installationIdCache.delete(key);
  }
}

/** Test-only introspection/reset. */
export function clearInstallationTokenCacheForTests(): void {
  tokenCache.clear();
  installationIdCache.clear();
}

/** Test-only introspection of the two cache sizes — asserts pruning actually shrinks them. */
export function getInstallationCacheSizesForTests(): { tokens: number; installations: number } {
  return { tokens: tokenCache.size, installations: installationIdCache.size };
}
