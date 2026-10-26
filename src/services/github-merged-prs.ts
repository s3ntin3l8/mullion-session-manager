import { getPullRequestByNumber, listClosedPullRequests } from "./github-write.js";
import type { ClosedPullRequest } from "./github-write.js";

// Shared "which PRs of this repo are already closed/merged" lookup. Task
// Master's clear-done / archive-merged flows and the Git panel's branch
// detail (squash-merged branches are not ancestors of main, so git alone
// can't tell they're done) both need it. One paginated closed-PR listing per
// repo — never a call per branch or per PR — cached for 5 minutes and dropped
// by the PR webhook (`invalidateMergedPrs`).

const CACHE_TTL_MS = 5 * 60 * 1000;
/** 3 pages x 100 = the 300 most recently updated closed PRs. */
const MAX_PAGES = 3;
const MAX_CACHE_ENTRIES = 100;

export interface ClosedPrRecord {
  number: number;
  url: string;
  state: "merged" | "closed";
  headRef: string;
  headSha: string;
  mergedAt: string | null;
}

interface RepoEntry {
  at: number;
  byNumber: Map<number, ClosedPrRecord>;
  /** Newest closed PR per head branch name (same-repo heads only). */
  byBranch: Map<string, ClosedPrRecord>;
}

const cache = new Map<string, RepoEntry>();
const inFlight = new Map<string, Promise<RepoEntry>>();

function key(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

function toRecord(pr: ClosedPullRequest): ClosedPrRecord {
  return {
    number: pr.number,
    url: pr.htmlUrl,
    state: pr.mergedAt ? "merged" : "closed",
    headRef: pr.headRef,
    headSha: pr.headSha,
    mergedAt: pr.mergedAt,
  };
}

async function load(token: string, owner: string, repo: string): Promise<RepoEntry> {
  const byNumber = new Map<number, ClosedPrRecord>();
  const byBranch = new Map<string, ClosedPrRecord>();
  const self = key(owner, repo);
  for (let page = 1; page <= MAX_PAGES; page++) {
    const prs = await listClosedPullRequests(token, owner, repo, page);
    for (const pr of prs) {
      const record = toRecord(pr);
      byNumber.set(pr.number, record);
      // A fork's PR from a same-named branch says nothing about our branch.
      if (pr.headRepo?.toLowerCase() !== self) continue;
      // Pages are newest-updated first, so the first PR seen per branch wins.
      if (!byBranch.has(pr.headRef)) byBranch.set(pr.headRef, record);
    }
    if (prs.length < 100) break;
  }
  return { at: Date.now(), byNumber, byBranch };
}

async function getEntry(
  token: string,
  owner: string,
  repo: string,
  fresh: boolean,
): Promise<RepoEntry> {
  const k = key(owner, repo);
  const hit = cache.get(k);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const pending = inFlight.get(k);
  if (pending) return pending;
  const promise = load(token, owner, repo)
    .then((entry) => {
      if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(k)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(k, entry);
      return entry;
    })
    .finally(() => inFlight.delete(k));
  inFlight.set(k, promise);
  return promise;
}

/**
 * Closed/merged PRs of a repo keyed by head branch name. `fresh` bypasses the
 * cache — a destructive caller re-validating a decision must not trust a
 * five-minute-old answer.
 */
export async function getClosedPrsByBranch(
  token: string,
  owner: string,
  repo: string,
  opts?: { fresh?: boolean },
): Promise<Map<string, ClosedPrRecord>> {
  return (await getEntry(token, owner, repo, opts?.fresh === true)).byBranch;
}

/**
 * Whether PR `number` merged. A merge is irreversible, so a cached "merged"
 * is final and saves the call; anything else (open, closed, unknown, not in
 * the cached window) goes to GitHub for a live answer.
 */
export async function isPullRequestMerged(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<{ merged: boolean; mergedAt: string | null }> {
  const cached = cache.get(key(owner, repo))?.byNumber.get(number);
  if (cached?.state === "merged") return { merged: true, mergedAt: cached.mergedAt };
  const pr = await getPullRequestByNumber(token, owner, repo, number);
  return { merged: pr.merged, mergedAt: pr.mergedAt };
}

/** Drops a repo's cached closed-PR listing (PR webhook). */
export function invalidateMergedPrs(owner: string, repo: string): void {
  cache.delete(key(owner, repo));
}

export function clearMergedPrsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
