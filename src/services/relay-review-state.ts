import type { FastifyInstance } from "fastify";
import type { RelayReviewState } from "../shared/types.js";
import type { PROrWithChecks } from "./github.js";
import { listPullRequestReviews } from "./github-write.js";
import { getReviewRunForPr } from "./hermes-review.js";
import { getStoredSettings } from "./settings.js";

export type LandedReview =
  | {
      checked: true;
      review: {
        author: string;
        state: string;
        commitId: string;
        submittedAt: string;
        /** The review's own text (issue #1704), bounded on the way in. */
        body?: string;
        bodyTruncated?: boolean;
        /** The review's page on GitHub. */
        htmlUrl?: string;
      } | null;
    }
  | { checked: false };

/**
 * The review states that count as "a review landed": the ones a bot actually
 * submits. A DISMISSED review was retracted, so it did not land. Both the
 * landed-review check and the duplicate-review warning use this one
 * definition, so `review status` and the warning never disagree.
 */
export const LANDED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);

// GitHub logins are case-insensitive, so a stored `S3ntin3l8-Hermes[bot]` must
// still match the account's canonical login. Empty = any bot (the old rule).
export function isReviewerLogin(author: string, reviewerBotLogin: string): boolean {
  return reviewerBotLogin === "" || author.toLowerCase() === reviewerBotLogin.toLowerCase();
}

// Best effort: the newest review by the reviewer's own bot account
// (`reviewRelay.reviewerBotLogin`; empty = any bot, the same rule as
// `reviewReader().base`) submitted after the run was dispatched and pinned to
// the commit it was dispatched for. Another bot's review (claude[bot],
// Copilot, ...) is not the relay's review and must not show as "posted". A
// GitHub failure must not hide the Hermes status.
export async function findLandedReview(
  app: FastifyInstance,
  token: string,
  t: { owner: string; repo: string; prNumber: number },
  record: { dispatchedAt: number; headSha: string } | null,
): Promise<LandedReview> {
  if (!record) return { checked: false };
  const { dispatchedAt, headSha } = record;
  const { reviewerBotLogin } = getStoredSettings(app.db).reviewRelay;
  try {
    const reviews = await listPullRequestReviews(token, t.owner, t.repo, t.prNumber);
    const landed = reviews
      .filter(
        (r) =>
          r.authorIsBot &&
          isReviewerLogin(r.author, reviewerBotLogin) &&
          r.commitId === headSha &&
          // The same "landed" definition the duplicate-review warning uses
          // (LANDED_REVIEW_STATES) — a DISMISSED review was retracted, so
          // it did not land, and "posted: <author> DISMISSED" would say
          // otherwise.
          LANDED_REVIEW_STATES.has(r.state) &&
          r.submittedAt &&
          Date.parse(r.submittedAt) >= dispatchedAt - 60_000,
      )
      .at(-1);
    if (!landed) {
      // Another bot's review of this head is visible on GitHub but is not the
      // relay's: say so, or "requested" with a posted review looks like a bug.
      const ignored = reviews.filter(
        (r) =>
          r.authorIsBot &&
          !isReviewerLogin(r.author, reviewerBotLogin) &&
          r.commitId === headSha &&
          LANDED_REVIEW_STATES.has(r.state),
      );
      if (ignored.length > 0) {
        app.log.warn(
          { authors: [...new Set(ignored.map((r) => r.author))], reviewerBotLogin },
          "review-status: ignoring review(s) by other bots (not reviewRelay.reviewerBotLogin)",
        );
      }
    }
    return {
      checked: true,
      review: landed
        ? {
            author: landed.author,
            state: landed.state,
            commitId: landed.commitId,
            submittedAt: landed.submittedAt as string,
            // The reviewer's actual words — the one thing an agent that asked
            // for a review came for (issue #1704).
            ...(landed.body !== undefined ? { body: landed.body } : {}),
            ...(landed.bodyTruncated ? { bodyTruncated: true } : {}),
            ...(landed.htmlUrl !== undefined ? { htmlUrl: landed.htmlUrl } : {}),
          }
        : null,
    };
  } catch (err) {
    app.log.warn({ detail: (err as Error).message }, "review-status: GitHub review lookup failed");
    return { checked: false };
  }
}

