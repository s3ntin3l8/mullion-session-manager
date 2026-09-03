// Plain-fetch client for the GitHub REST API (issue #27) — no octokit or
// other GitHub SDK dependency, matching this repo's existing "no HTTP
// client library, just fetch" convention (see remote-host-client.ts).
// Runs only on the primary (it needs the decrypted token from
// github-integration.ts, which the caller — routes/projects.ts — passes in;
// this module never imports that service itself, keeping the two
// independently testable).

import { githubApiFetch, GitHubApiError } from "./github-fetch.js";
export { GitHubApiError };

// GitHub repo/owner naming constraints: alphanumeric + hyphens for owners
// (max 39 chars), plus underscores/periods for repos (max 100 chars).
// We validate these before using parsed git-remote data in URLs, to satisfy
// CodeQL's "file-data in outbound request" rule even though
// encodeURIComponent and the fixed api.github.com base prevent injection.
const OWNER_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?$/;
const REPO_RE = /^[a-zA-Z0-9_.-]{1,100}$/;

// #701 — strict, anchored parse of GitHub's `parent_issue_url` (a
// remote-supplied string feeding a later outbound request — same
// "file/API data reaching a request" shape OWNER_RE/REPO_RE above guard
// against, for CodeQL's js/request-forgery). The owner/repo character
// classes below must stay in sync with OWNER_RE/REPO_RE; only the fixed
// api.github.com host and the /repos/{owner}/{repo}/issues/{n} path shape
// are new here. Anything that doesn't match this exactly is treated as "no
// parent" rather than partially parsed — see parseParentIssueUrl below.
const PARENT_ISSUE_URL_RE =
  /^https:\/\/api\.github\.com\/repos\/([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?)\/([a-zA-Z0-9_.-]{1,100})\/issues\/(\d{1,10})$/;

// Fetch-on-open + short TTL, not background polling — see the plan's
// "protect the 5000/hr budget" note. A project's Dock widget/panel re-fetches
// at most this often even if the user reopens it repeatedly.
const CACHE_TTL_MS = 60_000;

export interface GitHubIssueOrPr {
  number: number;
  title: string;
  htmlUrl: string;
  author: string | null;
}

export interface GitHubActionsRun {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headSha: string;
}

export interface GitHubJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string;
  steps: GitHubStep[];
}

export interface GitHubStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

// Aggregate read for the Dock widget's single CI dot — "in_progress" if any
// latest run hasn't completed yet, "failure" if any completed run didn't
// succeed, "success" only if every one did. `null` means no Actions data at
// all (disabled, no runs, or the lookup itself failed) — the dot/section
// just doesn't render for that case (routes/projects.ts's GET .../github
// still 200s; this is a feature-detect, not an error).
export type GitHubCiStatus = "success" | "failure" | "in_progress" | null;

// Per-PR CI status with head SHA and runs (issue #102).
export interface PROrWithChecks {
  number: number;
  title: string;
  htmlUrl: string;
  author: string | null;
  headSha: string;
  headBranch: string;
  baseBranch: string;
  ciStatus: GitHubCiStatus;
  actionsRuns: GitHubActionsRun[];
}

export interface GitHubPRsStatus {
  prs: PROrWithChecks[];
  // Summary counts for the dock widget: "3 PRs — 2✅ 1❌"
  prSummary: { total: number; pass: number; fail: number; pending: number; unknown: number };
}

export interface GitHubRepoStatus {
  repo: { owner: string; repo: string; htmlUrl: string };
  openIssues: number;
  openPRs: number;
  pulls: GitHubIssueOrPr[];
  issues: GitHubIssueOrPr[];
  actionsRuns: GitHubActionsRun[];
  ciStatus: GitHubCiStatus;
}

interface CacheEntry {
  ts: number;
  etag: string | null;
  data: GitHubRepoStatus;
}

