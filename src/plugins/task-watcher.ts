import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startTaskWatcher } from "../services/task-watcher.js";

// Phase 2.5 Task Master, Thin Slice (issue #214/#227) — inert unless both
// this is the primary role (mirrors githubPRPollerPlugin) AND
// MULLION_TASK_MASTER_ENABLED is set (default false — see env.ts). Flag-off
// means zero behavior change: no timers started, GET /api/tasks always
// returns [] (see routes/tasks.ts).
export const taskWatcherPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;
  if (!app.config.MULLION_TASK_MASTER_ENABLED) return;

  let cleanup: (() => void) | null = null;

  app.addHook("onReady", () => {
    cleanup = startTaskWatcher(app);
  });

  app.addHook("onClose", () => {
    if (cleanup) cleanup();
  });
});
