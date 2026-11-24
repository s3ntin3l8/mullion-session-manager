// Shared API types for GitHub: PRs, issues, Actions, the App integration and the review relay (#2412).
//
// The single declaration of each API shape here, used by both workspaces.
// Most were hand-copied into frontend/src/api/ before #2412; the backend
// module that produces one re-exports it, so its importers are unchanged, and
// the frontend imports it through src/shared/types.ts, the one entry point.
// Type-only: no runtime code, and no import from outside src/shared/ (an
// import back from types.ts would be a cycle).

// ---------------------------------------------------------------------------
// mullion-links.ts — IssueTriageState
// ---------------------------------------------------------------------------

/**
 * The triage relay's state for one issue (epic #1965, A6). Absent (`null` on
 * the issue) means no run is known — never requested, or the in-memory run
 * index was lost to a restart; it is NOT "no triage pending".
 */
export interface IssueTriageState {
  state: "requested";
  runId: string;
  /**
   * When the run was dispatched (ISO 8601). The index keeps finished runs too,
   * so `state` alone cannot tell an in-flight triage from an old one — a
   * consumer ages it out with this.
   */
  dispatchedAt: string;
}

// ---------------------------------------------------------------------------
// review-relay.ts — RelayReviewState
// ---------------------------------------------------------------------------

/**
 * The Hermes review relay's state for one pull request (issue #1630).
 *
 * `"none"` means *no relay run is known for this PR* — never requested here,
 * or the server restarted. It does NOT mean "no review is pending": the run
 * index is in-memory, so a restart loses it. A UI must render "none" as
 * "nothing to show", never as "no review pending".
 */
export interface RelayReviewState {
  state: "none" | "requested" | "landed";
  /** The relay run's id, when a run is known. */
  runId?: string;
  /** When the run was dispatched (ISO 8601). */
  dispatchedAt?: string;
  /** The Hermes run's own status: queued, running, completed, failed, … */
  status?: string;
  /**
   * Whether the landed-review lookup actually ran (`false` when the lookup
   * itself failed). Without it, a failed lookup and a review that simply has
   * not landed are the same answer — "requested" — and the UI cannot say
   * "could not confirm" instead.
   */
  landedChecked?: boolean;
  /** Who posted the landed review. */
  author?: string;
  /** The review's state: APPROVED, CHANGES_REQUESTED, … */
  verdict?: string;
  /** The review's own text (bounded on the way in). */
  body?: string;
  /** True when `body` was cut short by the server's cap. */
  bodyTruncated?: boolean;
  /** A link to the landed review on GitHub. */
  htmlUrl?: string;
}

/**
 * One review worth showing in full (epic #1965, A2): the latest human and the
 * latest bot review that has a body or leaves threads open.
 */
export interface ReviewSummaryEntry {
  author: string;
  isBot: boolean;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, … */
  state: string;
  /** Plain-text body, bounded server-side; empty for an inline-threads-only review. */
  body: string;
  submittedAt: string | null;
  /** The commit the review was made on ("" when unknown). */
  reviewedSha: string;
  /** The PR head has moved since `reviewedSha`. */
  stale: boolean;
}

/**
 * The PR's review status, computed ONCE on the server so the list pill and the
 * detail's Reviews row cannot disagree. GitHub's `latestReviews` (every state,
 * COMMENTED included — `latestOpinionatedReviews` drops what bots post) feeds
 * the buckets; the relay's state is folded in so it needs no block of its own.
 */
export interface ReviewSummary {
  /** GitHub's decision when it has one, else derived from the reviews. */
  decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "COMMENTED" | null;
  approved: string[];
  changesRequested: string[];
  /** The `changesRequested` reviewers whose review is of an older commit than the head. */
  changesRequestedStale?: string[];
  commented: string[];
  requested: string[];
  relay: { state: "requested" | "landed"; reviewer: string | null; url: string | null } | null;
  /** null = not fetched. */
  unresolvedThreads: number | null;
  /** Max 2: the latest human + the latest bot review with something to read. */
  latest: ReviewSummaryEntry[];
}

// The placement mode of a project — issue #1723 / roadmap 8.9 — is NOT
// declared here. It is derived from PLACEMENT_MODES in
// src/shared/constants.ts (the TaskStatus/TASK_STATUSES precedent in that
// file), so the runtime list and the type are one declaration and cannot
// drift. It used to be spelled out here as its own union, which made the
// pair two hand-maintained vocabularies — and this file is a leaf that
// imports nothing, so the two could only be held together by hand.
//
// "pinned" (the default) keeps today's behaviour exactly: every session
// under the project runs on the project's own host. "auto" opts the project
// into automatic placement.