// Keyed by "owner/repo" — module-level, shared across every project that
// happens to point at the same repo (e.g. two projects checked out from the
// same remote). Capped rather than truly unbounded (Hermes review, PR #39):
// a normal install's distinct-repo count is small, but nothing stops an
// unbounded number of distinct project cwds from being registered, so this
// still needs a ceiling on process memory. `Map` preserves insertion order,
// so evicting `cache.keys().next().value` evicts the oldest entry — a
// cheap approximate-LRU good enough for a 60s-TTL status cache, not a
// correctness-sensitive one.
export const MAX_CACHE_ENTRIES = 200;
const cache = new Map<string, CacheEntry>();

function cacheSet(key: string, entry: CacheEntry): void {
  if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, entry);
}

/** Test-only introspection — mirrors clearAgentsCacheForTests's pattern
 * (agent-detect.ts) for a module-level cache. */
export function getCacheSizeForTests(): number {
  return cache.size;
}

interface GitHubIssueApiItem {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
  pull_request?: unknown;
  // #667 — present on the plain issues-list response (verified live against
  // the API during planning, no extra Accept header or API version needed).
  // Only listLabeledIssues below reads it; getRepoStatus's own use of this
  // interface just carries the extra field through unread.
  issue_dependencies_summary?: { total_blocked_by?: number };
  // #701 — same free ride as issue_dependencies_summary above (verified live
  // against branchdam during planning, correcting an earlier — wrong —
  // claim that no such field exists; see issue #701's corrected body).
  // `null` on an issue with no parent, `undefined` only in practice on a
  // response shape this interface isn't used for (never actually absent on
  // the real issues-list response, but typed optional defensively).
  parent_issue_url?: string | null;
  sub_issues_summary?: { total?: number; completed?: number };
}

interface GitHubRepoApiResponse {
  default_branch?: string;
}

interface GitHubWorkflowRunApiItem {
  name: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
}

// Exported for task-reconciler.ts's review-spawn CI gate (#738 follow-up) —
// same aggregation the Dock widget's repo-level CI dot and the per-PR status
// already use, reused rather than reimplemented for a task's own PR head.
export function computeCiStatus(runs: GitHubActionsRun[]): GitHubCiStatus {
  if (runs.length === 0) return null;
  if (runs.some((r) => r.status !== "completed")) return "in_progress";
  // `skipped`/`cancelled` aren't a pass or a fail — excluding them from the
  // aggregate keeps a workflow someone disabled/skipped from painting the
  // dot red (Hermes review, PR #42). If every run is skipped/cancelled,
  // there's no real signal at all — same as no runs existing.
  const meaningful = runs.filter((r) => r.conclusion !== "skipped" && r.conclusion !== "cancelled");
  if (meaningful.length === 0) return null;
  return meaningful.every((r) => r.conclusion === "success") ? "success" : "failure";
}

/**
 * Best-effort latest-run-per-workflow lookup for the default branch —
 * never throws: Actions being disabled, a repo with no runs yet, or the
 * lookup itself failing all degrade to `[]` (feature-detect, not an
 * error — routes/projects.ts's GET .../github still 200s either way).
 * Two extra requests beyond the issues/PRs call above (repo info, for
 * `default_branch`; then the runs list itself) — acceptable since both
 * ride the same CACHE_TTL_MS as everything else in getRepoStatus.
 *
 * Latest run is kept per distinct `name` (the workflow's display name) —
 * an approximation, not a true per-workflow-id dedup, but matches the
 * plan's "latest run per workflow" scope without an extra lookup to
 * resolve workflow ids.
 */
