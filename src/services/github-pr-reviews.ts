// Review-state enrichment for the open-PR list (the sidebar's "does this PR
// need me?" data). The REST PR list has no review decision, mergeability,
// requested reviewers or thread state — all GraphQL-only — so the background
// poller (github-pr-poller.ts) layers this on top of getRepoPRsStatus.
//
// GraphQL points are a SEPARATE budget from REST, and cost scales with
// `first:` × parent count, not with what comes back. So the base query is
// deliberately small (≈1–3 points, `PR_PAGE` PRs, 5 reviews/requests each),
// and unresolved-thread counts — the expensive part — are fetched only for
// PRs whose `updatedAt` moved since the last poll, then cached per PR.
//
// Everything here is best-effort and never throws: a failure leaves the PRs
// with their neutral defaults. It also keeps its OWN backoff instead of
// githubApiFetch's process-wide `rateLimitedUntil` — a GraphQL limit must
// not pause the REST calls (CI badges) that work today.

import { applyPrPhase, type PROrWithChecks } from "./github.js";
import { isGitHubRateLimited } from "./github-fetch.js";
import type { PrMergeable, PrReviewDecision } from "./github-pr-phase.js";

const GRAPHQL_URL = "https://api.github.com/graphql";
const REQUEST_TIMEOUT_MS = 8_000;
// Newest-updated PRs enriched per repo. A PR beyond this page keeps its
// last-known review state, or stays phase "unknown" if it never had one —
// it self-corrects as soon as the PR sees activity moves it into the page.
const PR_PAGE = 50;
const THREADS_PER_PR = 50;
// Stop spending points when the hourly budget is nearly gone; resume at reset.
const LOW_BUDGET_REMAINING = 200;
const DEFAULT_BACKOFF_MS = 60_000;

let graphqlBackoffUntil = 0;

/** The poller's logger, narrowed to what this module uses. */
export interface ReviewLog {
  warn(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}
// Last failure reason that was warned about, so a permanent failure (e.g. a
// token that can't read these fields) logs once, not every 15s tick.
let lastWarnedFailure: string | null = null;

function noteFailure(log: ReviewLog | undefined, reason: string, extra: object = {}): void {
  if (!log || lastWarnedFailure === reason) return;
  lastWarnedFailure = reason;
  log.warn(
    { reason, ...extra },
    "[github-pr-reviews] review-state lookup failed; PR phases fall back to last known / unknown",
  );
}

export function resetGraphqlBackoffForTests(): void {
  graphqlBackoffUntil = 0;
  lastWarnedFailure = null;
  threadCache.clear();
  lastKnown.clear();
}

export function graphqlBackoffRemainingMs(): number {
  return Math.max(0, graphqlBackoffUntil - Date.now());
}

// "owner/repo#number" → thread count as of `updatedAt`. Also expires on a
// timer: resolving a thread doesn't reliably bump the PR's `updatedAt`, so
// the count is re-fetched at least this often.
const THREAD_CACHE_MAX_AGE_MS = 5 * 60_000;
const threadCache = new Map<string, { updatedAt: string; unresolved: number; ts: number }>();

type ReviewFields = Pick<
  PROrWithChecks,
  | "isDraft"
  | "updatedAt"
  | "reviewDecision"
  | "mergeable"
  | "mergeStateStatus"
  | "reviewers"
  | "requestedReviewers"
  | "unresolvedThreads"
  | "commentCount"
  | "reviewStateKnown"
>;

// Last successfully fetched review fields per PR. A failed or backed-off
// GraphQL call reuses these (stale but real) instead of resetting every PR to
// "unknown", which would flip phases and push the browser for no real change.
const lastKnown = new Map<string, ReviewFields>();

function reviewFieldsOf(pr: PROrWithChecks): ReviewFields {
  return {
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    reviewDecision: pr.reviewDecision,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewers: pr.reviewers,
    requestedReviewers: pr.requestedReviewers,
    unresolvedThreads: pr.unresolvedThreads,
    commentCount: pr.commentCount,
    reviewStateKnown: pr.reviewStateKnown,
  };
}

interface RateLimitNode {
  cost: number;
  remaining: number;
  resetAt: string;
}

interface GqlPrNode {
  number: number;
  isDraft: boolean;
  updatedAt: string;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  reviewRequests: {
    nodes: Array<{
      requestedReviewer: { __typename?: string; login?: string; name?: string } | null;
    } | null> | null;
  } | null;
  latestOpinionatedReviews: {
    nodes: Array<{ author: { login: string } | null; state: string } | null> | null;
  } | null;
  comments: { totalCount: number } | null;
}

const PR_LIST_QUERY = `query($owner: String!, $repo: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: ${PR_PAGE}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number isDraft updatedAt mergeable mergeStateStatus reviewDecision
        reviewRequests(first: 5) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
        latestOpinionatedReviews(first: 5) { nodes { author { login } state } }
        comments { totalCount }
      }
    }
  }
}`;

async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  log?: ReviewLog,
  // Only the primary list query re-arms the warning: the secondary thread
  // query is clean even when the list query keeps failing partially.
  rearmOnClean = false,
): Promise<T | null> {
  // Don't pile onto a REST rate limit either — same GitHub account, and the
  // caller (the poller) will simply retry next tick.
  if (isGitHubRateLimited() || Date.now() < graphqlBackoffUntil) return null;

  let res: Response;
  try {
    res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "User-Agent": "mullion-session-manager",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    noteFailure(log, "network");
    return null;
  }

  if (res.status === 429 || res.status === 403) {
    noteFailure(log, `http ${res.status}`);
    const retryAfter = Number(res.headers.get("retry-after"));
    graphqlBackoffUntil =
      Date.now() +
      (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_BACKOFF_MS);
    return null;
  }
  if (!res.ok) {
    noteFailure(log, `http ${res.status}`);
    return null;
  }

  let json: { data?: T; errors?: Array<{ type?: string; message: string }> };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return null;
  }
  if (json.errors?.length) noteFailure(log, json.errors[0].type ?? json.errors[0].message);
  else if (rearmOnClean) lastWarnedFailure = null; // a clean list response re-arms the warning
  if (json.errors?.some((e) => e.type === "RATE_LIMITED")) {
    graphqlBackoffUntil = Date.now() + DEFAULT_BACKOFF_MS;
    return null;
  }
  // Partial data (e.g. one field denied by a narrow token) is still useful.
  return json.data ?? null;
}

