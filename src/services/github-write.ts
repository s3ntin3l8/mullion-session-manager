// The GitHub write client (Phase 6 Task Master, 6.4/#217) — the first write
// capability beyond registerHook/unregisterHook (github-webhook.ts).
//
// Everything here is the write API's own surface: labels, comments,
// assignees, issues, pull requests, reviews, and the check-run markers the
// review relay writes.
//
// The request path itself — `githubRequest()`, its rate-limit short-circuit,
// and the scope error it raises — lives in github-request.ts (issue #2405),
// shared with the release-please client. The release-please feature moved
// out to github-release.ts for the same reason, and the four hand-rolled
// pagination loops became one helper in github-pagination.ts. The symbols
// that moved are re-exported from here, so every importer that reaches for
// them through `github-write.js` — and this module's own test file — keeps
// working unchanged.

import { GitHubApiError, validateGitHubRepoRef } from "./github.js";
import { githubApiFetch, classifyRateLimit } from "./github-fetch.js";
import { GitHubWriteScopeError, githubRequest } from "./github-request.js";
import { fetchAllPages } from "./github-pagination.js";

// Re-exported rather than re-implemented: these now live in modules that
// sit BESIDE this one. github-release.ts needs the transport too, so
// importing it back from here would make the two modules import each
// other; re-exporting keeps `github-write.js` the single import site its
// existing callers already use.
export { GitHubWriteScopeError, githubRequest };
export { getPullRequestByNumber } from "./github-request.js";
export {
  RELEASE_PLEASE_BRANCH_PREFIX,
  listWorkflows,
  findReleasePleaseWorkflow,
  dispatchWorkflow,
  listHeldRuns,
  approveRun,
  findReleasePullRequest,
  detectReleaseWorkflow,
  invalidateReleaseWorkflowCache,
  clearReleaseWorkflowCacheForTests,
  getCachedReleasePullRequestStatus,
  invalidateReleaseCache,
  clearReleasePrCacheForTests,
} from "./github-release.js";
export type { GitHubWorkflow, ReleasePullRequestSummary } from "./github-release.js";

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

export interface IssueCommentSummary {
  author: string;
  authorIsBot: boolean;
  /** The comment's text, bounded (see `MAX_ISSUE_COMMENT_CHARS`). */
  body: string;
  /** True when `body` was cut short by the cap. */
  bodyTruncated: boolean;
  createdAt: string | null;
  htmlUrl?: string;
}

/**
 * How much of an issue comment is kept (issue #1629). A comment body is
 * user-controlled prose — the same bound the review body gets.
 */
export const MAX_ISSUE_COMMENT_CHARS = 4_000;

const ISSUE_COMMENTS_PAGE_SIZE = 100;
const ISSUE_COMMENTS_MAX_PAGES = 10;

/**
 * Comments on an issue, oldest first (issue #1629). The triage relay posts
 * its findings as an issue comment, so this is how "did the triage land?"
 * is answered — the issue-comment counterpart of
 * `listPullRequestReviews`. Read-only.
 *
 * `since` narrows the walk to comments updated after that moment: issue
 * threads are long (a busy issue can have hundreds), and the caller knows
 * the dispatch time it filters on anyway. Without it, every status poll
 * walked up to ten pages of comments.
 */