async function fetchActionsRuns(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubActionsRun[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  try {
    const repoRes = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers },
    );
    if (!repoRes.ok) return [];
    const repoData = (await repoRes.json()) as GitHubRepoApiResponse;
    const defaultBranch = repoData.default_branch;
    if (!defaultBranch) return [];

    // 100 is GitHub's own max per_page — a repo with more than 100 distinct
    // workflow names on its default branch would still undercount here, but
    // that's an extreme case; 20 (the prior value) risked missing workflows
    // in an ordinary monorepo with more than a handful of them (Hermes
    // review, PR #42).
    const runsRes = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?branch=${encodeURIComponent(defaultBranch)}&per_page=100`,
      { headers },
    );
    if (!runsRes.ok) return [];
    const runsData = (await runsRes.json()) as { workflow_runs?: GitHubWorkflowRunApiItem[] };

    const seen = new Set<string>();
    const latest: GitHubActionsRun[] = [];
    // GitHub returns these ordered most-recent-first, so the first time a
    // given name is seen is already its latest run.
    for (const run of runsData.workflow_runs ?? []) {
      const name = run.name ?? "workflow";
      if (seen.has(name)) continue;
      seen.add(name);
      latest.push({
        name,
        status: run.status,
        conclusion: run.conclusion,
        htmlUrl: run.html_url,
        headSha: run.head_sha,
      });
    }
    return latest;
  } catch {
    return [];
  }
}

/**
 * Fetches open issues *and* PRs for a repo in a single call — GitHub's
 * `/issues` endpoint returns both (a PR is also an "issue"; entries with a
 * `pull_request` field are PRs) — rather than one call each to `/issues`
 * and `/pulls`, halving the quota cost for the same data. `repo.htmlUrl` is
 * constructed directly (no separate `GET /repos/{owner}/{repo}` call needed
 * just for a URL we can already compute).
 *
 * Capped at the first 100 open items (one page) — a repo with more open
 * issues+PRs combined than that undercounts here; not paginated further,
 * since this feeds a glance-and-a-short-list UI, not an exhaustive report.
 *
 * Uses the cached response (an ETag conditional request, or the cache
 * outright within CACHE_TTL_MS) when possible — a 304 doesn't count against
 * the token's rate limit.
 *
 * Also fetches the default branch's latest Actions run per workflow (issue
 * #27 phase 5, `fetchActionsRuns` below) — best-effort, never fails this
 * call: a repo with Actions disabled or no runs just gets `actionsRuns: []`
 * / `ciStatus: null`.
 */
export async function getRepoStatus(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubRepoStatus> {
  const key = `${owner}/${repo}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  const res = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=100`,
    { headers },
  );

  if (res.status === 304 && cached) {
    cached.ts = Date.now();
    return cached.data;
  }
  if (!res.ok) {
    throw new GitHubApiError(`GitHub API error for ${key} (HTTP ${res.status})`, res.status);
  }

  const items = (await res.json()) as GitHubIssueApiItem[];
  const pulls: GitHubIssueOrPr[] = [];
  const issues: GitHubIssueOrPr[] = [];
  for (const item of items) {
    const entry: GitHubIssueOrPr = {
      number: item.number,
      title: item.title,
      htmlUrl: item.html_url,
      author: item.user?.login ?? null,
    };
    (item.pull_request ? pulls : issues).push(entry);
  }

  const actionsRuns = await fetchActionsRuns(token, owner, repo);

  const data: GitHubRepoStatus = {
    repo: { owner, repo, htmlUrl: `https://github.com/${owner}/${repo}` },
    openIssues: issues.length,
    openPRs: pulls.length,
    pulls,
    issues,
    actionsRuns,
    ciStatus: computeCiStatus(actionsRuns),
  };
  cacheSet(key, { ts: Date.now(), etag: res.headers.get("etag"), data });
  return data;
}

// ────────────────────────────────────────────────────────────────────────────
// Task watcher (Phase 2.5 Thin Slice, issue #214) — a separate, unpaginated,
// uncached fetch (deliberately not folded into getRepoStatus's ETag-cached
// call above): the task watcher's own poll cadence is independently
// configurable (MULLION_TASK_POLL_INTERVAL), and GitHub's `/issues` endpoint
// only supports filtering by ONE label per request, so this always targets
// exactly the configured task label rather than every open issue.

