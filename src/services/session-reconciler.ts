import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";

/**
 * Detects sessions whose program exited on its own — user typed `exit`, a
 * crash — rather than via an explicit DELETE /api/sessions/:id. Fixes the
 * M2-era gap: such a session left a stale dtach socket with `status` still
 * "active" forever, so the next getOrCreate() would silently bootstrap a
 * fresh program under the same id instead of surfacing that it had ended.
 *
 * Source of truth is PtyManager.isMasterAlive() (the session's systemd
 * scope), not anything tracked in this process's memory — so this correctly
 * catches a session that exited before this process ever re-attached to it
 * (e.g. right after a restart). Only "active" rows are checked: "killed"
 * and previously-reconciled "exited" rows are already-settled and skipped.
 */
export async function reconcileExitedSessions(app: FastifyInstance): Promise<void> {
  const active = app.db.select().from(sessions).where(eq(sessions.status, "active")).all();

  await Promise.all(
    active.map(async (row) => {
      const alive = await app.pty.isMasterAlive(String(row.id));
      if (alive) return;

      // Stop tracking our now-orphaned attach-client, if any, then mark the
      // row so terminal.ts's preValidation stops offering to reattach to it.
      app.pty.kill(String(row.id));
      app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, row.id)).run();
      app.log.info({ sessionId: row.id }, "session reconciled: program exited on its own");
    }),
  );
}
