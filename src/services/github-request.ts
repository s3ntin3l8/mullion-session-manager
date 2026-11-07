// The shared GitHub REST request path (Phase 6 Task Master, 6.4/#217) — the
// first write capability beyond registerHook/unregisterHook
// (github-webhook.ts). One `githubRequest()` helper (owner/repo/method/
// path-suffix/optional JSON body), modeled on github-webhook.ts's
// registerHook shape: validateGitHubRepoRef() first, the standard header
// block, AbortSignal.timeout, error-body-into-message on failure.
// Deliberately THROWS on failure — unlike unregisterHook's
// `.catch(() => {})`, a dropped label or comment here would silently
// desync the local task row from the issue-of-record, which
// task-github-sync.ts's callers need to know about (even if they choose to
// treat it as best-effort themselves).
//
// Split out of github-write.ts (issue #2405) so that BOTH the write client
// and the release-please client (github-release.ts) can share one request
// path — and, more to the point, so neither has to import the other. The
// release client needs the transport and one PR read; the write client
// needs the transport too. Keeping the transport here is what lets
// github-release.ts and github-write.ts sit side by side with no import
// cycle between them.
//
// validateGitHubRepoRef() runs INSIDE githubRequest itself, in the same
// function that builds the URL and calls fetch — not just in each public
// wrapper before calling in here. Every wrapper in github-write.ts already
// validated once too, so this looks redundant, but it isn't: CodeQL's
// js/request-forgery dataflow analysis doesn't reliably connect a
// sanitizer call to a tainted value across a function-call boundary when
// the fetch itself happens one level deeper (a real finding on this file's
// first version, not a false-positive dismissal) — github.ts's own
// functions all validate-and-fetch in the same function body for exactly
// this reason, and this file now matches that precedent.

import { GitHubApiError, validateGitHubRepoRef } from "./github.js";
import {
  githubApiBase,
  classifyRateLimit,
  recordGitHubRateLimit,
  isGitHubRateLimited,
  githubRateLimitRemainingMs,
  GitHubRateLimitError,
} from "./github-fetch.js";

const REQUEST_TIMEOUT_MS = 5_000;
const USER_AGENT = "mullion-session-manager";

/**
 * A write rejected with 403/404 almost always means the connected token
 * lacks the required scope, not a transient API error — device-flow tokens
 * carry OAuth `repo` (read+write) and just work, while every fine-grained
 * PAT provisioned per today's docs is read-only and 403s on the first
 * label/comment/close write. Distinct from GitHubApiError so callers (and
 * their logs) can tell "GitHub is down" from "this token can't do this,"
 * per docs/github-integration.md's scope table. Only raised for a
 * write-method (POST/PATCH/DELETE) request — see githubRequest's own
 * comment on why a 404 on a GET means something else entirely.
 */
export class GitHubWriteScopeError extends GitHubApiError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode);
    this.name = "GitHubWriteScopeError";
  }
}

