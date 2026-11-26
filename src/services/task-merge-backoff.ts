// The merge sweep's per-task retry ledger.
//
// Split out of task-reconciler.ts, which is at its file-size ceiling: the
// ledger is shared by TWO sites that used to live in the same file — the merge
// sweep itself (`processMergeRequests`, which asks whether a task may be
// attempted again) and the `blocked` arm's re-assert path
// (task-merge-blocked.ts, which memoizes the head SHA a re-assert APPROVE was
// posted for). One ledger, two readers, so it gets its own module rather than
// a parameter threaded through the call chain.
//
// Per-task attempt state is process-local (module state, not a DB column),
// same posture and same reasoning as the draft-PR ledger: the merge INTENT is
// durable (`tasks.mergeRequestedAt`), the retry RATE LIMITER doesn't need to
// be.

import { createRetryBackoff } from "./task-retry-backoff.js";

const MERGE_RETRY_TTL_MS = 60 * 1000;
// Tighter ceiling than the draft-PR ledger's — a merge is a cheap GitHub API
// call (no git push involved) and a human is typically watching for it to
// land, unlike a stranded draft-PR retry.
const MERGE_RETRY_MAX_TTL_MS = 30 * 60 * 1000;
const MAX_MERGE_RETRY_ENTRIES = 500;

// Keyed by task id, and the one site that carries a field of its own:
// `lastReassertedSha` — the head SHA a re-assert APPROVE was last posted
// for. Without it, a re-assert whose APPROVE succeeds at the GitHub API
// level but doesn't actually satisfy the branch protection rule (the
// reviewer App isn't an eligible approver — the CODEOWNERS limitation this
// feature already documents) never flips `reviewDecision` to `APPROVED`, so
// the "can't spin" argument's premise fails: every backoff tick would
// re-post an identical APPROVE on the same commit forever, spam bounded by
// ticks, not pushes. Only cleared by `clearMergeState`/`resetMergeBackoff`,
// same lifecycle as the rest of this entry — a human's explicit "Merge
// now"/"Retry merge" click (which calls `resetMergeBackoff`) deliberately
// gets a fresh re-assert attempt even on an unchanged head.
export const mergeRetryBackoff = createRetryBackoff<number, { lastReassertedSha?: string }>({
  ttlMs: MERGE_RETRY_TTL_MS,
  maxTtlMs: MERGE_RETRY_MAX_TTL_MS,
  maxEntries: MAX_MERGE_RETRY_ENTRIES,
});

/**
 * Re-arms a task's merge backoff so the next reconcile tick attempts it
 * immediately instead of waiting out whatever backoff interval it was on.
 * Called by `POST /api/tasks/:id/merge` (a human's "Merge now"/"Retry merge"
 * click) — without this, a click during a long backoff window would appear
 * to do nothing until the window elapsed on its own.
 */
export function resetMergeBackoff(taskId: number): void {
  mergeRetryBackoff.reset(taskId);
}
