import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startEventWriter, startEventRetentionSweep } from "../services/event-store.js";

// Issue #213 (roadmap 4.7) — persists NotificationEvents (pty-manager.ts) to
// the new `session_events` table (src/db/schema.ts), opt-in via
// settings.sessions.eventPersistence (default off, matching Phase 1's
// in-memory-only event model — see docs/roadmap.md). The actual
// debounce/ceiling write path and the retention sweep both live in
// src/services/event-store.ts as plain, directly-testable functions — this
// file is just the Fastify wiring (role gate, decorator, hook lifecycle),
// mirroring src/plugins/task-watcher.ts's own split from
// src/services/task-watcher.ts's startTaskWatcher.
//
// Deliberately NOT wired into PtyManager itself: PtyManager has zero
// drizzle imports today, specifically because the "agent" role registers
// ptyPlugin with NO dbPlugin registered at all (see src/app.ts's role
// branch) — giving PtyManager a DB dependency would crash that role
// outright. Instead this plugin subscribes to the existing PUBLIC fan-out
// (app.pty.onEvent()) from the outside, exactly the way routes/events.ts's
// /ws/events already does, and is itself skipped entirely on the agent
// role (see the guard below).
//
// PRIMARY-LOCAL ONLY SCOPE (state this loudly — see this PR's description):
// app.pty.onEvent() only ever sees events from sessions THIS process
// spawned. A remote agent host's events reach the primary today only
// through per-browser-socket relays (relayRemoteEventsHost,
// src/routes/events.ts), which open when a browser tab connects and close
// when it disconnects — with no browser tab open, a remote host's events
// are never observed by the primary at all, so nothing here can persist
// them. Capturing remote-host history for real would need a persistent
// primary->agent `/internal/ws/events` subscription independent of any
// browser connection — a real follow-up, not attempted in this PR.
export const eventStorePlugin = fp(async (app: FastifyInstance) => {
  // Agent role has no app.db (see src/app.ts) — both the write path and the
  // retention sweep need it, so this whole plugin is a no-op there.
  if (app.config.MULLION_ROLE !== "primary") return;

  const stopWriter = startEventWriter(app);
  const retention = startEventRetentionSweep(app);

  // PATCH /api/settings calls this after a write that changes
  // sessions.eventRetentionDays (or eventPersistence) so the new threshold
  // takes effect immediately rather than waiting up to the sweep's fixed
  // cadence for its next tick — same immediate-effect posture as
  // reconfigureReconciler/reconfigureGitFetcher. This doesn't re-arm any
  // interval (the cadence is fixed — see event-store.ts's own comment) — it
  // just runs one sweep now, against whatever is currently persisted (the
  // settings route always writes before calling this, so the fresh
  // getStoredSettings read inside the sweep already sees the new value).
  app.decorate("reconfigureEventRetention", () => {
    retention.runNow().catch((err: unknown) => {
      app.log.error({ err }, "session_events retention sweep failed");
    });
  });

  // Also sweep once at boot: a server that's been down a while with
  // retention already configured shouldn't wait a full cadence for its
  // first prune.
  app.addHook("onReady", async () => {
    await retention.runNow();
  });

  app.addHook("onClose", () => {
    retention.stop();
    stopWriter();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    reconfigureEventRetention: () => void;
  }
}
