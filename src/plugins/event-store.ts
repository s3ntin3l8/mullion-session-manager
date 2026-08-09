import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startEventWriter, startEventRetentionSweep } from "../services/event-store.js";
import { startRemoteEventSubscriber } from "../services/remote-event-subscriber.js";

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
// As of remote-event-subscriber.ts, this also captures every enrolled
// agent host's events, not just this process's own — app.pty.onEvent()
// still only ever sees sessions THIS process spawned, but startEventWriter
// now also accepts pushEvent() calls fed by a persistent per-host
// `/internal/ws/events` subscription (remoteSubscriber below), independent
// of any browser tab being open. That's the piece relayRemoteEventsHost
// (src/routes/events.ts) never provided — its upstreams live and die with
// a browser's own `/ws/events` socket, so a remote host's events were
// simply never observed with no tab open. See event-store.ts's and
// event-history.ts's own doc comments for the full picture, and
// schema.ts's for the reconnect-replay dedupe index this all relies on.
export const eventStorePlugin = fp(async (app: FastifyInstance) => {
  // Agent role has no app.db (see src/app.ts) — the write path, the
  // retention sweep, and the remote subscriber's ownership checks all need
  // it, so this whole plugin is a no-op there. (The agent role's own
  // events are exposed to the primary via its DB-less
  // /internal/ws/events, routes/internal.ts — the far end of the
  // subscription this plugin opens.)
  if (app.config.MULLION_ROLE !== "primary") return;

  const writer = startEventWriter(app);
  // Declared before startEventRetentionSweep (below), not after — its
  // onTick closure captures this by reference, and while a closure over a
  // not-yet-initialized `const` happened to be safe here (no sweep can
  // complete synchronously during registration; the first tick is the
  // onReady runNow() further down), that safety depended on call-order
  // reasoning a reader would have to re-derive. Declaring in dependency
  // order removes the TDZ entirely (Hermes review, PR #564).
  const remoteSubscriber = startRemoteEventSubscriber(app, (event, sourceHostId) => {
    writer.pushEvent(event, sourceHostId);
  });
  const retention = startEventRetentionSweep(app, {
    // Hazard 5 fallback: reconcile the remote-subscription set on the same
    // fixed cadence the retention sweep already runs on, in case an
    // explicit reconfigureRemoteEventSubscriptions() call was ever missed
    // (there shouldn't be one — every host/enrollment mutation calls it —
    // but this makes that guarantee non-load-bearing).
    onTick: () => remoteSubscriber.reconcile(),
  });

  // PATCH /api/settings calls this after a write that changes
  // sessions.eventRetentionDays/eventRetentionPerSession/eventPersistence
  // so the new threshold takes effect immediately rather than waiting up to
  // the sweep's fixed cadence for its next tick — same immediate-effect
  // posture as reconfigureReconciler/reconfigureGitFetcher. This doesn't
  // re-arm any interval (the cadence is fixed — see event-store.ts's own
  // comment) — it just runs one sweep now, against whatever is currently
  // persisted (the settings route always writes before calling this, so
  // the fresh getStoredSettings read inside the sweep already sees the new
  // value). The sweep's own onTick above means an eventPersistence toggle
  // reaches remoteSubscriber.reconcile() through this same call, closing or
  // opening upstreams immediately (hazard 6) with no separate wiring needed.
  app.decorate("reconfigureEventRetention", () => {
    retention.runNow().catch((err: unknown) => {
      app.log.error({ err }, "session_events retention sweep failed");
    });
  });

  // Issue #213 cross-host capture (hazard 5) — the host set is not static
  // (hosts are enrolled/updated/deleted at runtime, host-registry.ts).
  // Called from routes/hosts.ts and routes/enrollment.ts on any mutation
  // that could change the desired subscription set; `forceReconnect` lets a
  // caller force a specific host's subscription to reopen immediately (a
  // rotated token/baseUrl) rather than keep using a socket built from
  // stale credentials until it happens to error out on its own.
  app.decorate("reconfigureRemoteEventSubscriptions", (opts?: { forceReconnect?: string[] }) => {
    remoteSubscriber.reconcile({ forceReconnect: opts?.forceReconnect });
  });

  // Also sweep once at boot: a server that's been down a while with
  // retention already configured shouldn't wait a full cadence for its
  // first prune. The sweep's own onTick (above) means this same call also
  // opens remote subscriptions immediately at boot, instead of waiting up
  // to EVENT_RETENTION_SWEEP_INTERVAL_MS for the first tick.
  app.addHook("onReady", async () => {
    await retention.runNow();
  });

  app.addHook("onClose", () => {
    remoteSubscriber.stop();
    retention.stop();
    writer.stop();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    reconfigureEventRetention: () => void;
    reconfigureRemoteEventSubscriptions: (opts?: { forceReconnect?: string[] }) => void;
  }
}
