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

export interface GitHubRepoStatus {
  repo: { owner: string; repo: string; htmlUrl: string };
  openIssues: number;
  openPRs: number;
  pulls: GitHubIssueOrPr[];
  issues: GitHubIssueOrPr[];
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

  const data: GitHubRepoStatus = {
    repo: { owner, repo, htmlUrl: `https://github.com/${owner}/${repo}` },
    openIssues: issues.length,
    openPRs: pulls.length,
    pulls,
    issues,
  };
  cacheSet(key, { ts: Date.now(), etag: res.headers.get("etag"), data });
  return data;
}
