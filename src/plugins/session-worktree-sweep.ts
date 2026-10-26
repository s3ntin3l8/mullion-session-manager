import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { sweepSessionWorktrees } from "../services/session-worktree-reclaim.js";

// Issue #1964 — reclaims the worktrees of ended isolated sessions that could
// not be reclaimed when they ended (the branch was not yet pushed or merged,
// the host was unreachable). Primary only: an agent has no database to find
// them in and no timers of its own, and the primary reaches every host through
// the same SessionBackend calls.

/** How often the sweep runs. A worktree left over for half an hour is not an
 * emergency, and each pass costs a git round trip per leftover. */
export const SESSION_WORKTREE_SWEEP_INTERVAL_MS = 30 * 60_000;
/** The first pass, soon after boot: sessions that ended while the server was
 * down, or in the window before a restart, are otherwise waiting half an hour. */
const FIRST_SWEEP_DELAY_MS = 2 * 60_000;

export const sessionWorktreeSweepPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  let running = false;
  async function sweep() {
    // One at a time: a slow remote host must not stack passes up behind itself.
    if (running) return;
    running = true;
    try {
      const counts = await sweepSessionWorktrees(app);
      if (counts.reclaimed > 0 || counts.kept > 0 || counts.deferred > 0) {
        app.log.info(counts, "session worktree sweep");
      }
    } catch (err) {
      app.log.error({ err }, "session worktree sweep failed");
    } finally {
      running = false;
    }
  }

  let first: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  app.addHook("onReady", async () => {
    first = setTimeout(() => void sweep(), FIRST_SWEEP_DELAY_MS);
    first.unref();
    timer = setInterval(() => void sweep(), SESSION_WORKTREE_SWEEP_INTERVAL_MS);
    timer.unref();
  });
  app.addHook("onClose", () => {
    if (first) clearTimeout(first);
    if (timer) clearInterval(timer);
  });
});
