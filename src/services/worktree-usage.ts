import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import path from "node:path";
import { projects, sessions, tasks } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { isGitRepo } from "./git-status.js";

// Task states a worktree is still needed in (a `done`/`cancelled` task keeps its
// `worktreePath` forever, so it must not count). Shared with routes/projects.ts's
// worktree-removal guard, so the two can't drift.
export const RESUMABLE_TASK_STATUSES = ["claimed", "in_progress", "reviewing", "failed"] as const;

const isWithin = (candidate: string, directory: string) => {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedDirectory = path.resolve(directory);
  return (
    resolvedCandidate === resolvedDirectory ||
    resolvedCandidate.startsWith(resolvedDirectory + path.sep)
  );
};

/**
 * Whether anything is using the worktree at `worktreePath`: an active session
 * whose directory is inside it, or a task that can still resume in it.
 *
 * Deliberately across ALL projects, not just the one whose repo owns the
 * worktree: a worktree is often registered as a Mullion project of its own, and
 * its sessions then belong to that project, not to the repo's. Local sessions
 * only (a remote host's cwd is a path on another machine). A session's
 * directory is the live one its PTY reports when that is a git repo (the
 * session may have `cd`'d), else the recorded one, else its project's.
 */
export function worktreeInUse(app: FastifyInstance, worktreePath: string): boolean {
  const activeSessions = app.db
    .select({ id: sessions.id, cwd: sessions.cwd, projectCwd: projects.cwd })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(and(eq(sessions.status, "active"), eq(projects.hostId, LOCAL_HOST_ID)))
    .all();
  for (const row of activeSessions) {
    let directory = row.cwd ?? row.projectCwd;
    const liveCwd = app.pty.get(String(row.id))?.liveCwd;
    if (liveCwd && isGitRepo(liveCwd)) directory = liveCwd;
    if (isWithin(directory, worktreePath)) return true;
  }

  const resolvedTarget = path.resolve(worktreePath);
  const resumable = app.db
    .select({ worktreePath: tasks.worktreePath })
    .from(tasks)
    .where(inArray(tasks.status, RESUMABLE_TASK_STATUSES))
    .all();
  return resumable.some(
    (task) => task.worktreePath !== null && path.resolve(task.worktreePath) === resolvedTarget,
  );
}
