// The release-please half of the GitHub client: detection, dispatch, and the
// release PR's own status.
//
// Split out of github-write.ts (issue #2405) so that file can shrink under
// its size ratchet. Everything release-specific lives here — the workflow-file
// name list, the branch prefix, BOTH module-level caches (the detection cache
// and the release-PR cache) and their TTLs. The two caches move together: they
// are one feature (a release PR's identity and its status), and splitting
// them across two modules would put one cache's lifetime in a file that knows
// nothing about the other.
//
// The transport is shared with the write client — githubRequest and the
// scope error it raises live in github-request.ts, so both this module and
// github-write.ts use the same request path and the same error shape.

import { getDefaultBranch, getPRsStatus } from "./github.js";
import { GitHubApiError, GitHubRateLimitError } from "./github-fetch.js";
import { githubRequest, GitHubWriteScopeError, getPullRequestByNumber } from "./github-request.js";
import type { ReleaseDetectionResult, ReleasePullRequestStatus } from "../shared/types.js";

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
 */
const RELEASE_WORKFLOW_FILENAMES = ["release-please.yml", "release-please.yaml"];
const RELEASE_PLEASE_ACTION_REFERENCE = "release-please-action";
const RELEASE_PLEASE_REUSABLE_REFERENCE = "s3ntin3l8/.github/.github/workflows/release-please.yml@";

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
  } catch (err) {
    if (err instanceof GitHubRateLimitError) throw err;
    return null;
  }
}

function isReleasePleaseBody(body: string): boolean {
  return (
    body.includes(RELEASE_PLEASE_ACTION_REFERENCE) ||
    body.includes(RELEASE_PLEASE_REUSABLE_REFERENCE)
  );
}

/**
 * Whether a workflow file declares a `workflow_dispatch` trigger — the one
 * thing GitHub's dispatch API needs, and it 422s without. Comments are
 * stripped first so a `# add workflow_dispatch: here` note doesn't count.
 */
