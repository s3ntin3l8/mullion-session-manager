// Shared GitHub REST write client (Phase 6 Task Master, 6.4/#217) — the
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
// validateGitHubRepoRef() runs INSIDE githubRequest itself, in the same
// function that builds the URL and calls fetch — not just in each public
// wrapper before calling in here. Every wrapper below already validated
// once too, so this looks redundant, but it isn't: CodeQL's
// js/request-forgery dataflow analysis doesn't reliably connect a
// sanitizer call to a tainted value across a function-call boundary when
// the fetch itself happens one level deeper (a real finding on this file's
// first version, not a false-positive dismissal) — github.ts's own
// functions all validate-and-fetch in the same function body for exactly
// this reason, and this file now matches that precedent.

import { GitHubApiError, validateGitHubRepoRef, getDefaultBranch, getPRsStatus } from "./github.js";
import {
  githubApiFetch,
  classifyRateLimit,
  recordGitHubRateLimit,
  isGitHubRateLimited,
  githubRateLimitRemainingMs,
  GitHubRateLimitError,
} from "./github-fetch.js";
import type { ReleaseDetectionResult, ReleasePullRequestStatus } from "../shared/types.js";

const GITHUB_API_BASE = "https://api.github.com";
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

async function githubRequest<T>(
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
    res = await fetch(`${GITHUB_API_BASE}${path}`, {
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

export async function addLabels(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  await githubRequest(token, owner, repo, "POST", `/issues/${issueNumber}/labels`, { labels });
}

/**
 * A 404 here means the label wasn't on the issue (or doesn't exist on the
 * repo at all) — already the desired end state, so it's swallowed as a
 * no-op rather than surfaced as a scope error or a write failure. Any
 * other failure (including a 403, which DOES indicate a real scope
 * problem — removing a label needs the same write access as adding one)
 * still throws.
 */
export async function removeLabel(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await githubRequest(
      token,
      owner,
      repo,
      "DELETE",
      `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    );
  } catch (err) {
    if (err instanceof GitHubWriteScopeError && err.statusCode === 404) return;
    throw err;
  }
}

export async function createComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<{ id: number; htmlUrl: string }> {
  const result = await githubRequest<{ id: number; html_url: string }>(
    token,
    owner,
    repo,
    "POST",
    `/issues/${issueNumber}/comments`,
    { body },
  );
  return { id: result.id, htmlUrl: result.html_url };
}

export async function setAssignees(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  assignees: string[],
): Promise<void> {
  await githubRequest(token, owner, repo, "POST", `/issues/${issueNumber}/assignees`, {
    assignees,
  });
}

export async function closeIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await githubRequest(token, owner, repo, "PATCH", `/issues/${issueNumber}`, {
    state: "closed",
  });
}

export interface IssueStateResult {
  state: "open" | "closed";
  labels: string[];
}

/** Fetches the current open/closed state and label names of a single issue
 * — used by task-github-sync.ts's read-back path to tell "closed on
 * GitHub" and "still open but lost its tracking label" apart from "still
 * open, still labeled, just fell off this sweep's own page cap" for a task
 * that dropped out of the watcher's labeled-issues sweep (#490a). One
 * request answers both questions rather than a separate label-list call. */
export async function getIssueState(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IssueStateResult> {
  const result = await githubRequest<{
    state: "open" | "closed";
    labels?: Array<string | { name?: string }>;
  }>(token, owner, repo, "GET", `/issues/${issueNumber}`);
  const labels = (result.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter((name): name is string => typeof name === "string");
  return { state: result.state, labels };
}

/** #701 — fetches a single issue's title, used by task-watcher.ts's
 * fillParentIssueTitles to lazily resolve a child card's `↳ <parent
 * title>` chip (the title isn't on the list response the way
 * `parent_issue_url` itself is, so this is the one extra call per DISTINCT
 * parent). A separate method rather than widening IssueStateResult: that
 * type is consumed by close-sync and shouldn't grow a field nothing there
 * reads. githubRequest's own 404-on-GET split means a deleted/private
 * parent surfaces as a plain GitHubApiError, not a false
 * GitHubWriteScopeError — the caller treats that as a bounded retry
 * candidate, not a hard failure. */
export async function getIssueTitle(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  const result = await githubRequest<{ title: string }>(
    token,
    owner,
    repo,
    "GET",
    `/issues/${issueNumber}`,
  );
  return result.title;
}

// #667 — native GitHub issue dependencies
// (docs.github.com/en/rest/issues/issue-dependencies). Both endpoints return
// full issue objects (state included, cross-repo blockers included via each
// item's own `repository`), so one call each fully resolves either
// direction — no follow-up lookups needed.

export interface DependencyIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: "open" | "closed";
}

interface GitHubDependencyApiItem {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  repository?: { name?: string; owner?: { login?: string } };
}

/** Shared by listBlockedByIssues/listBlockingIssues below — same request
 * shape, opposite direction. Single page (100 items), matching
 * listLabeledIssues' own documented one-page cap (see github.ts). Falls back
 * to the requesting `owner`/`repo` when a returned item's own `repository`
 * is absent (same-repo blocker — the common case). */
async function listDependencyIssues(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  direction: "blocked_by" | "blocking",
): Promise<DependencyIssue[]> {
  const results = await githubRequest<GitHubDependencyApiItem[]>(
    token,
    owner,
    repo,
    "GET",
    `/issues/${issueNumber}/dependencies/${direction}?per_page=100`,
  );
  return results.map((item) => ({
    owner: item.repository?.owner?.login ?? owner,
    repo: item.repository?.name ?? repo,
    number: item.number,
    title: item.title,
    htmlUrl: item.html_url,
    state: item.state,
  }));
}

/** The issues blocking `issueNumber` from being worked — task-dependencies.ts's
 * refreshTaskBlockers filters this to `state === "open"` and stores the
 * result on the task row. */
export async function listBlockedByIssues(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<DependencyIssue[]> {
  return listDependencyIssues(token, owner, repo, issueNumber, "blocked_by");
}

/** The issues `issueNumber` itself blocks — used only by the "a blocker just
 * closed" webhook push (routes/webhooks.ts) to find which tracked tasks to
 * re-check immediately rather than waiting for the next poll. */
export async function listBlockingIssues(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<DependencyIssue[]> {
  return listDependencyIssues(token, owner, repo, issueNumber, "blocking");
}

export interface CreatePullRequestParams {
  title: string;
  head: string;
  base: string;
  body?: string;
  /** Opens the PR in draft state — used by task-promote.ts's
   * openDraftPRForTask (a task entering "reviewing" opens a draft so CI runs
   * and a human/review-agent can see the diff before approve). Omitted
   * (falsy) for approve's own fallback create path, which opens a
   * ready-for-review PR directly since there's nothing left to wait on. */
  draft?: boolean;
}

/** Used by 6.7's task -> PR promotion (createSessionRecord/git-push.ts's
 * caller) — included here now since it's the same write-client shape as
 * every other operation in this file, not because this PR creates PRs. */
export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  params: CreatePullRequestParams,
): Promise<{ number: number; htmlUrl: string; nodeId: string }> {
  const result = await githubRequest<{ number: number; html_url: string; node_id: string }>(
    token,
    owner,
    repo,
    "POST",
    `/pulls`,
    {
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body,
      draft: params.draft,
    },
  );
  return { number: result.number, htmlUrl: result.html_url, nodeId: result.node_id };
}

/**
 * Looks a PR up by number — used to resolve its GraphQL node id (REST
 * doesn't expose a `draft` -> ready-for-review transition; see
 * markPullRequestReadyForReview below) when all a caller has on hand is the
 * `pr_number` recorded on a task row, not the id from the create response
 * that minted it (approve can run in a fresh process from whichever
 * `-> reviewing` transition opened the draft).
 *
 * `headSha` was already on the wire and previously discarded — added for
 * `createPullRequestReview` below, which needs the exact commit its
 * `comments[]` anchors bind to.
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

/**
 * Squash-merges a PR — `PUT /pulls/:number/merge`. Used only by the
 * merge-on-approve sweep (`processMergeRequests`, task-reconciler.ts), which
 * only ever calls this once `getPullRequestByNumber`'s `mergeableState` reads
 * `"clean"`.
 *
 * `sha` should be the head SHA just read via `getPullRequestByNumber` — GitHub
 * rejects the merge with a 409 if the branch moved since, rather than
 * silently merging a commit nobody has reviewed/CI'd. `commitTitle` is passed
 * explicitly (not left to the repo's own `squash_merge_commit_title`
 * setting) so the resulting `main` commit message is deterministic regardless
 * of repo config — see docs/tasks.md's note on task PR titles not being
 * Conventional-Commits-prefixed.
 *
 * `405` ("Pull Request is not mergeable") and `409` (the head-SHA mismatch
 * above) are BOTH ordinary, expected, retryable outcomes here — a PR whose
 * mergeability changed between the read and this call, or a push racing the
 * merge — not alarms. Callers should inspect `err.statusCode`
 * (`GitHubApiError`'s own field) rather than treating every failure as a
 * write-scope problem; only 403/404 route to `GitHubWriteScopeError` (see
 * `githubRequest`'s own doc comment).
 */
export async function mergePullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
  opts: { sha: string; commitTitle: string },
): Promise<{ merged: boolean; sha: string }> {
  const result = await githubRequest<{ merged: boolean; sha: string }>(
    token,
    owner,
    repo,
    "PUT",
    `/pulls/${number}/merge`,
    { merge_method: "squash", sha: opts.sha, commit_title: opts.commitTitle },
  );
  return { merged: result.merged, sha: result.sha };
}

/**
 * Updates a PR's branch against its base — `PUT /pulls/:number/update-branch`,
 * the API behind GitHub's "Update branch" button. Needed because native
 * auto-merge does NOT do this under `strict: true` branch protection (GitHub
 * merges only once the branch is already up to date; it never updates it for
 * you), and this repo's `allow_auto_merge` is `false` regardless.
 *
 * `expectedHeadSha` guards against updating a branch that moved again since
 * the caller last read it — same 422/409-on-mismatch posture as `mergePullRequest`.
 * The merge-on-approve sweep calls this only on `mergeableState === "behind"`,
 * then waits for the next tick rather than attempting the merge in the same
 * pass — checks must re-run against the new head first.
 */
export async function updatePullRequestBranch(
  token: string,
  owner: string,
  repo: string,
  number: number,
  expectedHeadSha: string,
): Promise<void> {
  await githubRequest(token, owner, repo, "PUT", `/pulls/${number}/update-branch`, {
    expected_head_sha: expectedHeadSha,
  });
}

/**
 * Deletes a remote branch ref — `DELETE /git/refs/heads/:branch`. Needed
 * because this repo's `delete_branch_on_merge` is `false`, so a successful
 * squash-merge otherwise leaves the branch behind forever. Safe ONLY on the
 * merge-sweep's `merged` path: `-> failed` deliberately preserves a task's
 * branch for Retry to resume (docs/tasks.md's Worktree lifecycle section),
 * but that path never reaches here — this only runs after a real, successful
 * merge, which has no Retry path to protect. Best-effort from the caller's
 * point of view: a 404 (already deleted, e.g. by someone clicking GitHub's
 * own post-merge "Delete branch" button) is already the desired end state,
 * so it's swallowed as a no-op — same `removeLabel`-precedent posture above.
 * `githubRequest` routes a non-GET 404 to `GitHubWriteScopeError` (not the
 * base `GitHubApiError`), so that's what's caught here; any other failure,
 * including a real 403 scope problem, still throws.
 */
export async function deleteRemoteBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  try {
    await githubRequest(
      token,
      owner,
      repo,
      "DELETE",
      `/git/refs/heads/${encodeURIComponent(branch)}`,
    );
  } catch (err) {
    if (err instanceof GitHubWriteScopeError && err.statusCode === 404) return;
    throw err;
  }
}

/**
 * A single anchored review comment, GitHub's own `path`/`line`/`side` shape
 * — mirrors `task-prompt.ts`'s `ReviewFinding` so `task-github-sync.ts` can
 * pass findings straight through with no reshaping.
 */
export interface ReviewCommentParams {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: string;
}

/**
 * Posts the review agent's findings as an actual PR review (`POST
 * /pulls/:n/reviews`) instead of an ordinary issue comment — gives Task
 * Master's review a place in the Reviews timeline with real inline anchored
 * comments, not prose citing `file:42` in a conversation comment.
 *
 * `event` defaults to `"COMMENT"` — the only value valid for the identity
 * that authored the PR. The PR this posts to is normally opened by this same
 * GitHub App installation (`task-promote.ts`'s `openDraftPRForTask`), and
 * GitHub rejects both `APPROVE` and `REQUEST_CHANGES` from a PR's own author
 * with a 422. A gating event is only ever valid with a token from a
 * genuinely different identity — `resolveReviewerToken`
 * (`github-integration.ts`, #737) — never with the primary token this
 * function is normally called with. Passing a gating event with the wrong
 * token is exactly the bug this default guards against; it isn't caught
 * here (this function has no way to know which identity `token`
 * authenticates as), so get it from the right caller
 * (`task-github-sync.ts`'s `postReviewFindingsComment`), not by threading a
 * gating event through some other call site.
 *
 * `commitId` should be the PR's current head SHA (`getPullRequestByNumber`'s
 * `headSha`) — GitHub anchors `comments[].line` against that specific
 * commit's diff, not "whatever HEAD is when this call lands."
 */
export async function createPullRequestReview(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  params: {
    body: string;
    commitId: string;
    comments?: ReviewCommentParams[];
    event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  },
): Promise<{ id: number; htmlUrl: string }> {
  const result = await githubRequest<{ id: number; html_url: string }>(
    token,
    owner,
    repo,
    "POST",
    `/pulls/${pullNumber}/reviews`,
    {
      body: params.body,
      commit_id: params.commitId,
      event: params.event ?? "COMMENT",
      // Hermes review, PR #738: an empty `comments` array (not `undefined`)
      // survives JSON.stringify and GitHub 422s a review whose `comments`
      // key is present but empty — this caller's own contract guards it
      // today (task-github-sync.ts never passes an empty array), but this
      // makes it safe for a future one that might.
      comments:
        params.comments && params.comments.length > 0
          ? params.comments.map((c) => ({
              path: c.path,
              line: c.line,
              // Omitted (not defaulted) when the caller doesn't set it —
              // GitHub's own default is "RIGHT", so there's no case where
              // guessing here does anything a bare omission wouldn't.
              side: c.side,
              body: c.body,
            }))
          : undefined,
    },
  );
  return { id: result.id, htmlUrl: result.html_url };
}

/**
 * #737 — GitHub's own aggregate verdict for a PR's reviews, GraphQL-only
 * (REST has no equivalent field). Used by `attemptMerge`'s `"blocked"` arm
 * (`task-reconciler.ts`) to tell a merge blocked on a missing/stale required
 * approval apart from one blocked on a red required status check — both
 * otherwise collapse into the same `mergeable_state: "blocked"` — and, from
 * the same call site, to decide whether the reviewer identity needs to
 * re-assert an approval a later push (an auto-rebase, a "branch is behind"
 * update) may have dismissed. `null` covers a repo with no review
 * requirement configured at all, where GitHub reports no decision rather
 * than `"REVIEW_REQUIRED"`.
 */
export async function getPullRequestReviewDecision(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<"APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null> {
  const data = await githubGraphQL<{
    repository: { pullRequest: { reviewDecision: string | null } | null } | null;
  }>(
    token,
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) { reviewDecision }
      }
    }`,
    { owner, repo, number },
  );
  const decision = data.repository?.pullRequest?.reviewDecision ?? null;
  if (
    decision === "APPROVED" ||
    decision === "CHANGES_REQUESTED" ||
    decision === "REVIEW_REQUIRED"
  ) {
    return decision;
  }
  return null;
}

/**
 * Closes a PR without merging — used to clean up a draft PR opened at
 * "-> reviewing" when the task is subsequently given up on rather than
 * approved (task-promote.ts's closeDraftPRForTask). The same PATCH
 * .../pulls/:number endpoint issues/PRs both share, just with `state` in
 * place of the issue-close endpoint's identical-looking PATCH — kept
 * separate from closeIssue above since a PR is not an issue number in the
 * same numbering-shares-a-namespace sense this file otherwise never has to
 * think about (GitHub's issue and PR numbers share one counter per repo,
 * but the two PATCH endpoints are genuinely different resources).
 */
export async function closePullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<void> {
  await githubRequest(token, owner, repo, "PATCH", `/pulls/${number}`, { state: "closed" });
}

/**
 * #782 — re-syncs an already-open PR's title to `tasks.prTitle` (`#761`'s
 * Conventional Commits title). The same shared `PATCH .../pulls/:number`
 * endpoint `closePullRequest` above already uses, just with `title` in
 * place of `state` — REST's PATCH has no `draft` field (see
 * `markPullRequestReadyForReview`'s own doc comment below for why THAT
 * needs GraphQL instead), but `title` is plainly in scope for it. Callers
 * are expected to compare against the PR's current title first and skip
 * the call when unchanged — this function itself doesn't check, since one
 * caller (`openDraftPRForTask`'s already-open re-entry) has no live title
 * in hand to compare against without an extra fetch.
 */
export async function updatePullRequestTitle(
  token: string,
  owner: string,
  repo: string,
  number: number,
  title: string,
): Promise<void> {
  await githubRequest(token, owner, repo, "PATCH", `/pulls/${number}`, { title });
}

/**
 * Minimal GraphQL POST — this repo's first GraphQL call (every other write
 * in this file is REST). Needed because REST's `PATCH /pulls/:number` has
 * no `draft` field: converting a draft PR to ready-for-review is
 * GraphQL-only (`markPullRequestReadyForReview`). Also used by
 * `fetchPullRequestReviewThreads` below (#757) — resolved/unresolved thread
 * state has no REST equivalent either. Deliberately not a general-purpose
 * client library, just a shared low-level POST both callers build their own
 * query/variables against, with the same error-shape posture
 * (`GitHubWriteScopeError` on 403/404, `GitHubApiError` otherwise) as every
 * REST helper in this file so a caller can handle both uniformly.
 */
async function githubGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await githubApiFetch("/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    // #759 — same classify-before-scope-error ordering as githubRequest
    // above. githubApiFetch already recorded this into the shared budget;
    // this call site still needs to throw its own typed error rather than
    // falling into the write-scope branch below.
    const rateLimit = classifyRateLimit(res);
    if (rateLimit) throw rateLimit;
    if (res.status === 403 || res.status === 404) {
      throw new GitHubWriteScopeError(
        `GitHub rejected this write (HTTP ${res.status}) — the connected token likely lacks write access. ${responseBody}`.trim(),
        res.status,
      );
    }
    throw new GitHubApiError(
      `GitHub GraphQL API error (HTTP ${res.status}): ${responseBody}`,
      res.status,
    );
  }

  // GraphQL's own error-signaling convention: a 200 response can still
  // carry an `errors` array (e.g. a permission error scoped to one field) —
  // unlike REST, a non-2xx status isn't the only failure signal.
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors && json.errors.length > 0) {
    throw new GitHubApiError(
      `GitHub GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
      res.status,
    );
  }
  if (json.data === undefined) {
    throw new GitHubApiError("GitHub GraphQL response had no data", res.status);
  }
  return json.data;
}

/**
 * Converts a draft PR to ready-for-review — GraphQL-only, see
 * githubGraphQL's own doc comment. Takes the PR's GraphQL node id (from
 * createPullRequest/getPullRequestByNumber's own `nodeId`), not its REST
 * number.
 */
export async function markPullRequestReadyForReview(
  token: string,
  pullRequestNodeId: string,
): Promise<void> {
  await githubGraphQL<{ markPullRequestReadyForReview: { pullRequest: { id: string } } }>(
    token,
    `mutation($id: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $id }) {
        pullRequest { id }
      }
    }`,
    { id: pullRequestNodeId },
  );
}

export interface PrReviewThreadComment {
  /** Null for a deleted/ghost account — GitHub itself allows this. */
  author: string | null;
  createdAt: string;
  /** Null on rare malformed data only — a real inline review comment always
   * has one; not worth a runtime guard for a case the schema doesn't
   * actually produce. */
  path: string | null;
  line: number | null;
  body: string;
}

export interface PrReviewThread {
  /** GraphQL node id — the argument `resolveReviewThread` below needs. Not
   * a REST comment id and not interchangeable with one. */
  id: string;
  isResolved: boolean;
  comments: PrReviewThreadComment[];
}

export interface PrReviewThreadsResult {
  /** The login of whichever identity `token` authenticates as, normalized
   * (see `stripBotSuffix`) to match `author.login` on that same account's
   * own posted content — a human login for a PAT fallback. NOT the same as
   * "Mullion's own comments": since #737/#827 a gating review round posts
   * from a SECOND, distinct identity (the reviewer App), which this token's
   * own login does not cover. Callers filtering out Mullion's own posts must
   * check against `resolveMullionReviewLogins` (github-integration.ts), not
   * this field alone. */
  viewerLogin: string | null;
  threads: PrReviewThread[];
  /** True when either page's `first` bound didn't cover every thread/comment
   * GitHub actually has — this function has no logger of its own (matching
   * every other helper in this file), so the caller decides whether/how to
   * surface it rather than this silently dropping the overflow. */
  truncated: boolean;
}

const REVIEW_THREADS_PAGE_SIZE = 100;
const REVIEW_THREAD_COMMENTS_PAGE_SIZE = 50;

/**
 * GitHub's `viewer { login }` field appends a `[bot]` suffix for a GitHub
 * App installation token's synthetic viewer identity, but the SAME account's
 * `author { login }` on content it actually posts (a review, a comment) does
 * not carry that suffix — confirmed live, 2026-08-27: an installed reviewer
 * App's `viewer.login` read `"mullion-reviewer[bot]"` while that exact App's
 * own posted review's `author.login` on the same PR read `"mullion-reviewer"`.
 * Every comparison in this file (and `resolveMullionReviewLogins`,
 * github-integration.ts) between a viewer-derived login and an
 * author-derived login needs this normalization, or the two never match
 * despite being the same account — which is exactly what let a reviewer
 * App's own unresolved review threads get re-ingested as human feedback and
 * never auto-resolved (D0/D1, #833/#834) even after those fixes landed.
 */
const BOT_SUFFIX = "[bot]";
function stripBotSuffix(login: string): string {
  return login.endsWith(BOT_SUFFIX) ? login.slice(0, -BOT_SUFFIX.length) : login;
}

/**
 * #757 — resolved-vs-unresolved review thread state, REST has no equivalent
 * for. `first`-bounded on both connections (a task PR is small and
 * short-lived; full cursor pagination would be a lot of machinery for a
 * case this workflow doesn't produce) — logs a warning rather than silently
 * truncating if either count is ever actually hit, so a future PR with more
 * comments than fit here has a signal something was dropped instead of a
 * silently incomplete auto-return.
 */
export async function fetchPullRequestReviewThreads(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<PrReviewThreadsResult> {
  const data = await githubGraphQL<{
    viewer: { login: string } | null;
    repository: {
      pullRequest: {
        reviewThreads: {
          totalCount: number;
          nodes: Array<{
            id: string;
            isResolved: boolean;
            comments: {
              totalCount: number;
              nodes: Array<{
                author: { login: string } | null;
                createdAt: string;
                path: string | null;
                line: number | null;
                body: string;
              }>;
            };
          }>;
        } | null;
      } | null;
    } | null;
  }>(
    token,
    `query($owner: String!, $repo: String!, $number: Int!, $threadsFirst: Int!, $commentsFirst: Int!) {
      viewer { login }
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: $threadsFirst) {
            totalCount
            nodes {
              id
              isResolved
              comments(first: $commentsFirst) {
                totalCount
                nodes {
                  author { login }
                  createdAt
                  path
                  line
                  body
                }
              }
            }
          }
        }
      }
    }`,
    {
      owner,
      repo,
      number,
      threadsFirst: REVIEW_THREADS_PAGE_SIZE,
      commentsFirst: REVIEW_THREAD_COMMENTS_PAGE_SIZE,
    },
  );

  const reviewThreads = data.repository?.pullRequest?.reviewThreads;
  if (!reviewThreads)
    return {
      viewerLogin: data.viewer?.login ? stripBotSuffix(data.viewer.login) : null,
      threads: [],
      truncated: false,
    };

  const truncated =
    reviewThreads.totalCount > reviewThreads.nodes.length ||
    reviewThreads.nodes.some((t) => t.comments.totalCount > t.comments.nodes.length);

  return {
    viewerLogin: data.viewer?.login ? stripBotSuffix(data.viewer.login) : null,
    threads: reviewThreads.nodes.map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      comments: t.comments.nodes.map((c) => ({
        author: c.author?.login ?? null,
        createdAt: c.createdAt,
        path: c.path,
        line: c.line,
        body: c.body,
      })),
    })),
    truncated,
  };
}

/**
 * D1 — marks a review thread resolved, closing the gap that left every
 * anchored review finding permanently blocking merge on any repo with
 * `required_conversation_resolution` enabled (this repo's own `main`
 * included): nothing in this codebase called GitHub's thread-resolution
 * mutation before this. Modeled on `markPullRequestReadyForReview` above —
 * same minimal-GraphQL-mutation shape, same "no PR node id needed, just the
 * thread's own" scoping.
 *
 * Callers MUST bound which threads they resolve — see
 * `resolveMullionOwnThreadsIfClean` (task-reconciler.ts) for the actual
 * policy. This function itself does no authorization check of its own; it
 * resolves whatever thread id it's given, same posture as every other
 * write in this file (the caller decides what's safe to call it with, this
 * just executes the call).
 */
export async function resolveReviewThread(token: string, threadId: string): Promise<void> {
  await githubGraphQL<{ resolveReviewThread: { thread: { id: string } } }>(
    token,
    `mutation($id: ID!) {
      resolveReviewThread(input: { threadId: $id }) {
        thread { id }
      }
    }`,
    { id: threadId },
  );
}

/**
 * The login `token` authenticates as, normalized to match `author.login` on
 * that same account's own posted content (see `stripBotSuffix` above) — a
 * PAT/OAuth token resolves to the human account it belongs to; a GitHub App
 * installation token's raw `viewer.login` carries a `[bot]` suffix its
 * authored comments/reviews don't. Used to build the set of logins Mullion's
 * own review posts can appear under (`resolveMullionReviewLogins`,
 * github-integration.ts) when a caller already has a token in hand and just
 * needs its identity, without the cost of a full
 * `fetchPullRequestReviewThreads` call.
 */
export async function fetchViewerLogin(token: string): Promise<string | null> {
  const data = await githubGraphQL<{ viewer: { login: string } | null }>(
    token,
    `query { viewer { login } }`,
    {},
  );
  return data.viewer?.login ? stripBotSuffix(data.viewer.login) : null;
}

/**
 * #486 — resolves an existing PR for a branch, so a `createPullRequest` 422
 * ("A pull request already exists for owner:branch," GitHub's error when a
 * previous approve attempt already pushed and created a PR but crashed
 * before that got recorded — see task-promote.ts's own doc comment) can be
 * resolved to the real PR instead of surfaced as a generic failure. `head`
 * must be `owner:branch` per GitHub's own `head` query-param format. Not
 * used on the happy path — only on this narrow 422 retry — so a GET here,
 * same read-only shape as getIssueState above.
 *
 * `state=open` deliberately, not `state=all` (Hermes review, PR #494): the
 * 422 this resolves means an OPEN PR currently exists for this head — a
 * closed/merged PR from the same branch name reused after that PR's own
 * lifecycle ended would otherwise be matched first (GitHub returns newest
 * first within a state, but doesn't rank open above closed), resolving
 * promotion to a dead URL. Branch names are unique per task today, making
 * that reuse unreachable, but scoping to `open` is strictly more correct
 * regardless. `sort=created&direction=desc` makes that "newest first"
 * reliance explicit rather than resting on the API's undocumented default
 * (Hermes review, PR #497) — `[first]` below is only correct because of
 * this ordering.
 */
export async function findPullRequestByHead(
  token: string,
  owner: string,
  repo: string,
  head: string,
): Promise<{
  number: number;
  htmlUrl: string;
  nodeId: string;
  draft: boolean;
  title: string;
} | null> {
  const results = await githubRequest<
    Array<{ number: number; html_url: string; node_id: string; draft: boolean; title: string }>
  >(
    token,
    owner,
    repo,
    "GET",
    `/pulls?head=${encodeURIComponent(head)}&state=open&sort=created&direction=desc`,
  );
  const [first] = results;
  return first
    ? {
        number: first.number,
        htmlUrl: first.html_url,
        nodeId: first.node_id,
        draft: first.draft,
        title: first.title,
      }
    : null;
}

// #744 — release-please detection/trigger/merge. `release-please--branches--`
// is release-please-action's own fixed branch-name prefix (verified against
// PR #803/#801/#807 in this repo — head `release-please--branches--main--
// components--mullion-session-manager`); a release PR is identified by that
// prefix, never by title text, which a repo/human could edit.
export const RELEASE_PLEASE_BRANCH_PREFIX = "release-please--branches--";

