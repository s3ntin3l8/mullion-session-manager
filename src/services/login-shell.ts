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
import { sessionShellOrNull } from "./session-shell.js";
import { runShellCapture } from "./shell-spawn.js";

// A login shell that blocks would hang the probe, so it gets a deadline —
// and then a SIGKILL escalation. `shell-spawn.ts` owns that machinery and
// explains why the escalation exists; these are only the two numbers this
// caller picks.
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_KILL_ESCALATION_MS = 2_000;

/** Why a login-shell run produced no output: the deadline fired, or the shell
 * failed (spawn error / broke after starting). `null` means it ran to
 * completion — an empty stdout is then a genuine "nothing printed". */
export type LoginShellFailure = "timeout" | "error";

export interface LoginShellResult {
  /** Trimmed stdout; null when empty, failed or timed out. */
  stdout: string | null;
  failure: LoginShellFailure | null;
}

/**
 * Like {@link runLoginShell}, but says WHY there was no output. A probe that
 * timed out (a loaded host) must not be read as "the CLI is not installed".
 * Never rejects.
 */
export function runLoginShellDetailed(script: string): Promise<LoginShellResult> {
  // The SESSION's shell (session-shell.ts) — Git Bash on Windows. A host with
  // none cannot run a session either, so the probe finds nothing. Any OTHER
  // failure resolving it is unexpected: logged, so it is not mistaken for
  // "nothing installed", but still a null — one probe must not reject them all.
  let shell: string | null;
  try {
    shell = sessionShellOrNull();
  } catch (err) {
    console.warn("[login-shell] could not resolve the session shell:", err);
    return Promise.resolve({ stdout: null, failure: "error" });
  }
  if (shell === null) return Promise.resolve({ stdout: null, failure: null });
  let failure: LoginShellFailure | null = null;
  return runShellCapture({
    shell,
    args: ["-lc", script],
    env: buildSessionEnv(),
    timeoutMs: PROBE_TIMEOUT_MS,
    killEscalationMs: PROBE_KILL_ESCALATION_MS,
    // The probe wants the command's output, and nothing at all when the
    // command printed nothing.
    trim: true,
    onTimeout: () => {
      failure = "timeout";
      console.warn(`[login-shell] probe timed out after ${PROBE_TIMEOUT_MS}ms: ${script}`);
    },
    onError: (err) => {
      failure = "error";
      console.warn(`[login-shell] probe failed: ${script}:`, err);
    },
  }).then((stdout) => ({ stdout, failure }));
}

/**
 * Runs one script in a login shell and resolves its trimmed stdout (null when
 * empty, failed or timed out). Never rejects — callers rely on that, awaiting
 * several probes in one Promise.all. Use {@link runLoginShellDetailed} when a
 * failure must be told apart from an empty result.
 */
export function runLoginShell(script: string): Promise<string | null> {
  return runLoginShellDetailed(script).then((r) => r.stdout);
}
