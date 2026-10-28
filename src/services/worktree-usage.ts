import type { FastifyInstance } from "fastify";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import path from "node:path";
import fs from "node:fs/promises";
import { projects, sessions, tasks } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { isGitRepo } from "./git-status.js";
import { resolveBackend } from "./session-backend.js";

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
  // Issue #1722 / roadmap 8.8 — "local" means the SESSION's own host is
  // local, not its project's: a session placed on a remote host has a cwd
  // on that other machine, so it cannot be holding a local worktree open —
  // counting it would make the local host's worktrees look busy forever.
  // A session with no host of its own inherits its project's (the
  // coalesce), so every pre-existing row keeps behaving exactly as before.
  const activeSessions = app.db
    .select({ id: sessions.id, cwd: sessions.cwd, projectCwd: projects.cwd })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(
      and(
        eq(sessions.status, "active"),
        sql`coalesce(${sessions.hostId}, ${projects.hostId}) = ${LOCAL_HOST_ID}`,
      ),
    )
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

/** Resolve an existing ancestor without blocking the event loop. */
async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  let prefix = resolved;
  for (;;) {
    try {
      // This only resolves directory metadata for the usage guard; it does
      // not read or modify file content. Registered-worktree membership is
      // independently checked before removal (CodeQL alert #430).
      const real = await fs.realpath(prefix);
      return path.resolve(real, path.relative(prefix, resolved));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(prefix);
      if (parent === prefix) throw error;
      prefix = parent;
    }
  }
}

/** Sessions on the worktree's host whose recorded or live cwd is inside it.
 * Ended sessions remain blockers until their process is confirmed dead. */