export async function githubRequest<T>(
  token: string,
  owner: string,
  repo: string,
  method: string,
  pathSuffix: string,
  body?: unknown,
): Promise<T> {
  validateGitHubRepoRef(owner, repo);
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${pathSuffix}`;

  // #759 — same short-circuit as githubApiFetch's own (github-fetch.ts);
  // duplicated here, not reused, because this function deliberately bypasses
  // githubApiFetch entirely (see the file-header comment on why).
  if (isGitHubRateLimited()) {
    throw new GitHubRateLimitError(
      "GitHub rate limit is in effect — not making this request",
      429,
      githubRateLimitRemainingMs(),
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${githubApiBase()}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubApiError(
      `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    // #759 — classify BEFORE the write-scope branch below: a rate-limited
    // 403 must never be reported as "the token lacks write access" (the
    // exact misdiagnosis this feature exists to fix).
    const rateLimit = classifyRateLimit(res);
    if (rateLimit) {
      recordGitHubRateLimit(Date.now() + rateLimit.retryAfterMs);
      throw rateLimit;
    }
    // A 404 on a write (label/comment/assignee/close/PR-create endpoints
    // all live under an issue/repo path a write implies exists) almost
    // always means "no write access" rather than "not found" — GitHub
    // returns 404, not 403, for a resource a token can't see at all. A GET
    // is different: a 404 there is a completely ordinary "this issue
    // doesn't exist" (or the repo doesn't), not a scope problem, so it's
    // left as a plain GitHubApiError instead.
    if (res.status === 403 || (res.status === 404 && method !== "GET")) {
      throw new GitHubWriteScopeError(
        `GitHub rejected this write (HTTP ${res.status}) for ${method} ${path} — the connected token likely lacks write access. See docs/github-integration.md for the required scopes. ${responseBody}`.trim(),
        res.status,
      );
    }
    throw new GitHubApiError(
      `GitHub API error (HTTP ${res.status}) for ${method} ${path}: ${responseBody}`,
      res.status,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Looks a PR up by number — used to resolve its GraphQL node id (REST
 * doesn't expose a `draft` -> ready-for-review transition; see
 * `markPullRequestReadyForReview` in github-write.ts) when all a caller has
 * on hand is the `pr_number` recorded on a task row, not the id from the
 * create response that minted it (approve can run in a fresh process from
 * whichever `-> reviewing` transition opened the draft).
 *
 * `headSha` was already on the wire and previously discarded — added for
 * `createPullRequestReview` in github-write.ts, which needs the exact
 * commit its `comments[]` anchors bind to.
 *
 * `mergeable`/`mergeableState`/`state`/`merged`/`title`/`headRef` — added for
 * the merge-on-approve sweep (`processMergeRequests`, task-reconciler.ts).
 * `mergeable` is `boolean | null`: GitHub computes it asynchronously after a
 * push, and `null` means "still computing, ask again" — never treat it as
 * false. `mergeableState` (GitHub's `mergeable_state`) is the finer-grained
 * signal the sweep actually branches on (`clean`/`behind`/`blocked`/
 * `unstable`/`dirty`/`unknown`); it's stable in practice but officially
 * undocumented by GitHub's REST API. Read via REST rather than GraphQL's
 * `mergeStateStatus` purely to avoid adding a second query shape to this
 * file for one more field — REST already returns it on the same response
 * every other field here comes from.
 *
 * `baseRef` — added for #755's red-CI-return gate, which needs the PR's
 * actual base branch to look up branch protection against (never assume
 * `main`/`default_branch`: a task's PR can target any branch a human chose
 * when opening it, e.g. when stacking on another feature branch).
 */
export async function getPullRequestByNumber(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<{
  number: number;
  htmlUrl: string;
  nodeId: string;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  // #1015 (archive), review fix — GitHub's own `merged_at` (ISO 8601, null
  // until merged), a deliberate addition to this whitelisted shape so the
  // archive-merged backfill route can record the PR's actual merge time
  // instead of "whenever this endpoint happened to run."
  mergedAt: string | null;
  mergeable: boolean | null;
  mergeableState: string;
}> {
  const result = await githubRequest<{
    number: number;
    html_url: string;
    node_id: string;
    draft: boolean;
    head: { sha: string; ref: string };
    base: { ref: string };
    title: string;
    state: "open" | "closed";
    merged: boolean;
    merged_at: string | null;
    mergeable: boolean | null;
    mergeable_state: string;
  }>(token, owner, repo, "GET", `/pulls/${number}`);
  return {
    number: result.number,
    htmlUrl: result.html_url,
    nodeId: result.node_id,
    draft: result.draft,
    headSha: result.head.sha,
    headRef: result.head.ref,
    baseRef: result.base.ref,
    title: result.title,
    state: result.state,
    merged: result.merged,
    mergedAt: result.merged_at,
    mergeable: result.mergeable,
    mergeableState: result.mergeable_state,
  };
}
