import { and, eq } from "drizzle-orm";
import { projectUrls } from "../db/schema.js";
import type { getDb } from "../db/client.js";

// DB access for the project-urls route (routes/project-urls.ts), moved verbatim.

type Db = ReturnType<typeof getDb>;

export type ProjectUrlRow = typeof projectUrls.$inferSelect;

export function listProjectUrls(db: Db, projectId: number): ProjectUrlRow[] {
  return db
    .select()
    .from(projectUrls)
    .where(eq(projectUrls.projectId, projectId))
    .orderBy(projectUrls.order)
    .all();
}

export function createProjectUrl(
  db: Db,
  projectId: number,
  input: { label: string; url: string; favorite?: boolean },
): ProjectUrlRow {
  const existing = db
    .select({ order: projectUrls.order })
    .from(projectUrls)
    .where(eq(projectUrls.projectId, projectId))
    .all();
  const nextOrder = existing.length > 0 ? Math.max(...existing.map((r) => r.order)) + 1 : 0;
  const [created] = db
    .insert(projectUrls)
    .values({
      projectId,
      label: input.label,
      url: input.url,
      favorite: input.favorite ?? false,
      order: nextOrder,
    })
    .returning()
    .all();
  return created;
}

export function findProjectUrl(db: Db, projectId: number, urlId: number): ProjectUrlRow | null {
  const [existing] = db
    .select()
    .from(projectUrls)
    .where(and(eq(projectUrls.id, urlId), eq(projectUrls.projectId, projectId)))
    .all();
  return existing ?? null;
}

export function updateProjectUrl(
  db: Db,
  urlId: number,
  patch: { label?: string; url?: string; favorite?: boolean },
): ProjectUrlRow | null {
  const [updated] = db
    .update(projectUrls)
    .set({
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.favorite !== undefined ? { favorite: patch.favorite } : {}),
    })
    .where(eq(projectUrls.id, urlId))
    .returning()
    .all();
  return updated ?? null;
}

export function deleteProjectUrl(db: Db, urlId: number): void {
  db.delete(projectUrls).where(eq(projectUrls.id, urlId)).run();
}

/** Ids of the project's URLs. */
export function listProjectUrlIds(db: Db, projectId: number): number[] {
  return db
    .select({ id: projectUrls.id })
    .from(projectUrls)
    .where(eq(projectUrls.projectId, projectId))
    .all()
    .map((r) => r.id);
}

/** Persist `ids` order (position in the array) in one transaction. */
export function reorderProjectUrls(db: Db, ids: number[]): void {
  db.transaction((tx) => {
    for (let i = 0; i < ids.length; i++) {
      tx.update(projectUrls).set({ order: i }).where(eq(projectUrls.id, ids[i])).run();
    }
  });
}