export async function listIssueComments(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  opts: { since?: string } = {},
): Promise<IssueCommentSummary[]> {
  const since = opts.since ? `&since=${encodeURIComponent(opts.since)}` : "";
  // Bare-array response: the endpoint answers with the comments themselves.
  const comments = await fetchAllPages(
    (page) =>
      githubRequest<
        Array<{
          user: { login: string; type: string } | null;
          body?: string | null;
          created_at: string | null;
          html_url?: string | null;
        }>
      >(
        token,
        owner,
        repo,
        "GET",
        `/issues/${issueNumber}/comments?per_page=${ISSUE_COMMENTS_PAGE_SIZE}${since}&page=${page}`,
      ),
    { maxPages: ISSUE_COMMENTS_MAX_PAGES, pageSize: ISSUE_COMMENTS_PAGE_SIZE },
  );
  return comments.map((c) => {
    const body = typeof c.body === "string" ? c.body : "";
    // truncateText cuts by code point and marks the cut with an ellipsis —
    // the same helper the review body uses (a plain slice would split a
    // surrogate pair).
    const truncated = [...body].length > MAX_ISSUE_COMMENT_CHARS;
    return {
      author: c.user?.login ?? "ghost",
      authorIsBot: c.user?.type === "Bot",
      body: truncated ? truncateText(body, MAX_ISSUE_COMMENT_CHARS) : body,
      bodyTruncated: truncated,
      createdAt: c.created_at,
      ...(typeof c.html_url === "string" ? { htmlUrl: c.html_url } : {}),
    };
  });
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
  /**
   * True when the number is a pull request, not an issue (issue #1629).
   *
   * GitHub answers `/issues/{n}` for a pull request too — with a
   * `pull_request` key it only reports for PRs. `getIssueState` did not
   * look at it, so a caller that took the answer at face value would treat
   * a PR as an issue (the same check github-issues.ts's own detail fetch
   * makes).
   */
  isPullRequest: boolean;
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
    pull_request?: unknown;
  }>(token, owner, repo, "GET", `/issues/${issueNumber}`);
  const labels = (result.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter((name): name is string => typeof name === "string");
  return { state: result.state, labels, isPullRequest: result.pull_request != null };
}

/**
 * The merged pull request that closed an issue, or `null` when none did
 * (closed as not planned, a duplicate, or by a PR that was closed unmerged).
 * GraphQL `closedByPullRequestsReferences` is what GitHub itself uses for the
 * "closed by" link, and it has no REST equivalent. Picks the first MERGED
 * reference; `includeClosedPrs` is needed because a merged PR is a closed one.
 * Throws on a GitHub error — the caller decides how to degrade.
 */
