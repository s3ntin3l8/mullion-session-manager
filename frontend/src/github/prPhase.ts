import type {
  GitHubActionsRun,
  GitHubCiStatus,
  GitHubJob,
  GitHubOtherCheck,
  GitHubPrPhase,
  RelayReviewState,
  ReviewSummary,
} from "../api/types.js";
import { legacyPillClass, statusTone, type Tone } from "../lib/statusTone.js";
import type { TriadItem } from "../ui/sidebar/index.js";
import { checkDotClass } from "./checkDot.js";

export const PHASE_LABEL: Record<GitHubPrPhase, string> = {
  draft: "Draft",
  conflicts: "Conflicts",
  ci_failing: "CI failing",
  changes_requested: "Changes requested",
  review_pending: "Awaiting review",
  reviewed: "Reviewed",
  ci_pending: "CI running",
  ready_to_merge: "Ready to merge",
  unknown: "Status unknown",
};

/** Phases that want the user's attention first, most urgent first. */
export const ATTENTION_ORDER: GitHubPrPhase[] = ["ci_failing", "changes_requested", "conflicts"];

export function phaseTone(phase: GitHubPrPhase): "bad" | "warn" | "good" | "dim" {
  return legacyPillClass(statusTone({ phase }));
}

/** Needs-attention PRs first (in ATTENTION_ORDER), then most recently updated. */
export function sortPrsByAttention<
  T extends { prPhase?: GitHubPrPhase; updatedAt?: string | null; number: number },
>(prs: readonly T[]): T[] {
  const rank = (p: T) => {
    const i = p.prPhase ? ATTENTION_ORDER.indexOf(p.prPhase) : -1;
    return i === -1 ? ATTENTION_ORDER.length : i;
  };
  return [...prs].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    // A PR with no updatedAt sorts as oldest.
    const ts = (p: T) => Date.parse(p.updatedAt ?? "") || 0;
    const t = ts(b) - ts(a);
    if (t !== 0) return t;
    return b.number - a.number;
  });
}

/** The short glyph + words a compact surface (session row) shows for a PR. */
export function phaseChip(
  phase: GitHubPrPhase | undefined,
  unresolvedThreads: number | null | undefined,
): { glyph: string; text: string } | null {
  const threads = unresolvedThreads && unresolvedThreads > 0 ? ` 💬${unresolvedThreads}` : "";
  switch (phase) {
    case "ci_failing":
      return { glyph: "✗", text: `CI${threads}` };
    case "changes_requested":
      return { glyph: "✎", text: `changes${threads}` };
    case "conflicts":
      return { glyph: "⚠", text: `conflicts${threads}` };
    case "ready_to_merge":
      return { glyph: "✓", text: `ready${threads}` };
    case "draft":
      return { glyph: "", text: `draft${threads}` };
    default:
      return threads ? { glyph: "", text: threads.trim() } : null;
  }
}

/** Open PRs that want the user, by phase — what the right-rail badge counts. */
export function attentionSummary(prs: readonly { prPhase?: GitHubPrPhase }[]): {
  total: number;
  byPhase: Partial<Record<GitHubPrPhase, number>>;
} {
  const byPhase: Partial<Record<GitHubPrPhase, number>> = {};
  let total = 0;
  for (const pr of prs) {
    if (pr.prPhase && ATTENTION_ORDER.includes(pr.prPhase)) {
      byPhase[pr.prPhase] = (byPhase[pr.prPhase] ?? 0) + 1;
      total += 1;
    }
  }
  return { total, byPhase };
}

/** The PR the rail badge routes to: the most urgent attention phase wins
 * (ATTENTION_ORDER), the list order breaks ties. Null when nothing needs the user. */
export function firstAttentionPr<T extends { number: number; prPhase?: GitHubPrPhase }>(
  prs: readonly T[],
): T | null {
  for (const phase of ATTENTION_ORDER) {
    const hit = prs.find((pr) => pr.prPhase === phase);
    if (hit) return hit;
  }
  return null;
}

// ───────── Status-first derivations (epic #1965, B4) ─────────
// ONE reading of "how is this PR doing" for the three dimensions, shared by the
// list row and the detail view so the two can never disagree.

/** The fields the list row and the detail both carry (the detail has all). */
export interface PrStatusInput {
  actionsRuns: GitHubActionsRun[];
  ciStatus?: GitHubCiStatus;
  /** Detail only: a real CI answer exists (distinct from "no checks"). */
  ciKnown?: boolean;
  /** List only: the poller fetched this PR's head runs (possibly none). */
  ciFetched?: boolean;
  otherChecks?: GitHubOtherCheck[];
  prPhase?: GitHubPrPhase;
  isDraft?: boolean;
  state?: "OPEN" | "CLOSED" | "MERGED";
  /** Detail only: commits the base has that the head lacks. */
  behindBy?: number | null;
  baseBranch?: string;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviewers?: { login: string; state: string }[];
  requestedReviewers?: string[];
  reviewSummary?: ReviewSummary;
}

