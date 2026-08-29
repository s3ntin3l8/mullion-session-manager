import { eq } from "drizzle-orm";
import { projectTooling } from "../db/schema.js";
import type { getDb } from "../db/client.js";

// Issue: per-project Mullion briefing authored from the UI — the DB-backed
// producer for the spawn-time briefingOverride channel PR #892 wired
// through. See project_tooling's own schema.ts doc comment for the
// precedence rule (this row wins over a project's committed AGENTS.md/
// CLAUDE.md region) and session-lifecycle.ts's createSessionRecord for
// where that precedence is actually applied.
//
// PR-5 extended the same row with `skill`/`reviewerAgent` — this module now
// exposes three parallel read/write/clear triples, one per column, sharing
// the same byte-cap validation and upsert-vs-insert logic
// (upsertToolingField/clearToolingField below) rather than three
// independently-hand-rolled copies of it. `readProjectBriefing`/
// `writeProjectBriefing`/`deleteProjectBriefing`'s own signatures are
// UNCHANGED from before this PR (session-lifecycle.ts's producer and
// existing tests call them exactly as before) — they're now thin wrappers
// over the shared helpers.

// Kept in sync by hand with internal-schemas.ts's spawnSessionSchema
// `briefingOverride`/`projectSkill`/`projectReviewerAgent` maxLength (8192
// each) — see that field's own comment for why this is a real,
// operator-authored-config bound rather than agent-rules.ts's much larger
// 512 KiB whole-FILE cap (MAX_RULE_FILE_BYTES): each of these three fields
// is a short operating-instructions block, not an arbitrary rule file, and
// the caps would silently diverge if one cap were reused across all of
// agent-rules.ts/project-tooling.ts.
export const MAX_PROJECT_TOOLING_FIELD_BYTES = 8192;
/** @deprecated kept as an alias — every existing caller of the byte cap
 * constant referred to it under this name before PR-5 generalized the
 * table to three fields. */
export const MAX_PROJECT_BRIEFING_BYTES = MAX_PROJECT_TOOLING_FIELD_BYTES;

export class ProjectBriefingTooLargeError extends Error {
  constructor(byteLength: number) {
    super(
      `Briefing is ${byteLength} bytes, exceeds the ${MAX_PROJECT_TOOLING_FIELD_BYTES}-byte limit`,
    );
    this.name = "ProjectBriefingTooLargeError";
  }
}

export class ProjectToolingFieldTooLargeError extends Error {
  constructor(
    readonly field: "skill" | "reviewerAgent",
    byteLength: number,
  ) {
    super(
      `${field} is ${byteLength} bytes, exceeds the ${MAX_PROJECT_TOOLING_FIELD_BYTES}-byte limit`,
    );
    this.name = "ProjectToolingFieldTooLargeError";
  }
}

type ToolingColumn = "briefing" | "skill" | "reviewerAgent";
const TOOLING_COLUMNS: readonly ToolingColumn[] = ["briefing", "skill", "reviewerAgent"];

function readToolingColumn(
  db: ReturnType<typeof getDb>,
  projectId: number,
  column: ToolingColumn,
): string | null {
  const [row] = db
    .select({ value: projectTooling[column] })
    .from(projectTooling)
    .where(eq(projectTooling.projectId, projectId))
    .all();
  return row?.value ?? null;
}

/** Shared upsert for one column — validates the byte cap BEFORE touching the
 * DB at all (same "validate, then write" order as agent-rules.ts's
 * writeAgentRule), then inserts a fresh row or updates the existing one.
 * Byte length, not character length: a multi-byte UTF-8 value could
 * otherwise slip past a character-count check and still exceed what
 * internal-schemas.ts's schema will actually accept once it reaches the
 * spawn body. */
function upsertToolingColumn(
  db: ReturnType<typeof getDb>,
  projectId: number,
  column: ToolingColumn,
  value: string,
): void {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_PROJECT_TOOLING_FIELD_BYTES) {
    throw column === "briefing"
      ? new ProjectBriefingTooLargeError(byteLength)
      : new ProjectToolingFieldTooLargeError(column, byteLength);
  }
  const existing = db
    .select({ id: projectTooling.id })
    .from(projectTooling)
    .where(eq(projectTooling.projectId, projectId))
    .all();
  if (existing.length > 0) {
    db.update(projectTooling)
      .set({ [column]: value, updatedAt: new Date() })
      .where(eq(projectTooling.projectId, projectId))
      .run();
  } else {
    db.insert(projectTooling)
      .values({ projectId, [column]: value, updatedAt: new Date() })
      .run();
  }
}

