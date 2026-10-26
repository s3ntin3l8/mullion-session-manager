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
import {
  normalizeRollupState,
  parseOtherChecks,
  type ChecksRollupState,
  type OtherCheck,
} from "./github.js";
import type { PrMergeable, PrReviewDecision } from "./github-pr-phase.js";
import {
  buildReviewSummary,
  LATEST_REVIEWS_SELECTION,
  reviewersOf,
  type GqlLatestReviewNode,
} from "./review-summary.js";
import type { ReviewSummary } from "../shared/types.js";

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 100;
// 100 files per page; a PR bigger than this shows the first MAX_FILE_PAGES × 100
// and the UI says the list is partial (the header count is GitHub's own).
const MAX_FILE_PAGES = 3;

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
  /** Latest review per reviewer, every state (COMMENTED included). */
  reviewers: { login: string; state: string }[];
  /** The same server-computed status the PR list carries (epic #1965, A2). */
  reviewSummary: ReviewSummary;
  reviews: PrDetailReview[];
  threads: PrDetailThread[];
  comments: PrDetailComment[];
  /** The head commit's rollup state, which includes checks that are not Actions runs. */
  checksRollup: ChecksRollupState;
  /** Head-commit checks that are not Actions runs ("Other checks"). */
  otherChecks: OtherCheck[];
  /** The head has more checks than were read (50); the list above is partial. */
  checksTruncated?: boolean;
  /**
   * True when GraphQL was unavailable (rate limit/backoff) and this is the
   * best that could be assembled: no reviews/threads/conversation, possibly
   * an older cached copy. The UI should say so rather than show "no reviews".
   */
  partial?: boolean;
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
  headCommit: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: {
            totalCount: number;
            nodes: Parameters<typeof parseOtherChecks>[0] | null;
          } | null;
        } | null;
      };
    } | null> | null;
  } | null;
  reviewRequests: {
    nodes: Array<{
      requestedReviewer: { login?: string; name?: string } | null;
    } | null> | null;
  } | null;
  latestReviews: { nodes: Array<GqlLatestReviewNode | null> | null } | null;
  reviews: {
    nodes: Array<{
      author: GqlAuthor | null;
      state: string;
      bodyHTML: string;
      submittedAt: string | null;
      comments?: { totalCount: number } | null;
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
      headCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { totalCount nodes { __typename ... on CheckRun { name status conclusion detailsUrl checkSuite { app { slug } } } ... on StatusContext { context state targetUrl } } } } } } }
      reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
      ${LATEST_REVIEWS_SELECTION}
      reviews(last: 50) { nodes { author { login } state bodyHTML submittedAt comments { totalCount } } }
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
  const out: PrDetailFile[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const res = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return out;
    const raw = (await res.json()) as Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
    }>;
    for (const f of raw) {
      out.push({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      });
    }
    if (raw.length < 100) break;
  }
  return out;
}

interface RestPr {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged?: boolean;
  draft?: boolean;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string; sha: string };
  created_at: string;
  updated_at: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  mergeable?: boolean | null;
}

/**
 * GraphQL is unavailable: answer with what is still reachable instead of a
 * 502 that blanks the whole drill-in. An older cached copy wins (it has
 * everything, just aged); else the REST PR plus its files. Either way
 * `partial: true`. Throws only when nothing at all can be had.
 */