export async function getMergedClosingPullRequest(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ number: number; mergedAt: string | null } | null> {
  const data = await githubGraphQL<{
    repository: {
      issue: {
        closedByPullRequestsReferences: {
          nodes: Array<{ number: number; merged: boolean; mergedAt: string | null }>;
        } | null;
      } | null;
    } | null;
  }>(
    token,
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
            nodes { number merged mergedAt }
          }
        }
      }
    }`,
    { owner, repo, number: issueNumber },
  );
  const hit = data.repository?.issue?.closedByPullRequestsReferences?.nodes.find((n) => n.merged);
  return hit ? { number: hit.number, mergedAt: hit.mergedAt } : null;
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
 * of repo config — see docs/tasks-internals.md's note on task PR titles not being
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
 * Omitted (the sidebar's review box, which posts no inline comments, may not
 * know a head), GitHub reviews the PR's current head.
 */
export async function createPullRequestReview(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  params: {
    body: string;
    /** Omitted: GitHub reviews the PR's current head. */
    commitId?: string;
    comments?: ReviewCommentParams[];
    event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  },
): Promise<{ id: number; htmlUrl: string }> {
  // Inline comments are anchored to `commitId`'s diff; without it GitHub
  // would anchor them to whatever the head is when this lands.
  if (params.comments?.length && !params.commitId) {
    throw new Error("createPullRequestReview: inline comments need a commitId");
  }
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

export interface PullRequestReviewSummary {
  author: string;
  authorIsBot: boolean;
  state: string;
  commitId: string;
  submittedAt: string | null;
  /**
   * The review's own text (issue #1704). A review body is attacker-controlled
   * prose — it is what an untrusted PR author would have the review bot quote
   * — so it is capped on the way in (see `MAX_REVIEW_BODY_CHARS`) rather than
   * on the way out, so no caller can forget to bound it.
   */
  body?: string;
  /** True when `body` was cut short by the cap. */
  bodyTruncated?: boolean;
  /** The review's own page on GitHub, for linking to. */
  htmlUrl?: string;
}

const REVIEWS_PAGE_SIZE = 100;
const REVIEWS_MAX_PAGES = 10;
// The check runs of a commit: a busy commit has hundreds of them, so the
// marker can be off the first page.
const CHECK_RUNS_PAGE_SIZE = 100;
const CHECK_RUNS_MAX_PAGES = 10;
/**
 * How much of a review body is kept (issue #1704). A review body is prose
 * written by a bot (or by whoever the bot quotes) — long, but not unbounded:
 * the same order of magnitude as the relay's own run-output cap
 * (`MAX_RUN_OUTPUT_CHARS` in services/hermes-review.ts).
 */
export const MAX_REVIEW_BODY_CHARS = 4_000;

/**
 * Cuts a text to at most `max` characters without splitting a surrogate
 * pair — a plain `slice` can leave a lone surrogate, which is not valid
 * text and renders as a replacement character. The cut is made visible with
 * an ellipsis, so a truncated body reads as truncated.
 */
function truncateText(text: string, max: number): string {
  if ([...text].length <= max) return text;
  const cut = [...text].slice(0, max).join("");
  return `${cut}…`;
}

/**
 * Reviews on a PR, oldest first, reduced to what "did the review bot's verdict
 * land" needs. The endpoint is ascending, so every page is read (up to 1000
 * reviews): the newest review is on the last one. Read-only.
 */
/**
 * A check run on a commit — the "a review of this pull request is in flight"
 * marker the Hermes review protocol uses (issue #1749).
 *
 * The marker is a check run on the reviewed head (named by `reviewRelay.ledgerName`,
 * default "Hermes review"), whose
 * `external_id` is the Hermes run id. The shared workflow reads and writes the
 * same marker, so both entry points see one another's in-flight review.
 */
export interface CommitCheckRunSummary {
  id: number;
  name: string;
  /** The Hermes run id — empty when the check run is not one of ours. */
  externalId: string;
  status: string;
  conclusion: string | null;
  /** The marker records the session the round ran in: "session: <id>". */
  summary: string;
  /** When the run started — ISO-8601 UTC; "" when GitHub did not say. */
  startedAt: string;
  /** When the run was closed — ISO-8601 UTC; "" while it is still open. */
  completedAt: string;
}

/**
 * The check runs on a commit. Used to find the in-flight marker (and the
 * session it remembers) on the previous round's commit.
 *
 * Every page is read (the newest marker can be off the first page — a busy
 * commit has hundreds of check runs), and the list is returned NEWEST FIRST:
 * the endpoint answers in descending id order, but the ids are what the
 * order is decided by here, so a caller that takes the first marker gets the
 * newest one whatever the endpoint does.
 */
export async function listCommitCheckRuns(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<CommitCheckRunSummary[]> {
  // Envelope response: this endpoint answers `{ check_runs: [...] }`, so the
  // helper unwraps the inner array rather than measuring the response.
  const runs = await fetchAllPages(
    (page) =>
      githubRequest<{
        check_runs?: Array<{
          id: number;
          name: string;
          external_id?: string | null;
          status?: string;
          conclusion?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          output?: { summary?: string | null } | null;
        }>;
      }>(
        token,
        owner,
        repo,
        "GET",
        `/commits/${encodeURIComponent(sha)}/check-runs?per_page=${CHECK_RUNS_PAGE_SIZE}&page=${page}`,
      ),
    {
      maxPages: CHECK_RUNS_MAX_PAGES,
      pageSize: CHECK_RUNS_PAGE_SIZE,
      envelopeKey: "check_runs",
    },
  );
  const out: CommitCheckRunSummary[] = runs.map((r) => ({
    id: r.id,
    name: r.name,
    externalId: r.external_id ?? "",
    status: r.status ?? "",
    conclusion: r.conclusion ?? null,
    summary: r.output?.summary ?? "",
    startedAt: r.started_at ?? "",
    completedAt: r.completed_at ?? "",
  }));
  // Newest first, by id — the endpoint's own order is not the contract.
  return out.sort((a, b) => b.id - a.id);
}

/**
 * A finished ledger marker (the check run named by `reviewRelay.ledgerName`) on one
 * of a PR's commits.
 *
 * The marker sits on the commit the run reviewed and does NOT follow the PR's
 * head, which makes it the one reliable record of what a review covered:
 * `pulls/{n}/reviews[].commit_id` is re-pointed at the current head when the
 * branch tip is rewritten (a force-push, "Update branch" — s3ntin3l8/.github#129).
 */
export interface ReviewMarker {
  /** The commit the run reviewed. */
  oid: string;
  /** The check run's id: the highest is the newest dispatch. */
  id: number;
  /** When the run started — ISO-8601 UTC. */
  startedAt: string;
  /**
   * When the run was closed — ISO-8601 UTC. With `startedAt` it bounds which
   * reviews are this run's: one submitted while it ran, not any later one.
   */
  completedAt: string;
}

/** How many of a PR's newest commits are searched for markers. */
const MARKER_COMMIT_WINDOW = 50;
/** GitHub lists at most 250 commits of a PR, 100 to a page. */
const PR_COMMITS_PAGE_SIZE = 100;
const PR_COMMITS_MAX_PAGES = 3;
/** Commits whose check runs are read at the same time. */
const MARKER_FETCH_CONCURRENCY = 10;
/** How many of a PR's newest force-pushes are searched for the heads it had before them. */
const MARKER_FORCE_PUSH_WINDOW = 20;

const FORCE_PUSHED_HEADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], last: ${MARKER_FORCE_PUSH_WINDOW}) {
        nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } } }
      }
    }
  }
}`;