export interface TaskIssue {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  // #667 — GitHub's `issue_dependencies_summary.total_blocked_by`, when the
  // response carried it. `undefined` (not `0`) when absent — a webhook-built
  // TaskIssue (routes/webhooks.ts, which has no summary to read) omits this
  // field entirely rather than coercing to 0, so upsertIssueTask can tell
  // "known zero" from "unknown" and never resets a stored count. See
  // task-watcher.ts's upsertIssueTask and task-dependencies.ts's
  // dependencyGate.
  dependencyCount?: number;
  // #701 — GitHub sub-issue hierarchy. THREE-state, same reasoning as
  // dependencyCount above but in the opposite direction: `undefined` means
  // unknown (a webhook-built TaskIssue has no summary to read and must not
  // clear a previously-known parent), `null` means known-to-have-no-parent,
  // and an object means it has one. The undefined/null split is load-bearing
  // here in a way dependencyCount's isn't — a parent can legitimately be
  // REMOVED, so a poll-sourced `null` has to actively clear the stored
  // column, not just leave it alone. See task-watcher.ts's upsertIssueTask.
  parent?: { repo: string; number: number } | null;
  // Also free on the same response (item.sub_issues_summary). Present only
  // when the poll sourced this TaskIssue; a webhook-built one omits it,
  // same as dependencyCount.
  subIssues?: { total: number; completed: number };
}

/**
 * Strict, anchored parse of GitHub's `parent_issue_url` — see
 * PARENT_ISSUE_URL_RE's own comment. Anything that doesn't match exactly
 * (wrong host, malformed path, a future URL shape) is treated as "no
 * parent" rather than partially parsed. `repo` here is "owner/repo" (the
 * schema's `parentIssueRepo` column is that combined slug, since the parent
 * can live in a different repo than the child's own project) — not just
 * the repo name.
 */
function parseParentIssueUrl(
  url: string | null | undefined,
): { repo: string; number: number } | null {
  if (!url) return null;
  const match = PARENT_ISSUE_URL_RE.exec(url);
  if (!match) return null;
  const [, owner, repo, numberStr] = match;
  return { repo: `${owner}/${repo}`, number: Number(numberStr) };
}

/**
 * Fetches open issues carrying `label` — server-side label filtering via
 * GitHub's own `labels` query param cuts the response down to just that
 * label, but a PR can carry any label a normal issue can, so the same
 * `pull_request`-field filter getRepoStatus uses above still applies here.
 * Capped at the first 100 open items (one page), matching getRepoStatus's
 * own "glance list, not an exhaustive report" scope. Never cached: the task
 * watcher's own poll interval is the only throttle.
 */
export async function listLabeledIssues(
  token: string,
  owner: string,
  repo: string,
  label: string,
): Promise<TaskIssue[]> {
  // owner/repo originate from parseGitRemote's read of .git/config — same
  // "file data reaching an outbound request" shape fetchOpenPRs/
  // fetchRunsForHead below already guard against with this same call
  // (CodeQL's js/request-forgery query flags it otherwise).
  validateGitHubRepoRef(owner, repo);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const res = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
    { headers },
  );

  if (!res.ok) {
    throw new GitHubApiError(
      `GitHub API error for ${owner}/${repo} labeled issues (HTTP ${res.status})`,
      res.status,
    );
  }

  const items = (await res.json()) as (GitHubIssueApiItem & { body?: string | null })[];
  return items
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      title: item.title,
      body: item.body ?? null,
      htmlUrl: item.html_url,
      dependencyCount: item.issue_dependencies_summary?.total_blocked_by,
      // #701 — parent_issue_url is `null` for an issue with no parent (not
      // absent), so this always resolves to a definite value on a real
      // response — parseParentIssueUrl's `undefined` handling only matters
      // for a webhook-built item that omits the field entirely.
      parent: parseParentIssueUrl(item.parent_issue_url),
      subIssues:
        item.sub_issues_summary?.total !== undefined &&
        item.sub_issues_summary.completed !== undefined
          ? { total: item.sub_issues_summary.total, completed: item.sub_issues_summary.completed }
          : undefined,
    }));
}