export type RunJobs = GitHubJob[] | null | undefined;

/** One dimension of the triad. `text` is the long form (Status row / tooltip). */
export interface DimStatus {
  tone: Tone;
  glyph: string;
  text: string;
  /** Chip text at normal density. */
  label: string;
  /** Chip text in compact density (≤300px); "" = the icon alone says it. */
  short: string;
}

export function runIdFromUrl(url: string): number | null {
  const match = url.match(/\/actions\/runs\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export function isSkippedJob(job: Pick<GitHubJob, "status" | "conclusion">): boolean {
  return checkDotClass(job.status, job.conclusion) === "none";
}

export interface CheckCounts {
  failed: number;
  pending: number;
  passed: number;
  skipped: number;
}

const otherCheckClass = (c: GitHubOtherCheck): "bad" | "pending" | "good" | "none" =>
  c.state === "failure"
    ? "bad"
    : c.state === "pending"
      ? "pending"
      : c.state === "neutral"
        ? "none"
        : "good";

/**
 * Counts for the CI chip. Job-level once every fetchable run's jobs are loaded
 * (the drilldown loads them), run-level before that; "Other checks" (A1) count
 * either way.
 */
export function checkCounts(
  input: PrStatusInput,
  jobsByRun?: Record<number, RunJobs>,
): CheckCounts {
  const loaded = Object.values(jobsByRun ?? {}).filter((j): j is GitHubJob[] => Array.isArray(j));
  const fetchable = input.actionsRuns.filter((r) => runIdFromUrl(r.htmlUrl) != null).length;
  const classes: string[] = [];
  if (loaded.length === fetchable && loaded.some((j) => j.length > 0)) {
    // Job level. A run that reports no jobs at all (a skipped workflow) says
    // nothing there, so the run itself still counts; a run with no job-list URL
    // has none to show and is left out, as before.
    for (const r of input.actionsRuns) {
      const id = runIdFromUrl(r.htmlUrl);
      if (id == null) continue;
      const jobs = jobsByRun?.[id];
      if (Array.isArray(jobs) && jobs.length > 0) {
        for (const j of jobs) classes.push(checkDotClass(j.status, j.conclusion));
      } else {
        classes.push(checkDotClass(r.status, r.conclusion));
      }
    }
  } else {
    for (const r of input.actionsRuns) classes.push(checkDotClass(r.status, r.conclusion));
  }
  for (const c of input.otherChecks ?? []) classes.push(otherCheckClass(c));
  const count = (k: string) => classes.filter((c) => c === k).length;
  return {
    failed: count("bad"),
    pending: count("pending"),
    skipped: count("none"),
    passed: count("good"),
  };
}

export function checksStatus(input: PrStatusInput, jobsByRun?: Record<number, RunJobs>): DimStatus {
  const n = checkCounts(input, jobsByRun);
  const total = n.failed + n.pending + n.passed + n.skipped;
  if (total === 0) {
    // ciStatus null = the poller has no answer (not yet fetched or failed), as
    // opposed to a PR that genuinely has no runs.
    const known = input.ciKnown ?? (input.ciFetched === true || input.ciStatus != null);
    return {
      tone: "neutral",
      glyph: "○",
      text: known ? "No checks reported" : "Checks unknown",
      label: known ? "No CI" : "CI unknown",
      short: "—",
    };
  }
  const parts = [
    n.failed > 0 ? `✗${n.failed}` : "",
    n.pending > 0 ? `⋯${n.pending}` : "",
    n.passed > 0 ? `✓${n.passed}` : "",
  ].filter(Boolean);
  if (n.failed > 0) {
    return {
      tone: "danger",
      glyph: "✗",
      text: [`${n.failed} failing`, n.pending > 0 ? `${n.pending} in progress` : ""]
        .filter(Boolean)
        .join(", "),
      label: parts.join(" "),
      short: `✗${n.failed}`,
    };
  }
  if (n.pending > 0) {
    const awaiting = input.actionsRuns.filter(
      (r) => r.status === "completed" && r.conclusion === "action_required",
    ).length;
    const running = n.pending - awaiting;
    return {
      tone: "warn",
      glyph: "⋯",
      text: [
        awaiting > 0 ? `${awaiting} awaiting approval` : "",
        running > 0 ? `${running} in progress` : "",
      ]
        .filter(Boolean)
        .join(", "),
      label: parts.join(" "),
      short: `${n.passed}/${n.passed + n.pending}`,
    };
  }
  if (n.passed === 0) {
    // Everything skipped or cancelled: nothing ran, which is not a pass.
    return {
      tone: "neutral",
      glyph: "–",
      text: "No checks ran",
      label: `–${n.skipped}`,
      short: `–${n.skipped}`,
    };
  }
  return {
    tone: "success",
    glyph: "✓",
    text: "All checks have passed",
    label: parts.join(" "),
    short: `✓${n.passed}`,
  };
}

/** The list of names as prose: "a", "a and b", "a, b and c". */
export function joinNames(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What a review that has not landed is doing, in words. */
export function pendingLabel(
  status: string | undefined,
  landedChecked: boolean | undefined,
): string {
  switch (status) {
    case "failed":
    case "interrupted":
    case "cancelled":
      return "the review did not finish";
    case "completed":
      // The run finished — but the landed-review lookup is what says whether
      // it posted anything. If that lookup failed, the review may well be on
      // the PR, so this must not claim the bot posted nothing.
      return landedChecked === false
        ? "the review could not be confirmed on the pull request"
        : "the review finished without posting";
    case "stopping":
    case "stopped":
      return "the review is being stopped";
    case "not_found":
      // Hermes no longer knows the run (it expired, or the server restarted
      // and lost it) — nothing is coming.
      return "the review run is no longer known to the relay";
    case "unknown":
    case undefined:
      // No status at all — the run-status read failed, so this says nothing
      // about the review. Claiming it is "waiting" would be an assertion
      // made from no data.
      return "the relay could not read the review run";
    default:
      // The run's status says it is still going. The landed-review lookup is
      // what separates "still waiting" from "we could not confirm it" — a
      // failed lookup must not be read as "no review yet".
      return landedChecked === false
        ? "the review could not be confirmed on the pull request"
        : "waiting for the review bot";
  }
}

export interface ReviewStatus extends DimStatus {
  relay: ReviewSummary["relay"];
}

/**
 * The Reviews dimension, read from the server's `ReviewSummary` (COMMENTED
 * counts, the relay is folded in). An older server without the summary falls
 * back to the lean fields. `relayRun` is the live relay read, which wins over
 * the summary's snapshot: it knows the run's status and lands a review sooner.
 */
export function reviewStatus(
  input: PrStatusInput,
  relayRun: RelayReviewState | null | undefined,
): ReviewStatus {
  const reviewers = input.reviewers ?? [];
  const sum: ReviewSummary = input.reviewSummary ?? {
    decision: input.reviewDecision ?? null,
    approved: reviewers.filter((r) => r.state === "APPROVED").map((r) => r.login),
    changesRequested: reviewers.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.login),
    commented: reviewers.filter((r) => r.state === "COMMENTED").map((r) => r.login),
    requested: input.requestedReviewers ?? [],
    relay: null,
    unresolvedThreads: null,
    latest: [],
  };
  const relay: ReviewSummary["relay"] =
    relayRun && (relayRun.state === "requested" || relayRun.state === "landed")
      ? { state: relayRun.state, reviewer: relayRun.author ?? null, url: relayRun.htmlUrl ?? null }
      : sum.relay;
  const running =
    relay?.state === "requested" &&
    (relayRun?.status === "running" || relayRun?.status === "queued") &&
    relayRun?.landedChecked !== false;
  const pending = pendingLabel(relayRun?.status, relayRun?.landedChecked);
  const relaySuffix = relay?.state === "requested" ? ` · review requested — ${pending}` : "";
  const threads =
    sum.unresolvedThreads && sum.unresolvedThreads > 0 ? ` · ${sum.unresolvedThreads} open` : "";
  const mk = (
    tone: Tone,
    glyph: string,
    text: string,
    label: string,
    short = glyph,
  ): ReviewStatus => ({ tone, glyph, text, label, short, relay });
  if (sum.changesRequested.length > 0 || sum.decision === "CHANGES_REQUESTED") {
    return mk(
      "danger",
      "✎",
      `Changes requested by ${joinNames(sum.changesRequested) || "a reviewer"}${threads}${relaySuffix}`,
      "Changes requested",
      "Changes",
    );
  }
  if (sum.decision === "APPROVED") {
    return mk(
      "success",
      "✓",
      `Approved by ${joinNames(sum.approved) || "a reviewer"}${relaySuffix}`,
      "Approved",
      "Approved",
    );
  }
  if (sum.commented.length > 0) {
    return mk(
      "info",
      "💬",
      `Commented by ${joinNames(sum.commented)}${threads}${relaySuffix}`,
      running ? "Commented · relay running" : "Commented",
    );
  }
  if (sum.requested.length > 0) {
    return mk(
      "warn",
      "○",
      `Awaiting review from ${sum.requested.join(", ")}${relaySuffix}`,
      running ? "Relay running" : "Review requested",
    );
  }
  if (sum.decision === "REVIEW_REQUIRED") {
    return mk("warn", "○", `Review required${relaySuffix}`, "Review required");
  }
  if (relay?.state === "requested") {
    return mk(
      "warn",
      "○",
      `Review requested — ${pending}`,
      running ? "Relay running" : "Review requested",
    );
  }
  return mk("neutral", "○", "No reviews yet", "No reviews");
}

/** The Merge dimension; `text` is the long form, `label` what the chip says. */
export function mergeStatus(input: PrStatusInput): DimStatus {
  const s = mergeStatusBase(input);
  const behind = input.behindBy ?? 0;
  if (input.state !== "OPEN" || behind <= 0) return s;
  return { ...s, text: `${s.text} · ${behind} behind ${input.baseBranch ?? "base"}` };
}

function mergeStatusBase(input: PrStatusInput): DimStatus {
  if (input.state === "MERGED") {
    return { tone: "merged", glyph: "✓", text: "Merged", label: "Merged", short: "Merged" };
  }
  if (input.state === "CLOSED") {
    return { tone: "neutral", glyph: "○", text: "Closed", label: "Closed", short: "Closed" };
  }
  const phase: GitHubPrPhase = input.prPhase ?? "unknown";
  const tone = statusTone({ phase });
  if (phase === "ready_to_merge") {
    return {
      tone: "success",
      glyph: "✓",
      text: "Ready to merge (squash)",
      label: "Ready",
      short: "Ready",
    };
  }
  if (phase === "conflicts") {
    return {
      tone: "danger",
      glyph: "⚠",
      text: "Conflicts with the base branch",
      label: "Conflicts",
      short: "Conflicts",
    };
  }
  if (phase === "draft" || input.isDraft) {
    return {
      tone: "neutral",
      glyph: "○",
      text: `Blocked: ${PHASE_LABEL.draft.toLowerCase()}`,
      label: "Draft",
      short: "Draft",
    };
  }
  const blocked = phase === "ci_failing" || phase === "changes_requested";
  return {
    tone,
    glyph: tone === "danger" ? "✗" : "⋯",
    text: `Blocked: ${PHASE_LABEL[phase].toLowerCase()}`,
    label: blocked ? `Blocked: ${PHASE_LABEL[phase]}` : "Waiting",
    short: blocked ? "Blocked" : "Wait",
  };
}

export interface PrStatuses {
  ci: DimStatus;
  review: ReviewStatus;
  merge: DimStatus;
}

export function prStatuses(
  input: PrStatusInput,
  relayRun: RelayReviewState | null | undefined,
  jobsByRun?: Record<number, RunJobs>,
): PrStatuses {
  return {
    ci: checksStatus(input, jobsByRun),
    review: reviewStatus(input, relayRun),
    merge: mergeStatus(input),
  };
}

/** The three chips, each a button that toggles its drilldown. */
export function prTriadItems(
  s: PrStatuses,
  onToggle: (key: TriadItem["key"]) => void,
): TriadItem[] {
  const item = (key: TriadItem["key"], name: string, d: DimStatus): TriadItem => ({
    key,
    tone: d.tone,
    label: d.label,
    short: d.short,
    title: `${name}: ${d.text}`,
    onClick: () => onToggle(key),
  });
  return [
    item("ci", "CI", s.ci),
    item("review", "Review", s.review),
    item("merge", "Merge", s.merge),
  ];
}

/**
 * The relay's marker on a PR row, in words (issue #1630).
 *
 * A review that was requested but could not be confirmed — the landed-review
 * lookup failed — is not the same as one that is simply on its way, and the
 * title says so instead of implying the bot is still working.
 */
export function relayPillTitle(relay: RelayReviewState): string {
  if (relay.state === "landed") {
    return `Review posted: ${relay.verdict ?? "review"}${relay.author ? ` by ${relay.author}` : ""}`;
  }
  if (relay.landedChecked === false) {
    return "A review was requested for this pull request — it could not be confirmed on the pull request";
  }
  return "A review was requested for this pull request";
}

/** Per-reviewer latest state for the Reviews drilldown, COMMENTED and bots included. */
export function reviewerRows(
  input: Pick<PrStatusInput, "reviewSummary" | "reviewers">,
): { login: string; state: string }[] {
  const sum = input.reviewSummary;
  if (!sum) return input.reviewers ?? [];
  return [
    ...sum.approved.map((login) => ({ login, state: "APPROVED" })),
    ...sum.changesRequested.map((login) => ({ login, state: "CHANGES_REQUESTED" })),
    ...sum.commented.map((login) => ({ login, state: "COMMENTED" })),
  ];
}
