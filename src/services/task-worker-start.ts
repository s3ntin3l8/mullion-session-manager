import type { FastifyInstance } from "fastify";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { sessions } from "../db/schema.js";
import { tasks } from "../db/schema.js";
import type { SessionBackend } from "./session-backend.js";
import { discoverTurnStarted } from "./session-turn-start.js";
import { notifyTaskNeedsAttention } from "./push-delivery.js";
import { broadcastTaskEvent } from "./task-events.js";
import { registerTaskTransitionListener } from "./task-state.js";

const startedLocalWorkers = new WeakSet<object>();

type Task = typeof tasks.$inferSelect;
type Session = typeof sessions.$inferSelect;

registerTaskTransitionListener((app, { taskId, to }) => {
  if (to !== "in_progress") {
    app.db
      .update(tasks)
      .set({ needsHumanReason: null })
      .where(and(eq(tasks.id, taskId), eq(tasks.needsHumanReason, "worker-not-started")))
      .run();
  }
});

/** Also cleans old/raw status writes, including tasks with no surviving session. */
export function clearStoppedWorkerWarnings(app: FastifyInstance): void {
  app.db
    .update(tasks)
    .set({ needsHumanReason: null })
    .where(and(ne(tasks.status, "in_progress"), eq(tasks.needsHumanReason, "worker-not-started")))
    .run();
}

async function turnStarted(
  app: FastifyInstance,
  session: Session,
  hostId: string,
  backend: SessionBackend,
): Promise<boolean | null> {
  if (!hostId || hostId === "local") {
    const live = app.pty.get(String(session.id));
    if (!live) return null;
    if (startedLocalWorkers.has(live)) return true;
    const search = live.startupTranscriptSearch?.();
    if (!search) return null;
    const started = await discoverTurnStarted({ ...search, since: session.createdAt.getTime() });
    if (started) startedLocalWorkers.add(live);
    // A later constructor belongs to an adopted session. Its original launch
    // environment may be lost, so absence in a guessed home proves nothing.
    // Allow for the DB timestamp's one-second precision and spawn scheduling.
    if (started === false && search.since > session.createdAt.getTime() + 5_000) return null;
    return started;
  }
  // Version-skewed/unsupported remote hosts return a refusal. Never interpret
  // that as an empty conversation. A user entry suffices even with no output.
  const transcript = await backend.getTranscript(String(session.id), {
    afterSeq: 0,
    limit: 500,
    fullTools: false,
  });
  if (!transcript.ok) return null;
  if (transcript.entries.some((entry) => entry.role === "user")) return true;
  return transcript.more ? null : false;
}

export async function checkWorkerStarted(
  app: FastifyInstance,
  task: Task,
  session: Session,
  hostId: string,
  backend: SessionBackend,
  timeoutMinutes: number,
  now: Date,
): Promise<void> {
  if (task.status !== "in_progress" || session.status !== "active") return;
  if (
    task.needsHumanReason !== "worker-not-started" &&
    (timeoutMinutes === 0 || now.getTime() - session.createdAt.getTime() <= timeoutMinutes * 60_000)
  )
    return;
  try {
    const started = await turnStarted(app, session, hostId, backend);
    if (started === null) return;
    if (started) {
      const cleared = app.db
        .update(tasks)
        .set({ needsHumanReason: null })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.sessionId, session.id),
            eq(tasks.needsHumanReason, "worker-not-started"),
          ),
        )
        .run();
      if (cleared.changes)
        broadcastTaskEvent({
          taskId: task.id,
          projectId: task.projectId,
          kind: "nudge",
          ts: now.getTime(),
        });
      return;
    }
    if (timeoutMinutes === 0 || task.needsHumanReason !== null) return;
    let screen = "(screen unavailable)";
    try {
      screen =
        (await backend.getRenderedScrollback(String(session.id)))
          .trimEnd()
          .split("\n")
          .slice(-12)
          .join("\n")
          .slice(-4000) || "(empty screen)";
    } catch {
      /* Screen diagnostics must not suppress the warning. */
    }
    const changed = app.db
      .update(tasks)
      .set({ needsHumanReason: "worker-not-started" })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.status, "in_progress"),
          eq(tasks.sessionId, session.id),
          isNull(tasks.needsHumanReason),
        ),
      )
      .run();
    if (!changed.changes) return;
    const note = `Worker has not started a turn after ${timeoutMinutes} minutes. Check its terminal for a startup prompt.\nLast rendered screen lines:\n${screen}`;
    app.pty.get(String(session.id))?.emitTaskStartupNote?.(note);
    app.log.info({ taskId: task.id, sessionId: session.id, note }, "task worker has not started");
    broadcastTaskEvent({
      taskId: task.id,
      projectId: task.projectId,
      kind: "nudge",
      ts: now.getTime(),
    });
    await notifyTaskNeedsAttention(app, task.id, `Task #${task.id}: worker has not started a turn`);
  } catch (err) {
    app.log.warn({ err, taskId: task.id }, "task reconcile: worker startup check unavailable");
  }
}