/** Clears one column back to null — NOT the same as writing an empty
 * string (see deleteProjectBriefing's own doc comment for why that
 * distinction matters to a project's committed AGENTS.md/CLAUDE.md
 * region). Deletes the ROW ENTIRELY only once every OTHER column is also
 * null — clearing a project's skill must never discard a briefing or
 * reviewer agent set independently on the same row. A no-op when no row
 * exists yet. */
function clearToolingColumn(
  db: ReturnType<typeof getDb>,
  projectId: number,
  column: ToolingColumn,
): void {
  const [row] = db
    .select()
    .from(projectTooling)
    .where(eq(projectTooling.projectId, projectId))
    .all();
  if (!row) return;
  const otherColumnsNull = TOOLING_COLUMNS.filter((c) => c !== column).every((c) => row[c] == null);
  if (otherColumnsNull) {
    db.delete(projectTooling).where(eq(projectTooling.projectId, projectId)).run();
  } else {
    db.update(projectTooling)
      .set({ [column]: null, updatedAt: new Date() })
      .where(eq(projectTooling.projectId, projectId))
      .run();
  }
}

/** `null` when the project has no DB-authored briefing at all — the
 * ordinary case for every project until someone opts in via the UI.
 * Never throws. */
export function readProjectBriefing(
  db: ReturnType<typeof getDb>,
  projectId: number,
): string | null {
  return readToolingColumn(db, projectId, "briefing");
}

/** Upserts the project's briefing column. Throws ProjectBriefingTooLargeError
 * before touching the DB at all. */
export function writeProjectBriefing(
  db: ReturnType<typeof getDb>,
  projectId: number,
  briefing: string,
): void {
  upsertToolingColumn(db, projectId, "briefing", briefing);
}

/** Clears the project's briefing column — NOT the same as writing an empty
 * string. Restores the project's own committed AGENTS.md/CLAUDE.md briefing
 * region, if any (session-lifecycle.ts's createSessionRecord only overrides
 * when this column is non-null); writing an empty string would instead
 * override with an empty briefing, which writeSessionBriefing's own clamp/
 * write path would happily accept as "the operator wants a blank briefing"
 * — a materially different outcome the UI must not conflate with "I want
 * the committed file back". Leaves the row (and any skill/reviewerAgent set
 * on it) intact — see clearToolingColumn's own doc comment for why the row
 * is only actually deleted once every column is null. */
export function deleteProjectBriefing(db: ReturnType<typeof getDb>, projectId: number): void {
  clearToolingColumn(db, projectId, "briefing");
}

/** `null` when the project has no DB-authored project skill. Never throws. */
export function readProjectSkill(db: ReturnType<typeof getDb>, projectId: number): string | null {
  return readToolingColumn(db, projectId, "skill");
}

/** Upserts the project's skill column (raw SKILL.md content — YAML
 * frontmatter + Markdown body). Throws ProjectToolingFieldTooLargeError
 * before touching the DB. Frontmatter validity (parseable `name`/
 * `description`, and a safe name) is checked by the route, not here — same
 * split of responsibility as agent-rules.ts (this module owns size/
 * storage, the route owns request-shaped validation). */
export function writeProjectSkill(
  db: ReturnType<typeof getDb>,
  projectId: number,
  skill: string,
): void {
  upsertToolingColumn(db, projectId, "skill", skill);
}

/** Clears the project's skill column. See clearToolingColumn's own doc
 * comment — leaves briefing/reviewerAgent on the same row untouched. */
export function deleteProjectSkill(db: ReturnType<typeof getDb>, projectId: number): void {
  clearToolingColumn(db, projectId, "skill");
}

/** `null` when the project has no DB-authored reviewer subagent. Never
 * throws. */
export function readProjectReviewerAgent(
  db: ReturnType<typeof getDb>,
  projectId: number,
): string | null {
  return readToolingColumn(db, projectId, "reviewerAgent");
}

/** Upserts the project's reviewer-agent column (raw Claude-Code-shaped
 * subagent Markdown — see schema.ts's own doc comment on why it's stored
 * in that one shape and translated per-adapter at spawn time, not stored
 * per-adapter). Throws ProjectToolingFieldTooLargeError before touching
 * the DB. */
export function writeProjectReviewerAgent(
  db: ReturnType<typeof getDb>,
  projectId: number,
  reviewerAgent: string,
): void {
  upsertToolingColumn(db, projectId, "reviewerAgent", reviewerAgent);
}

/** Clears the project's reviewer-agent column. See clearToolingColumn's own
 * doc comment — leaves briefing/skill on the same row untouched. */
export function deleteProjectReviewerAgent(db: ReturnType<typeof getDb>, projectId: number): void {
  clearToolingColumn(db, projectId, "reviewerAgent");
}
