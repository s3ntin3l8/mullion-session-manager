// #3229 — the branches a "Start fresh" abandoned.
//
// "Start fresh" abandons a waiting retry's preserved branch: it stays on
// the host that owns it, with the worker's commits, and the task runs on
// from scratch. The operator needs to be able to FIND that branch
// afterwards — its name and the host it was left on — so the task row
// records both and the board card and the task sidebar show them.
//
// The column holds JSON (`tasks.abandonedBranches`), and the codec that
// reads it is SHARED with the backend (src/shared/abandoned-branches.ts):
// the two sides must agree on the shape, and a second copy of the parser
// is a copy that can drift — after which the UI names a branch the
// backend never recorded, or names none at all.
//
// A task can be started fresh more than once, so there can be MORE THAN
// ONE abandoned branch, and every one of them is worth naming: each holds
// a branch with the worker's commits on it.

import { parseAbandonedBranches } from "../../../src/shared/abandoned-branches.js";

export type { AbandonedBranch } from "../../../src/shared/types.js";

/**
 * One line per recorded abandonment: the branch and the host it was left
 * on (the branch alone when it was abandoned on this machine). Oldest
 * first, so the order matches the row's.
 */
export function describeAbandonedBranches(raw: string | null | undefined): string[] {
  return parseAbandonedBranches(raw).map((entry) =>
    entry.hostId === null ? entry.branch : `${entry.branch} on ${entry.hostId}`,
  );
}