// ---------------------------------------------------------------------------
// github.ts — GitHubCiStatus
// ---------------------------------------------------------------------------
//
// The backend's own declaration (src/services/github.ts) and the frontend's
// hand-mirrored copy (frontend/src/api/types.ts) were the SAME union spelled
// twice, and the backend's copy sat in a module the PR-phase helper imported
// back — so github.ts and github-pr-phase.ts imported each other (issue
// #2414). One declaration, both sides.

export type GitHubCiStatus = "success" | "failure" | "in_progress" | null;

/** #2104 — the last mint result for one token scope. */
export interface MintOutcome {
  scope: string;
  /** The GitHub permission that scope needs, in the App settings' wording. */
  permission: string;
  /** `denied`: GitHub refused the permission; `error`: the mint failed for
   * another reason (a bad key, a network error, a 5xx) — not a missing grant.
   * An App that simply does not cover this repo (not installed, or a 404
   * installation/repo mismatch) is a supported steady state, not recorded. */
  state: "ok" | "denied" | "error";
  /** HTTP status GitHub answered the mint with, when it did. */
  status?: number;
  owner: string;
  repo: string;
  /** True when the operation went on under the shared PAT/OAuth token. */
  fellBackToPat: boolean;
  at: number;
}

export interface HermesModelProvider {
  /** Hermes provider slug — what a run's `provider` field takes. */
  provider: string;
  name: string;
  models: string[];
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

export interface GitHubPRsStatus {
  /** Set by `getPRsStatus` when the entry is older than the TTL: served anyway, refresh pending. */
  stale?: boolean;
  prs: PROrWithChecks[];
  // Summary counts for the dock widget: "3 PRs — 2✅ 1❌"
  prSummary: { total: number; pass: number; fail: number; pending: number; unknown: number };
}

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
  /**
   * The review relay's state for this PR (issue #1630) — present only when a
   * review was requested for it through Mullion's Hermes relay. Absent means
   * "no relay run is known for this PR" — which is NOT "no review is
   * pending" (the relay's run index is in-memory, so a restart loses it).
   *
   * Declared on BOTH sides (this type and the frontend's copy) so the
   * compiler catches a drift between them.
   */
  relayReview?: RelayReviewState;
  /** Task Master task that opened this PR, joined server-side (epic #1965, A6). */
  taskId?: number;
  taskStatus?: string;
  actionsRuns: GitHubActionsRun[];
  // Review state — filled by github-pr-reviews.ts's GraphQL enrichment in the
  // background poller. Best-effort: when that fails (or the PR is past the
  // enriched page) these keep their neutral defaults and `prPhase` is derived
  // from what is known (CI only).
  isDraft: boolean;
  updatedAt: string | null;
  reviewDecision: PrReviewDecision;
  mergeable: PrMergeable;
  mergeStateStatus: string | null;
  /** Latest opinionated review per reviewer — merge gating's input (see `reviewSummary` for COMMENTED). */
  reviewers: { login: string; state: string; recovered?: boolean }[];
  /**
   * The server-computed review status shared with the PR detail (epic #1965,
   * A2). Absent until the GraphQL enrichment has run for the PR.
   */
  reviewSummary?: ReviewSummary;
  requestedReviewers: string[];
  /** null = not fetched (yet), as opposed to a known zero. */
  unresolvedThreads: number | null;
  commentCount: number | null;
  /** True once the GraphQL enrichment filled this PR's review fields; false
   *  while they are still the REST-side defaults. */
  reviewStateKnown: boolean;
  /** True once this PR's head-run lookup succeeded (runs may legitimately be empty). */
  ciFetched: boolean;
  /**
   * The head commit's `statusCheckRollup` state (GraphQL enrichment) — covers
   * checks that are not Actions runs. Folded into `ciStatus` by
   * `combineCiStatus`; kept so the fold is idempotent across re-enrichment.
   */
  checksRollup?: ChecksRollupState;
  /**
   * Commits the head is behind its base, read (REST compare) only for a PR
   * GitHub reports BEHIND; null/absent = not asked or unanswered.
   */
  behindBy?: number | null;
  prPhase: PrPhase;
}

/** GitHub's `statusCheckRollup.state` for a head commit, collapsed to three. */
export type ChecksRollupState = "success" | "failure" | "pending" | null;

export type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;

