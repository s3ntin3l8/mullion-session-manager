// Which host a session or project lives on (issue #2713). Split out of
// session-live-info.ts so execution-context.ts can resolve a session's host
// without importing the live-info module, which sits above it.
import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "./host-registry.js";

/** hostId of the project a session row belongs to — "local" for any row
 * whose project is missing (shouldn't happen; projectId is a required FK)
 * or genuinely local, keeping every call site's fallback identical.
 *
 * Still the right answer for PROJECT-scoped operations (git ops, project
 * files, a project's worktree, webhooks) — a session's host says where
 * that session runs, not where the project's work lives. */
export function resolveProjectHostId(app: FastifyInstance, projectId: number): string {
  const [project] = app.db
    .select({ hostId: projects.hostId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .all();
  return project?.hostId ?? LOCAL_HOST_ID;
}

/**
 * The host a session lives on: its own recorded host, else its project's.
 *
 * Issue #1722 / roadmap 8.8 — a session records the host it was actually
 * spawned on (`sessions.hostId`, written once at creation), so a placement
 * policy can put some of a project's sessions on one machine and some on
 * another. Every SESSION-scoped operation resolves through here.
 *
 * The row's own value wins when it is set; NULL means "inherit the
 * project's host", which is every pre-existing row (and every row created
 * before the placement wiring lands). The fallback is therefore the only
 * thing that has to be right for old rows — a placed session costs NO
 * query here at all, and an inheriting one costs the same single query
 * its project-scoped sibling always did.
 *
 * `projectId` is deliberately not consulted when the row carries its own
 * host: the project's host is a different fact (where the project's work
 * lives), and reading it would be a query nobody needs.
 */
export function resolveSessionHostId(
  app: FastifyInstance,
  row: { projectId: number; hostId: string | null },
): string {
  if (row.hostId !== null) return row.hostId;
  return resolveProjectHostId(app, row.projectId);
}

/** The full project row, or undefined when there is no such project. */
export function getProjectRow(
  app: FastifyInstance,
  projectId: number,
): typeof projects.$inferSelect | undefined {
  return app.db.select().from(projects).where(eq(projects.id, projectId)).get();
}

/** A project's checkout (cwd + host), or undefined when there is no such project. */
export function getProjectCheckout(
  app: FastifyInstance,
  projectId: number,
): { cwd: string; hostId: string } | undefined {
  return app.db
    .select({ cwd: projects.cwd, hostId: projects.hostId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
}

/** Every project on the local host (id, name, cwd). */
export function listLocalProjects(
  app: FastifyInstance,
): Array<{ id: number; name: string; cwd: string }> {
  return app.db
    .select({ id: projects.id, name: projects.name, cwd: projects.cwd })
    .from(projects)
    .where(eq(projects.hostId, LOCAL_HOST_ID))
    .all();
}

/** One project, only if it lives on the local host. */
export function getLocalProject(
  app: FastifyInstance,
  projectId: number,
): { id: number; name: string; cwd: string } | undefined {
  return app.db
    .select({ id: projects.id, name: projects.name, cwd: projects.cwd })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.hostId, LOCAL_HOST_ID)))
    .get();
}

/** The `env` column of every active local session that has one. */
export function listActiveLocalSessionEnvs(app: FastifyInstance): Array<string | null> {
  return app.db
    .select({ env: sessions.env })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(
      and(
        eq(sessions.status, "active"),
        eq(projects.hostId, LOCAL_HOST_ID),
        isNotNull(sessions.env),
      ),
    )
    .all()
    .map((row) => row.env);
}
