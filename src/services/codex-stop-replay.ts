// Issue #2939 — a codex Stop that arrives before adopt is rejected and the
// forwarder has already exited, so it cannot be retried. The rollout file
// is still there. After a session is adopted, replay a clean completion
// that the reconciler never saw, as the same progress message mapCodexStop
// emits (forwarder-core.mjs). A rate-limited completion is left for
// detectCodexRateLimits.
import { eq, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { readCodexRateLimitSignal } from "../hooks/codex-rollout.mjs";
import { tasks } from "../db/schema.js";
import type { HookMessage } from "./hook-protocol.js";

/** session id -> turn id already replayed in this process. */
const replayedTurns = new Map<string, string>();

/** Codex writes `completed_at` in unix seconds. A 13-digit value is already ms. */
function completedAtMs(raw: number): number {
  return raw > 1e12 ? raw : raw * 1000;
}

/**
 * Emits the Stop a restart dropped, once, for a task session that was just
 * adopted. No-op unless the rollout's last turn is a clean completion at or
 * after the claim (or the review start), with nothing after it.
 */
export async function replayDroppedCodexStop(
  app: FastifyInstance,
  sessionId: string,
): Promise<void> {
  const sessionNumericId = Number(sessionId);
  if (!Number.isInteger(sessionNumericId)) return;

  const rows = app.db
    .select()
    .from(tasks)
    .where(or(eq(tasks.sessionId, sessionNumericId), eq(tasks.reviewSessionId, sessionNumericId)))
    .all();
  const task = rows.find(
    (row) => row.status === "claimed" || row.status === "in_progress" || row.status === "reviewing",
  );
  if (!task) return;
  const since = task.sessionId === sessionNumericId ? task.claimedAt : task.reviewingAt;
  if (since === null) return;

  const found = app.pty.codexTranscriptPathSessions().find((row) => row.id === sessionId);
  if (!found) return;

  let signal;
  try {
    signal = readCodexRateLimitSignal(found.transcriptPath, { codexHome: found.codexHome });
  } catch {
    return;
  }
  if (signal === null || signal.rateLimited || signal.followed) return;
  if (signal.turnId === null || signal.completedAt === null) return;
  if (completedAtMs(signal.completedAt) < since.getTime()) return;
  if (replayedTurns.get(sessionId) === signal.turnId) return;

  const live = app.pty.get(sessionId);
  if (live && typeof live.toInfo === "function") {
    const ended = live.toInfo().lastTurnEndedAt;
    if (ended !== null && ended >= since.getTime()) {
      replayedTurns.set(sessionId, signal.turnId);
      return;
    }
  }

  // Same shape as mapCodexStop. Not imported: forwarder-core.mjs has no
  // declaration file, and this is the whole Stop mapping.
  const message: HookMessage = {
    kind: "progress",
    phase: "done",
    ...(signal.lastAgentMessage !== null ? { lastAssistantMessage: signal.lastAgentMessage } : {}),
  };
  app.pty.emitHookEvent(sessionId, message, completedAtMs(signal.completedAt), {
    provesHookPipeline: false,
  });
  replayedTurns.set(sessionId, signal.turnId);
}
