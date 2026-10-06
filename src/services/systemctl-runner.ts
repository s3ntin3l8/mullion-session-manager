import { spawn as spawnChild, type ChildProcess } from "node:child_process";

// Shared `systemctl --user` spawn plumbing — kept in its own module (not
// session-process.ts) so cgroup-inventory.ts can use it without an import
// cycle (session-process.ts imports cgroup-inventory.ts). session-process.ts
// re-exports everything here, so existing importers (device-process.ts,
// avd-manager.ts, pty-manager.ts) are unchanged.

// Issue #1232 — every systemctl spawn in this file except describeScope()
// had no timeout at all: a wedged `--user` D-Bus bus (systemd restart, OOM
// pressure) left the caller pending indefinitely. isSystemctlUserAvailable's
// execFileSync below is worse than the async cases — a synchronous call
// blocks the entire event loop, not just one promise. SYSTEMCTL_TIMEOUT_MS
// matches cgroup-inventory.ts's own SYSTEMCTL_TIMEOUT_MS budget for the same
// class of call; KILL_ESCALATION_MS mirrors every other spawn-with-timeout
// helper in this repo (git-status.ts, agent-detect.ts, ...) — SIGTERM first,
// SIGKILL only if the process is still alive after a short grace period.
// Exported — device-process.ts (the devices/AVD analogue of this module,
// same "crs-<kind>-<instanceId>-<id>" scope-naming/ownership shape, a
// deliberately separate module rather than a generalization of this
// high-risk one, see that file's own header) reuses this budget and the
// escalation helper below rather than hand-copying them and risking drift.
export const SYSTEMCTL_TIMEOUT_MS = 5_000;
export const KILL_ESCALATION_MS = 2_000;

/**
 * Arms the SIGTERM-then-SIGKILL escalation every timed spawn below needs —
 * extracted once three near-identical hand-rolled copies of this same
 * bookkeeping accumulated in this file (describeScope, listOwnedScopes,
 * stopScope; code-review finding on this issue). `onTimeout` fires once,
 * synchronously, when `timeoutMs` elapses with SIGTERM already sent — its
 * ONLY job is to settle whatever promise this spawn backs (e.g. call this
 * function's own `finish`/`fail`); it must NOT call the returned
 * `clearOnSettle` itself, or the escalation timer this function just armed
 * would be cancelled before it can ever fire, defeating the whole point.
 *
 * `clearOnSettle` is what the caller's own 'error'/'close'/'exit' handlers
 * call instead, unconditionally, once the child is CONFIRMED to have
 * actually ended — whether that happens before `timeoutMs` (the ordinary,
 * on-time case) or after (SIGTERM/SIGKILL actually worked). Safe to call
 * either way: clearing an already-fired `timeoutMs` timer is a no-op: only
 * the still-pending escalation timer, if any, actually gets cancelled.
 */
// Exported for device-process.ts's reuse — see the SYSTEMCTL_TIMEOUT_MS
// comment above. No behavior change; this function is otherwise unmodified.
export function armKillEscalation(
  child: Pick<ChildProcess, "kill" | "exitCode" | "signalCode">,
  timeoutMs: number,
  onTimeout: () => void,
): { clearOnSettle: () => void } {
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const clearKillTimer = () => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  };

  const timer = setTimeout(() => {
    try {
      child.kill(); // SIGTERM
    } catch {
      // Best-effort — a kill() failure on an already-dead or non-standard
      // child must not turn into an unhandled throw here.
    }
    // Escalate to SIGKILL if still alive after a short grace period.
    // `killed`/`exitCode` alone don't tell us this — Node sets `killed`
    // once a signal is successfully SENT, not once the process has
    // actually died — so `exitCode`/`signalCode` both staying `null` is
    // the real "still alive" signal. Deliberately NOT cancelled by
    // `onTimeout` below — see this function's own doc comment.
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Same best-effort posture as the SIGTERM above.
        }
      }
    }, KILL_ESCALATION_MS);
    killTimer.unref();
    onTimeout();
  }, timeoutMs);
  timer.unref();

  return {
    clearOnSettle: () => {
      clearTimeout(timer);
      clearKillTimer();
    },
  };
}

export interface SystemctlResult {
  /** Everything the child wrote to stdout (empty unless `captureStdout`). */
  stdout: string;
  /** Exit code, when the child ended on its own. */
  code: number | null;
  /** The spawn itself failed (systemctl missing, EAGAIN, ...). */
  errored: boolean;
  /** `timeoutMs` elapsed first; SIGTERM (then SIGKILL) was sent. */
  timedOut: boolean;
}

/**
 * Runs `systemctl <args>` bounded by `timeoutMs` (SIGTERM, then SIGKILL after
 * KILL_ESCALATION_MS, via armKillEscalation) and resolves with what happened.
 * NEVER rejects — callers map `errored`/`timedOut`/`code` onto their own
 * failure contract (a listing's `failed: true`, a best-effort stop's no-op,
 * a describe probe's `null`). Settles at most once.
 *
 * `captureStdout: true` pipes stdout and settles on 'close' (not 'exit' —
 * 'exit' doesn't guarantee every stdout chunk has arrived yet). Otherwise
 * stdio is ignored entirely and the child settles on 'exit' (a mutating
 * call like `stop` has nothing to read back).
 */
export function runSystemctl(
  args: string[],
  timeoutMs: number,
  opts: { captureStdout?: boolean } = {},
): Promise<SystemctlResult> {
  const capture = opts.captureStdout === true;
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawnChild("systemctl", args, {
      stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
    });
    const onStdoutData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);

    const finish = (partial: Partial<SystemctlResult>) => {
      if (settled) return;
      settled = true;
      child.stdout?.off("data", onStdoutData);
      resolve({ stdout, code: null, errored: false, timedOut: false, ...partial });
    };
    const armed = armKillEscalation(child, timeoutMs, () => finish({ timedOut: true }));
    const onEnd = (code: number | null) => {
      armed.clearOnSettle();
      finish({ code });
    };
    child.on("error", () => {
      armed.clearOnSettle();
      finish({ errored: true });
    });
    child.on(capture ? "close" : "exit", onEnd);
  });
}
