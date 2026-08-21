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

import { GitHubApiError, validateGitHubRepoRef } from "./github.js";
import {
  githubApiFetch,
  classifyRateLimit,
  recordGitHubRateLimit,
  isGitHubRateLimited,
  githubRateLimitRemainingMs,
  GitHubRateLimitError,
} from "./github-fetch.js";

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
  title: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
}> {
  const result = await githubRequest<{
    number: number;
    html_url: string;
    node_id: string;
    draft: boolean;
    head: { sha: string; ref: string };
    title: string;
    state: "open" | "closed";
    merged: boolean;
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
    title: result.title,
    state: result.state,
    merged: result.merged,
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
 * `event` is deliberately NOT a parameter: only `"COMMENT"` is ever valid
 * here. The PR this posts to was opened by this same GitHub App installation
 * (`task-promote.ts`'s `openDraftPRForTask`), and GitHub rejects both
 * `APPROVE` and `REQUEST_CHANGES` from a PR's own author with a 422 — so
 * this posts a comment-only review with no merge-gating state. Actually
 * gating merge on this review needs a second identity (a separate App or
 * PAT) — a materially bigger, deliberately deferred piece of work; see
 * https://github.com/s3ntin3l8/mullion-session-manager/issues/737.
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
  params: { body: string; commitId: string; comments?: ReviewCommentParams[] },
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
      event: "COMMENT",
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
 * Minimal GraphQL POST — this repo's first GraphQL call (every other write
 * in this file is REST). Needed because REST's `PATCH /pulls/:number` has
 * no `draft` field: converting a draft PR to ready-for-review is
 * GraphQL-only (`markPullRequestReadyForReview`). Deliberately not a
 * general-purpose client — one function, used by exactly one caller below,
 * with the same error-shape posture (`GitHubWriteScopeError` on 403/404,
 * `GitHubApiError` otherwise) as every REST helper in this file so a
 * caller can handle both uniformly.
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
): Promise<{ number: number; htmlUrl: string; nodeId: string; draft: boolean } | null> {
  const results = await githubRequest<
    Array<{ number: number; html_url: string; node_id: string; draft: boolean }>
  >(
    token,
    owner,
    repo,
    "GET",
    `/pulls?head=${encodeURIComponent(head)}&state=open&sort=created&direction=desc`,
  );
  const [first] = results;
  return first
    ? { number: first.number, htmlUrl: first.html_url, nodeId: first.node_id, draft: first.draft }
    : null;
}