/**
 * The relay's state for one pull request (issue #1630) — the state the
 * operator needs to see: was a review requested, is it still in flight, did
 * the bot's review land, and what did it say.
 *
 * The shape lives in src/shared/types.ts so the frontend cannot drift from
 * it; the doc there says what `"none"` does and does not mean.
 */
export type { RelayReviewState };

// The landed check costs a GitHub call, and the UI polls while a review is
// pending — so the answer is memoized per run for a short while. The window
// is well under the PR drill-in's own poll interval (30s), so a review that
// lands now is never hidden for more than one poll cycle.
//
// The memo lives on the app (a WeakMap keyed by it), not in a module-level
// map: a second buildApp() in the same process must not inherit the first
// one's answers.
const LANDED_MEMO_TTL_MS = 10_000;
const MAX_LANDED_MEMO_ENTRIES = 500;
//
// A landed review is *terminal*: the PR poller asks every few seconds, and a
// review that has landed does not un-land, so re-fetching it would cost one
// GitHub call per relay-known PR per tick, forever. Only the cap evicts it.
// Anything else (still requested, or the lookup failed) keeps the short TTL.
interface LandedMemoEntry {
  landed: LandedReview;
  at: number;
  terminal: boolean;
}
const landedMemos = new WeakMap<FastifyInstance, Map<string, LandedMemoEntry>>();

function isLanded(landed: LandedReview): boolean {
  return landed.checked && landed.review !== null;
}

function landedMemoFor(app: FastifyInstance): Map<string, LandedMemoEntry> {
  let memo = landedMemos.get(app);
  if (!memo) {
    memo = new Map();
    landedMemos.set(app, memo);
  }
  return memo;
}

/**
 * Keeps the landed-review memo within its cap.
 *
 * The age sweep first: an entry past its TTL is worthless anyway. When that
 * frees nothing — a burst of *fresh* entries, which is exactly what a burst
 * of re-reviews is, since the key is per (PR, runId) — the oldest entries
 * are evicted instead, so the map cannot grow past the cap.
 */
export function pruneLandedMemo(
  memo: Map<string, { at: number; terminal?: boolean }>,
  now: number,
  max: number = MAX_LANDED_MEMO_ENTRIES,
): void {
  if (memo.size <= max) return;
  for (const [key, entry] of memo) {
    if (!entry.terminal && now - entry.at >= LANDED_MEMO_TTL_MS) memo.delete(key);
  }
  if (memo.size <= max) return;
  const oldest = [...memo.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of oldest) {
    memo.delete(key);
    if (memo.size <= max) break;
  }
}

/**
 * The relay's state for a pull request, as the operator's UI sees it
 * (issue #1630). Needs a GitHub token to look for the landed review; without
 * one it still reports the request itself.
 */
