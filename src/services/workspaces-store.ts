import { eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { workspaces } from "../db/schema.js";

type Db = ReturnType<typeof getDb>;

export type WorkspaceRow = typeof workspaces.$inferSelect;

// Issue #1618 — the name listWorkspaces seeds when the table is empty.
// Mirrors the frontend's own DEFAULT_WORKSPACE_NAME (App.tsx).
export const DEFAULT_WORKSPACE_NAME = "Default";

export interface WorkspacePatch {
  name?: string;
  // Already-stringified opaque layout blob; never inspected here.
  layout?: string;
  groupId?: number | null;
  position?: number;
}

/**
 * Issue #1618 — a fresh (or fully emptied) database must never list zero
 * workspaces. The common (non-empty) case is a plain WAL snapshot read and
 * never touches the write lock. Only an empty read enters an `immediate`
 * transaction, which takes the write lock BEFORE re-checking, so the
 * check-then-insert is atomic against a second connection to the same file
 * too. If another connection holds the write lock past busy_timeout this
 * throws SQLITE_BUSY (see routes/workspaces.ts for the caller-side notes).
 */
export function listWorkspacesSeeded(db: Db): WorkspaceRow[] {
  const existing = db.select().from(workspaces).all();
  if (existing.length > 0) return existing;
  return db.transaction(
    (tx) => {
      const current = tx.select().from(workspaces).all();
      if (current.length > 0) return current;
      return tx
        .insert(workspaces)
        .values({ name: DEFAULT_WORKSPACE_NAME, layout: null })
        .returning()
        .all();
    },
    { behavior: "immediate" },
  );
}

export function createWorkspace(db: Db, name: string): WorkspaceRow {
  const [created] = db.insert(workspaces).values({ name, layout: null }).returning().all();
  return created;
}

/** The updated row, or undefined when no workspace has this id. */
export function updateWorkspace(
  db: Db,
  id: number,
  patch: WorkspacePatch,
): WorkspaceRow | undefined {
  const updated = db
    .update(workspaces)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.layout !== undefined ? { layout: patch.layout } : {}),
      ...(patch.groupId !== undefined ? { groupId: patch.groupId } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
    })
    .where(eq(workspaces.id, id))
    .returning()
    .all();
  return updated[0];
}

/** True when a row was deleted. */
export function deleteWorkspace(db: Db, id: number): boolean {
  return db.delete(workspaces).where(eq(workspaces.id, id)).returning().all().length > 0;
}
