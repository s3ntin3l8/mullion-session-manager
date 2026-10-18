// Single-PR detail for the sidebar's PR drill-in: header, change stats,
// reviews, review threads and the issue-comment conversation, plus the
// changed-file list. Bodies are GitHub-rendered HTML (`bodyHTML`); the
// frontend sanitizes before inserting.
//
// One GraphQL query (cost ≈ a handful of points; it shares the review
// enrichment's separate GraphQL backoff, see github-pr-reviews.ts) plus one
// REST call for the files (newest-first windows — `last:` — so a busy PR shows its latest activity), cached for 30s per PR so a re-open or a burst of
// webhook nudges doesn't re-spend either budget.

import { githubApiFetch, GitHubApiError } from "./github-fetch.js";
import { graphql } from "./github-pr-reviews.js";
import type { PrMergeable, PrReviewDecision } from "./github-pr-phase.js";

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 100;

export interface PrDetailComment {
  author: string | null;
  bodyHtml: string;
  createdAt: string;
}

export interface PrDetailReview extends PrDetailComment {
  state: string;
}

export interface PrDetailThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: PrDetailComment[];
}

export interface PrDetailFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PrDetailCommit {
  oid: string;
  headline: string;
  author: string | null;
  committedDate: string;
}

export interface PrDetail {
  number: number;
  title: string;
  htmlUrl: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: string | null;
  bodyHtml: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  commits: PrDetailCommit[];
  files: PrDetailFile[];
  mergeable: PrMergeable;
  mergeStateStatus: string | null;
  reviewDecision: PrReviewDecision;
  requestedReviewers: string[];
  /** Latest opinionated review per reviewer. */
  reviewers: { login: string; state: string }[];
  reviews: PrDetailReview[];
  threads: PrDetailThread[];
  comments: PrDetailComment[];
}

interface GqlAuthor {
  login: string;
}

interface GqlPr {
  number: number;
  title: string;
  url: string;
  bodyHTML: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  author: GqlAuthor | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  commits: {
    totalCount: number;
    nodes: Array<{
      commit: {
        oid: string;
        messageHeadline: string;
        committedDate: string;
        author: { name: string | null } | null;
      };
    } | null> | null;
  } | null;
  reviewRequests: {
    nodes: Array<{
      requestedReviewer: { login?: string; name?: string } | null;
    } | null> | null;
  } | null;
  latestOpinionatedReviews: {
    nodes: Array<{ author: GqlAuthor | null; state: string } | null> | null;
  } | null;
  reviews: {
    nodes: Array<{
      author: GqlAuthor | null;
      state: string;
      bodyHTML: string;
      submittedAt: string | null;
    } | null> | null;
  } | null;
  reviewThreads: {
    nodes: Array<{
      isResolved: boolean;
      isOutdated: boolean;
      path: string | null;
      line: number | null;
      comments: {
        nodes: Array<{
          author: GqlAuthor | null;
          bodyHTML: string;
          createdAt: string;
        } | null> | null;
      } | null;
    } | null> | null;
  } | null;
  comments: {
    nodes: Array<{ author: GqlAuthor | null; bodyHTML: string; createdAt: string } | null> | null;
  } | null;
}

const QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title url bodyHTML state isDraft baseRefName headRefName headRefOid
      additions deletions changedFiles createdAt updatedAt
      author { login }
      mergeable mergeStateStatus reviewDecision
      commits(last: 20) { totalCount nodes { commit { oid messageHeadline committedDate author { name } } } }
      reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
      latestOpinionatedReviews(first: 20) { nodes { author { login } state } }
      reviews(last: 50) { nodes { author { login } state bodyHTML submittedAt } }
      reviewThreads(last: 50) { nodes { isResolved isOutdated path line comments(first: 30) { nodes { author { login } bodyHTML createdAt } } } }
      comments(last: 50) { nodes { author { login } bodyHTML createdAt } }
    }
  }
}`;

const cache = new Map<string, { ts: number; data: PrDetail }>();

export function invalidatePrDetail(owner: string, repo: string, number?: number): void {
  const prefix = `${owner}/${repo}#`;
  for (const key of cache.keys()) {
    if (number === undefined ? key.startsWith(prefix) : key === `${prefix}${number}`) {
      cache.delete(key);
    }
  }
}

export function resetPrDetailCacheForTests(): void {
  cache.clear();
}

function asDecision(v: string | null): PrReviewDecision {
  return v === "APPROVED" || v === "CHANGES_REQUESTED" || v === "REVIEW_REQUIRED" ? v : null;
}

function asMergeable(v: string | null): PrMergeable {
  return v === "MERGEABLE" || v === "CONFLICTING" || v === "UNKNOWN" ? v : null;
}

const present = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

async function fetchFiles(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<PrDetailFile[]> {
  const res = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  const raw = (await res.json()) as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
  return raw.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
  }));
}

export async function getPrDetail(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<PrDetail> {
  const key = `${owner}/${repo}#${number}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

  const [data, files] = await Promise.all([
    graphql<{ repository: { pullRequest: GqlPr | null } | null }>(token, QUERY, {
      owner,
      repo,
      number,
    }),
    fetchFiles(token, owner, repo, number),
  ]);
  const pr = data?.repository?.pullRequest;
  if (!data) throw new GitHubApiError(`Could not load ${key} (GraphQL unavailable)`, 502);
  if (!pr) throw new GitHubApiError(`${key} not found`, 404);

  const toComment = (c: { author: GqlAuthor | null; bodyHTML: string; createdAt: string }) => ({
    author: c.author?.login ?? null,
    bodyHtml: c.bodyHTML,
    createdAt: c.createdAt,
  });

  const detail: PrDetail = {
    number: pr.number,
    title: pr.title,
    htmlUrl: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    author: pr.author?.login ?? null,
    bodyHtml: pr.bodyHTML,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    headSha: pr.headRefOid,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commitCount: pr.commits?.totalCount ?? 0,
    commits: (pr.commits?.nodes ?? []).filter(present).map((n) => ({
      oid: n.commit.oid,
      headline: n.commit.messageHeadline,
      author: n.commit.author?.name ?? null,
      committedDate: n.commit.committedDate,
    })),
    files,
    mergeable: asMergeable(pr.mergeable),
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: asDecision(pr.reviewDecision),
    requestedReviewers: (pr.reviewRequests?.nodes ?? [])
      .map((n) => n?.requestedReviewer?.login ?? n?.requestedReviewer?.name ?? null)
      .filter(present),
    reviewers: (pr.latestOpinionatedReviews?.nodes ?? [])
      .filter(present)
      .filter((n) => n.author !== null)
      .map((n) => ({ login: n.author!.login, state: n.state })),
    reviews: (pr.reviews?.nodes ?? [])
      .filter(present)
      // Empty COMMENTED reviews are just the wrapper of inline threads.
      .filter((r) => r.state !== "COMMENTED" || r.bodyHTML.trim() !== "")
      .map((r) => ({
        author: r.author?.login ?? null,
        state: r.state,
        bodyHtml: r.bodyHTML,
        createdAt: r.submittedAt ?? pr.createdAt,
      })),
    threads: (pr.reviewThreads?.nodes ?? []).filter(present).map((t) => ({
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line,
      comments: (t.comments?.nodes ?? []).filter(present).map(toComment),
    })),
    comments: (pr.comments?.nodes ?? []).filter(present).map(toComment),
  };

  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), data: detail });
  return detail;
}
