import { spawn as spawnChild } from "node:child_process";
import { statSync } from "node:fs";
// armKillEscalation lives in systemctl-runner.ts, whose name is narrower than
// the helper it exports: the SIGTERM-then-SIGKILL escalation is generic and
// used by every timed spawn in this repo (git-status.ts, agent-detect.ts,
// avd-manager.ts, device-process.ts, ...), not just systemctl's. It stays put
// here rather than moving, so this issue doesn't churn every one of those
// importers; see systemctl-runner.ts's own header comment.
import { armKillEscalation } from "../systemctl-runner.js";

/**
 * Whether `cwd` is a directory this process could actually run in.
 *
 * A bare `existsSync` check would miss a `cwd` that exists but isn't a
 * directory (e.g. a file left behind at that path): that also spawns with an
 * identical ENOENT yet would still surface the misleading raw message. Both
 * cases are the same "not usable" answer, so both are covered here.
 *
 * Lives in the scope module (rather than in pty-manager.ts, where it was
 * before) because the ENOENT-vs-cwd classification below is a property of
 * "spawn something under a scope", not of any one caller — every backend
 * needs it, and pty-manager.ts imports this module, so keeping it there would
 * have meant a cycle.
 */
export function isUsableCwd(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

export interface ScopeSpawnOptions {
  /** The supervisor to run — e.g. "systemd-run". */
  command: string;
  /** Its argv. */
  argv: string[];
  /** The program's working directory. */
  cwd: string;
  /** The program's environment. */
  env: NodeJS.ProcessEnv;
  /** How long the supervisor may take before it is killed and the launch fails. */
  timeoutMs: number;
  /** Human-readable phrase for this launch, used in the diagnostics below. */
  label: string;
  /**
   * The scope's name, used in the diagnostics below. On the systemd backend
   * this is the transient unit's name.
   */
  scopeName: string;
  /**
   * Optional hook to enrich a failed launch with a backend-specific
   * explanation — e.g. the systemd backend's "a scope named X already exists
   * and is running Y" diagnostic for the name-collision case.
   *
   * Returns the DETAIL to append after the standard message, or null for
   * "nothing more to add". Never rejects: a probe that fails must not turn an
   * already-failed launch into a different (or worse) failure.
   */
  describeFailure?: (code: number | null) => Promise<string | null>;
  /**
   * Called after the child settles, whatever the outcome — the backend's hook
   * for dropping any cached listing that a just-created-or-just-stopped scope
   * could have invalidated.
   */
  onSettled?: () => void;
}

/**
 * Runs a supervisor, waits for it to report success, and turns anything else
 * into a rejection carrying a diagnostic.
 *
 * The shared spine of every backend's `start()`: the spawn itself, the
 * SIGTERM-then-SIGKILL escalation, and the three failure classifications
 * below. Each of them is behavior that was previously inline in a single
 * caller's spawn path, so the messages and their ordering are preserved
 * exactly — a caller that pattern-matches on them keeps working.
 *
 * The three failures:
 *
 *   - **timeout** — the supervisor never reported back within `timeoutMs`.
 *     The escalation has already sent SIGTERM (then SIGKILL) by the time this
 *     fires; the launch is abandoned, and the message says so.
 *   - **spawn error** — the binary is missing, or the cwd is gone. Node's own
 *     ENOENT blames whichever binary it was trying to exec ("spawn systemd-run
 *     ENOENT") even when the REAL cause is `cwd` itself having vanished (a
 *     worktree deleted out from under an in-flight re-seed) — the process
 *     manager can't tell those apart from the raw error alone, and the
 *     misleading message sent a prior incident's investigation looking at the
 *     wrong binary. Classified here, where `cwd` is in scope, instead of
 *     leaving every caller to re-derive it.
 *   - **non-zero exit** — the supervisor ran and failed. A backend may add
 *     detail via `describeFailure`.
 */
export function spawnScopeProcess(opts: ScopeSpawnOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(opts.command, opts.argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "ignore",
    });
    // M3 — a wedged supervisor left this promise pending forever (and, with
    // it, the caller's spawnOutcome()/terminate()). Same SIGTERM-then-SIGKILL
    // escalation every other timed spawn in this repo uses.
    const armed = armKillEscalation(child, opts.timeoutMs, () => {
      reject(
        new Error(`${opts.label} timed out after ${opts.timeoutMs}ms (unit ${opts.scopeName})`),
      );
    });
    child.on("error", (err) => {
      armed.clearOnSettle();
      opts.onSettled?.();
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT" && !isUsableCwd(opts.cwd)) {
        reject(new Error(`${opts.label} failed: cwd does not exist: ${opts.cwd}`));
        return;
      }
      reject(err);
    });
    child.on("exit", (code) => {
      armed.clearOnSettle();
      opts.onSettled?.();
      if (code === 0) {
        resolve();
        return;
      }
      const rejectWith = (detail: string | null) => {
        const base = `${opts.label} exited with code ${code} (unit ${opts.scopeName})`;
        reject(new Error(detail ? `${base}: ${detail}` : base));
      };
      if (!opts.describeFailure) {
        rejectWith(null);
        return;
      }
      opts.describeFailure(code).then(rejectWith, () => rejectWith(null));
    });
  });
}