async function partialDetail(
  token: string,
  owner: string,
  repo: string,
  number: number,
  key: string,
  stale: PrDetail | undefined,
  files: PrDetailFile[],
): Promise<PrDetail> {
  if (stale) return { ...stale, partial: true };
  let rest: RestPr | null = null;
  try {
    const res = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) throw new GitHubApiError(`${key} not found`, 404);
    if (res.ok) rest = (await res.json()) as RestPr;
  } catch (err) {
    if (err instanceof GitHubApiError && err.statusCode === 404) throw err;
  }
  if (!rest?.base || !rest.head)
    throw new GitHubApiError(`Could not load ${key} (GitHub unavailable)`, 502);
  return {
    number: rest.number,
    title: rest.title,
    htmlUrl: rest.html_url,
    state: rest.merged ? "MERGED" : rest.state === "closed" ? "CLOSED" : "OPEN",
    isDraft: rest.draft === true,
    author: rest.user?.login ?? null,
    bodyHtml: "",
    baseBranch: rest.base.ref,
    headBranch: rest.head.ref,
    headSha: rest.head.sha,
    createdAt: rest.created_at,
    updatedAt: rest.updated_at,
    additions: rest.additions ?? 0,
    deletions: rest.deletions ?? 0,
    changedFiles: rest.changed_files ?? files.length,
    commitCount: rest.commits ?? 0,
    commits: [],
    files,
    mergeable:
      rest.mergeable === true ? "MERGEABLE" : rest.mergeable === false ? "CONFLICTING" : null,
    mergeStateStatus: null,
    reviewDecision: null,
    requestedReviewers: [],
    reviewers: [],
    reviewSummary: buildReviewSummary({
      reviewDecision: null,
      reviews: [],
      requestedReviewers: [],
      unresolvedThreads: null,
      headSha: rest.head.sha,
    }),
    reviews: [],
    threads: [],
    comments: [],
    checksRollup: null,
    otherChecks: [],
    partial: true,
  };
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
    // REST can be in rate-limit backoff too (it is what makes GraphQL refuse
    // as well); the files are then simply missing from a partial answer.
    fetchFiles(token, owner, repo, number).catch(() => [] as PrDetailFile[]),
  ]);
  const pr = data?.repository?.pullRequest;
  if (!data) return partialDetail(token, owner, repo, number, key, hit?.data, files);
  if (!pr) throw new GitHubApiError(`${key} not found`, 404);

  const toComment = (c: { author: GqlAuthor | null; bodyHTML: string; createdAt: string }) => ({
    author: c.author?.login ?? null,
    bodyHtml: c.bodyHTML,
    createdAt: c.createdAt,
  });

  const requestedReviewers = (pr.reviewRequests?.nodes ?? [])
    .map((n) => n?.requestedReviewer?.login ?? n?.requestedReviewer?.name ?? null)
    .filter(present);
  const threads = (pr.reviewThreads?.nodes ?? []).filter(present);
  const latestReviews = pr.latestReviews?.nodes ?? [];

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
    requestedReviewers,
    reviewers: reviewersOf(latestReviews),
    reviewSummary: buildReviewSummary({
      reviewDecision: asDecision(pr.reviewDecision),
      reviews: latestReviews,
      requestedReviewers,
      unresolvedThreads: threads.filter((t) => !t.isResolved).length,
      headSha: pr.headRefOid,
    }),
    reviews: (pr.reviews?.nodes ?? [])
      .filter(present)
      // An empty COMMENTED review is just the wrapper of its inline threads —
      // dropped, unless it carries some: then it is the only record that the
      // reviewer reviewed, so it stays (the threads are listed with it).
      .filter(
        (r) =>
          r.state !== "COMMENTED" || r.bodyHTML.trim() !== "" || (r.comments?.totalCount ?? 0) > 0,
      )
      .map((r) => ({
        author: r.author?.login ?? null,
        state: r.state,
        bodyHtml: r.bodyHTML,
        createdAt: r.submittedAt ?? pr.createdAt,
      })),
    threads: threads.map((t) => ({
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line,
      comments: (t.comments?.nodes ?? []).filter(present).map(toComment),
    })),
    comments: (pr.comments?.nodes ?? []).filter(present).map(toComment),
    checksRollup: normalizeRollupState(pr.headCommit?.nodes?.[0]?.commit.statusCheckRollup?.state),
    checksTruncated:
      (pr.headCommit?.nodes?.[0]?.commit.statusCheckRollup?.contexts?.totalCount ?? 0) >
      (pr.headCommit?.nodes?.[0]?.commit.statusCheckRollup?.contexts?.nodes?.length ?? 0),
    otherChecks: parseOtherChecks(
      pr.headCommit?.nodes?.[0]?.commit.statusCheckRollup?.contexts?.nodes ?? [],
    ),
  };

  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), data: detail });
  return detail;
}
