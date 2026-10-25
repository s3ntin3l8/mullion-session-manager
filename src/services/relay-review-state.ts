import type { FastifyInstance } from "fastify";
import type { RelayReviewState } from "../shared/types.js";
import type { PROrWithChecks } from "./github.js";
import { listPullRequestReviews } from "./github-write.js";
import type { PullRequestReviewSummary, ReviewMarker } from "./github-write.js";
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

/**
 * The commit the last review round demonstrably covered ("R") — the base of
 * the next round's delta, and the commit whose content decides "nothing new to
 * review". The shared workflow computes the same value (`hermes-review.yml`,
 * "Resolve review scope"); both put it in one idempotency key, so the two
 * must agree.
 *
 * It is NOT read from `reviews[].commit_id` alone (s3ntin3l8/.github#129):
 * GitHub re-points an approval's `commit_id` at the PR's current head when the
 * branch tip is rewritten (a force-push, "Update branch"), so that field stops
 * recording what was reviewed. The record that stays put is the ledger — the
 * "Hermes review" check run sits on the commit it reviewed. So R is:
 *
 *  1. the commit of the newest ledger marker that ended SUCCESS and is PAIRED
 *     with a landed review by the reviewer submitted WHILE THE RUN RAN, i.e.
 *     between the marker's start and its close (a run can complete without
 *     posting a review, a later review is another run's, and dismissing the
 *     review retracts the pairing); else
 *  2. the last landed review's `commit_id`, but only while that commit is not
 *     newer than the review — a newer one was re-pointed, so nothing is known
 *     about what was covered and the round reviews the whole diff ("").
 *
 * A failure to read the ledger or a commit is not fatal: it degrades to the
 * next rule, and ultimately to a full review.
 */
/**
 * How long after a marker was closed a review still counts as its run's. The
 * marker is closed from a different clock than GitHub stamps the review with
 * (the workflow's runner, or this server), so a few seconds of skew must not
 * un-pair a genuine review. The shared workflow uses the same slack.
 */
const MARKER_PAIRING_SLACK_MS = 60_000;

export async function resolveReviewedCommit(input: {
  reviews: PullRequestReviewSummary[];
  reviewerBotLogin: string;
  /** The finished ledger markers; omit when there is no token to read them. */
  markers?: () => Promise<ReviewMarker[]>;
  /** A commit's committer date (ISO-8601), or "" when unknown. */
  committedAt: (sha: string) => Promise<string>;
  /**
   * Told when a read failed and the rule degraded. Without it the failure is
   * invisible: a private repo whose ledger cannot be read silently falls back
   * to the very `commit_id` rule this exists to replace.
   */
  onError?: (detail: string) => void;
}): Promise<string> {
  const landed = input.reviews.filter(
    (r) =>
      r.authorIsBot &&
      isReviewerLogin(r.author, input.reviewerBotLogin) &&
      // A landed review, not merely a non-dismissed one: a PENDING (draft)
      // review never landed.
      LANDED_REVIEW_STATES.has(r.state),
  );
  if (input.markers) {
    try {
      const submitted = landed.flatMap((r) => (r.submittedAt ? [Date.parse(r.submittedAt)] : []));
      const paired = (await input.markers())
        .filter((m) => {
          // A review is the run's own when it was submitted while the run ran
          // (s3ntin3l8/.github#133). With a lower bound only, ANY later review
          // paired every older success marker, so a run that posted nothing
          // could be picked as the base by an unrelated review — a base that is
          // too NEW, which skips code nobody reviewed.
          const from = Date.parse(m.startedAt);
          const to = Date.parse(m.completedAt) + MARKER_PAIRING_SLACK_MS;
          return submitted.some((at) => at >= from && at <= to);
        })
        .sort((a, b) => a.id - b.id)
        .at(-1);
      if (paired) return paired.oid;
    } catch (err) {
      // No ledger answer: fall through to the commit_id rule.
      input.onError?.(`ledger unreadable, falling back to commit_id: ${(err as Error).message}`);
    }
  }
  const last = landed.at(-1);
  if (!last || last.commitId === "" || !last.submittedAt) return "";
  try {
    const committed = Date.parse(await input.committedAt(last.commitId));
    if (!Number.isNaN(committed) && committed <= Date.parse(last.submittedAt)) {
      return last.commitId;
    }
  } catch (err) {
    // An unreadable commit is not a trusted one.
    input.onError?.(
      `commit ${last.commitId} unreadable, reviewing the whole diff: ${(err as Error).message}`,
    );
  }
  return "";
}

