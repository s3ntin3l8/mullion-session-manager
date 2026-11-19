import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tasks } from "../db/schema.js";
import type { projects } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { getCodexHookTrust } from "./hook-adapters/codex-trust.js";
import { commandAgentBin } from "./hook-adapters/index.js";
import { broadcastTaskEvent } from "./task-events.js";

export const CODEX_TRUST_HOLD_DETAIL =
  "Codex is waiting for /hooks trust — open codex once and approve Mullion's hooks";

/**
 * Issue #3341 — the Codex `/hooks` trust gate for a task that is already
 * `claimed`. Returns a "codex-trust-held" outcome while the resolved agent is
 * local codex and `getCodexHookTrust()` is `"pending"`, else null (dispatch
 * proceeds). Fails open (logs a warning and dispatches) if the trust check
 * throws.
 */
export function codexTrustHold(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  command: string,
  workerHostId: string,
): { ok: false; reason: "codex-trust-held"; detail: string } | null {
  // A remote worker host's trust state lives in that host's `~/.codex`, which
  // `getCodexHookTrust()` cannot read: do not gate remote placements.
  if (commandAgentBin(command) === "codex" && workerHostId === LOCAL_HOST_ID) {
    let trust: ReturnType<typeof getCodexHookTrust>;
    try {
      trust = getCodexHookTrust();
    } catch (err) {
      app.log.warn(
        { err, taskId: task.id },
        "task dispatch: getCodexHookTrust failed — dispatching anyway",
      );
      trust = "trusted";
    }
    if (trust === "pending") {
      if (task.failureReason !== CODEX_TRUST_HOLD_DETAIL) {
        const written = app.db
          .update(tasks)
          .set({ failureReason: CODEX_TRUST_HOLD_DETAIL })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
          .run();
        if (written.changes > 0) {
          app.log.info(
            { taskId: task.id },
            `task dispatch: ${CODEX_TRUST_HOLD_DETAIL} — holding the task`,
          );
          broadcastTaskEvent({
            taskId: task.id,
            projectId: project.id,
            kind: "dispatch",
            ts: Date.now(),
          });
        }
      }
      return { ok: false, reason: "codex-trust-held", detail: CODEX_TRUST_HOLD_DETAIL };
    }
  }
  // Gate is clear (or no longer local codex): drop a hold text left by an earlier sweep.
  if (task.failureReason === CODEX_TRUST_HOLD_DETAIL) {
    const cleared = app.db
      .update(tasks)
      .set({ failureReason: null })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
      .run();
    if (cleared.changes > 0) {
      broadcastTaskEvent({
        taskId: task.id,
        projectId: project.id,
        kind: "dispatch",
        ts: Date.now(),
      });
    }
  }
  return null;
}
