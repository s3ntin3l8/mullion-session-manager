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
 * That PATH also includes the entries only an interactive rc file (~/.zshrc,
 * ~/.bashrc) adds: `buildSessionEnv()` merges them in (see user-shell-env.ts),
 * because a `-lc` shell never reads those files itself.
 *
 * `agent-detect.ts` uses this to find the agent binaries; the mcode adapter
 * uses it to read mcode's own version (its CODEX plugin format has a minimum
 * version, and the check has to see the SAME mcode a session would run).
 *
 * It lives here rather than in `agent-detect.ts` because `agent-detect.ts`
 * imports the hook adapters — so a hook adapter importing from it would be a
 * cycle.
 */

import { buildSessionEnv } from "./session-env.js";
import { runShellCapture } from "./shell-spawn.js";

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
 *
 * The spawn/timeout/kill machinery lives in `shell-spawn.ts`, shared with the
 * interactive-shell resolver (issue #1833).
 */
export function runLoginShell(script: string): Promise<string | null> {
  return runShellCapture({
    shell: process.env.SHELL || "/bin/bash",
    args: ["-lc", script],
    env: buildSessionEnv(),
    timeoutMs: PROBE_TIMEOUT_MS,
    killEscalationMs: PROBE_KILL_ESCALATION_MS,
    // The probe wants the command's output, and nothing at all when the
    // command printed nothing.
    trim: true,
  });
}
