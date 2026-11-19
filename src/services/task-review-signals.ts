import type { tasks } from "../db/schema.js";
import { isApprovingVerdict } from "./task-prompt.js";
import { hasIngestedCurrentReview } from "./task-review-handle.js";

// Pure review-state signals shared by the reconciler's stall detection and
// approval-carry paths. Keep these independent of reconciliation side effects.

/** `- **ref** — still-open: …` lines of a rendered "### Earlier findings"
 * section, as `renderReviewFindingsMarkdown` writes them. */
export function openRefsOfRenderedRound(block: string | undefined): Set<string> {
  const refs = new Set<string>();
  if (!block) return refs;
  for (const m of block.matchAll(/^- \*\*(.+?)\*\* — (?:still-open|re-broken)/gm)) {
    refs.add(m[1]);
  }
  return refs;
}

/** Does the task's approval still stand for the head under review? True when
 * an approving verdict was ingested for the CURRENT review session — the same
 * pair of facts the auto-approve gate reads — so a later head-moving return
 * (a CI fix, a reviewer's inline suggestions) can carry it instead of
 * re-reviewing. */
export function hasCurrentApproval(task: typeof tasks.$inferSelect): boolean {
  return isApprovingVerdict(task.lastReviewVerdict) && hasIngestedCurrentReview(task);
}

/** Epoch seconds of an ingested verdict — the key `taskRereviewRequestPath`
 * hangs a suggestions-round worker's "review this" request on. Seconds, not
 * ms, because `lastReviewVerdictAt` round-trips through a `timestamp` column
 * that stores whole seconds; the writer and the reader must agree. */
export function rereviewRequestKey(verdictAt: Date): number {
  return Math.floor(verdictAt.getTime() / 1000);
}
