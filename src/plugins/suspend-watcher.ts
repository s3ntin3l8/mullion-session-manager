import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startSuspendWatcher, type SuspendWatcherHandle } from "../services/suspend-detect.js";

// Issue #1719 (roadmap 8.5) — decorates app.suspendWatcher, the one
// process-wide watcher that reports "this host just came back from a
// suspend".
//
// Registered in BOTH role branches, and deliberately early (before ptyPlugin
// and agentEnrollmentPlugin, which both subscribe to it): the detection is
// cheap, needs neither the DB nor app.pty, and has to exist before either of
// its subscribers registers.
//
// One watcher for the whole process, not one per subscriber: two independent
// timers would each have to decide independently whether a gap was a suspend,
// and a subscriber that missed the event would silently miss the recovery it
// depends on.

export const suspendWatcherPlugin = fp(async (app: FastifyInstance) => {
  const watcher: SuspendWatcherHandle = startSuspendWatcher(app);

  app.decorate("suspendWatcher", watcher);

  app.addHook("onClose", () => {
    watcher.stop();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    /** The process-wide suspend/resume watcher — see suspend-detect.ts. */
    suspendWatcher: SuspendWatcherHandle;
  }
}