// #939/#1016 — worker-prompt context (task-issue-context.ts). A worker's
// initial prompt today is exactly `${title}\n\n${body}` (task-prompt.ts's
// taskSpec) — these two reads are what let it also see the issue's own
// comment thread and, for a child of a tracking epic, the parent's own
// spec+comments. Deliberately separate, uncached one-off GET calls (not
// folded into listLabeledIssues' list response, which carries neither) —
// these only run once per worker SPAWN, not once per 60s poll sweep, so the
// extra request volume is negligible next to the ingest sweep's own budget.

export interface GitHubIssueComment {
  author: string | null;
  body: string;
  createdAt: string;
}

/**
 * Last `perPage` comments on an issue, newest-last (oldest-first within the
 * returned window) — matches the order a human reading the thread top-to-
 * bottom would see, and the order task-prompt.ts's own rendering expects.
 * GitHub's list-comments endpoint has no "give me the last N" mode, so this
 * asks for `direction=desc` (newest first) then reverses client-side, rather
 * than requesting `direction=asc` and hoping `perPage` happens to cover the
 * whole thread — a long thread (#939's own epic explicitly said "see each
 * issue's comments for results") would otherwise silently return only the
 * OLDEST N, which is usually the least relevant part for a worker context.
 */
export async function listIssueComments(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  perPage: number,
): Promise<GitHubIssueComment[]> {
  validateGitHubRepoRef(owner, repo);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const res = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=${perPage}&sort=created&direction=desc`,
    { headers },
  );

  if (!res.ok) {
    throw new GitHubApiError(
      `GitHub API error for ${owner}/${repo}#${issueNumber} comments (HTTP ${res.status})`,
      res.status,
    );
  }

  const items = (await res.json()) as {
    user: { login: string } | null;
    body?: string | null;
    created_at: string;
  }[];
  return items
    .map((item) => ({
      author: item.user?.login ?? null,
      body: item.body ?? "",
      createdAt: item.created_at,
    }))
    .reverse();
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  body: string | null;
}

/** A single issue's title+body — used to resolve a parent tracking issue's
 * own spec, which (unlike a child's `parent_issue_url`/`sub_issues_summary`)
 * doesn't ride any list response the child's own ingest already reads. */
