// Shared low-level fetch plumbing for the GitHub REST API — factored out of
// github.ts, github-app.ts, github-webhook.ts, github-integration.ts, and
// update-checker.ts, which each redeclared the same GITHUB_API_BASE,
// Accept/User-Agent headers, AbortSignal.timeout, and network-failure
// mapping. Deliberately narrow: `github-write.ts`'s own `githubRequest`
// hardcodes `/repos/{owner}/{repo}` paths and write-specific 404 mapping —
// a distinct, correct abstraction that stays as-is, not absorbed here.
// Every module keeps its own HTTP-status policy (which 4xx means what,
// which error class to throw) at its own call sites — only the mechanics
// below are shared.

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 5_000;
const USER_AGENT = "mullion-session-manager";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/**
 * Distinct from GitHubApiError (and from GitHubWriteScopeError,
 * github-write.ts) so a caller — and its logs — can tell "GitHub is
 * temporarily rate-limiting us" from every other 4xx/5xx shape, including
 * the specific misdiagnosis this class exists to prevent: `githubRequest`
 * used to classify ANY 403 as "the token lacks write access"
 * (GitHubWriteScopeError), but GitHub also returns 403 for a secondary
 * rate limit and for a primary limit exhausted (`X-RateLimit-Remaining:
 * 0`). `retryAfterMs` is how long the caller should treat GitHub as
 * unreachable for — same number that's fed into recordGitHubRateLimit
 * below (#759).
 */
export class GitHubRateLimitError extends GitHubApiError {
  constructor(
    message: string,
    statusCode: number,
    public readonly retryAfterMs: number,
  ) {
    super(message, statusCode);
    this.name = "GitHubRateLimitError";
  }
}

// A 429 with no Retry-After header at all (secondary rate limit, some
// abuse-detection responses) — GitHub's own docs say to wait "at least one
// minute" in that case.
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

/**
 * Install-wide rate-limit budget (#759) — one module-scope "don't call
 * GitHub again until T", observed by every request this process makes
 * (githubApiFetch below and github-write.ts's own raw-fetch `githubRequest`,
 * which deliberately bypasses githubApiFetch — see that file's own doc
 * comment — but calls recordGitHubRateLimit/isGitHubRateLimited directly).
 * Deliberately process-local, not persisted: same posture as
 * task-reconciler.ts's per-task backoff maps (draftPrRetryState and
 * siblings) — a restart just means one extra live check against GitHub,
 * not a correctness problem.
 *
 * This is the PRIMARY defense against hammering a rate-limited GitHub, not
 * a supplement to per-task backoff maps. It's enforced here, at the
 * transport, rather than threaded into task-reconciler.ts's three
 * independent per-task maps (draftPrRetryState/mergeRetryState/
 * autoApproveRetryState): those maps record an attempt OPTIMISTICALLY,
 * before the network call even happens (see draftPrRetryState's own
 * comment), so there's no single catch site to hook a rate-limit-aware
 * resume time into without a deeper refactor of the discriminated-result
 * types those sweeps already use to swallow errors
 * (ApproveOutcome/PromoteOutcome-style shapes). A transport-level budget
 * gets the same practical protection — no sweep, and no individual GitHub
 * call anywhere in the process, makes a network request while rate-limited
 * — without that refactor, and it also covers call sites #759 doesn't
 * enumerate (task-watcher.ts's dependency/readback checks, the parent-title
 * backfill, ...).
 */
let rateLimitedUntil = 0;

export function recordGitHubRateLimit(resumeAt: number): void {
  rateLimitedUntil = Math.max(rateLimitedUntil, resumeAt);
}

export function isGitHubRateLimited(): boolean {
  return Date.now() < rateLimitedUntil;
}

export function githubRateLimitRemainingMs(): number {
  return Math.max(0, rateLimitedUntil - Date.now());
}

// clearAgentsCacheForTests pattern (agent-detect.ts) for a module-level
// singleton — this budget is process-wide and would otherwise leak between
// test files/cases that share a Vitest worker.
export function resetGitHubRateLimitForTests(): void {
  rateLimitedUntil = 0;
}

/**
 * Reads `Retry-After` (seconds, or an HTTP-date) off a Response, falling
 * back to `DEFAULT_RATE_LIMIT_BACKOFF_MS` when the header is present but
 * unparseable, or absent on a 429 (secondary rate limit responses
 * sometimes omit it entirely).
 */