/**
 * Candidate workflow-file basenames release-please-action commonly ships
 * under — mirrors `COMPOSE_DEFAULT_FILENAMES`'s candidate-list-of-known-names
 * shape (docker-service-detect.ts), the closest existing precedent for "does
 * this repo have X configured" in this codebase. Unlike that probe, this one
 * can't be a local `existsSync` (a project may be remote-hosted, and this
 * repo has no GitHub contents-API client at all — see the #744 plan) — GitHub
 * Actions is the only source of truth for "is there a dispatchable workflow"
 * anyway, since that's also where the workflow id dispatch needs comes from.
 *
 * Deliberately narrow — `release-please.yml`/`.yaml` only, NOT the more
 * generic `release.yml`/`.yaml` a first draft of this list included.
 * `release.yml` is one of the most common workflow filenames for something
 * that has nothing to do with release-please (goreleaser, semantic-release,
 * an `npm publish` job) — matching it would make the Run button dispatch an
 * arbitrary, unrelated, outward-facing workflow under a label that says
 * "release-please." A false negative here (a release-please repo that named
 * its file something else) just hides the section; a false positive
 * publishes something. The asymmetry is why this stays narrow rather than
 * permissive.
 *
 * #1033 — content fallback: a file whose basename isn't in this list can still
 * be a release-please workflow if its body references `release-please-action`
 * (the npm action google-github-actions/release-please-action runs) OR the
 * org-level reusable workflow `s3ntin3l8/.github/.github/workflows/release-please`.
 * Both checks are deliberately case-sensitive on the package name — false
 * positives here ship a workflow under the wrong label, so we accept that a
 * release-please repo that capitalizes differently slips through to
 * not-configured rather than risk a non-release-please `release.yml` ever
 * matching.
 */