export async function getRelayReviewState(
  app: FastifyInstance,
  opts: { owner: string; repo: string; prNumber: number; token?: string | null },
): Promise<RelayReviewState> {
  const { owner, repo, prNumber } = opts;
  const record = getReviewRunForPr(owner, repo, prNumber);
  if (!record) return { state: "none" };

  const base: RelayReviewState = {
    state: "requested",
    runId: record.runId,
    dispatchedAt: new Date(record.dispatchedAt).toISOString(),
  };
  if (!opts.token) {
    // No token means the landed-review lookup cannot run at all — so the
    // review is *unconfirmed*, not "not landed".
    return { ...base, landedChecked: false };
  }

  // The memo is keyed by the run, so a new dispatch re-checks immediately.
  const memo = landedMemoFor(app);
  const memoKey = `${owner}/${repo}#${prNumber}@${record.runId}`;
  const cached = memo.get(memoKey);
  const now = Date.now();
  let landed: LandedReview;
  if (cached && (cached.terminal || now - cached.at < LANDED_MEMO_TTL_MS)) {
    // A HIT does NOT re-stamp the entry: a sliding window would let any
    // reader faster than the TTL pin the cached answer indefinitely — and
    // the PR list is refreshed on every webhook event, so a CI-active PR
    // would never see a review land.
    landed = cached.landed;
  } else {
    landed = await findLandedReview(app, opts.token, { owner, repo, prNumber }, record);
    memo.set(memoKey, { landed, at: now, terminal: isLanded(landed) });
    // The memo holds a review body per PR; drop the entries that can no
    // longer be hit, so it cannot grow with the process.
    pruneLandedMemo(memo, now);
  }

  if (landed.checked && landed.review) {
    return {
      ...base,
      state: "landed",
      landedChecked: true,
      author: landed.review.author,
      verdict: landed.review.state,
      ...(landed.review.body !== undefined ? { body: landed.review.body } : {}),
      ...(landed.review.bodyTruncated ? { bodyTruncated: true } : {}),
      ...(landed.review.htmlUrl !== undefined ? { htmlUrl: landed.review.htmlUrl } : {}),
    };
  }
  // `landedChecked: false` means the lookup itself failed — the UI can say
  // "could not confirm" instead of claiming the review is simply not there.
  return { ...base, landedChecked: landed.checked };
}

/**
 * Annotates a repo's pull requests with the review relay's state for each
 * (issues #1630, #1744). Runs in the PR poller, so the slow GitHub call that
 * looks for a landed review never sits in a request path: the routes read the
 * annotated cache.
 *
 * Only a PR the relay knows about costs anything: the run index is in-memory,
 * so a PR with no run in it is left exactly as it was, and the GitHub call
 * happens only for the few PRs that actually have a run. With no token the PR
 * still shows that a review was requested — it just cannot say whether it
 * landed (the state says "could not confirm", not "not landed").
 *
 * A GitHub failure while looking for a landed review is already absorbed by
 * `findLandedReview` (it reports `landedChecked: false`).
 */
export async function annotateRelayReviewState(
  app: FastifyInstance,
  prs: PROrWithChecks[],
  repoRef: { owner: string; repo: string },
  token: string | null,
): Promise<PROrWithChecks[]> {
  if (!prs.some((pr) => getReviewRunForPr(repoRef.owner, repoRef.repo, pr.number) !== null)) {
    return prs;
  }
  return Promise.all(
    prs.map(async (pr) => {
      if (getReviewRunForPr(repoRef.owner, repoRef.repo, pr.number) === null) return pr;
      const relayReview = await getRelayReviewState(app, {
        owner: repoRef.owner,
        repo: repoRef.repo,
        prNumber: pr.number,
        token,
      });
      // The list renders the state, the verdict and the author — not the
      // review's whole text, which the drill-in fetches when it is opened.
      const { body: _body, bodyTruncated: _truncated, ...summary } = relayReview;
      return { ...pr, relayReview: summary };
    }),
  );
}

/**
 * The read-path counterpart of `annotateRelayReviewState`: a pure, synchronous
 * overlay of what the in-memory run index already knows, with no GitHub call.
 *
 * The poller's annotation can be up to one tick behind, so a review requested
 * a moment ago would not show yet. If the run index has a run the cached
 * annotation does not describe, the PR is shown as requested straight away;
 * the poller's next tick says whether it landed. Never mutates the cache.
 */
export function overlayRelayRuns(
  prs: PROrWithChecks[],
  repoRef: { owner: string; repo: string },
): PROrWithChecks[] {
  let changed = false;
  const out = prs.map((pr) => {
    const record = getReviewRunForPr(repoRef.owner, repoRef.repo, pr.number);
    if (!record || pr.relayReview?.runId === record.runId) return pr;
    changed = true;
    return {
      ...pr,
      relayReview: {
        state: "requested" as const,
        runId: record.runId,
        dispatchedAt: new Date(record.dispatchedAt).toISOString(),
        landedChecked: false,
      },
    };
  });
  return changed ? out : prs;
}
