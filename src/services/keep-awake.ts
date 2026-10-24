import { spawn, type ChildProcess } from "node:child_process";
import type { FastifyInstance } from "fastify";

// Issue #1719 (roadmap 8.5) — keep an idle macOS host awake while it has
// live sessions.
//
// THE PROBLEM: macOS idles a laptop into sleep after a few minutes of
// inactivity, and a sleeping machine runs NOTHING — a session on it makes no
// progress at all, not even the polling a "background" task would do. The
// launchd unit cannot fix this: `KeepAlive` decides whether a job is
// *restarted* after it exits, and has nothing to say about the machine
// staying awake. Only a power assertion (`caffeinate`) or a `pmset` setting
// does.
//
// WHY AN APP-LEVEL CHILD, ARMED ON LIVE SESSIONS: an always-on launchd
// keep-awake job would hold the assertion forever — the machine would never
// sleep again, even with nothing to do, which is a battery bug rather than a
// feature. Mullion holds the assertion only while it actually has live
// sessions, so an idle-but-installed agent still lets the laptop sleep. This
// matches #1719's own wording: "run caffeinate while sessions are live".
//
// THE `-w <pid>` IS LOAD-BEARING: launchd's own units carry
// `AbandonProcessGroup=true` (deploy/launchd/*.plist), which means launchd
// does NOT signal the job's children when the job is stopped — so a
// SIGTERM to Mullion would leave an orphaned `caffeinate` behind, holding
// the assertion and keeping the machine awake forever. `caffeinate -w <pid>`
// exits by itself when the given process exits, which covers even the case
// where Mullion is SIGKILLed and never gets to run its own cleanup.

/** How often the live-session predicate is re-evaluated. */
export const DEFAULT_KEEP_AWAKE_INTERVAL_MS = 10_000;

/** The `caffeinate` flags Mullion uses: no display sleep, no idle sleep, no
 * sleep on AC power, and declare the user active. */
export const CAFFEINATE_ARGS = ["-dimsu"] as const;

export interface KeepAwakeOptions {
  /** Platform override — tests only. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** How often to re-evaluate the predicate. Defaults to 10s. */
  intervalMs?: number;
  /**
   * Injectable spawn — tests only. Defaults to `node:child_process`'s spawn.
   *
   * Injectable rather than module-mocked so the test can drive the arm/disarm
   * lifecycle without monkey-patching a global.
   */
  spawnFn?: typeof spawn;
  /**
   * Whether this host currently has at least one live session. Defaults to
   * reading `app.pty`'s in-memory session list.
   */
  hasLiveSessions?: () => boolean;
}

export interface KeepAwakeHandle {
  /** Re-evaluates the predicate now and arms/disarms accordingly. */
  sync(): void;
  /** Whether the keep-awake child is currently running. */
  isArmed(): boolean;
  /** Stops the timer and terminates the child. Idempotent. */
  stop(): void;
}

/**
 * Starts the keep-awake service.
 *
 * INERT OFF DARWIN: on every other platform this returns a handle that does
 * nothing at all — no timer, no child. `caffeinate` is a macOS binary; on
 * Linux the equivalent concern does not exist (a systemd unit's
 * `WakeSystem`/idle behaviour is a different problem, and the Linux path is
 * #1720's territory, not this issue's).
 */
export function startKeepAwake(
  app: FastifyInstance,
  options: KeepAwakeOptions = {},
): KeepAwakeHandle {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawnFn ?? spawn;

  if (platform !== "darwin") {
    return {
      sync: () => {},
      isArmed: () => false,
      stop: () => {},
    };
  }

  if (app.config.MULLION_KEEP_AWAKE === false) {
    app.log.info("[keep-awake] disabled by MULLION_KEEP_AWAKE=0 — the host may idle-sleep");
    return {
      sync: () => {},
      isArmed: () => false,
      stop: () => {},
    };
  }

  const intervalMs = options.intervalMs ?? DEFAULT_KEEP_AWAKE_INTERVAL_MS;
  const hasLiveSessions =
    options.hasLiveSessions ?? (() => app.pty.list().some((session) => session.alive));

  let child: ChildProcess | null = null;
  let stopped = false;
  // Set once the binary is known to be missing, so a host without caffeinate
  // logs ONE warning instead of one per poll for the rest of the process's
  // life. A missing keep-awake must never be fatal — sessions still run.
  let binaryMissing = false;

  function disarm(): void {
    if (!child) return;
    const current = child;
    child = null;
    try {
      current.kill("SIGTERM");
    } catch (err) {
      // The child may already be gone (it exited on its own between the
      // predicate check and here). Nothing to do.
      app.log.debug({ err }, "[keep-awake] failed to terminate the caffeinate child");
    }
  }

  function arm(): void {
    if (child || binaryMissing) return;
    const args = [...CAFFEINATE_ARGS, "-w", String(process.pid)];
    try {
      const spawned = spawnFn("caffeinate", args, { stdio: "ignore" });
      child = spawned;
      spawned.on("error", (err: unknown) => {
        child = null;
        if (!binaryMissing) {
          binaryMissing = true;
          app.log.warn(
            { err },
            "[keep-awake] could not start caffeinate — the host may idle-sleep while sessions run",
          );
        }
      });
      spawned.on("exit", () => {
        // caffeinate exited on its own (e.g. our own SIGTERM landed). Drop the
        // reference so the next poll can re-arm if sessions are still live.
        if (child === spawned) child = null;
      });
      app.log.info({ args }, "[keep-awake] armed");
    } catch (err) {
      if (!binaryMissing) {
        binaryMissing = true;
        app.log.warn(
          { err },
          "[keep-awake] could not start caffeinate — the host may idle-sleep while sessions run",
        );
      }
    }
  }

  function sync(): void {
    if (stopped) return;
    let live: boolean;
    try {
      live = hasLiveSessions();
    } catch (err) {
      // A failure to read the session list must never disarm the keep-awake
      // on a guess — an armed-but-unnecessary assertion is far less harmful
      // than a disarmed machine that idles into the middle of a build.
      app.log.error({ err }, "[keep-awake] could not read the live-session list");
      return;
    }
    if (live) arm();
    else disarm();
  }

  const timer = setInterval(sync, intervalMs);
  // unref() so this timer alone never keeps the process alive — matching the
  // repo's convention for background timers (see src/plugins/pty.ts's
  // reconcile timer).
  timer.unref();

  return {
    sync,
    isArmed: () => child !== null,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      disarm();
    },
  };
}