const RELEASE_WORKFLOW_FILENAMES = ["release-please.yml", "release-please.yaml"];
const RELEASE_PLEASE_ACTION_REFERENCE = "release-please-action";
const RELEASE_PLEASE_REUSABLE_REFERENCE = "s3ntin3l8/.github/.github/workflows/release-please";

export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
}

/**
 * Lists a repo's Actions workflows — `GET /actions/workflows`. Used to
 * detect a release-please workflow (matching `path`'s basename against
 * RELEASE_WORKFLOW_FILENAMES) and to resolve the id `dispatchWorkflow` below
 * needs. Read-shaped (a GET, no side effect) but lives in this write-client
 * file rather than github.ts for cohesion with `dispatchWorkflow` — the two
 * are always used together and the "does this repo have workflow_dispatch
 * wired up" answer for one is meaningless without the other.
 */
export async function listWorkflows(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubWorkflow[]> {
  const result = await githubRequest<{
    workflows: Array<{ id: number; name: string; path: string }>;
  }>(token, owner, repo, "GET", "/actions/workflows?per_page=100");
  return result.workflows.map((w) => ({ id: w.id, name: w.name, path: w.path }));
}

/**
 * Finds the release-please workflow among a repo's Actions workflows, by
 * matching `path`'s basename (e.g. `.github/workflows/release-please.yml`)
 * against RELEASE_WORKFLOW_FILENAMES. Exported separately from
 * `listWorkflows` so callers needing only "is this a release-please repo"
 * don't have to duplicate the matching logic.
 */
export function findReleasePleaseWorkflow(workflows: GitHubWorkflow[]): GitHubWorkflow | null {
  return (
    workflows.find((w) => {
      const basename = w.path.split("/").pop();
      return basename !== undefined && RELEASE_WORKFLOW_FILENAMES.includes(basename);
    }) ?? null
  );
}

/**
 * #1033 — content fallback for filename misses. Fetches the raw bytes of a
 * workflow file at `workflow.path` via `GET /repos/{o}/{r}/contents/{path}`
 * and returns the decoded body, or null on any failure (404 on a missing
 * file, a contents-API 403 that means the token can list workflows but not
 * read their bytes, or a malformed response).
 *
 * Returns null rather than throwing because a content-fetch failure must NOT
 * collapse a whole `detectReleaseWorkflow` probe into an error — a repo whose
 * release-please workflow file we can't read just falls through to
 * not-configured, same shape as a workflow we read and didn't recognize.
 * Throwing would propagate to the route layer as a generic 5xx and hide the
 * Release section for every project sharing the rate-limit budget (the same
 * shape #759 exists to prevent), not what we want for a best-effort
 * widening.
 *
 * Note: GitHub returns content base64-encoded with line breaks; this helper
 * tolerates either. `Buffer.from(content, "base64")` decodes both
 * whitespace-stripped and raw-with-newlines forms correctly.
 */
async function fetchWorkflowBody(
  token: string,
  owner: string,
  repo: string,
  workflow: GitHubWorkflow,
): Promise<string | null> {
  try {
    const result = await githubRequest<{ content?: string; encoding?: string }>(
      token,
      owner,
      repo,
      "GET",
      `/contents/${workflow.path.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (result.encoding !== "base64" || typeof result.content !== "string") return null;
    return Buffer.from(result.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * #1033 — content-level release-please detection for workflows whose
 * basename isn't in RELEASE_WORKFLOW_FILENAMES. Returns the first workflow
 * whose body references `release-please-action` (the npm package name;
 * case-sensitive to preserve the false-positive-avoidance invariant) OR the
 * org-level reusable workflow `s3ntin3l8/.github/.github/workflows/release-please`.
 *
 * Substring match rather than regex — a full regex over the package name
 * doesn't add precision here, the references are unambiguous GitHub Actions
 * `uses:` syntax (`uses: googleapis/release-please-action@v4`,
 * `uses: s3ntin3l8/.github/.github/workflows/release-please.yml@main`), and a
 * simpler check keeps the false-positive reasoning easy to audit.
 */
function isReleasePleaseBody(body: string): boolean {
  return (
    body.includes(RELEASE_PLEASE_ACTION_REFERENCE) ||
    body.includes(RELEASE_PLEASE_REUSABLE_REFERENCE)
  );
}

/**
 * #1033 — content fallback for filename misses. Walks every workflow file
 * GitHub returned that wasn't already filename-matched, fetches its body,
 * and returns the first one whose body matches `isReleasePleaseBody`. Fetches
 * sequentially rather than `Promise.all` so a partial failure (one file's
 * contents endpoint 404s because the file was just deleted) doesn't fan out
 * N requests against the shared rate-limit budget — same rationale as
 * github.ts's `getPRsStatus`, which also serializes. The result is amortized
 * by the 60-min cache in `detectReleaseWorkflow` anyway.
 */
async function findReleasePleaseWorkflowByContent(
  token: string,
  owner: string,
  repo: string,
  workflows: GitHubWorkflow[],
): Promise<GitHubWorkflow | null> {
  for (const workflow of workflows) {
    const basename = workflow.path.split("/").pop();
    if (basename === undefined) continue;
    if (RELEASE_WORKFLOW_FILENAMES.includes(basename)) continue;
    const body = await fetchWorkflowBody(token, owner, repo, workflow);
    if (body !== null && isReleasePleaseBody(body)) return workflow;
  }
  return null;
}

interface ReleaseWorkflowCacheEntry {
  result: ReleaseDetectionResult;
  expiresAt: number;
}
const releaseWorkflowCache = new Map<string, ReleaseWorkflowCacheEntry>();
// The release workflow's id never changes, but the frontend keys its GET
// .../release call on `prsRefreshTrigger`, which bumps on every /ws/github
// frame (pr, issue, ci, release, push — store/slices/github.ts) — without a
// cache, an active repo would spend a live `listWorkflows` call per frame
// against the process-wide rate-limit budget `github-fetch.ts` shares with
// the PR poller. Same TTL/"only successes cached" posture as
// fetchRequiredStatusContexts (github.ts).
const RELEASE_WORKFLOW_CACHE_TTL_MS = 60 * 60_000;

/**
 * Detects whether a repo has a release-please workflow, distinguishing "not
 * configured" (the token could list workflows; none matched) from
 * "no-actions-scope" (the list call itself was rejected — a PAT without
 * `Actions: read` is an explicitly supported configuration, not an error;
 * see docs/github-integration.md). Only a `"found"`/`"not-configured"`
 * result is cached — a scope failure isn't, in case the connected token is
 * fixed later, matching fetchRequiredStatusContexts's "only successes
 * cached" precedent.
 */
export async function detectReleaseWorkflow(
  token: string,
  owner: string,
  repo: string,
): Promise<ReleaseDetectionResult> {
  const key = `${owner}/${repo}`;
  const cached = releaseWorkflowCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  let result: ReleaseDetectionResult;
  try {
    const workflows = await listWorkflows(token, owner, repo);
    let workflow = findReleasePleaseWorkflow(workflows);
    // #1033 — filename-list misses are common in practice (release.yml, or a
    // ci.yml that delegates to the org-level reusable workflow); fall back
    // to a content probe so those repos don't silently lose the Run button.
    // findReleasePleaseWorkflowByContent is sequential-by-design and bounded
    // by the number of workflows in the repo, all of which are amortized by
    // the 60-min cache below.
    workflow ??= await findReleasePleaseWorkflowByContent(token, owner, repo, workflows);
    result = workflow ? { kind: "found", workflow } : { kind: "not-configured" };
  } catch (err) {
    // Narrowed to GitHubWriteScopeError specifically, NOT the base
    // GitHubApiError — GitHubRateLimitError also extends GitHubApiError
    // (github-fetch.ts), and #759's whole point is that a rate-limited 403
    // must never be reported as "the token lacks scope" (githubRequest's
    // own doc comment). A rate limit — or a network failure, a 5xx, any
    // other non-scope error — rethrows here and is the GET route's problem
    // to surface (it already catches GitHubApiError), not silently
    // relabeled as "no-actions-scope" and hidden.
    if (!(err instanceof GitHubWriteScopeError)) throw err;
    return { kind: "no-actions-scope" };
  }

  releaseWorkflowCache.set(key, { result, expiresAt: Date.now() + RELEASE_WORKFLOW_CACHE_TTL_MS });
  return result;
}

// Test-only: clears the module-scope cache above so one test's cached
// detection result can't leak into another's assertions.
export function clearReleaseWorkflowCacheForTests(): void {
  releaseWorkflowCache.clear();
}

/**
 * Dispatches a workflow run — `POST /actions/workflows/:id/dispatches`,
 * always 204 with no body (GitHub gives no run id back; a caller wanting to
 * link to the resulting run has to poll
 * `GET /actions/workflows/:id/runs?event=workflow_dispatch` and match on
 * `created_at` after this call, not implemented here).
 *
 * `ref` must be a branch/tag the workflow file already exists on — dispatch
 * fails with 404 for an unknown ref (github.ts's `default_branch`, from
 * `GET /repos/{o}/{r}`, is what release-please callers should pass; never
 * assume `main`, same reasoning as `getPullRequestByNumber`'s `baseRef`).
 *
 * A workflow whose file has no `workflow_dispatch:` trigger 422s with
 * "Workflow does not have 'workflow_dispatch' trigger" — surfaced as a plain
 * `GitHubApiError` (not `GitHubWriteScopeError`; this isn't a permission
 * problem), so callers can map it to "this repo's release workflow isn't
 * wired up for manual runs" rather than a generic failure or a scope
 * misdiagnosis. Needs a token minted with `actions: write`
 * (github-app.ts's DISPATCH_PERMISSIONS) — neither WRITE_PERMISSIONS nor
 * READ_PERMISSIONS grants it.
 */
export async function dispatchWorkflow(
  token: string,
  owner: string,
  repo: string,
  workflowId: number,
  ref: string,
): Promise<void> {
  await githubRequest(token, owner, repo, "POST", `/actions/workflows/${workflowId}/dispatches`, {
    ref,
  });
}

export interface ReleasePullRequestSummary {
  number: number;
  htmlUrl: string;
  headRef: string;
  title: string;
}

/**
 * Finds the release-please PR for `base` (the repo's default branch),
 * identified by its head branch's fixed `release-please--branches--<base>`
 * prefix — release-please-action's own naming, not something a title-text
 * match could rely on (a human/bot can retitle a PR; release-please doesn't
 * rename its own branch). `sort=created&direction=desc` mirrors
 * `findPullRequestByHead`'s own reasoning above: release-please closes/
 * reopens rather than reusing a stale closed PR, so taking the newest by
 * creation date is always the current one for this repo's release cycle,
 * regardless of `state`.
 *
 * `state` defaults to `"open"` — every caller wanting "the release PR a
 * human can act on right now" (the GitHub panel's own Release section,
 * `getCachedReleasePullRequestStatus` below) wants exactly that, and
 * scoping to `open` there is strictly more correct: a closed one from a
 * skipped/out-of-band cycle isn't something to show as pending.
 * `resolveReleaseMerge` (release-merge.ts) passes `"all"` explicitly for
 * its own fallback check — see that file's own doc comment on why.
 */
export async function findReleasePullRequest(
  token: string,
  owner: string,
  repo: string,
  base: string,
  state: "open" | "all" = "open",
): Promise<ReleasePullRequestSummary | null> {
  const results = await githubRequest<
    Array<{ number: number; html_url: string; head: { ref: string }; title: string }>
  >(
    token,
    owner,
    repo,
    "GET",
    `/pulls?state=${state}&base=${encodeURIComponent(base)}&sort=created&direction=desc`,
  );
  const match = results.find((pr) => pr.head.ref.startsWith(RELEASE_PLEASE_BRANCH_PREFIX));
  return match
    ? {
        number: match.number,
        htmlUrl: match.html_url,
        headRef: match.head.ref,
        title: match.title,
      }
    : null;
}

interface ReleasePrCacheEntry {
  pr: ReleasePullRequestStatus | null;
  expiresAt: number;
}
const releasePrCache = new Map<string, ReleasePrCacheEntry>();
// Same TTL as getRepoStatus's own CACHE_TTL_MS (github.ts) — this is the
// same "glance-level widget, not a live feed" tradeoff. Without this, GET
// .../release costs THREE live calls (getDefaultBranch, findReleasePullRequest,
// getPullRequestByNumber) every time the frontend refetches — and it refetches
// on every /ws/github frame (pr, issue, ci, push, release —
// store/slices/github.ts's prsRefreshTrigger), not just release-relevant
// ones. An active repo's webhook traffic would otherwise spend three calls
// per frame against the process-wide rate-limit budget (github-fetch.ts)
// the PR poller and every Task Master write share — degrading features
// well outside this one panel section.
const RELEASE_PR_CACHE_TTL_MS = 60_000;

/**
 * Assembles the open release PR's status (or `null`) for `owner/repo`,
 * cached for `RELEASE_PR_CACHE_TTL_MS` — the read path behind GET
 * .../release. Resolves the default branch, finds the release-please PR
 * against it, reads its full mergeability, and merges in `ciStatus` from
 * the PR poller's own warm cache (github.ts's `getPRsStatus`) when present
 * — never a live Actions-runs call of its own, same posture as
 * `/github/prs`.
 *
 * `invalidateReleaseCache` below lets a route drop the cache immediately
 * after an action it just took (a merge that just closed the PR) rather
 * than waiting out the TTL and showing stale state right after the user's
 * own click.
 */
export async function getCachedReleasePullRequestStatus(
  token: string,
  owner: string,
  repo: string,
): Promise<ReleasePullRequestStatus | null> {
  const key = `${owner}/${repo}`;
  const cached = releasePrCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.pr;

  const defaultBranch = await getDefaultBranch(token, owner, repo);
  const summary = await findReleasePullRequest(token, owner, repo, defaultBranch);

  let pr: ReleasePullRequestStatus | null = null;
  if (summary) {
    const full = await getPullRequestByNumber(token, owner, repo, summary.number);
    const cachedPrs = getPRsStatus(owner, repo);
    const ciMatch = cachedPrs?.prs.find((p) => p.number === full.number);
    pr = {
      number: full.number,
      htmlUrl: full.htmlUrl,
      title: full.title,
      headRef: full.headRef,
      headSha: full.headSha,
      draft: full.draft,
      mergeable: full.mergeable,
      mergeableState: full.mergeableState,
      ciStatus: ciMatch?.ciStatus ?? null,
    };
  }

  releasePrCache.set(key, { pr, expiresAt: Date.now() + RELEASE_PR_CACHE_TTL_MS });
  return pr;
}

/**
 * Drops the cached release PR status for `owner/repo` — called after a
 * successful `/release/run` (a new PR may appear shortly) or
 * `/release/merge` (the PR the cache was holding just closed), so the
 * user's own action is reflected on their very next fetch instead of
 * waiting out RELEASE_PR_CACHE_TTL_MS. Same role as github.ts's own
 * `invalidatePRsCache`.
 */
export function invalidateReleaseCache(owner: string, repo: string): void {
  releasePrCache.delete(`${owner}/${repo}`);
}

// Test-only: clears the module-scope cache above so one test's cached
// result can't leak into another's assertions.
export function clearReleasePrCacheForTests(): void {
  releasePrCache.clear();
}
