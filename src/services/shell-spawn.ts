/**
 * Runs a script in a shell and resolves its stdout.
 *
 * ## Why this exists
 *
 * Two callers need "run a shell script, capture its output, but never hang
 * forever":
 *
 * - `login-shell.ts` — the login-shell probe (`-lc`), used to find the agent
 *   binaries and to read an agent's own version. It wants the output
 *   TRIMMED, and it is silent about a timeout.
 * - `user-shell-env.ts` — the interactive-shell resolve (`-ilc`), used to
 *   learn the PATH an interactive rc file builds. It wants the output RAW
 *   (it carries sentinel markers), and it LOGS a diagnostic on a timeout or a
 *   spawn failure.
 *
 * Everything else about them is the same: the same spawn shape, the same
 * deadline, the same SIGTERM-then-SIGKILL escalation, the same
 * `close`-not-`exit` rule. That logic used to be written twice (issue #1833),
 * and the two copies had already drifted — one of them left an unguarded
 * `child.kill()` in a timer callback, which is an UNHANDLED exception (fatal
 * to the process, not just to the probe) whenever a stand-in for `spawn` has
 * no `kill` at all.
 *
 * So it lives here, once, and both callers delegate to it.
 *
 * ## The contract
 *
 * **When this settles, the child is dead or is about to be killed.** Every exit
 * path upholds it, including the ones that give up early:
 *
 * - the deadline fires → SIGTERM, then SIGKILL if the child ignores it;
 * - the child errors → a child that had actually started is ended the same way,
 *   because the deadline that would have ended it is about to be cancelled
 *   (issue #1845).
 *
 * A child that never started has nothing to end — `child.pid` is undefined
 * precisely because the spawn failed — so only a child that really ran is
 * signalled.
 */

import { spawn as spawnChild } from "node:child_process";

export interface ShellSpawnOptions {
  /** The shell to run. */
  shell: string;
  /** The shell's arguments — the script itself is the caller's business. */
  args: string[];
  /** The child's environment. */
  env: NodeJS.ProcessEnv;
  /** ms before the child is SIGTERMed and then SIGKILLed. */
  timeoutMs: number;
  /** ms between the SIGTERM and the SIGKILL. */
  killEscalationMs: number;
  /**
   * Trim the captured stdout, and report an empty result as null.
   *
   * The login-shell path wants that (`"out"`, and null for nothing). The
   * interactive-shell path does NOT: it wants the raw text, because that text
   * carries its sentinel markers — and an empty string stays an empty string
   * there, because the caller parses the markers out of it itself.
   */
  trim: boolean;
  /**
   * Do not let the SIGKILL-escalation timer hold the process open.
   *
   * The interactive resolver unrefs it, so a timed-out resolve does not keep
   * the server alive for the escalation's grace period. The login-shell probe
   * leaves it referenced, so the escalation always gets its chance to run
   * before the process exits.
   */
  unrefEscalationTimer?: boolean;
  /** Called when the deadline fires. */
  onTimeout?: () => void;
  /**
   * Called when the child failed — either because it never started, or
   * because it started and then broke.
   *
   * `spawned` tells the two apart: Node leaves `child.pid` undefined when the
   * spawn itself failed, and sets it once the child is really running. That
   * distinction matters because a child can also fail AFTER it started — a
   * SIGTERM the shell refuses produces one — and "failed to spawn" would be
   * the wrong thing to log about that.
   */
  onError?: (err: Error, spawned: boolean) => void;
}

/**
 * Runs the shell and resolves its stdout (null when the shell failed, timed
 * out, or — with `trim` — produced nothing).
 */
export function runShellCapture(options: ShellSpawnOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;

    const child = spawnChild(options.shell, options.args, {
      env: options.env,
      // stderr is never read by anything below, so dropping it ENTIRELY
      // (rather than leaving it as a pipe no one drains) is what actually
      // prevents the blocked-write hang: a shell that writes more than the
      // OS pipe buffer (~64 KiB) to stderr blocks on the write syscall
      // forever with nothing here ever reading it. The timeout below is a
      // backstop for whatever this does not cover.
      stdio: ["ignore", "pipe", "ignore"],
    });

    const onStdoutData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      resolve(value);
    };

    // Killing is best-effort: the child may already be gone, and a test
    // double standing in for `spawn` may not implement `kill` at all. An
    // unguarded `child.kill()` here would throw inside a timer callback — an
    // UNHANDLED exception, which is fatal to the process, not just to this
    // probe.
    const kill = (signal?: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone, or a stand-in without kill().
      }
    };

    // A child that is still alive is one whose `exitCode` and `signalCode` are
    // both `null`. (`killed`/`exitCode` don't tell us this: Node sets `killed`
    // once a signal is successfully SENT, not once the process has actually
    // died — `exitCode`/`signalCode` both staying `null` is the real "still
    // alive" signal.)
    const isAlive = () => child.exitCode === null && child.signalCode === null;

    // Escalate to SIGKILL if the process is still alive after a short grace
    // period — a timeout firing means it already ignored our attempt to end it
    // cooperatively. Armed at most once: the deadline and the 'error' path can
    // both reach it, and two timers would mean two chances to signal a child
    // that is already gone.
    const armEscalation = () => {
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (isAlive()) {
          kill("SIGKILL");
        }
      }, options.killEscalationMs);
      if (options.unrefEscalationTimer) killTimer.unref();
    };

    const timer = setTimeout(() => {
      options.onTimeout?.();
      kill(); // SIGTERM
      armEscalation();
      finish(null);
    }, options.timeoutMs);

    // NOTE: the SIGKILL escalation timer is deliberately NOT cleared here.
    // An 'error' on the child (a SIGTERM that failed with EPERM, say) does
    // not mean the child is gone — it means our attempt to end it failed. If
    // the deadline has already fired, the child may well still be alive and
    // still needs escalating to SIGKILL. The timer is cleared on 'close',
    // which is the event that actually means the child is gone.
    child.on("error", (err) => {
      // `pid` is undefined when the spawn itself failed and a number once the
      // child is really running, so this tells the caller which of the two
      // happened.
      const spawned = child.pid !== undefined;
      options.onError?.(err, spawned);

      // A child that started and then failed is still RUNNING, and `finish()`
      // is about to cancel the deadline that would have ended it — so end it
      // here, exactly the way the deadline does (issue #1845). A spawn failure
      // has no child to end: `pid` is undefined precisely because it never
      // started.
      if (spawned && isAlive()) {
        kill();
        armEscalation();
      }

      finish(null);
    });
    // 'close' (stdio streams closed), NOT 'exit' (process ended) — 'exit'
    // only guarantees the process itself has ended, not that every stdout
    // 'data' chunk has actually been delivered yet. Found live: under the
    // concurrent load of probing 8 binaries at once, this raced often
    // enough to intermittently report a genuinely-installed CLI as
    // unavailable (empty `stdout` read at the moment 'exit' fired, even
    // though the shell's `command -v` output arrived a moment later).
    child.on("close", () => {
      clearKillTimer();
      finish(options.trim ? stdout.trim() || null : stdout);
    });
  });
}
