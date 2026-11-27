// #3229 — the branches a "Start fresh" abandoned.
//
// "Start fresh" abandons a waiting retry's preserved branch: it stays on the
// host that owns it, with the worker's commits, and the task runs on from
// scratch. The operator needs to be able to FIND that branch afterwards —
// its name and the host it was left on — so the task row records both and
// the board card and the task sidebar show them.
//
// The column holds JSON (`tasks.abandonedBranches`), the same shape the
// backend's own task-abandoned-branches.ts writes:
// `[{"hostId":"macbook","branch":"mullion/task-7-foo"}]`, oldest first.

import type { AbandonedBranch } from "../../../src/shared/types.js";

export type { AbandonedBranch } from "../../../src/shared/types.js";

/**
 * The recorded abandonments, oldest first. Never throws: a value that does
 * not parse reads as "nothing abandoned", which is the safe direction (the
 * operator simply sees no hint).
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

/**
 * One line naming the abandoned branch and the host it was left on — what
 * the card and the sidebar show. Null when nothing was abandoned.
 */
export function describeAbandonedBranch(raw: string | null | undefined): string | null {
  const list = parseAbandonedBranches(raw);
  const latest = list[list.length - 1];
  if (latest === undefined) return null;
  return latest.hostId === null ? latest.branch : `${latest.branch} on ${latest.hostId}`;
}
