import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { projectUrls, projects, sessions } from "../db/schema.js";

// The few session / project / project-URL reads the browser routes
// (routes/browser*.ts) make, kept here so those routes don't query `app.db`
// themselves (the routes>db import boundary).

export type SessionRow = typeof sessions.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;

export function getSessionRow(app: FastifyInstance, sessionId: number): SessionRow | undefined {
  const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  return row;
}

export function getProjectRow(app: FastifyInstance, projectId: number): ProjectRow | undefined {
  const [row] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  return row;
}

export function listFavoriteProjectUrls(app: FastifyInstance): (typeof projectUrls.$inferSelect)[] {
  return app.db
    .select()
    .from(projectUrls)
    .where(eq(projectUrls.favorite, true))
    .orderBy(asc(projectUrls.order), asc(projectUrls.id))
    .all();
}