// Best effort: the newest review by the reviewer's own bot account
// (`reviewRelay.reviewerBotLogin`; empty = any bot, the same rule as
// `reviewReader().base`) submitted after the run was dispatched. Another bot's
// review (claude[bot], Copilot, ...) is not the relay's review and must not
// show as "posted". A GitHub failure must not hide the Hermes status.
export async function findLandedReview(
  app: FastifyInstance,
  token: string,
  t: { owner: string; repo: string; prNumber: number },
  // Only the dispatch time is used: the review is matched by when it was
  // submitted, not by the commit_id GitHub re-points (s3ntin3l8/.github#129).
  record: { dispatchedAt: number } | null,
): Promise<LandedReview> {
  if (!record) return { checked: false };
  const { dispatchedAt } = record;
  const { reviewerBotLogin } = getStoredSettings(app.db).reviewRelay;
  try {
    const reviews = await listPullRequestReviews(token, t.owner, t.repo, t.prNumber);
    const landed = reviews
      .filter(
        (r) =>
          r.authorIsBot &&
          isReviewerLogin(r.author, reviewerBotLogin) &&
          // Not pinned to `commitId === headSha`: GitHub re-points an approval's
          // commit_id at the PR's current head when the branch is rewritten, so
          // that field no longer says which head the review was for
          // (s3ntin3l8/.github#129). The review came from this run when it was
          // submitted after the run was dispatched (below).
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
          LANDED_REVIEW_STATES.has(r.state) &&
          r.submittedAt &&
          Date.parse(r.submittedAt) >= dispatchedAt - 60_000,
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
// The PR poller asks every few seconds, so a short TTL alone would cost one
// GitHub call per relay-known PR per tick, forever. Two answers are therefore
// settled enough to be re-checked only every LANDED_RECHECK_MS:
//   - a landed review (it can still be dismissed on GitHub, so it is re-checked
//     rarely rather than never — a dismissed review stops reading "landed");
//   - a run so old (STALE_RUN_MS; Hermes keeps run status 24h) that a review
//     is not coming, so an abandoned run costs a trickle, not a call per tick.
// Anything else (still requested, or the lookup failed) keeps the short TTL.
const LANDED_RECHECK_MS = 10 * 60_000;
const STALE_RUN_MS = 24 * 60 * 60_000;
interface LandedMemoEntry {
  landed: LandedReview;
  at: number;
  /** How long this answer holds; absent = LANDED_MEMO_TTL_MS. */
  ttl: number;
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
  memo: Map<string, { at: number; ttl?: number }>,
  now: number,
  max: number = MAX_LANDED_MEMO_ENTRIES,
): void {
  if (memo.size <= max) return;
  for (const [key, entry] of memo) {
    if (now - entry.at >= (entry.ttl ?? LANDED_MEMO_TTL_MS)) memo.delete(key);
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
  if (cached && now - cached.at < cached.ttl) {
    // A HIT does NOT re-stamp the entry: a sliding window would let any
    // reader faster than the TTL pin the cached answer indefinitely — and
    // the PR list is refreshed on every webhook event, so a CI-active PR
    // would never see a review land.
    landed = cached.landed;
  } else {
    landed = await findLandedReview(app, opts.token, { owner, repo, prNumber }, record);
    const settled = isLanded(landed) || now - record.dispatchedAt > STALE_RUN_MS;
    memo.set(memoKey, {
      landed,
      at: now,
      ttl: settled ? LANDED_RECHECK_MS : LANDED_MEMO_TTL_MS,
    });
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