export async function sessionsUsingWorktree(
  app: FastifyInstance,
  worktreePath: string,
  hostId: string,
  excludeId?: number,
  stopOnActive = false,
): Promise<{ active: number[]; alive: number[]; unknown: number[] }> {
  const resolvedPath = path.resolve(worktreePath);
  const effectiveCwd = sql<string | null>`coalesce(${sessions.cwd}, ${projects.cwd})`;
  const hostMatch = sql`coalesce(${sessions.hostId}, ${projects.hostId}, ${LOCAL_HOST_ID}) = ${hostId}`;
  let recordedMatch = sql`substr(${effectiveCwd}, 1, ${resolvedPath.length}) = ${resolvedPath}`;
  const liveIds: number[] = [];
  const matchedPaths = new Set<string | null>();
  const uncertainPaths = new Set<string | null>();
  const uncertainLive = new Set<number>();
  if (hostId === LOCAL_HOST_ID) {
    const canonicalTarget = await canonicalPath(resolvedPath);
    const seen = new Set<string | null>();
    const aliases: string[] = [];
    const readPaths = () =>
      app.db
        .selectDistinct({ cwd: effectiveCwd })
        .from(sessions)
        .leftJoin(projects, eq(sessions.projectId, projects.id))
        .where(hostMatch)
        .all()
        .filter(({ cwd }) => !seen.has(cwd));
    // Repeat when sessions appeared while filesystem resolution was in flight.
    // Any remaining new paths become uncertain blockers after bounded retries.
    for (let round = 0; round < 3; round++) {
      const paths = readPaths();
      if (paths.length === 0) break;
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(16, paths.length) }, async () => {
          for (;;) {
            const entry = paths[next++];
            if (!entry) return;
            seen.add(entry.cwd);
            if (entry.cwd === null) {
              uncertainPaths.add(null);
              continue;
            }
            try {
              if (isWithin(await canonicalPath(entry.cwd), canonicalTarget)) {
                aliases.push(entry.cwd);
                matchedPaths.add(entry.cwd);
              }
            } catch {
              uncertainPaths.add(entry.cwd);
              aliases.push(entry.cwd);
            }
          }
        }),
      );
    }
    // Re-resolve only PTYs whose cwd changed while a previous snapshot was
    // being checked. A stable unrelated cwd must not block removal.
    const checkedLive = new Map<string, string | null>();
    const liveState = new Map<string, "inside" | "unknown">();
    for (let round = 0; round < 3; round++) {
      const snapshot = app.pty.list();
      const present = new Set(snapshot.map(({ id }) => id));
      for (const id of checkedLive.keys()) {
        if (!present.has(id)) {
          checkedLive.delete(id);
          liveState.delete(id);
        }
      }
      const changed = snapshot.filter(
        ({ id, liveCwd }) => !checkedLive.has(id) || checkedLive.get(id) !== liveCwd,
      );
      for (const { id, liveCwd } of changed) {
        checkedLive.set(id, liveCwd);
        liveState.delete(id);
        if (!liveCwd) continue;
        try {
          if (isWithin(await canonicalPath(liveCwd), canonicalTarget)) liveState.set(id, "inside");
        } catch {
          liveState.set(id, "unknown");
        }
      }
    }
    // Changes that continue past the retry bound cannot be classified safely.
    for (const { id, liveCwd } of app.pty.list()) {
      if (!checkedLive.has(id) || checkedLive.get(id) !== liveCwd) liveState.set(id, "unknown");
    }
    for (const [id, state] of liveState) {
      const numericId = Number(id);
      if (!Number.isInteger(numericId)) continue;
      if (state === "unknown") uncertainLive.add(numericId);
      liveIds.push(numericId);
    }
    // The live-cwd work above yields; newly recorded paths are conservative
    // blockers until a later check can resolve them.
    for (const { cwd } of readPaths()) {
      uncertainPaths.add(cwd);
      if (cwd !== null) aliases.push(cwd);
    }
    if (aliases.length > 0) recordedMatch = or(recordedMatch, inArray(effectiveCwd, aliases))!;
    if (uncertainPaths.has(null)) recordedMatch = or(recordedMatch, sql`${effectiveCwd} IS NULL`)!;
  }
  const rows = app.db
    .select({
      id: sessions.id,
      status: sessions.status,
      cwd: sessions.cwd,
      projectCwd: projects.cwd,
    })
    .from(sessions)
    .leftJoin(projects, eq(sessions.projectId, projects.id))
    .where(
      and(
        hostMatch,
        liveIds.length > 0 ? or(recordedMatch, inArray(sessions.id, liveIds)) : recordedMatch,
      ),
    )
    .all();
  const matching = rows.filter((row) => {
    if (row.id === excludeId) return false;
    const recorded = row.cwd ?? row.projectCwd;
    if (hostId !== LOCAL_HOST_ID) return recorded !== null && isWithin(recorded, resolvedPath);
    return matchedPaths.has(recorded) || uncertainPaths.has(recorded) || liveIds.includes(row.id);
  });
  const definitelyInside = (row: (typeof matching)[number]) => {
    const recorded = row.cwd ?? row.projectCwd;
    return (
      hostId !== LOCAL_HOST_ID ||
      matchedPaths.has(recorded) ||
      (liveIds.includes(row.id) && !uncertainLive.has(row.id))
    );
  };
  const active = matching
    .filter((row) => row.status === "active" && definitelyInside(row))
    .map((row) => row.id);
  const unknown = matching
    .filter((row) => row.status === "active" && !definitelyInside(row))
    .map((row) => row.id);
  if (stopOnActive && active.length > 0) return { active, alive: [], unknown };
  const ended = matching.filter((row) => row.status !== "active");
  const alive: number[] = [];
  if (ended.length > 0) {
    const states = await resolveBackend(app, hostId).liveness(ended.map((row) => String(row.id)));
    for (const row of ended) {
      const state = states[String(row.id)];
      if (state === "dead") continue;
      if (state === "alive" && definitelyInside(row)) alive.push(row.id);
      else unknown.push(row.id);
    }
  }
  return { active, alive, unknown };
}
