import { and, eq, inArray } from "drizzle-orm";
import { projects, sessions, tasks } from "../db/schema.js";
import type { getDb } from "../db/client.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import type { RESUMABLE_TASK_STATUSES } from "./worktree-usage.js";

// The project-* route modules (project-docker/-files/-git/-git-writes/
// -github/-setup/-tooling) used to query `app.db` against the schema tables
// directly, which `scripts/check-import-boundaries.mjs` forbids for routes.
// The queries they shared live here; each function is a verbatim move of the
// query the route ran inline — same filters, same ordering, no new semantics.

type Db = ReturnType<typeof getDb>;
type ResumableStatuses = typeof RESUMABLE_TASK_STATUSES;

export type ProjectRow = typeof projects.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

/** One project row by id, or `null`. */
export function getProjectById(db: Db, projectId: number): ProjectRow | null {
  const [project] = db.select().from(projects).where(eq(projects.id, projectId)).all();
  return project ?? null;
}

/** The project rows among `ids` (missing ids simply absent). */
export function getProjectsByIds(db: Db, ids: number[]): ProjectRow[] {
  return db.select().from(projects).where(inArray(projects.id, ids)).all();
}

/** One session row by id, or `null`. */
export function getSessionById(db: Db, sessionId: number): SessionRow | null {
  const [session] = db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  return session ?? null;
}

/** Every registered local-host project's cwd. */
export function listLocalProjectCwds(db: Db): string[] {
  return db
    .select({ cwd: projects.cwd })
    .from(projects)
    .where(eq(projects.hostId, LOCAL_HOST_ID))
    .all()
    .map((row) => row.cwd);
}

/** Record the scaffold-derived slug and conventions hash on a project. */
export function setProjectScaffoldStamp(
  db: Db,
  projectId: number,
  stamp: { slug: string; conventionsHash: string },
): void {
  db.update(projects)
    .set({ slug: stamp.slug, conventionsHash: stamp.conventionsHash })
    .where(eq(projects.id, projectId))
    .run();
}

// --- dock stack sessions (project-docker.ts) -------------------------------

/** The active `kind: "dock"` session of a project named `name`, or `null`. */
export function findActiveDockSession(db: Db, projectId: number, name: string): SessionRow | null {
  const [existing] = db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, projectId),
        eq(sessions.kind, "dock"),
        eq(sessions.status, "active"),
        eq(sessions.name, name),
      ),
    )
    .all();
  return existing ?? null;
}

/** CAS an active session to `exited` (a concurrent reconciler pass wins ties). */
export function markActiveSessionExited(db: Db, sessionId: number): void {
  db.update(sessions)
    .set({ status: "exited" })
    .where(and(eq(sessions.id, sessionId), eq(sessions.status, "active")))
    .run();
}

// --- worktree usage (project-git-writes.ts) --------------------------------

/** Id of a project task in one of `statuses` that claims `branchName`. */
export function findTaskIdByBranch(
  db: Db,
  projectId: number,
  branchName: string,
  statuses: ResumableStatuses,
): number | null {
  const [row] = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.branchName, branchName),
        inArray(tasks.status, statuses),
      ),
    )
    .all();
  return row?.id ?? null;
}

/** Session id + worktree path of the project's tasks in one of `statuses`. */
export function listTaskWorktreeRefs(
  db: Db,
  projectId: number,
  statuses: ResumableStatuses,
): { sessionId: number | null; worktreePath: string | null }[] {
  return db
    .select({ sessionId: tasks.sessionId, worktreePath: tasks.worktreePath })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.status, statuses)))
    .all();
}

/** Every active session joined to its project's cwd and host (if any). */
export function listActiveSessionsWithProject(db: Db): {
  id: number;
  cwd: string | null;
  hostId: string | null;
  projectCwd: string | null;
  projectHostId: string | null;
}[] {
  return db
    .select({
      id: sessions.id,
      cwd: sessions.cwd,
      hostId: sessions.hostId,
      projectCwd: projects.cwd,
      projectHostId: projects.hostId,
    })
    .from(sessions)
    .leftJoin(projects, eq(sessions.projectId, projects.id))
    .where(eq(sessions.status, "active"))
    .all();
}

// --- GitHub issue → task status (project-github.ts) ------------------------

/** Task status per issue number, for the project's tasks on `numbers`. */
export function listTaskStatusesByIssue(
  db: Db,
  projectId: number,
  numbers: number[],
): { issueNumber: number | null; status: string }[] {
  if (numbers.length === 0) return [];
  return db
    .select({ issueNumber: tasks.issueNumber, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.issueNumber, numbers)))
    .all();
}

/** Status of the project's task for one issue, or `null`. */
export function getTaskStatusForIssue(
  db: Db,
  projectId: number,
  issueNumber: number,
): string | null {
  const row = db
    .select({ status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, issueNumber)))
    .get();
  return row?.status ?? null;
}
