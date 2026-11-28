import { asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { projects, workspacePinnedProjects } from "../db/schema.js";

// #3537 — projects pinned to a workspace (see the table's comment in
// db/schema.ts). Never reads or writes `workspaces.layout`.

type Db = ReturnType<typeof getDb>;
// A transaction handle exposes the same query builder as the db itself.
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Every workspace's pinned project ids, in `position` order, in one query. */
export function pinnedProjectIdsByWorkspace(db: DbOrTx): Map<number, number[]> {
  const rows = db
    .select({
      workspaceId: workspacePinnedProjects.workspaceId,
      projectId: workspacePinnedProjects.projectId,
    })
    .from(workspacePinnedProjects)
    .orderBy(
      asc(workspacePinnedProjects.workspaceId),
      asc(workspacePinnedProjects.position),
      asc(workspacePinnedProjects.id),
    )
    .all();
  const byWorkspace = new Map<number, number[]>();
  for (const row of rows) {
    const ids = byWorkspace.get(row.workspaceId);
    if (ids) ids.push(row.projectId);
    else byWorkspace.set(row.workspaceId, [row.projectId]);
  }
  return byWorkspace;
}

/** One workspace's pinned project ids, in `position` order. */
export function pinnedProjectIds(db: DbOrTx, workspaceId: number): number[] {
  return db
    .select({ projectId: workspacePinnedProjects.projectId })
    .from(workspacePinnedProjects)
    .where(eq(workspacePinnedProjects.workspaceId, workspaceId))
    .orderBy(asc(workspacePinnedProjects.position), asc(workspacePinnedProjects.id))
    .all()
    .map((r) => r.projectId);
}

/** First-seen order, duplicates dropped. */
export function dedupeIds(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

/** The ids in `ids` that name no project. */
export function unknownProjectIds(db: DbOrTx, ids: readonly number[]): number[] {
  const unique = dedupeIds(ids);
  if (unique.length === 0) return [];
  const found = new Set(
    db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.id, unique))
      .all()
      .map((r) => r.id),
  );
  return unique.filter((id) => !found.has(id));
}

/**
 * Replaces a workspace's pins with `ids` (de-duplicated, `position` = index).
 * The caller runs this inside a transaction and has already checked that the
 * workspace and every project exist.
 */
export function replacePinnedProjects(
  db: DbOrTx,
  workspaceId: number,
  ids: readonly number[],
): void {
  db.delete(workspacePinnedProjects)
    .where(eq(workspacePinnedProjects.workspaceId, workspaceId))
    .run();
  const unique = dedupeIds(ids);
  if (unique.length === 0) return;
  db.insert(workspacePinnedProjects)
    .values(unique.map((projectId, position) => ({ workspaceId, projectId, position })))
    .run();
}
