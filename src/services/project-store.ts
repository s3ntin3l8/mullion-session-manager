/**
 * Database access for the `projects` route module (src/routes/projects.ts).
 *
 * The route used to query `app.db` with schema tables directly (a baselined
 * `routes>db` import-boundary violation, #2814). Every read and write it made
 * lives here instead, with the query semantics unchanged.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { projects, sessions, webhookRegistrations } from "../db/schema.js";
import { LOCAL_HOST_ID } from "./host-registry.js";

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type ProjectPatch = Partial<typeof projects.$inferInsert>;
export type SessionRow = typeof sessions.$inferSelect;

/** Every project, unordered. */
export function listProjects(app: FastifyInstance): ProjectRow[] {
  return app.db.select().from(projects).all();
}

/** Every project, ordered by case-insensitive name (the GET /api/projects order). */
export function listProjectsByName(app: FastifyInstance): ProjectRow[] {
  return app.db
    .select()
    .from(projects)
    .orderBy(sql`LOWER(${projects.name})`)
    .all();
}

export function getProjectById(app: FastifyInstance, id: number): ProjectRow | undefined {
  return app.db.select().from(projects).where(eq(projects.id, id)).get();
}

/** Like {@link getProjectById} for a row the caller has just written or verified exists. */
export function getProjectOrThrow(app: FastifyInstance, id: number): ProjectRow {
  const row = getProjectById(app, id);
  if (!row) throw new Error(`project ${id} not found`);
  return row;
}

/** The cwds of the projects whose primary host is `hostId`. */
export function listProjectCwdsOnHost(app: FastifyInstance, hostId: string): string[] {
  return app.db
    .select({ cwd: projects.cwd })
    .from(projects)
    .where(eq(projects.hostId, hostId))
    .all()
    .map((p) => p.cwd);
}

/** The ids of every project. */
export function listProjectIds(app: FastifyInstance): number[] {
  return app.db
    .select({ id: projects.id })
    .from(projects)
    .all()
    .map((p) => p.id);
}

/** id / cwd / hostId of every project except `excludeId`. */
export function listOtherProjectLocations(
  app: FastifyInstance,
  excludeId: number,
): { id: number; cwd: string; hostId: string }[] {
  return app.db
    .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
    .from(projects)
    .all()
    .filter((p) => p.id !== excludeId);
}

/** The rows for the given ids (missing ids are simply absent). */
export function getProjectsByIds(app: FastifyInstance, ids: number[]): ProjectRow[] {
  return app.db.select().from(projects).where(inArray(projects.id, ids)).all();
}

/** The first project OTHER than `projectId` for which `matches` is true. */
export function findOtherProject(
  app: FastifyInstance,
  projectId: number,
  matches: (p: ProjectRow) => boolean,
): ProjectRow | undefined {
  return app.db
    .select()
    .from(projects)
    .all()
    .find((p) => p.id !== projectId && matches(p));
}

export function insertProject(app: FastifyInstance, values: ProjectInsert): ProjectRow {
  const [created] = app.db.insert(projects).values(values).returning().all();
  return created;
}

/** Updates a project; returns the updated row, or undefined when it does not exist. */
export function updateProject(
  app: FastifyInstance,
  id: number,
  patch: ProjectPatch,
): ProjectRow | undefined {
  const [updated] = app.db.update(projects).set(patch).where(eq(projects.id, id)).returning().all();
  return updated;
}

/** Deletes a project row; returns false when it did not exist. */
export function deleteProject(app: FastifyInstance, id: number): boolean {
  return app.db.delete(projects).where(eq(projects.id, id)).returning().all().length > 0;
}

/** Every session of one project. */
export function listSessionsForProject(app: FastifyInstance, projectId: number): SessionRow[] {
  return app.db.select().from(sessions).where(eq(sessions.projectId, projectId)).all();
}

/**
 * The active dock sessions, grouped project id -> host id -> session ids (as
 * strings). The host is the SESSION's own (its recorded host, else its
 * project's), not the project's: a project can run a dock session on another
 * host than the one it lives on, and the session's output is only readable on
 * the host it runs on (issue #3427).
 */
export function dockSessionIdsByProject(app: FastifyInstance): Map<number, Map<string, string[]>> {
  const active = app.db
    .select({
      id: sessions.id,
      projectId: sessions.projectId,
      hostId: sql<string>`coalesce(${sessions.hostId}, ${projects.hostId})`,
    })
    .from(sessions)
    .leftJoin(projects, eq(sessions.projectId, projects.id))
    .where(and(eq(sessions.kind, "dock"), eq(sessions.status, "active")))
    .all();
  const byProject = new Map<number, Map<string, string[]>>();
  for (const session of active) {
    const byHost = byProject.get(session.projectId) ?? new Map<string, string[]>();
    const hostId = session.hostId ?? LOCAL_HOST_ID;
    byHost.set(hostId, [...(byHost.get(hostId) ?? []), String(session.id)]);
    byProject.set(session.projectId, byHost);
  }
  return byProject;
}

export interface WebhookRegistrationRepo {
  owner: string;
  repo: string;
  hookId: number | null;
}

/** A project's webhook registration (owner/repo/hookId), if it has one. */
export function getWebhookRegistration(
  app: FastifyInstance,
  projectId: number,
): WebhookRegistrationRepo | undefined {
  return app.db
    .select({
      owner: webhookRegistrations.owner,
      repo: webhookRegistrations.repo,
      hookId: webhookRegistrations.hookId,
    })
    .from(webhookRegistrations)
    .where(eq(webhookRegistrations.projectId, projectId))
    .get();
}