function retryAfterMsFrom(res: Response): number {
  const header = res.headers.get("retry-after");
  if (header === null) return DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return DEFAULT_RATE_LIMIT_BACKOFF_MS;
}

/**
 * How long until `X-RateLimit-Reset` (a Unix seconds timestamp), or `null`
 * if the header is absent, unparseable, or already in the past — the last
 * case matters: a *past* reset alongside `remaining: 0` is a stale/
 * inconsistent pair, not a live rate limit, and treating it as one would
 * make classifyRateLimit's own "must be genuinely rate-limited" guard
 * below meaningless.
 */
function rateLimitResetMsFrom(res: Response): number | null {
  const header = res.headers.get("x-ratelimit-reset");
  if (header === null) return null;
  const resetSeconds = Number(header);
  if (!Number.isFinite(resetSeconds)) return null;
  const remaining = resetSeconds * 1000 - Date.now();
  return remaining > 0 ? remaining : null;
}

/**
 * Classifies a non-ok Response as a GitHub rate limit, or returns `null` if
 * it isn't one — callers decide what to do with `null` (their own existing
 * 4xx/5xx handling). Two shapes:
 *
 *  - `429` unconditionally — GitHub never returns 429 for anything else.
 *  - `403` ONLY when it carries independent rate-limit evidence:
 *    `Retry-After`, OR `X-RateLimit-Remaining: 0` paired with a
 *    `X-RateLimit-Reset` that hasn't passed yet. A bare 403 with neither
 *    is a genuine permission/scope problem (GitHub also sets
 *    `x-ratelimit-remaining: 0` on SOME permission-failure responses,
 *    independent of the actual rate-limit state — the reset-in-the-future
 *    check is what keeps that from being misread as "we're rate-limited,
 *    back off globally" when the real answer is "this token can't do
 *    this," which is exactly the diagnostic inversion this feature exists
 *    to fix, just pointing the other way).
 */
export function classifyRateLimit(res: Response): GitHubRateLimitError | null {
  if (res.status === 429) {
    return new GitHubRateLimitError("GitHub rate limit hit (HTTP 429)", 429, retryAfterMsFrom(res));
  }
  if (res.status === 403) {
    const retryAfterHeader = res.headers.get("retry-after");
    const remainingIsZero = res.headers.get("x-ratelimit-remaining") === "0";
    const resetMs = rateLimitResetMsFrom(res);
    if (retryAfterHeader !== null) {
      return new GitHubRateLimitError(
        "GitHub rate limit hit (HTTP 403 with Retry-After)",
        403,
        retryAfterMsFrom(res),
      );
    }
    if (remainingIsZero && resetMs !== null) {
      return new GitHubRateLimitError(
        "GitHub rate limit hit (HTTP 403, X-RateLimit-Remaining: 0)",
        403,
        resetMs,
      );
    }
  }
  return null;
}

/**
 * Issues a request against `${GITHUB_API_BASE}${path}`, merging the
 * caller's own headers (Authorization, Content-Type, If-None-Match, ...)
 * over the Accept/User-Agent defaults every caller needs, and applying the
 * shared REQUEST_TIMEOUT_MS via AbortSignal.timeout. A raw network failure
 * (including the abort firing) is the one outcome mapped here, into
 * GitHubApiError(msg, 0) — every caller already treats "couldn't reach
 * GitHub at all" the same way. A non-ok HTTP response is returned as-is:
 * 403/404/etc mean different things to different callers, so that stays
 * their call.
 */
export async function githubApiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  // #759 — fail fast and locally rather than spending a request (and its
  // own 5s timeout) proving what the install-wide budget above already
  // knows. Every caller through this shared chokepoint gets this for free.
  if (isGitHubRateLimited()) {
    throw new GitHubRateLimitError(
      "GitHub rate limit is in effect — not making this request",
      429,
      githubRateLimitRemainingMs(),
    );
  }

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubApiError(
      `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  // Record into the shared budget regardless of whether THIS caller is
  // about to throw on it — a caller with its own bespoke 403 handling
  // (github.ts's read-side functions, none of which claim "scope error" on
  // 403) still gets the response returned as-is, per this function's own
  // doc comment above, but the install-wide budget still learns about the
  // rate limit either way.
  const rateLimit = classifyRateLimit(res);
  if (rateLimit) recordGitHubRateLimit(Date.now() + rateLimit.retryAfterMs);
  return res;
}