export async function getIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssueSummary> {
  validateGitHubRepoRef(owner, repo);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const res = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
    { headers },
  );

  if (!res.ok) {
    throw new GitHubApiError(
      `GitHub API error for ${owner}/${repo}#${issueNumber} (HTTP ${res.status})`,
      res.status,
    );
  }

  const item = (await res.json()) as { number: number; title: string; body?: string | null };
  return { number: item.number, title: item.title, body: item.body ?? null };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-PR CI status (issue #102) — server-side poller writes to this cache,
// the /github/prs endpoint reads from it.

interface GitHubPullApiItem {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
  head: { sha: string; ref: string };
  base: { ref: string };
}

interface PRsCacheEntry {
  ts: number;
  data: GitHubPRsStatus;
}

const prsCache = new Map<string, PRsCacheEntry>();

function prsCacheSet(key: string, entry: PRsCacheEntry): void {
  if (!prsCache.has(key) && prsCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = prsCache.keys().next().value;
    if (oldestKey !== undefined) prsCache.delete(oldestKey);
  }
  prsCache.set(key, entry);
}

interface GitHubWorkflowRunItem {
  name: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
}

export function validateGitHubRepoRef(owner: string, repo: string): void {
  if (!OWNER_RE.test(owner)) throw new GitHubApiError(`Invalid GitHub owner: ${owner}`, 400);
  if (!REPO_RE.test(repo)) throw new GitHubApiError(`Invalid GitHub repo name: ${repo}`, 400);
}

async function fetchOpenPRs(token: string, owner: string, repo: string): Promise<PROrWithChecks[]> {
  validateGitHubRepoRef(owner, repo);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const res = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`,
    { headers },
  );

  if (!res.ok) {
    throw new GitHubApiError(`GitHub API error for PRs (HTTP ${res.status})`, res.status);
  }

  const items = (await res.json()) as GitHubPullApiItem[];
  return items.map((item) => ({
    number: item.number,
    title: item.title,
    htmlUrl: item.html_url,
    author: item.user?.login ?? null,
    headSha: item.head.sha,
    headBranch: item.head.ref,
    baseBranch: item.base.ref,
    ciStatus: null,
    actionsRuns: [],
  }));
}

// #744 — the release-please routes need the repo's default branch (both to
// filter the open release PR by `base` and as the dispatch `ref`) and must
// never assume `main`, the same reasoning `getPullRequestByNumber`'s
// `baseRef` field documents. `fetchActionsRuns` above already reads this
// same field internally but doesn't expose it; this is that read, exported.
// Unlike `fetchActionsRuns`'s degrade-to-`[]` posture, this throws
// GitHubApiError on failure — callers here need to distinguish "couldn't
// resolve the default branch" from "resolved it, there's just nothing
// there," which a silent `null` would collapse.
export async function getDefaultBranch(
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  validateGitHubRepoRef(owner, repo);
  const res = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) {
    throw new GitHubApiError(`GitHub API error for repo info (HTTP ${res.status})`, res.status);
  }
  const data = (await res.json()) as GitHubRepoApiResponse;
  if (!data.default_branch) {
    throw new GitHubApiError("GitHub repo info did not include a default_branch", res.status);
  }
  return data.default_branch;
}

// Exported for task-reconciler.ts's review-spawn CI gate (#738 follow-up).
// Never throws (see the try/catch below) — a lookup failure degrades to `[]`
// the same way it already does for every other caller of this function,
// which `computeCiStatus([])` reads as `null` ("no signal"), not a failure
// the caller needs its own try/catch to handle.
export async function fetchRunsForHead(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
): Promise<GitHubActionsRun[]> {
  validateGitHubRepoRef(owner, repo);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  try {
    const runsRes = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
      { headers },
    );
    if (!runsRes.ok) return [];
    const runsData = (await runsRes.json()) as { workflow_runs?: GitHubWorkflowRunItem[] };

    // GitHub returns these ordered most-recent-first, so the first time a
    // given name is seen is already its latest run (same assumption the
    // existing fetchActionsRuns above documents — see line 193).
    const seen = new Set<string>();
    const latest: GitHubActionsRun[] = [];
    for (const run of runsData.workflow_runs ?? []) {
      const name = run.name ?? "workflow";
      if (seen.has(name)) continue;
      seen.add(name);
      latest.push({
        name,
        status: run.status,
        conclusion: run.conclusion,
        htmlUrl: run.html_url,
        headSha: run.head_sha,
      });
    }
    return latest;
  } catch {
    return [];
  }
}

export interface CheckRunResult {
  name: string;
  conclusion: string | null;
}

/**
 * #755 fresh-review finding: `required_status_checks.contexts` (branch
 * protection) names match CHECK RUN names, not Workflow Run names — two
 * different GitHub API namespaces that happen to look superficially
 * similar. Verified live against this repo's own protected branch: a
 * single workflow run (`fetchRunsForHead`'s `"CI/CD"`, `"CodeQL"`, ...)
 * fans out into many individual check runs (`"test-node / lint-and-test"`,
 * `"analyze / Analyze (javascript-typescript)"`, ...), and it's the
 * check-run name GitHub itself compares against `required_status_checks
 * .contexts` when deciding merge eligibility — `fetchRunsForHead`'s names
 * never appear in that set at all. The original #755 implementation
 * compared `fetchRunsForHead`'s workflow-run names against
 * `fetchRequiredStatusContexts`'s check-run-shaped required set, which can
 * never match for a repo using GitHub's standard "require these specific
 * job checks" branch protection — the common case, not an edge case. This
 * is the fix: read `GET /commits/{sha}/check-runs` directly, in the same
 * namespace as the required set.
 *
 * `fetchRunsForHead` stays on the Workflow Runs API deliberately — its
 * other callers (the review-agent's CI summary, auto-approve's coarse
 * red/green pre-filter) only need "is anything red at all," not per-check
 * names, and Workflow Runs is one call per commit regardless of how many
 * jobs it fans out into.
 *
 * Never throws — degrades to `[]` on any failure, same posture as
 * `fetchRunsForHead`. A job configured with `continue-on-error: true` can
 * report a check-run `conclusion` other than the plain pass/fail GitHub
 * shows in its own merge-gate UI; not accounted for here, same scope
 * boundary `computeCiStatus` already draws for skipped/cancelled runs.
 *
 * Scope boundary, not covered here: `required_status_checks.contexts` can
 * name either a Check Run (what this function reads) OR a legacy Statuses
 * API context (`GET /commits/{sha}/status`) — this repo's own `main` uses
 * only Check Run names today, but a Task Master project pointed at a repo
 * whose branch protection requires a Statuses-API context would see that
 * context invisible to this lookup, and `attemptReturnRedCiToWorker` would
 * never fire for it (fails safe — the task just stays in `reviewing`, same
 * as any other `redRequired === false`). Not fixed here; would need a
 * second, differently-shaped call merged against the same required set.
 */
export async function fetchCheckRunsForHead(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
): Promise<CheckRunResult[]> {
  validateGitHubRepoRef(owner, repo);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  try {
    const res = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
      { headers },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      check_runs?: { name: string; conclusion: string | null }[];
    };
    return (data.check_runs ?? []).map((c) => ({ name: c.name, conclusion: c.conclusion }));
  } catch {
    return [];
  }
}

interface RequiredStatusContextsCacheEntry {
  contexts: string[];
  expiresAt: number;
}
const requiredStatusContextsCache = new Map<string, RequiredStatusContextsCacheEntry>();
// Branch protection changes about never — this is read on every
// processAutoApprovals tick for every candidate task otherwise (#755).
const REQUIRED_STATUS_CONTEXTS_CACHE_TTL_MS = 60 * 60_000;

/**
 * Reads `required_status_checks.contexts` from branch protection for a
 * branch — the subset of check names that actually gate a merge, as
 * opposed to every Actions run for a head commit (`computeCiStatus` makes
 * no required/non-required distinction at all). #755's red-CI-return gate
 * uses this to avoid returning a task to the worker over a red but
 * non-required check (this repo's own `test-e2e`, deliberately not
 * required — see docs/ci-cd.md).
 *
 * Returns `null`, never throws, on ANY lookup failure. The GitHub App's
 * "read" token scope (`READ_PERMISSIONS`, github-app.ts) does not include
 * `administration`, which this endpoint requires — deliberately not
 * expanded for this one lookup (see #755's own plan notes: that would be
 * unrequested scope creep for a single feature). A 403 from that missing
 * scope and a 404 (no protection configured, or the branch doesn't exist)
 * both collapse to `null`. Callers must fail CLOSED on `null` — treating it
 * as "nothing is required" would let a task stalled on a red
 * non-required-only check look identical to one this gate has an actual
 * opinion on.
 *
 * Cached per `owner/repo/branch` for `REQUIRED_STATUS_CONTEXTS_CACHE_TTL_MS`.
 * Only successes are cached — a failure is retried on the next call rather
 * than latched, since it may be transient.
 */
export async function fetchRequiredStatusContexts(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string[] | null> {
  validateGitHubRepoRef(owner, repo);
  const key = `${owner}/${repo}/${branch}`;
  const cached = requiredStatusContextsCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.contexts;

  try {
    const res = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}/protection`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      required_status_checks?: { contexts?: string[] } | null;
    };
    const contexts = data.required_status_checks?.contexts ?? [];
    requiredStatusContextsCache.set(key, {
      contexts,
      expiresAt: Date.now() + REQUIRED_STATUS_CONTEXTS_CACHE_TTL_MS,
    });
    return contexts;
  } catch {
    return null;
  }
}

