import { eq } from "drizzle-orm";
import { projectTooling } from "../db/schema.js";
import type { getDb } from "../db/client.js";

// Issue: per-project Mullion briefing authored from the UI — the DB-backed
// producer for the spawn-time briefingOverride channel PR #892 wired
// through. See project_tooling's own schema.ts doc comment for what this
// row is now (issue #942 redesign): a short, always-additive pinned note,
// never a competing alternate to a project's committed AGENTS.md region —
// and session-lifecycle.ts's createSessionRecord for where it's resolved.
//
// PR-5 extended the same row with `skill`/`reviewerAgent` — this module now
// exposes three parallel read/write/clear triples, one per column, sharing
// the same upsert-vs-insert logic (upsertToolingColumn/clearToolingColumn
// below) rather than three independently-hand-rolled copies of it.
// `readProjectBriefing`/`writeProjectBriefing`/`deleteProjectBriefing`'s own
// signatures are UNCHANGED from before this PR (session-lifecycle.ts's
// producer and existing tests call them exactly as before) — they're now
// thin wrappers over the shared helpers.

// Kept in sync by hand with internal-schemas.ts's spawnSessionSchema
// `projectSkill`/`projectReviewerAgent` maxLength (8192 each) — see that
// field's own comment for why this is a real, operator-authored-config
// bound rather than agent-rules.ts's much larger 512 KiB whole-FILE cap
// (MAX_RULE_FILE_BYTES). `briefing` (the pinned note) does NOT share this
// cap — see MAX_PROJECT_BRIEFING_FIELD_BYTES below for why it needs its own,
// much smaller one.
export const MAX_PROJECT_TOOLING_FIELD_BYTES = 8192;

// Issue #942 — the pinned note is a short, live, "pay attention to this"
// note, not a document, so it gets its own (much smaller) save-time cap
// rather than sharing skill/reviewerAgent's 8192-byte one. Matches
// project-briefing.ts's own MAX_BRIEFING_BYTES (the spawn-time clamp
// applied when writing a session's per-session copy) exactly, so rejecting
// an over-cap save here means that clamp should never actually have to
// truncate anything in practice — reject at save time, don't silently
// truncate later at spawn time. This is the cap for every NEW save only —
// internal-schemas.ts's spawnSessionSchema `briefingOverride` maxLength is
// deliberately NOT this same number; see that field's own comment for why
// it stays at the old, more permissive 8192 to tolerate rows saved before
// this cap shrank, with no data migration.
export const MAX_PROJECT_BRIEFING_FIELD_BYTES = 512;

export class ProjectBriefingTooLargeError extends Error {
  constructor(byteLength: number) {
    super(
      `Briefing is ${byteLength} bytes, exceeds the ${MAX_PROJECT_BRIEFING_FIELD_BYTES}-byte limit`,
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

function capForColumn(column: ToolingColumn): number {
  return column === "briefing" ? MAX_PROJECT_BRIEFING_FIELD_BYTES : MAX_PROJECT_TOOLING_FIELD_BYTES;
}

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
  if (byteLength > capForColumn(column)) {
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
 * distinction still matters). Deletes the ROW ENTIRELY only once every
 * OTHER column is also null — clearing a project's skill must never discard
 * a briefing or reviewer agent set independently on the same row. A no-op
 * when no row exists yet. */
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
 * string. This is the only way to stop the pinned note from being injected
 * at all (session-lifecycle.ts's createSessionRecord only resolves a note
 * when this column is non-null); writing an empty string would instead set
 * a real, empty note, which writeSessionBriefing's own write path would
 * happily accept as "the operator wants a blank pinned note" — a materially
 * different outcome the UI must not conflate with "I want no note at all".
 * Leaves the row (and any skill/reviewerAgent set on it) intact — see
 * clearToolingColumn's own doc comment for why the row is only actually
 * deleted once every column is null. */
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