function noteBudget(rateLimit: RateLimitNode | undefined, log?: ReviewLog): void {
  if (rateLimit) {
    log?.debug(
      { cost: rateLimit.cost, remaining: rateLimit.remaining },
      "[github-pr-reviews] GraphQL budget",
    );
  }
  if (!rateLimit || rateLimit.remaining >= LOW_BUDGET_REMAINING) return;
  const resetAt = Date.parse(rateLimit.resetAt);
  graphqlBackoffUntil = Number.isNaN(resetAt) ? Date.now() + DEFAULT_BACKOFF_MS : resetAt;
}

function asDecision(value: string | null): PrReviewDecision {
  return value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED"
    ? value
    : null;
}

function asMergeable(value: string | null): PrMergeable {
  return value === "MERGEABLE" || value === "CONFLICTING" || value === "UNKNOWN" ? value : null;
}

/**
 * Fills the review fields on `prs` in place (and re-derives `prPhase`).
 * Never throws; on any failure the PRs keep their defaults.
 */
export async function enrichPrsWithReviewState(
  token: string,
  owner: string,
  repo: string,
  prs: PROrWithChecks[],
  log?: ReviewLog,
): Promise<void> {
  if (prs.length === 0) return;
  const keyFor = (n: number) => `${owner}/${repo}#${n}`;
  const reuseLastKnown = () => {
    for (const pr of prs) {
      const known = lastKnown.get(keyFor(pr.number));
      if (known) Object.assign(pr, known);
      applyPrPhase(pr);
    }
  };

  const data = await graphql<{
    rateLimit?: RateLimitNode;
    repository: { pullRequests: { nodes: Array<GqlPrNode | null> | null } | null } | null;
  }>(token, PR_LIST_QUERY, { owner, repo }, log, true);
  if (!data?.repository) return reuseLastKnown();
  noteBudget(data.rateLimit, log);

  const byNumber = new Map<number, GqlPrNode>();
  for (const node of data.repository.pullRequests?.nodes ?? []) {
    if (node) byNumber.set(node.number, node);
  }

  const needThreads: number[] = [];
  for (const pr of prs) {
    const node = byNumber.get(pr.number);
    if (!node) {
      // Past the enriched page: keep whatever was last known for it.
      const known = lastKnown.get(keyFor(pr.number));
      if (known) Object.assign(pr, known);
      continue;
    }
    pr.reviewStateKnown = true;
    pr.isDraft = node.isDraft;
    pr.updatedAt = node.updatedAt;
    pr.reviewDecision = asDecision(node.reviewDecision);
    pr.mergeable = asMergeable(node.mergeable);
    pr.mergeStateStatus = node.mergeStateStatus;
    pr.commentCount = node.comments?.totalCount ?? null;
    pr.requestedReviewers = (node.reviewRequests?.nodes ?? [])
      .map((n) => n?.requestedReviewer?.login ?? n?.requestedReviewer?.name ?? null)
      .filter((v): v is string => v !== null);
    pr.reviewers = (node.latestOpinionatedReviews?.nodes ?? [])
      .filter((n): n is NonNullable<typeof n> => n !== null && n.author !== null)
      .map((n) => ({ login: n.author!.login, state: n.state }));

    const cached = threadCache.get(keyFor(pr.number));
    if (
      cached &&
      cached.updatedAt === node.updatedAt &&
      Date.now() - cached.ts < THREAD_CACHE_MAX_AGE_MS
    ) {
      pr.unresolvedThreads = cached.unresolved;
    } else {
      needThreads.push(pr.number);
    }
  }

  if (needThreads.length > 0) {
    // Aliased single request. Numbers come from GitHub's own response, so
    // inlining them is safe; the isInteger guard is belt and braces.
    const aliases = needThreads
      .filter((n) => Number.isInteger(n))
      .map(
        (n) =>
          `p${n}: pullRequest(number: ${n}) { reviewThreads(first: ${THREADS_PER_PR}) { nodes { isResolved } } }`,
      )
      .join("\n");
    const threads = await graphql<{
      rateLimit?: RateLimitNode;
      repository: Record<
        string,
        { reviewThreads: { nodes: Array<{ isResolved: boolean } | null> | null } | null } | null
      > | null;
    }>(
      token,
      `query($owner: String!, $repo: String!) {
        rateLimit { cost remaining resetAt }
        repository(owner: $owner, name: $repo) { ${aliases} }
      }`,
      { owner, repo },
      log,
    );
    noteBudget(threads?.rateLimit, log);
    for (const n of needThreads) {
      const entry = threads?.repository?.[`p${n}`];
      const node = byNumber.get(n);
      if (!entry || !node) continue;
      // A nulled connection means "not fetched", not "no threads".
      if (!entry.reviewThreads?.nodes) continue;
      const unresolved = entry.reviewThreads.nodes.filter((t) => t && !t.isResolved).length;
      threadCache.set(keyFor(n), { updatedAt: node.updatedAt, unresolved, ts: Date.now() });
      const pr = prs.find((p) => p.number === n);
      if (pr) pr.unresolvedThreads = unresolved;
    }
  }

  // A thread lookup that failed leaves `unresolvedThreads` null for a PR we
  // had a count for — keep the old one rather than flapping to "not fetched".
  for (const pr of prs) {
    if (pr.unresolvedThreads === null) {
      pr.unresolvedThreads = lastKnown.get(keyFor(pr.number))?.unresolvedThreads ?? null;
    }
    if (byNumber.has(pr.number)) lastKnown.set(keyFor(pr.number), reviewFieldsOf(pr));
  }

  // Bound both caches to this repo's currently open PRs.
  const live = new Set(prs.map((p) => keyFor(p.number)));
  const prefix = `${owner}/${repo}#`;
  for (const cache of [threadCache, lastKnown] as Array<Map<string, unknown>>) {
    for (const key of cache.keys()) {
      if (key.startsWith(prefix) && !live.has(key)) cache.delete(key);
    }
  }

  for (const pr of prs) applyPrPhase(pr);
}