// Exported for the per-branch filter (issue #202, routes/projects.ts's
// GET .../github/prs?branch=): the route re-derives the summary counts for
// its filtered subset rather than slicing the cached whole-repo summary.
export function computePRSummary(prs: PROrWithChecks[]): GitHubPRsStatus["prSummary"] {
  let pass = 0;
  let fail = 0;
  let pending = 0;
  let unknown = 0;
  for (const pr of prs) {
    if (pr.ciStatus === "success") pass++;
    else if (pr.ciStatus === "failure") fail++;
    else if (pr.ciStatus === "in_progress") pending++;
    else unknown++;
  }
  return { total: prs.length, pass, fail, pending, unknown };
}

/**
 * Fetches per-PR CI status for all open PRs in a repo. Returns both the
 * per-PR data and aggregate counts. Best-effort per-head runs: if a
 * head_sha's runs fail to fetch, that PR gets ciStatus: null.
 */
export async function getRepoPRsStatus(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubPRsStatus> {
  const prs = await fetchOpenPRs(token, owner, repo);

  // Fetch runs for all PR heads in parallel.
  const runsResults = await Promise.allSettled(
    prs.map((pr) => fetchRunsForHead(token, owner, repo, pr.headSha)),
  );

  for (let i = 0; i < prs.length; i++) {
    const result = runsResults[i];
    if (result.status === "fulfilled") {
      prs[i].actionsRuns = result.value;
      prs[i].ciStatus = computeCiStatus(result.value);
    }
  }

  const prSummary = computePRSummary(prs);

  return { prs, prSummary };
}

/** Cache key for the per-PR status data. */
function prsCacheKey(owner: string, repo: string): string {
  return `${owner}/${repo}/prs`;
}

/** Drops cached per-PR status so the next REST read goes live. */
export function invalidatePRsCache(owner: string, repo: string): void {
  prsCache.delete(prsCacheKey(owner, repo));
}

/**
 * Writes per-PR status to the cache. Called by the background poller
 * (github-pr-poller.ts) — not meant for direct route use.
 */
export function setRepoPRsStatus(owner: string, repo: string, data: GitHubPRsStatus): void {
  prsCacheSet(prsCacheKey(owner, repo), { ts: Date.now(), data });
}

/**
 * Reads per-PR status from the cache. Returns null if no entry exists or
 * the entry is older than CACHE_TTL_MS — the caller (the route) should
 * degrade to 204 rather than fetching live.
 */
export function getPRsStatus(owner: string, repo: string): GitHubPRsStatus | null {
  const key = prsCacheKey(owner, repo);
  const cached = prsCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts > CACHE_TTL_MS) {
    prsCache.delete(key);
    return null;
  }
  return cached.data;
}

