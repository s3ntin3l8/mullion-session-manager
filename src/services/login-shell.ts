/**
 * Runs a script in a LOGIN shell and resolves its trimmed stdout.
 *
 * ## Why a login shell, and not the server's own PATH
 *
 * A spawned session's shell is a login shell, so it sees the PATH the user's
 * profile builds — nvm, direnv, asdf, a Homebrew prefix, whatever. The
 * Mullion SERVER, on the other hand, runs under systemd --user with a minimal
 * PATH (the shipped units set no `PATH=` line), so a CLI the user installed
 * through npm/nvm is on the session's PATH and NOT on the server's.
 *
 * So anything that asks "does this host have X, and which version?" has to
 * ask the same way a session would — through a login shell — or it will
 * report "not installed" for a CLI that every session runs perfectly well.
 *
 * `agent-detect.ts` uses this to find the agent binaries; the mcode adapter
 * uses it to read mcode's own version (its CODEX plugin format has a minimum
 * version, and the check has to see the SAME mcode a session would run).
 *
 * It lives here rather than in `agent-detect.ts` because `agent-detect.ts`
 * imports the hook adapters — so a hook adapter importing from it would be a
 * cycle.
 */

import { spawn as spawnChild } from "node:child_process";
import { buildSessionEnv } from "./session-env.js";

// A login shell that blocks would hang the probe, so it gets a deadline —
// and then a SIGKILL escalation, because a timeout firing means it already
// ignored our attempt to end it cooperatively. (`killed`/`exitCode` don't
// tell us this: Node sets `killed` once a signal is successfully SENT, not
// once the process has actually died — `exitCode`/`signalCode` both staying
// `null` is the real "still alive" signal.)
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_KILL_ESCALATION_MS = 2_000;

/**
 * Runs one script in a login shell and resolves its trimmed stdout (null when
 * empty, failed or timed out).
 */
export function runLoginShell(script: string): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/bash";
    let stdout = "";
    let settled = false;

    const child = spawnChild(shell, ["-lc", script], {
      env: buildSessionEnv(),
      // B7 — stderr is never read by anything below, so dropping it
      // entirely (rather than leaving it as a pipe no one drains) is what
      // actually prevents the blocked-write hang; the timeout below is a
      // backstop for whatever this doesn't cover (a shell that blocks for
      // some other reason). Matches this repo's other spawn calls that
      // don't need stderr (e.g. git-refs.ts's runGit).
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

    const timer = setTimeout(() => {
      child.kill(); // SIGTERM
      // Escalate to SIGKILL if the process is still alive after a short
      // grace period — a timeout firing means it already ignored our
      // attempt to end it cooperatively.
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, PROBE_KILL_ESCALATION_MS);
      finish(null);
    }, PROBE_TIMEOUT_MS);

    child.on("error", () => {
      clearKillTimer();
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
      finish(stdout.trim() || null);
    });
  });
}