interface ForcePushedHeadsData {
  repository: {
    pullRequest: {
      timelineItems: {
        nodes: Array<{ beforeCommit?: { oid?: string } | null } | null> | null;
      } | null;
    } | null;
  } | null;
}

/**
 * The heads a PR had BEFORE each of its last force-pushes, oldest first
 * (s3ntin3l8/.github#136). A rebase or a recreated branch drops the reviewed
 * commit from the PR, but the ledger marker stays on it; REST's timeline only
 * names the commit AFTER a force-push, so this is GraphQL. A `beforeCommit`
 * GitHub has already collected comes back null and is skipped. `{ reason }` = the
 * read was not possible (rate limit, a failed or partial answer, a token without
 * access): the caller degrades to the PR's current commits, which can make the
 * relay's base differ from the shared workflow's for that dispatch (a lost
 * dedup, never a wrong review).
 *
 * Goes through `githubGraphQL()` (this file's shared POST on `githubApiFetch`), so
 * a GraphQL throttle is recorded into the shared rate-limit budget like every
 * other read here. Deliberately NOT the poller's `graphql()` helper
 * (github-pr-reviews.ts): that one arms an app-wide backoff on a 403/429 and
 * shares a warning slot with the PR-list refresh, so a failure of this read
 * would pause the UI.
 */
