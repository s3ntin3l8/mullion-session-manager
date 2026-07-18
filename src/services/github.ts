// Plain-fetch client for the GitHub REST API (issue #27) — no octokit or
// other GitHub SDK dependency, matching this repo's existing "no HTTP
// client library, just fetch" convention (see remote-host-client.ts).
// Runs only on the primary (it needs the decrypted token from
// github-integration.ts, which the caller — routes/projects.ts — passes in;
// this module never imports that service itself, keeping the two
// independently testable).

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 5_000;
const USER_AGENT = "tessera-session-manager";

// Fetch-on-open + short TTL, not background polling — see the plan's
// "protect the 5000/hr budget" note. A project's Dock widget/panel re-fetches
// at most this often even if the user reopens it repeatedly.
const CACHE_TTL_MS = 60_000;

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

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

// Aggregate read for the Dock widget's single CI dot — "in_progress" if any
// latest run hasn't completed yet, "failure" if any completed run didn't
// succeed, "success" only if every one did. `null` means no Actions data at
// all (disabled, no runs, or the lookup itself failed) — the dot/section
// just doesn't render for that case (routes/projects.ts's GET .../github
// still 200s; this is a feature-detect, not an error).
export type GitHubCiStatus = "success" | "failure" | "in_progress" | null;

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

function computeCiStatus(runs: GitHubActionsRun[]): GitHubCiStatus {
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
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };

  try {
    const repoRes = await fetch(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
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
    const runsRes = await fetch(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?branch=${encodeURIComponent(defaultBranch)}&per_page=100`,
      { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
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
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  let res: Response;
  try {
    res = await fetch(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=100`,
      {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch (err) {
    throw new GitHubApiError(
      `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

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
