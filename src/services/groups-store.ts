import { eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { groups } from "../db/schema.js";

type Db = ReturnType<typeof getDb>;

export type GroupRow = typeof groups.$inferSelect;

export interface GroupPatch {
  name?: string;
  icon?: string | null;
  color?: string | null;
  collapsed?: boolean;
  position?: number;
}

export function listGroups(db: Db): GroupRow[] {
  return db.select().from(groups).all();
}

export function createGroup(db: Db, input: { name: string; color?: string | null }): GroupRow {
  const [created] = db
    .insert(groups)
    .values({
      name: input.name,
      ...(input.color !== undefined ? { color: input.color } : {}),
    })
    .returning()
    .all();
  return created;
}

/** The updated row, or undefined when no group has this id. */
export function updateGroup(db: Db, id: number, patch: GroupPatch): GroupRow | undefined {
  const updated = db
    .update(groups)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.collapsed !== undefined ? { collapsed: patch.collapsed } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
    })
    .where(eq(groups.id, id))
    .returning()
    .all();
  return updated[0];
}

/** True when a row was deleted. */
export function deleteGroup(db: Db, id: number): boolean {
  return db.delete(groups).where(eq(groups.id, id)).returning().all().length > 0;
}
