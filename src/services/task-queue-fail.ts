// Issue #1997/#3194 — failing a still-`claimed` task, with the reason on the
// row where the user and the board can see it.
//
// Split out of task-claim.ts (which is at its size ceiling): the queue's
// give-up (task-dispatch.ts) and the placement refusal both land here.

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, tasks } from "../db/schema.js";
import { recordTaskTransition } from "./task-state.js";
import { syncTaskTransition } from "./task-github-sync.js";

/**
 * Fails a still-`claimed` task, with the reason on the row where the user and
 * the board can see it, and records the `claimed -> failed` transition. The
 * conditional write makes it a no-op when something else moved the row first.
 *
 * The transition record is what the activity feed and the issue sync hang
 * off — a bare status write reaches neither, so the failure would be
 * invisible in both. `dispatchQueuedRetry`'s own release() makes the same
 * `claimed -> failed` write and records it the same way.
 *
 * `extra` is written with the failure AND shown to the issue sync, so what it
 * syncs is the row as it now is. The dispatch-failure clock is always cleared:
 * the task is no longer queued.
 *
 * Shared by the placement refusal below and the dispatcher's give-up
 * (task-dispatch.ts, issue #1997).
 */
export function failQueuedTask(
  app: FastifyInstance,
  taskId: number,
  opts: {
    detail: string;
    via: "placement-refusal" | "dispatch-give-up";
    hostId: string | null;
    context?: Record<string, unknown>;
    extra?: Partial<typeof tasks.$inferInsert>;
  },
): boolean {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (!task) return false;
  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return false;
  const patch: Partial<typeof tasks.$inferInsert> = {
    status: "failed",
    resumeQueued: false,
    failureReason: opts.detail,
    failureDiagnostics: null,
    dispatchFailingSince: null,
    dispatchHeld: false,
    // Issue #3194 — a failed task is not waiting for a host any more.
    retryHostId: null,
    ...opts.extra,
  };
  const updated = app.db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
    .run();
  if (updated.changes === 0) return false;
  recordTaskTransition(app, {
    taskId,
    projectId: project.id,
    from: "claimed",
    to: "failed",
    via: opts.via,
    context: { reason: opts.detail, hostId: opts.hostId, ...opts.context },
  });
  // Fire-and-forget, same posture as every other sync on this path — the
  // transition is already committed, and a GitHub-side problem must not
  // unwind it.
  void syncTaskTransition(app, { ...task, ...patch } as typeof task, project, "failed");
  return true;
}
