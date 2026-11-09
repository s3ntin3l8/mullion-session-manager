import { and, eq, isNull } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { projects, sessions } from "../db/schema.js";

type Db = ReturnType<typeof getDb>;

export type SessionRow = typeof sessions.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;

export interface SessionListFilter {
  projectId?: number;
  kind?: SessionRow["kind"];
  status?: SessionRow["status"];
  parentSessionId?: number;
}

export function getSessionRow(db: Db, id: number): SessionRow | undefined {
  const [row] = db.select().from(sessions).where(eq(sessions.id, id)).all();
  return row;
}

export function getProjectRow(db: Db, id: number): ProjectRow | undefined {
  const [row] = db.select().from(projects).where(eq(projects.id, id)).all();
  return row;
}

/** Every session row matching all the given filters (none → the whole table). */
export function listSessionRows(db: Db, filter: SessionListFilter = {}): SessionRow[] {
  const conditions = [
    filter.projectId !== undefined ? eq(sessions.projectId, filter.projectId) : undefined,
    filter.kind !== undefined ? eq(sessions.kind, filter.kind) : undefined,
    filter.status !== undefined ? eq(sessions.status, filter.status) : undefined,
    filter.parentSessionId !== undefined
      ? eq(sessions.parentSessionId, filter.parentSessionId)
      : undefined,
  ].filter((c) => c !== undefined);
  return conditions.length > 0
    ? db
        .select()
        .from(sessions)
        .where(and(...conditions))
        .all()
    : db.select().from(sessions).all();
}

/** The stored model choices of a session (a parent's, to inherit into a child). */
export function getSessionModels(
  db: Db,
  id: number,
): { model: string | null; smallModel: string | null } | undefined {
  const [row] = db
    .select({ model: sessions.model, smallModel: sessions.smallModel })
    .from(sessions)
    .where(eq(sessions.id, id))
    .all();
  return row;
}

/**
 * An explicit rename: also pins the title against live OSC title updates
 * (issue #69). Returns the updated row, or undefined for an unknown id. A
 * UNIQUE violation (sessions_stack_identity_unique) propagates for the caller
 * to map to a 409.
 */
export function renameSessionRow(db: Db, id: number, name: string): SessionRow | undefined {
  const updated = db
    .update(sessions)
    .set({ name, nameLocked: true })
    .where(eq(sessions.id, id))
    .returning()
    .all();
  return updated[0];
}

/** Records an attach (the "last attached" timestamp). */
export function touchSessionAttached(db: Db, id: number): void {
  db.update(sessions).set({ lastAttachedAt: new Date() }).where(eq(sessions.id, id)).run();
}

/**
 * Sets the project's devServerUrl only while it is still null. False when
 * another accepted offer already set it (zero affected rows).
 */
export function setProjectDevServerUrlIfUnset(db: Db, projectId: number, url: string): boolean {
  const updated = db
    .update(projects)
    .set({ devServerUrl: url })
    .where(and(eq(projects.id, projectId), isNull(projects.devServerUrl)))
    .run();
  return updated.changes > 0;
}
