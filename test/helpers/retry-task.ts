import type { FastifyInstance } from "fastify";

/**
 * A retry is queued (`enqueueRetry`) and then started by the dispatch sweep
 * (`dispatchQueuedRetry`). Tests that want the combined end-to-end behavior
 * the old single-phase `retryTask` had call this; tests that need the
 * intermediate "queued, no slot yet" state call the two halves directly.
 *
 * Imports lazily so a test's own `vi.mock` of the services applies.
 */
export async function retryTask(
  app: FastifyInstance,
  taskId: number,
  opts: { agent?: string | null; reviewAgent?: string | null } = {},
) {
  const { enqueueRetry } = await import("../../src/services/task-retry.js");
  const { dispatchQueuedRetry } = await import("../../src/services/task-claim.js");
  const queued = await enqueueRetry(app, taskId, opts);
  if (!queued.ok) return queued;
  return dispatchQueuedRetry(app, taskId);
}

/** Waits for the dispatch sweep to start a queued task: the row flips to
 * `in_progress` at reservation, and the session is attached after the spawn. */
export async function waitForTaskRunning(app: FastifyInstance, taskId: number) {
  const { vi } = await import("vitest");
  const { eq } = await import("drizzle-orm");
  const { tasks } = await import("../../src/db/schema.js");
  await vi.waitFor(
    () => {
      const row = app.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (row?.status !== "in_progress" || row.sessionId === null) throw new Error("not running");
    },
    { timeout: 15000 },
  );
}
