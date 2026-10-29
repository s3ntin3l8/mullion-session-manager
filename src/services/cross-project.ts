// Issues #2123 / #2124 — the one rule for "may a session of project P act on
// project T", shared by every place that decides it: validateParent
// (session-lifecycle.ts, which binds a direct POST /api/sessions too), the
// sessions.spawn_child and projects.spawn_targets socket ops, and the project
// PATCH validation.
//
// Two operator opt-ins, one on each side:
//
//  - The SOURCE project is a coordinator (`allowCrossProjectSpawn`, #2110), and may
//    reach every project (`crossProjectTargets` null, the default) or only those
//    listed (#2123).
//  - The TARGET project accepts children from other projects (`acceptsChildrenFrom`,
//    #2124): `any` (the default, null), `none`, or `listed` (only the projects in
//    `acceptsChildrenFromList`).
//
// Both must hold. Nothing here reads the database: callers pass the two rows, so
// the rule is a pure function and the tests are a table.
import type { projects } from "../db/schema.js";

type ProjectRow = typeof projects.$inferSelect;

export const ACCEPTS_CHILDREN_FROM = ["any", "listed", "none"] as const;
export type AcceptsChildrenFrom = (typeof ACCEPTS_CHILDREN_FROM)[number];

/** Most project ids either list may hold. */
export const MAX_PROJECT_LIST = 200;

/**
 * A stored id list as an array, or `null` for "no list". Anything that is not a
 * JSON array of positive integers is treated as no list rather than throwing, so a
 * hand-edited row cannot break the rule (a malformed ACCEPT list then reads as
 * empty, which refuses).
 */
export function parseProjectIdList(raw: string | null | undefined): number[] | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((id): id is number => Number.isInteger(id) && id > 0);
}

/** An id list for storage: sorted, deduplicated, and `null` when empty (the
 * "all" reading of a coordinator's list). */
export function serializeProjectIdList(ids: readonly number[] | null | undefined): string | null {
  if (!ids || ids.length === 0) return null;
  return JSON.stringify([...new Set(ids)].sort((a, b) => a - b));
}

function readAccepts(value: string | null | undefined): AcceptsChildrenFrom {
  return value === "none" || value === "listed" ? value : "any";
}

/** Whether `target` takes cross-project children from `sourceId`. */
export function targetAccepts(target: ProjectRow, sourceId: number): boolean {
  switch (readAccepts(target.acceptsChildrenFrom)) {
    case "any":
      return true;
    case "none":
      return false;
    case "listed":
      return (parseProjectIdList(target.acceptsChildrenFromList) ?? []).includes(sourceId);
  }
}

/** Whether the coordinator `source` may reach `target`. */
export function coordinatorReaches(source: ProjectRow, target: ProjectRow): boolean {
  if (source.allowCrossProjectSpawn !== true) return false;
  const list = parseProjectIdList(source.crossProjectTargets);
  // null = every project; a stored list is stored non-empty (see serialize).
  return list === null || list.includes(target.id);
}

/**
 * May a session of `source` have a child in `target`? Same project is always
 * fine; otherwise the source must be a coordinator that reaches the target AND
 * the target must accept the source. A missing row (a deleted project) refuses.
 */
export function crossProjectAllowed(
  source: ProjectRow | undefined,
  target: ProjectRow | undefined,
): boolean {
  if (!source || !target) return false;
  if (source.id === target.id) return true;
  return coordinatorReaches(source, target) && targetAccepts(target, source.id);
}

/** A project row's lists as arrays for the API (the columns hold JSON text). */
export function crossProjectFieldsOut(row: ProjectRow): {
  crossProjectTargets: number[] | null;
  acceptsChildrenFromList: number[] | null;
} {
  return {
    crossProjectTargets: parseProjectIdList(row.crossProjectTargets),
    acceptsChildrenFromList: parseProjectIdList(row.acceptsChildrenFromList),
  };
}
