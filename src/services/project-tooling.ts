import { eq } from "drizzle-orm";
import { projectTooling } from "../db/schema.js";
import type { getDb } from "../db/client.js";

// Issue: per-project Mullion briefing authored from the UI — the DB-backed
// producer for the spawn-time briefingOverride channel PR #892 wired
// through. See project_tooling's own schema.ts doc comment for the
// precedence rule (this row wins over a project's committed AGENTS.md/
// CLAUDE.md region) and session-lifecycle.ts's createSessionRecord for
// where that precedence is actually applied.

// Kept in sync by hand with internal-schemas.ts's spawnSessionSchema
// `briefingOverride` maxLength (8192) — see that field's own comment for
// why this is a real, operator-authored-config bound rather than
// agent-rules.ts's much larger 512 KiB whole-FILE cap (MAX_RULE_FILE_BYTES):
// a project briefing is a short operating-instructions block, not an
// arbitrary rule file, and the two caps would silently diverge if one were
// reused for the other.
export const MAX_PROJECT_BRIEFING_BYTES = 8192;

export class ProjectBriefingTooLargeError extends Error {
  constructor(byteLength: number) {
    super(`Briefing is ${byteLength} bytes, exceeds the ${MAX_PROJECT_BRIEFING_BYTES}-byte limit`);
    this.name = "ProjectBriefingTooLargeError";
  }
}

/** `null` when the project has no DB-authored briefing at all — the
 * ordinary case for every project until someone opts in via the UI.
 * Never throws. */
export function readProjectBriefing(
  db: ReturnType<typeof getDb>,
  projectId: number,
): string | null {
  const [row] = db
    .select({ briefing: projectTooling.briefing })
    .from(projectTooling)
    .where(eq(projectTooling.projectId, projectId))
    .all();
  return row?.briefing ?? null;
}

/** Upserts the project's briefing row. Throws ProjectBriefingTooLargeError
 * before touching the DB at all — same "validate, then write" order as
 * agent-rules.ts's writeAgentRule. Byte length, not character length: a
 * multi-byte UTF-8 briefing could otherwise slip past a character-count
 * check and still exceed what internal-schemas.ts's schema will actually
 * accept once it reaches the spawn body. */
export function writeProjectBriefing(
  db: ReturnType<typeof getDb>,
  projectId: number,
  briefing: string,
): void {
  const byteLength = Buffer.byteLength(briefing, "utf8");
  if (byteLength > MAX_PROJECT_BRIEFING_BYTES) {
    throw new ProjectBriefingTooLargeError(byteLength);
  }
  const existing = db
    .select({ id: projectTooling.id })
    .from(projectTooling)
    .where(eq(projectTooling.projectId, projectId))
    .all();
  if (existing.length > 0) {
    db.update(projectTooling)
      .set({ briefing, updatedAt: new Date() })
      .where(eq(projectTooling.projectId, projectId))
      .run();
  } else {
    db.insert(projectTooling).values({ projectId, briefing, updatedAt: new Date() }).run();
  }
}

/** Deletes the project's briefing row entirely — NOT the same as writing an
 * empty string. Deleting restores the project's own committed
 * AGENTS.md/CLAUDE.md briefing region, if any (session-lifecycle.ts's
 * createSessionRecord only overrides when a row exists); writing an empty
 * string would instead override with an empty briefing, which
 * writeSessionBriefing's own clamp/write path would happily accept as "the
 * operator wants a blank briefing" — a materially different outcome the UI
 * must not conflate with "I want the committed file back". A no-op, not an
 * error, when no row exists yet. */
export function deleteProjectBriefing(db: ReturnType<typeof getDb>, projectId: number): void {
  db.delete(projectTooling).where(eq(projectTooling.projectId, projectId)).run();
}