/**
 * - `draft`: not ready for anyone yet.
 * - `conflicts`: cannot merge until rebased.
 * - `ci_failing`: a required signal is red.
 * - `changes_requested`: a reviewer asked for changes.
 * - `review_pending`: waiting on a review (required, requested, or blocked).
 * - `reviewed`: a review landed with comments but no approval, and the PR is
 *   still waiting on one — "someone looked, read what they said". It only ever
 *   replaces `review_pending`; `ready_to_merge` is untouched.
 * - `threads_unresolved`: nothing is missing a review, but GitHub reports the PR
 *   blocked while conversations are open (branch protection's "require
 *   conversation resolution"). The user has to reply or resolve, though nothing
 *   is broken: the frontend counts it in the attention badge (ATTENTION_ORDER,
 *   frontend/src/github/prPhase.ts).
 * - `behind`: strict branch protection ("require branches to be up to date")
 *   and the head has fallen behind its base; GitHub reports BEHIND only then.
 *   Updating the branch is the next step. The frontend counts it last in the
 *   attention badge (ATTENTION_ORDER, frontend/src/github/prPhase.ts): it needs
 *   one click and nothing is broken.
 * - `ci_pending`: approved (or no review needed) but CI is still running.
 * - `ready_to_merge`: nothing left to wait for.
 * - `unknown`: review state couldn't be fetched (GraphQL failed or backed
 *   off), so "nothing left to wait for" can't be claimed — CI-only signals
 *   (`ci_failing`, `ci_pending`) still apply.
 */
export type PrPhase =
  | "draft"
  | "conflicts"
  | "ci_failing"
  | "changes_requested"
  | "review_pending"
  | "reviewed"
  | "threads_unresolved"
  | "behind"
  | "ci_pending"
  | "ready_to_merge"
  | "unknown";

export type PrReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export type DeviceFlowStatus = "pending" | "connected" | "expired" | "denied" | "error";

// Never includes device_code — that's this module's own internal secret,
// not something any API response should carry (see the module comment).
export interface DeviceFlowSummary {
  status: DeviceFlowStatus;
  userCode: string;
  verificationUri: string;
  errorMessage?: string;
}

/**
 * What became of the in-flight marker for a dispatched pull-request review
 * (#1790). Absent for a replayed request, which writes none.
 */
export type ReviewMarkerResult =
  | { written: true; checkRunId: number }
  | { written: false; reason: MarkerUnavailableReason; message: string };

/** Why the in-flight marker for a Hermes review could not be written. */
export type MarkerUnavailableReason =
  | "app-not-configured"
  | "not-installed"
  | "permission-not-granted"
  | "mint-failed"
  | "write-failed";

export interface IssueComment {
  id: number;
  author: string | null;
  bodyHtml: string;
  createdAt: string;
  htmlUrl: string;
}

export interface ChecksMarkerOutcome {
  /** "ok", or why the marker token could not be had / used. */
  state: "ok" | MarkerUnavailableReason;
  owner: string;
  repo: string;
  at: number;
}

export interface GitHubAppStatus {
  configured: boolean;
  // Public — a numeric App id, not a secret (the private key never leaves
  // this function). `null` when no App is configured.
  appId: string | null;
  // How many accounts this App is installed on, straight from GitHub's own
  // `/app/installations` list — the same call `resolveGitHubToken` makes
  // to resolve an owner, just for display rather than to mint a token.
  // `null` when not configured, or when the live list call itself failed
  // (logged, not surfaced as an error — this is a status display, not a
  // write path, so a transient GitHub outage shouldn't make the whole
  // integration summary fail to load).
  installationCount: number | null;
  // #514 — a SHA-256/base64 fingerprint of the stored key's public half
  // (see computeKeyFingerprint, github-app.ts), directly comparable to the
  // fingerprint GitHub's own App settings page displays. Not a secret.
  // `null` when not configured, or when the stored key can't be decrypted
  // (e.g. a DB_ENCRYPTION_KEY mismatch) — same tolerance
  // installationCount already has for its own failure mode.
  keyFingerprint: string | null;
  // #514 — when the currently-stored key was last set (initial configure
  // or a rotation), for Settings' "Key set <date>" display. `null` when
  // not configured, or for a row that predates this column.
  /** ISO 8601; the service converts the column, so the type says what JSON carries. */
  keyRotatedAt: string | null;
  // #1790 — the outcome of the last Hermes in-flight marker write through this
  // App, when one has been attempted since the server started. Absent before
  // the first review request.
  checksMarker?: ChecksMarkerOutcome;
  // #2104 — the last token-mint result per scope, only the ones that did not
  // come back clean, so Settings can say which App permission is missing and
  // which operations are running under the operator's PAT instead.
  mintOutcomes?: MintOutcome[];
}

export interface WebhookRegistrationResult {
  reposSucceeded: number;
  reposFailed: number;
}
