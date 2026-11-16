import { and, asc, eq, lt } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { sessions, workspacePendingOpens, workspaces } from "../db/schema.js";

// #3033 — sessions opened on the fold or the phone, waiting for a desktop
// client to add their panes (see the table's comment in db/schema.ts). Never
// reads or writes `workspaces.layout`.

type Db = ReturnType<typeof getDb>;

export type PendingOpenRow = typeof workspacePendingOpens.$inferSelect;

// An open older than this is dropped rather than applied: a day of use on
// the phone alone must not land as a burst of panes when the desk next shows
// the workspace.
export const PENDING_OPEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type RecordPendingOpenResult =
  | { ok: true; row: PendingOpenRow; created: boolean }
  | { ok: false; reason: "workspace" | "session" | "killed" };

function sessionStatus(db: Db, id: number): string | undefined {
  return db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, id)).get()
    ?.status;
}

function sessionExists(db: Db, id: number): boolean {
  return sessionStatus(db, id) !== undefined;
}

export function workspaceExists(db: Db, workspaceId: number): boolean {
  return (
    db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .get() !== undefined
  );
}

/** Records (or re-records) an open. A second record of the same session in
 * the same workspace keeps one row and takes the newer reference. */
export function recordPendingOpen(
  db: Db,
  workspaceId: number,
  sessionId: number,
  referenceSessionId: number | null,
): RecordPendingOpenResult {
  if (!workspaceExists(db, workspaceId)) return { ok: false, reason: "workspace" };
  const status = sessionStatus(db, sessionId);
  if (status === undefined) return { ok: false, reason: "session" };
  // A killed session's pane is closed at the desk, never added there.
  if (status === "killed") return { ok: false, reason: "killed" };
  // An unknown reference is dropped rather than refused: it only steers where
  // the pane lands, and the desk falls back to the largest pane without it.
  const reference =
    referenceSessionId !== null &&
    referenceSessionId !== sessionId &&
    sessionExists(db, referenceSessionId)
      ? referenceSessionId
      : null;
  const existed =
    db
      .select({ id: workspacePendingOpens.id })
      .from(workspacePendingOpens)
      .where(
        and(
          eq(workspacePendingOpens.workspaceId, workspaceId),
          eq(workspacePendingOpens.sessionId, sessionId),
        ),
      )
      .get() !== undefined;
  // A re-record also renews the open's age.
  const row = db
    .insert(workspacePendingOpens)
    .values({ workspaceId, sessionId, referenceSessionId: reference })
    .onConflictDoUpdate({
      target: [workspacePendingOpens.workspaceId, workspacePendingOpens.sessionId],
      set: { referenceSessionId: reference, createdAt: new Date() },
    })
    .returning()
    .get();
  return { ok: true, row, created: !existed };
}

export function listPendingOpens(
  db: Db,
  workspaceId: number,
  now: number = Date.now(),
): PendingOpenRow[] {
  db.delete(workspacePendingOpens)
    .where(
      and(
        eq(workspacePendingOpens.workspaceId, workspaceId),
        lt(workspacePendingOpens.createdAt, new Date(now - PENDING_OPEN_MAX_AGE_MS)),
      ),
    )
    .run();
  return db
    .select()
    .from(workspacePendingOpens)
    .where(eq(workspacePendingOpens.workspaceId, workspaceId))
    .orderBy(asc(workspacePendingOpens.id))
    .all();
}

/**
 * Removes one pending open, atomically: a single DELETE ... RETURNING, so of
 * two clients acknowledging the same open only one sees `true`. Used both for
 * the desktop's acknowledge (applied) and the fold's withdraw (closed there
 * before the desk applied it).
 */
export function removePendingOpen(db: Db, workspaceId: number, sessionId: number): boolean {
  const removed = db
    .delete(workspacePendingOpens)
    .where(
      and(
        eq(workspacePendingOpens.workspaceId, workspaceId),
        eq(workspacePendingOpens.sessionId, sessionId),
      ),
    )
    .returning({ id: workspacePendingOpens.id })
    .all();
  return removed.length > 0;
}

/** A killed session's pending opens are dropped, not applied (#3033). */
export function dropPendingOpensForSession(db: Db, sessionId: number): void {
  db.delete(workspacePendingOpens).where(eq(workspacePendingOpens.sessionId, sessionId)).run();
}
