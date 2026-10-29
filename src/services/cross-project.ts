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
 * JSON array of positive integers is treated as no list rather than throwing; the
 * callers decide what "no list" means (every project for a coordinator's targets,
 * nobody for a consent list), and a set-but-unreadable value fails closed in both.
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

/** The stored consent mode. Unset (null) is the default, any; a value this build does
 * not know refuses, so a hand-edited row never opens a project up. */
function readAccepts(value: string | null | undefined): AcceptsChildrenFrom {
  if (value === null || value === undefined || value === "" || value === "any") return "any";
  return value === "listed" ? "listed" : "none";
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
  const raw = source.crossProjectTargets;
  // Unset = every project. A value that is set but is not a readable list (a hand
  // edit) reaches nothing rather than everything.
  if (raw === null || raw === undefined || raw.trim() === "") return true;
  return (parseProjectIdList(raw) ?? []).includes(target.id);
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

export type AcceptsMessagesFrom = AcceptsChildrenFrom;

/** The stored messaging consent. Unlike children, the default (unset) is NONE: a
 * running session never takes instructions from another project until its operator
 * opts in. An unknown value refuses. */
function readAcceptsMessages(value: string | null | undefined): AcceptsMessagesFrom {
  return value === "any" || value === "listed" ? value : "none";
}

/** Whether `target` takes messages from `sourceId`'s sessions. */
export function targetAcceptsMessages(target: ProjectRow, sourceId: number): boolean {
  switch (readAcceptsMessages(target.acceptsMessagesFrom)) {
    case "any":
      return true;
    case "none":
      return false;
    case "listed":
      return (parseProjectIdList(target.acceptsMessagesFromList) ?? []).includes(sourceId);
  }
}

/**
 * May a session of `source` send a message to a running session of `target`
 * (issue #2270)? Only across projects: the source must be a coordinator that reaches
 * the target (the same target list as spawning), AND the target project must have
 * opted in to messages from the source. A missing row refuses.
 */
export function messageAllowed(
  source: ProjectRow | undefined,
  target: ProjectRow | undefined,
): boolean {
  if (!source || !target || source.id === target.id) return false;
  return coordinatorReaches(source, target) && targetAcceptsMessages(target, source.id);
}

/** A project row's lists as arrays for the API (the columns hold JSON text). */
export function crossProjectFieldsOut(row: ProjectRow): {
  crossProjectTargets: number[] | null;
  acceptsChildrenFromList: number[] | null;
  acceptsMessagesFromList: number[] | null;
} {
  return {
    crossProjectTargets: parseProjectIdList(row.crossProjectTargets),
    acceptsChildrenFromList: parseProjectIdList(row.acceptsChildrenFromList),
    acceptsMessagesFromList: parseProjectIdList(row.acceptsMessagesFromList),
  };
}
