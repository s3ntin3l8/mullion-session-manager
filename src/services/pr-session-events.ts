// PR transitions -> session events. The poller already diffs each repo's PR
// snapshots (github-pr-phase.ts); this turns those diffs into the pr_* kinds
// on the PtyManager event stream, so the bell/timeline show them and an
// agent can wait on its own PR via events.subscribe. Pure derivation here;
// the poller owns the I/O (finding sessions, emitting).

import type { NotificationEvent } from "../shared/types.js";
import type { PrChange } from "./github-pr-phase.js";

export interface PrEventSpec {
  kind: Extract<NotificationEvent["kind"], `pr_${string}`>;
  payload: Record<string, unknown>;
}

export interface PrEventMeta {
  number: number;
  title: string;
  url: string;
}

/**
 * What happened to one PR between two polls. Review-derived signals
 * (decision, comments) are only trusted when both snapshots carry counts:
 * those are null until the GraphQL enrichment succeeded, and a backoff
 * recovering would otherwise read as a review landing. A merge is not
 * derivable from a diff alone — the poller looks that up and passes it in.
 */
export function derivePrEvents(
  change: PrChange,
  meta: PrEventMeta,
  merged: boolean,
): PrEventSpec[] {
  const base = { number: meta.number, title: meta.title, url: meta.url };
  if (change.kind === "closed") {
    return merged ? [{ kind: "pr_merged", payload: base }] : [];
  }
  const { before, after } = change;
  if (change.kind !== "updated" || !before || !after) return [];

  const events: PrEventSpec[] = [];
  if (after.ciStatus === "failure" && before.ciStatus !== "failure") {
    events.push({ kind: "pr_ci_failed", payload: base });
  } else if (
    after.ciStatus === "success" &&
    (before.ciStatus === "failure" || before.ciStatus === "in_progress")
  ) {
    events.push({ kind: "pr_ci_passed", payload: base });
  }
  if (after.mergeable === "CONFLICTING" && before.mergeable !== "CONFLICTING") {
    events.push({ kind: "pr_conflicts", payload: base });
  }
  const reviewKnown =
    before.commentCount !== null &&
    after.commentCount !== null &&
    before.unresolvedThreads !== null &&
    after.unresolvedThreads !== null;
  if (reviewKnown) {
    if (
      after.reviewDecision !== before.reviewDecision &&
      (after.reviewDecision === "APPROVED" || after.reviewDecision === "CHANGES_REQUESTED")
    ) {
      events.push({
        kind: "pr_review_submitted",
        payload: { ...base, decision: after.reviewDecision },
      });
    }
    const added = (after.commentCount ?? 0) - (before.commentCount ?? 0);
    const newThreads = (after.unresolvedThreads ?? 0) - (before.unresolvedThreads ?? 0);
    if (added > 0 || newThreads > 0) {
      events.push({
        kind: "pr_new_comments",
        payload: { ...base, added: Math.max(added, 0), unresolvedThreads: after.unresolvedThreads },
      });
    }
  }
  return events;
}
