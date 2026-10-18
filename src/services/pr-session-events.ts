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

export interface ProjectSession {
  id: string;
  /** Directory to probe: the shell's OSC 7 cwd, else the spawn cwd. */
  cwd: string;
  /** Hook-reported branch; can be null (no hook) or the main checkout's
   *  branch for a session that lives in a worktree. */
  liveBranch: string | null;
}

/** Memoizes one probe per session id, so however many PR changes (and
 *  projects) consult a session in one run, its checkout is probed once. */
export function createProbeMemo(
  probe: (session: ProjectSession) => Promise<string | null>,
): (session: ProjectSession) => Promise<string | null> {
  const probes = new Map<string, Promise<string | null>>();
  return (session) => {
    let p = probes.get(session.id);
    if (!p) probes.set(session.id, (p = probe(session)));
    return p;
  };
}

/**
 * Sessions on `headBranch`: those whose hook said so, plus those whose actual
 * checkout is on it. The hook alone is not enough — a worktree session can
 * report the main checkout's branch, which is why the session row prefers the
 * polled branch — so every session not already matched is probed.
 */
export async function sessionIdsOnBranch(
  sessions: readonly ProjectSession[],
  headBranch: string,
  branchOf: (session: ProjectSession) => Promise<string | null>,
): Promise<string[]> {
  const hit = (s: ProjectSession) => s.liveBranch === headBranch;
  const probed = await Promise.all(
    sessions
      .filter((s) => !hit(s))
      .map(async (s) => ((await branchOf(s)) === headBranch ? s : null)),
  );
  return [...sessions.filter(hit), ...probed.filter((s): s is ProjectSession => s !== null)].map(
    (s) => s.id,
  );
}

/** Drops closed PRs from the carried-over metadata (they have had their one
 *  look). Takes the live map so a stale reference can't be pruned instead. */
export function pruneClosedMeta(
  metas: Map<number, unknown> | undefined,
  changes: readonly PrChange[],
): void {
  if (!metas) return;
  for (const change of changes) if (change.kind === "closed") metas.delete(change.number);
}
