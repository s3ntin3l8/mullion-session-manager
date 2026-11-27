// Issue #3229 — the branches a "Start fresh" abandoned.
//
// "Start fresh" (issue #3194) is the operator's way out of a retry that
// waits for a host that never comes back. It ABANDONS the waiting retry's
// preserved branch: the branch stays on the host that owns it, with the
// worker's commits, and the task is re-queued as a NEW claim.
//
// The branch NAME is deterministic (`mullion/task-<id>-<slug>`, see
// git-worktree.ts's deriveTaskBranchName), so that new claim used to derive
// the very name the abandoned branch still holds — and the claim's
// orphan-clear then deleted it, destroying the only copy of those commits
// (or refused the claim outright when the worktree directory was already
// gone). This module is the record that stops it: the task row lists the
// abandoned branches, the claim path derives a name that differs from every
// one of them, and the orphan-clear never deletes a branch the row names.
//
// It is a LIST and not a single name because a task can be started fresh
// more than once, and every one of those branches is equally worth keeping:
// the second "Start fresh" must not make the first one's branch reusable
// again.
//
// The column holds JSON (`tasks.abandonedBranches`), so this module is the
// one place that knows its shape: the writer (task-start-fresh.ts), the
// reader (task-claim.ts's claim path) and the guard
// (git-worktree.ts's clearOrphanedTaskWorktree) all speak it.

import type { AbandonedBranch } from "../shared/types.js";

/** One abandoned branch: its name, and the host it was abandoned on. */
export type { AbandonedBranch } from "../shared/types.js";

/**
 * The row's recorded abandonments, oldest first. Never throws: a row
 * written by an older build (or edited by hand) that does not parse reads
 * as "nothing abandoned", which is the safe direction — the claim path then
 * derives the plain branch name, exactly as before.
 */
export function parseAbandonedBranches(raw: string | null | undefined): AbandonedBranch[] {
  if (raw === null || raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AbandonedBranch[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { hostId?: unknown; branch?: unknown };
    if (typeof record.branch !== "string" || record.branch.length === 0) continue;
    out.push({
      hostId: typeof record.hostId === "string" && record.hostId.length > 0 ? record.hostId : null,
      branch: record.branch,
    });
  }
  return out;
}

/** The row's recorded abandonments as the JSON the column stores. */
export function serializeAbandonedBranches(list: readonly AbandonedBranch[]): string {
  return JSON.stringify(list.map((entry) => ({ hostId: entry.hostId, branch: entry.branch })));
}

/**
 * Just the NAMES of the recorded abandonments — what the claim path avoids
 * (it must not derive a branch name that is already abandoned) and what the
 * orphan-clear refuses to delete.
 */
export function abandonedBranchNames(list: readonly AbandonedBranch[]): string[] {
  return list.map((entry) => entry.branch);
}

/**
 * The row's recorded abandonments, read straight from the column. The one
 * reader every caller shares, so the JSON shape stays in this module.
 */
export function abandonedBranchesOf(row: { abandonedBranches: string | null }): AbandonedBranch[] {
  return parseAbandonedBranches(row.abandonedBranches);
}