async function listForcePushedHeads(
  prToken: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ heads: string[] } | { reason: string }> {
  validateGitHubRepoRef(owner, repo);
  let data: ForcePushedHeadsData;
  try {
    data = await githubGraphQL<ForcePushedHeadsData>(prToken, FORCE_PUSHED_HEADS_QUERY, {
      owner,
      repo,
      number: prNumber,
    });
  } catch (err) {
    // A rate limit (already recorded into the shared budget by githubApiFetch), a
    // token without access, a GraphQL error: the caller degrades the same way for
    // all of them, and reports why. `githubGraphQL` words a 403/404 as a refused WRITE
    // ("the token likely lacks write access"), which would mislead in a log about a read.
    return {
      reason:
        err instanceof GitHubWriteScopeError
          ? `HTTP ${err.statusCode}: the token cannot read the pull request's timeline`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
  const nodes = data?.repository?.pullRequest?.timelineItems?.nodes;
  if (!nodes) return { reason: "the answer had no force-push timeline" };
  return { heads: nodes.flatMap((n) => (n?.beforeCommit?.oid ? [n.beforeCommit.oid] : [])) };
}

/**
 * The finished (`success`) ledger markers on a PR's last commits. A run that
 * was stopped or failed reviewed nothing, so it is not returned. The shared
 * workflow reads the same markers with the same window and the same filter
 * (`hermes-review.yml`, "Resolve review scope") — the two must agree, since
 * the delta base they derive goes into one idempotency key.
 *
 * Two tokens, because no single one can do both reads: the PR's commits need
 * the PR token (`pull_requests`/`contents`), while the App's installation
 * token for the ledger is checks-only (`checks` + `metadata`) and GitHub
 * answers GraphQL `pullRequest.commits` — and REST `/pulls/{n}/commits` —
 * with FORBIDDEN for it on a private repository. Its own check-run reads work.
 * (It is the same split `readRememberedSession` relies on.)
 *
 * The heads the PR had before its last force-pushes are searched too (see
 * `listForcePushedHeads`), so a rewrite that dropped the reviewed commit does
 * not hide its marker (s3ntin3l8/.github#136). The workflow does the same.
 *
 * Cost: up to 3 requests for the PR's commits, one GraphQL request for the
 * force-pushes, plus one per candidate commit (the window of 50 and up to 20
 * dropped heads), in batches of 10 — `base()` runs on every relay dispatch,
 * and the windows are what size it.
 */
export async function listReviewMarkers(
  prToken: string,
  checksToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  markerName: string,
  /**
   * Told ONCE, with a count, when some commits' check runs could not be read
   * (not once per commit: a systemic failure would otherwise log up to 50
   * warnings per dispatch). Those commits are skipped and the rest are kept: a
   * base derived from fewer commits is older, so the round over-reviews rather
   * than under-reviews.
   */
  onError?: (detail: string) => void,
): Promise<ReviewMarker[]> {
  // The PR's commits, oldest first; only the newest window is searched.
  // Bare-array response, and this endpoint's own cap is THREE pages — GitHub
  // lists at most 250 commits of a PR, so three 100-item pages is the whole
  // list.
  const commits = (
    await fetchAllPages(
      (page) =>
        githubRequest<Array<{ sha: string }>>(
          prToken,
          owner,
          repo,
          "GET",
          `/pulls/${prNumber}/commits?per_page=${PR_COMMITS_PAGE_SIZE}&page=${page}`,
        ),
      { maxPages: PR_COMMITS_MAX_PAGES, pageSize: PR_COMMITS_PAGE_SIZE },
    )
  ).map((c) => c.sha);
  const forcePushed = await listForcePushedHeads(prToken, owner, repo, prNumber);
  if ("reason" in forcePushed) {
    onError?.(
      `force-push history unreadable (${forcePushed.reason}), searching the PR's current commits only`,
    );
  }
  // A head that is still in the PR (it was force-pushed to and then back) is read once.
  const window = [
    ...new Set([
      ...commits.slice(-MARKER_COMMIT_WINDOW),
      ...("heads" in forcePushed ? forcePushed.heads : []),
    ]),
  ];
  const out: ReviewMarker[] = [];
  const failed: string[] = [];
  for (let i = 0; i < window.length; i += MARKER_FETCH_CONCURRENCY) {
    const batch = window.slice(i, i + MARKER_FETCH_CONCURRENCY);
    // Not atomic: one commit's failed read (a 5xx, a timeout, a rate limit)
    // must not throw away the markers the other reads already returned.
    const runs = await Promise.allSettled(
      batch.map((sha) => listCommitCheckRuns(checksToken, owner, repo, sha)),
    );
    batch.forEach((sha, j) => {
      const result = runs[j];
      if (!result || result.status === "rejected") {
        failed.push(
          `${sha}: ${result?.status === "rejected" ? String(result.reason?.message ?? result.reason) : "no result"}`,
        );
        return;
      }
      for (const run of result.value) {
        if (
          run.name === markerName &&
          run.conclusion === "success" &&
          run.startedAt &&
          run.completedAt
        ) {
          out.push({
            oid: sha,
            id: run.id,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
          });
        }
      }
    });
  }
  // One report for the whole read, not one per commit: a systemic failure (a
  // token without access, a rate limit) fails all of the up-to-50 reads and
  // would otherwise log 50 warnings for a single dispatch.
  if (failed.length > 0) {
    onError?.(
      `check runs of ${failed.length} commit(s) unreadable, skipping them (first: ${failed[0]})`,
    );
  }
  return out;
}

export interface CommitInfo {
  /** The commit's tree: two commits with one tree hold identical content. */
  treeSha: string;
  /** When the commit was committed — ISO-8601 UTC; "" when unknown. */
  committedAt: string;
}

/** A commit's tree and committer date. */
export async function getCommitInfo(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<CommitInfo> {
  const data = await githubRequest<{
    commit?: { tree?: { sha?: string }; committer?: { date?: string | null } | null };
  }>(token, owner, repo, "GET", `/commits/${encodeURIComponent(sha)}`);
  return {
    treeSha: data.commit?.tree?.sha ?? "",
    committedAt: data.commit?.committer?.date ?? "",
  };
}

/**
 * Writes the in-flight marker: a check run on the reviewed head whose
 * external_id is the Hermes run id, and whose summary records the session the
 * round runs in (so the next round — from either entry point — can continue
 * in it).
 *
 * The shared workflow writes the same marker with the same shape; a marker
 * written by one is found by the other.
 */
export async function createReviewMarkerCheckRun(
  token: string,
  owner: string,
  repo: string,
  m: {
    name: string;
    headSha: string;
    externalId: string;
    sessionId: string;
    detailsUrl?: string;
  },
): Promise<number> {
  const data = await githubRequest<{ id: number }>(token, owner, repo, "POST", "/check-runs", {
    name: m.name,
    head_sha: m.headSha,
    external_id: m.externalId,
    status: "in_progress",
    details_url: m.detailsUrl,
    output: { title: m.name, summary: `session: ${m.sessionId}` },
  });
  return data.id;
}

/** Closes the in-flight marker when the review it names has finished. */
export async function completeReviewMarkerCheckRun(
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
  conclusion: "success" | "failure" | "neutral",
): Promise<void> {
  await githubRequest(token, owner, repo, "PATCH", `/check-runs/${checkRunId}`, {
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
  });
}

export async function listPullRequestReviews(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestReviewSummary[]> {
  // Bare-array response: the endpoint answers with the reviews themselves.
  const reviews = await fetchAllPages(
    (page) =>
      githubRequest<
        Array<{
          user: { login: string; type: string } | null;
          state: string;
          commit_id: string;
          submitted_at: string | null;
          body?: string | null;
          html_url?: string | null;
        }>
      >(
        token,
        owner,
        repo,
        "GET",
        `/pulls/${number}/reviews?per_page=${REVIEWS_PAGE_SIZE}&page=${page}`,
      ),
    { maxPages: REVIEWS_MAX_PAGES, pageSize: REVIEWS_PAGE_SIZE },
  );
  return reviews.map((r) => {
    const body = typeof r.body === "string" ? r.body : "";
    // The cut is by code point, so the flag has to be too — a body of
    // 4000 emoji is 8000 UTF-16 units but no code point is dropped.
    const truncated = [...body].length > MAX_REVIEW_BODY_CHARS;
    return {
      author: r.user?.login ?? "ghost",
      authorIsBot: r.user?.type === "Bot",
      state: r.state,
      commitId: r.commit_id,
      submittedAt: r.submitted_at,
      // An empty body is left undefined rather than "" — "this review said
      // nothing" and "this review's text was not fetched" are the same
      // thing to every caller, and neither is worth a field.
      ...(body ? { body: truncated ? truncateText(body, MAX_REVIEW_BODY_CHARS) : body } : {}),
      ...(truncated ? { bodyTruncated: true } : {}),
      ...(typeof r.html_url === "string" ? { htmlUrl: r.html_url } : {}),
    };
  });
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
 * #2904 — re-runs ONE job of a workflow run
 * (`POST /actions/jobs/:job_id/rerun`). The lever for a coverage upload that
 * Codecov never turned into a status: re-running the job that uploaded the
 * coverage makes Codecov reprocess the commit, and the pending status goes
 * green (that is exactly what a human did by hand on PR #2894).
 *
 * Returns `false` when GitHub REFUSES the re-run — 403/404 (a token without
 * Actions write, a job GitHub will not re-run) and 422 ("cannot be rerun",
 * which GitHub says of a job that is still running or of a run whose attempt
 * has already been re-used). A refusal is a definite answer the caller acts
 * on by SKIPPING that job and trying the next candidate — not an error. A
 * thrown rate-limit or network error is "could not ask" and propagates.
 */
export async function rerunJob(
  token: string,
  owner: string,
  repo: string,
  jobId: number,
): Promise<boolean> {
  try {
    await githubRequest(token, owner, repo, "POST", `/actions/jobs/${jobId}/rerun`);
    return true;
  } catch (err) {
    if (err instanceof GitHubWriteScopeError) return false;
    // 422 — "cannot be rerun". GitHub's own wording for a job it will not
    // re-run (still running, or its attempt already re-used). A refusal, like
    // the 403 above.
    if (err instanceof GitHubApiError && err.statusCode === 422) return false;
    throw err;
  }
}

/**
 * Re-runs only the failed (and cancelled/abandoned) jobs of one workflow run
 * (`POST /actions/runs/:id/rerun-failed-jobs`). The answer for a red check that
 * no code change can fix — a lost runner, an abandoned shard — which the red-CI
 * return to the worker cannot resolve.
 *
 * Returns `false` when GitHub REFUSES the rerun (403/404: "This workflow run
 * cannot be retried", which it says of runs that never created jobs and of
 * CodeQL / dependency-review runs, or a token without Actions write). That is a
 * definite answer the caller acts on, unlike a thrown rate-limit or network
 * error, which is "could not ask" and propagates.
 */
export async function rerunFailedJobs(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<boolean> {
  try {
    await githubRequest(token, owner, repo, "POST", `/actions/runs/${runId}/rerun-failed-jobs`);
    return true;
  } catch (err) {
    if (err instanceof GitHubWriteScopeError) return false;
    throw err;
  }
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

/** GitHub's `PullRequestReviewState`. */
export type PrReviewState =
  "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

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
  /** State of the review this comment was posted as part of (APPROVED,
   * CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING), or null when GitHub
   * reports none — a reply in a thread belongs to its own review, so a human
   * answering under an approval reads COMMENTED, not APPROVED. */
  reviewState: PrReviewState | null;
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
                pullRequestReview: { state: PrReviewState } | null;
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
                  pullRequestReview { state }
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
        reviewState: c.pullRequestReview?.state ?? null,
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
 * `resolveMullionOwnThreadsIfClean` (task-own-threads.ts) for the actual
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

/** A reply just posted to a review thread, in the PR drill-in's own comment shape. */
export interface ReviewThreadReply {
  author: string | null;
  bodyHtml: string;
  createdAt: string;
  htmlUrl: string;
}

/**
 * Replies to a review thread, addressed by its GraphQL node id — the same id
 * `resolveReviewThread` takes, so the sidebar needs nothing else to do both.
 * (REST's `pulls/:n/comments/:id/replies` needs the thread's *first*
 * comment's database id instead, and a reply-to-a-reply id there is a 404
 * that reads as "no write access".) No authorization check of its own, same
 * posture as `resolveReviewThread`.
 */
export async function replyToReviewThread(
  token: string,
  threadId: string,
  body: string,
): Promise<ReviewThreadReply> {
  const data = await githubGraphQL<{
    addPullRequestReviewThreadReply: {
      comment: {
        author: { login: string } | null;
        bodyHTML: string;
        createdAt: string;
        url: string;
      } | null;
    } | null;
  }>(
    token,
    `mutation($id: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
        comment { author { login } bodyHTML createdAt url }
      }
    }`,
    { id: threadId, body },
  );
  const comment = data.addPullRequestReviewThreadReply?.comment;
  if (!comment) throw new GitHubApiError("GitHub did not return the posted reply", 502);
  return {
    author: comment.author?.login ?? null,
    bodyHtml: comment.bodyHTML,
    createdAt: comment.createdAt,
    htmlUrl: comment.url,
  };
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

/**
 * The most recent MERGED pull request whose head is `head` (`owner:branch`),
 * with the commit that head pointed at when it merged and the branch it merged
 * into — so a caller can tell a branch whose work is all in the merged PR from
 * one that has had commits added since, and a merge into the default branch
 * from one into some other feature branch. Read-only. `state=closed` returns merged and abandoned PRs alike, so
 * the first one with a `merged_at` wins (newest first, as in
 * `findPullRequestByHead`). Only looks at the newest few: a branch name reused
 * across many PRs resolves to its latest merge or nothing, never an old one.
 */
export async function findMergedPullRequestByHead(
  token: string,
  owner: string,
  repo: string,
  head: string,
): Promise<{ number: number; headSha: string; baseRef: string } | null> {
  const results = await githubRequest<
    Array<{
      number: number;
      merged_at: string | null;
      head: { sha: string };
      base: { ref: string };
    }>
  >(
    token,
    owner,
    repo,
    "GET",
    `/pulls?head=${encodeURIComponent(head)}&state=closed&sort=created&direction=desc&per_page=5`,
  );
  const merged = results.find((pr) => pr.merged_at !== null);
  return merged
    ? { number: merged.number, headSha: merged.head.sha, baseRef: merged.base.ref }
    : null;
}

/** One closed pull request, as the merged-PR lookup needs it. */
export interface ClosedPullRequest {
  number: number;
  htmlUrl: string;
  headRef: string;
  headSha: string;
  /** `owner/repo` of the head, `null` when the fork was deleted. */
  headRepo: string | null;
  baseRef: string;
  mergedAt: string | null;
  updatedAt: string;
}

/**
 * The `per_page` size `listClosedPullRequests` asks for. Exported because its
 * paginated caller (github-merged-prs.ts) has to measure a page against the
 * SAME number to know where the list ended — two literals in two modules are
 * exactly the kind of pair that drifts, and a drift here silently cuts the
 * walk to one page.
 */
export const CLOSED_PRS_PAGE_SIZE = 100;

/**
 * One page of closed pull requests (CLOSED_PRS_PAGE_SIZE of them), most
 * recently updated first — merged and abandoned alike (`mergedAt` tells them
 * apart). Read-only. The paginated caller lives in github-merged-prs.ts; this
 * is just the REST shape.
 */
export async function listClosedPullRequests(
  token: string,
  owner: string,
  repo: string,
  page: number,
): Promise<ClosedPullRequest[]> {
  const results = await githubRequest<
    Array<{
      number: number;
      html_url: string;
      merged_at: string | null;
      updated_at: string;
      head: { ref: string; sha: string; repo: { full_name: string } | null };
      base: { ref: string };
    }>
  >(
    token,
    owner,
    repo,
    "GET",
    `/pulls?state=closed&sort=updated&direction=desc&per_page=${CLOSED_PRS_PAGE_SIZE}&page=${page}`,
  );
  return results.map((pr) => ({
    number: pr.number,
    htmlUrl: pr.html_url,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    headRepo: pr.head.repo?.full_name ?? null,
    baseRef: pr.base.ref,
    mergedAt: pr.merged_at,
    updatedAt: pr.updated_at,
  }));
}

export interface IssueSummary {
  title: string;
  /** "open" | "closed" as GitHub reports it. */
  state: string;
  /** GitHub's `sub_issues_summary`, when the issue has one. */
  subIssues: { total: number; completed: number } | null;
}

/** An issue's title, state and sub-issue summary in one call (#2919: the
 * board's epic filter needs the PARENT's own progress and open/closed state;
 * getIssueTitle only carried the title). */
export async function getIssueSummary(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IssueSummary> {
  const result = await githubRequest<{
    title: string;
    state: string;
    sub_issues_summary?: { total?: number; completed?: number } | null;
  }>(token, owner, repo, "GET", `/issues/${issueNumber}`);
  const s = result.sub_issues_summary;
  return {
    title: result.title,
    state: result.state,
    subIssues:
      s && typeof s.total === "number"
        ? { total: s.total, completed: typeof s.completed === "number" ? s.completed : 0 }
        : null,
  };
}