// ────────────────────────────────────────────────────────────────────────────
// Job-level detail + log fetching (Phase 2, issue #221)

interface GitHubJobsApiResponse {
  total_count: number;
  jobs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
    html_url: string;
    steps: Array<{
      name: string;
      status: string;
      conclusion: string | null;
      number: number;
    }> | null;
  }>;
}

/**
 * Fetches jobs for a given workflow run. Returns an empty array on error
 * (best-effort, never throws — same pattern as fetchActionsRuns).
 */
export async function getWorkflowRunJobs(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<GitHubJob[]> {
  validateGitHubRepoRef(owner, repo);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  try {
    const res = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/jobs?per_page=100`,
      { headers },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as GitHubJobsApiResponse;
    return data.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      htmlUrl: j.html_url,
      steps:
        j.steps?.map((s) => ({
          name: s.name,
          status: s.status,
          conclusion: s.conclusion,
          number: s.number,
        })) ?? [],
    }));
  } catch {
    return [];
  }
}

/**
 * Fetches truncated logs for a given job. Returns null on error.
 * The caller passes ?lines=N to control truncation.
 */
export async function getJobLogs(
  token: string,
  owner: string,
  repo: string,
  jobId: number,
  lines: number = 50,
): Promise<string | null> {
  validateGitHubRepoRef(owner, repo);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  try {
    const res = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`,
      { headers },
    );
    if (!res.ok) return null;
    const text = await res.text();
    const parts = text.split("\n");
    const truncated = parts.slice(-lines).join("\n");
    return truncated;
  } catch {
    return null;
  }
}
