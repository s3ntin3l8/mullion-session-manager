import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { projects, sessions, tasks } from "../db/schema.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { noteHostReachable } from "./host-warn-throttle.js";
import { resolveBackend, warnHostError } from "./session-backend.js";
import { killSession } from "./session-lifecycle.js";

// #2804 — a Task Master session (worker, review, rebase worker) is only ever hidden
// from the sidebar through the task's CURRENT sessionId/reviewSessionId, and only
// ended by the paths that transition the task. A spawn path that replaces or
// unlinks a session without killing it, and every archive/merge path, leaves a live,
// promptable session behind. This sweep is the safety net for both, whatever path
// caused them.

/**
 * An unlinked session younger than this is left alone: its row is inserted `active`
 * before the spawn finishes (remote hosts included) and the task is only pointed at
 * it afterwards, so a spawn in flight reads as "linked to nothing". Same window as
 * the review-spawn claim (REVIEW_SPAWN_CLAIM_STALE_MS), the longest in-flight marker.
 */
export const TASK_ORPHAN_GRACE_MS = 10 * 60_000;

const MSG_REJECTED =
  "task orphan sweep: host rejected the liveness request (reachable but erroring), skipping its sessions";
const MSG_UNREACHABLE = "task orphan sweep: host unreachable, skipping its sessions";
const MSG_BUSY = "task orphan sweep: host busy (concurrency cap reached), retrying next tick";

type Reason = "unlinked" | "archived-task";
interface Candidate {
  sessionId: number;
  taskId: number | null;
  hostId: string;
  reason: Reason;
}

let sweeping = false;

/**
 * Ends Task Master sessions that must no longer be running:
 *  - `unlinked`: spawned by a task (`sessions.task_id`) but referenced by no task's
 *    `sessionId`/`reviewSessionId`, past TASK_ORPHAN_GRACE_MS. A human's session in a
 *    task worktree carries no `task_id` and is never touched.
 *  - `archived-task`: still linked, but the task is archived (merged or done and
 *    cleared), so nothing can use the session any more.
 *
 * A host that can't be reached is skipped (retried next tick), never treated as
 * "dead": `killSession` flips the row to `killed` even when the terminate failed,
 * which would leave an untracked process behind. Returns the number of sessions it
 * asked to end. Never throws; one overlapping call is dropped.
 */
export async function sweepTaskSessions(app: FastifyInstance, now = Date.now()): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  try {
    const candidates = findCandidates(app, now);
    if (candidates.length === 0) return 0;

    const byHost = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const group = byHost.get(c.hostId) ?? [];
      group.push(c);
      byHost.set(c.hostId, group);
    }

    let ended = 0;
    await Promise.all(
      [...byHost.entries()].map(async ([hostId, group]) => {
        try {
          await resolveBackend(app, hostId).liveness(group.map((c) => String(c.sessionId)));
        } catch (err) {
          warnHostError(app.log, { hostId }, err, MSG_REJECTED, MSG_UNREACHABLE, MSG_BUSY, hostId);
          return;
        }
        noteHostReachable(app.log, hostId, MSG_UNREACHABLE, MSG_BUSY, MSG_REJECTED);
        for (const c of group) {
          app.log.warn(
            { sessionId: c.sessionId, taskId: c.taskId, hostId, reason: c.reason },
            "task orphan sweep: ending a task session that should no longer be running",
          );
          try {
            await killSession(app, c.sessionId, "detach");
            ended += 1;
          } catch (err) {
            app.log.warn(
              { err, sessionId: c.sessionId, taskId: c.taskId },
              "task orphan sweep: killSession threw, retrying next tick",
            );
          }
        }
      }),
    );
    return ended;
  } catch (err) {
    app.log.warn({ err }, "task orphan sweep failed");
    return 0;
  } finally {
    sweeping = false;
  }
}

function findCandidates(app: FastifyInstance, now: number): Candidate[] {
  const host = sql<string | null>`coalesce(${sessions.hostId}, ${projects.hostId})`;
  const byId = new Map<number, Candidate>();

  const unlinked = app.db
    .select({ id: sessions.id, taskId: sessions.taskId, hostId: host })
    .from(sessions)
    .leftJoin(projects, eq(sessions.projectId, projects.id))
    .where(
      and(
        eq(sessions.status, "active"),
        eq(sessions.kind, "terminal"),
        isNotNull(sessions.taskId),
        lt(sessions.createdAt, new Date(now - TASK_ORPHAN_GRACE_MS)),
        sql`${sessions.id} NOT IN (SELECT ${tasks.sessionId} FROM ${tasks} WHERE ${tasks.sessionId} IS NOT NULL)`,
        sql`${sessions.id} NOT IN (SELECT ${tasks.reviewSessionId} FROM ${tasks} WHERE ${tasks.reviewSessionId} IS NOT NULL)`,
      ),
    )
    .all();
  for (const row of unlinked) {
    byId.set(row.id, {
      sessionId: row.id,
      taskId: row.taskId,
      hostId: row.hostId ?? LOCAL_HOST_ID,
      reason: "unlinked",
    });
  }

  // One join, not a scan of every archived task: archived tasks only accumulate.
  const archived = app.db
    .select({ id: sessions.id, taskId: tasks.id, hostId: host })
    .from(sessions)
    .innerJoin(tasks, or(eq(tasks.sessionId, sessions.id), eq(tasks.reviewSessionId, sessions.id)))
    .leftJoin(projects, eq(sessions.projectId, projects.id))
    .where(and(isNotNull(tasks.archivedAt), eq(sessions.status, "active")))
    .all();
  for (const row of archived) {
    if (byId.has(row.id)) continue;
    byId.set(row.id, {
      sessionId: row.id,
      taskId: row.taskId,
      hostId: row.hostId ?? LOCAL_HOST_ID,
      reason: "archived-task",
    });
  }
  return [...byId.values()];
}
