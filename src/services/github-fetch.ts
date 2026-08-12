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
  try {
    return await fetch(`${GITHUB_API_BASE}${path}`, {
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
}