function hasDispatchTrigger(body: string): boolean {
  return /\bworkflow_dispatch\b/.test(body.replace(/#.*$/gm, ""));
}

async function findReleasePleaseWorkflowByContent(
  token: string,
  owner: string,
  repo: string,
  workflows: GitHubWorkflow[],
): Promise<{ workflow: GitHubWorkflow; body: string } | null> {
  for (const workflow of workflows) {
    const basename = workflow.path.split("/").pop();
    if (basename === undefined) continue;
    if (RELEASE_WORKFLOW_FILENAMES.includes(basename)) continue;
    const body = await fetchWorkflowBody(token, owner, repo, workflow);
    if (body !== null && isReleasePleaseBody(body)) return { workflow, body };
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
// the other hourly caches in this module.
const RELEASE_WORKFLOW_CACHE_TTL_MS = 60 * 60_000;
// A workflow that isn't (known to be) dispatchable is re-read sooner, so a
// repo that just added `workflow_dispatch:` gets its Run button back without
// waiting out the hour.
const RELEASE_WORKFLOW_UNDISPATCHABLE_TTL_MS = 5 * 60_000;

/**
 * Detects whether a repo has a release-please workflow, distinguishing "not
 * configured" (the token could list workflows; none matched) from
 * "no-actions-scope" (the list call itself was rejected — a PAT without
 * `Actions: read` is an explicitly supported configuration, not an error;
 * see docs/github-integration.md). Only a `"found"`/`"not-configured"`
 * result is cached — a scope failure isn't, in case the connected token is
 * fixed later.
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
    let body: string | null = null;
    if (workflow) {
      body = await fetchWorkflowBody(token, owner, repo, workflow);
    } else {
      const hit = await findReleasePleaseWorkflowByContent(token, owner, repo, workflows);
      workflow = hit?.workflow ?? null;
      body = hit?.body ?? null;
    }
    result = workflow
      ? {
          kind: "found",
          workflow: {
            ...workflow,
            // null = the file couldn't be read, so Run stays enabled and a
            // real dispatch decides.
            dispatchable: body === null ? null : hasDispatchTrigger(body),
          },
        }
      : { kind: "not-configured" };
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

  const ttl =
    result.kind === "found" && result.workflow.dispatchable !== true
      ? RELEASE_WORKFLOW_UNDISPATCHABLE_TTL_MS
      : RELEASE_WORKFLOW_CACHE_TTL_MS;
  releaseWorkflowCache.set(key, { result, expiresAt: Date.now() + ttl });
  return result;
}

/**
 * Drops the cached detection for `owner/repo` — called when a dispatch 422s,
 * so the next read re-checks the workflow file instead of trusting a cached
 * "dispatchable" answer.
 */
export function invalidateReleaseWorkflowCache(owner: string, repo: string): void {
  releaseWorkflowCache.delete(`${owner}/${repo}`);
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

export interface HeldRuns {
  /** Ids of the head commit's runs GitHub is holding for approval. */
  held: number[];
  /** Every workflow run GitHub has for the head commit, held or not. */
  total: number;
}

/**
 * Lists the workflow runs for `headSha` that are waiting for someone to click
 * "Approve and run" — `GET /actions/runs?head_sha=`, keeping those with
 * `conclusion: "action_required"` (a completed-but-never-started run, the
 * shape every held run has on a bot-authored PR) or `status: "action_required"`
 * (approval-gated with no conclusion yet). `status: "waiting"` is deliberately
 * NOT counted: it also covers concurrency and environment gates, which
 * `/approve` refuses.
 *
 * `total` is the number of runs of any kind for that commit: `held` empty with
 * `total` 0 means no workflow ever fired (a PR opened with the default
 * `GITHUB_TOKEN` triggers none), which approving cannot fix, while `held`
 * empty with `total` > 0 just means nothing is waiting.
 */
export async function listHeldRuns(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
): Promise<HeldRuns> {
  const result = await githubRequest<{
    total_count: number;
    workflow_runs: Array<{ id: number; status: string | null; conclusion: string | null }>;
  }>(
    token,
    owner,
    repo,
    "GET",
    `/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
  );
  const held = result.workflow_runs
    .filter((run) => run.conclusion === "action_required" || run.status === "action_required")
    .map((run) => run.id);
  return { held, total: result.total_count };
}

/**
 * Approves one held run — `POST /actions/runs/:id/approve`, 204/empty on
 * success. Needs a token with `actions: write` — the account PAT the route
 * resolves, not an App token minted here; a token without it surfaces as
 * `GitHubWriteScopeError`. GitHub also answers 403 for a run that is no
 * longer awaiting approval, so a caller must not read every 403 as a scope
 * problem.
 */
export async function approveRun(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<void> {
  await githubRequest(token, owner, repo, "POST", `/actions/runs/${runId}/approve`);
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
 * `findPullRequestByHead`'s own reasoning (github-write.ts): release-please closes/
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
// .../release costs FOUR live calls (getDefaultBranch, findReleasePullRequest,
// getPullRequestByNumber, and the head commit's workflow-runs read in
// listHeldRuns) every time the frontend refetches — and it refetches
// on every /ws/github frame (pr, issue, ci, push, release —
// store/slices/github.ts's prsRefreshTrigger), not just release-relevant
// ones. An active repo's webhook traffic would otherwise spend four calls
// per frame against the process-wide rate-limit budget (github-fetch.ts)
// the PR poller and every Task Master write share — degrading features
// well outside this one panel section.
const RELEASE_PR_CACHE_TTL_MS = 60_000;

/**
 * Assembles the open release PR's status (or `null`) for `owner/repo`,
 * cached for `RELEASE_PR_CACHE_TTL_MS` — the read path behind GET
 * .../release. Resolves the default branch, finds the release-please PR
 * against it, reads its full mergeability, and merges in `ciStatus` from
 * the PR poller's own warm cache (github.ts's `getPRsStatus`) when present.
 * `ciStatus` itself never makes a live Actions-runs call (same posture as
 * `/github/prs`); the held-run count does, via one `listHeldRuns` read of the
 * head commit's runs, which is why the result is cached.
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
    // A runs-read failure (a token without Actions: read, a rate limit) must
    // not hide the release PR itself: degrade to "nothing known held".
    let heldRuns = 0;
    let noRuns = false;
    try {
      const runs = await listHeldRuns(token, owner, repo, full.headSha);
      heldRuns = runs.held.length;
      noRuns = runs.total === 0;
    } catch (err) {
      if (!(err instanceof GitHubApiError)) throw err;
    }
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
      heldRuns,
      noRuns,
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
