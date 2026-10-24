import { runShellCapture } from "./shell-spawn.js";

// Resolves the PATH an *interactive* shell of the user's would have.
//
// Why this exists: every Mullion shell (the agent probe in agent-detect.ts and
// every session, launch-plan.ts) runs as `$SHELL -lc …` — login, but NOT
// interactive. zsh therefore never reads ~/.zshrc, and bash's stock Debian/
// Ubuntu ~/.bashrc returns early for a non-interactive shell. Most CLI
// installers (nvm, bun, pyenv, opencode, mcode, …) append their PATH line to
// exactly those files, so an agent that works in the user's terminal showed up
// as "not found on PATH" here — and, if only the probe were fixed, would then
// fail to launch with `command not found`.
//
// Rather than add `-i` to every spawn (an interactive rc would run on every
// session start and can print banners/prompts into the PTY or hang on a
// `read`), resolve the interactive PATH ONCE with a throwaway `-ilc` shell and
// merge it into buildSessionEnv() — the same approach VS Code takes.

const RESOLVE_TIMEOUT_MS = 5_000;
const RESOLVE_KILL_ESCALATION_MS = 2_000;
// rc files may print anything (banners, oh-my-zsh update prompts); only the
// bytes between these markers are parsed.
const SENTINEL = "__MULLION_USER_ENV_8f3a1c__";

// Prints just $PATH between the markers: `env -0` is not portable (macOS's
// /usr/bin/env has no -0, and this repo deploys there via launchd). fish has a
// different startup model (config.fish, no .zshrc/.bashrc) — only shells known
// to behave are resolved; anything else falls back to today's behaviour.
const SUPPORTED_SHELLS = new Set(["bash", "zsh"]);
const RESOLVE_SCRIPT = `printf '%s%s%s' '${SENTINEL}' "$PATH" '${SENTINEL}'`;

export interface UserShellEnvLogger {
  debug: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}
let log: UserShellEnvLogger | undefined;
/** Wired once at boot (server.ts); the failure paths below are otherwise
 * silent, and the symptom they cause is an unexplained "not found on PATH". */
export function setUserShellEnvLogger(logger: UserShellEnvLogger | undefined): void {
  log = logger;
}

let resolved: { path: string } | null = null;
let settled = false;
let inflight: Promise<void> | null = null;

/** Pure: the PATH printed between the sentinels (anything the rc printed
 * before/after is ignored), or null. */
export function parseUserShellPath(stdout: string): string | null {
  const start = stdout.indexOf(SENTINEL);
  if (start === -1) return null;
  const from = start + SENTINEL.length;
  const end = stdout.indexOf(SENTINEL, from);
  if (end === -1) return null;
  return stdout.slice(from, end) || null;
}

/** Pure: `base`'s PATH with any `extra` entries it lacks prepended, de-duped, order kept. */
export function mergePaths(base: string | undefined, extra: string): string {
  const baseEntries = (base ?? "").split(":").filter(Boolean);
  const seen = new Set(baseEntries);
  const added: string[] = [];
  for (const entry of extra.split(":")) {
    if (entry && !seen.has(entry)) {
      seen.add(entry);
      added.push(entry);
    }
  }
  return [...added, ...baseEntries].join(":");
}

function isDisabled(): boolean {
  return process.env.MULLION_RESOLVE_INTERACTIVE_ENV === "0";
}

/** What a failed resolve leaves in effect — worded for the first resolve
 * (nothing cached yet) vs. a rescan (the previous PATH is kept). */
function fallbackNote(): string {
  return resolved ? "keeping the previous PATH" : "using the service environment's PATH";
}

function runInteractiveShell(shell: string): Promise<string | null> {
  // The spawn/timeout/kill machinery lives in `shell-spawn.ts`, shared with
  // the login-shell probe (issue #1833).
  return runShellCapture({
    shell,
    args: ["-ilc", RESOLVE_SCRIPT],
    env: process.env,
    timeoutMs: RESOLVE_TIMEOUT_MS,
    killEscalationMs: RESOLVE_KILL_ESCALATION_MS,
    // The raw text carries the sentinel markers, so it must not be trimmed —
    // and an empty result stays an empty string, because the caller parses
    // the markers out of it itself.
    trim: false,
    // A timed-out resolve must not hold the server open for the escalation's
    // grace period.
    unrefEscalationTimer: true,
    onTimeout: () => {
      log?.warn(
        { shell, timeoutMs: RESOLVE_TIMEOUT_MS },
        `user-shell-env: interactive shell timed out; ${fallbackNote()}`,
      );
    },
    onError: (err) => {
      // Not only a spawn failure: the child's 'error' event also fires when a
      // KILL fails (the deadline's SIGTERM, say). The message therefore says
      // what the failure means — no interactive PATH — rather than what
      // caused it; the cause is in `err`.
      log?.warn(
        { err, shell },
        `user-shell-env: could not resolve the interactive PATH; ${fallbackNote()}`,
      );
    },
  });
}

/**
 * Resolves (once; concurrent callers share one shell) the interactive shell's
 * PATH. Never rejects — failure, timeout, an unsupported shell, or the
 * `MULLION_RESOLVE_INTERACTIVE_ENV=0` opt-out leave the cache as it was: empty
 * on the first resolve (buildSessionEnv() then behaves exactly as before), or
 * the previous PATH on a rescan.
 */
export function resolveUserShellEnv(): Promise<void> {
  if (settled || isDisabled()) return Promise.resolve();
  if (inflight) return inflight;
  const shell = process.env.SHELL || "";
  if (!SUPPORTED_SHELLS.has(shell.split("/").pop() ?? "")) {
    log?.debug({ shell }, "user-shell-env: unsupported shell, not resolving the interactive PATH");
    settled = true;
    return Promise.resolve();
  }
  inflight = runInteractiveShell(shell)
    .then((stdout) => {
      const path = stdout === null ? null : parseUserShellPath(stdout);
      // Only overwrite on success: a failed rescan (rc hiccup, timeout) must
      // not discard the PATH an earlier resolve already found.
      if (path) resolved = { path };
      // stdout === null already logged its own reason (timeout / spawn error);
      // here the shell ran but printed no PATH between the markers.
      else if (stdout !== null)
        log?.warn(
          { shell },
          `user-shell-env: no PATH from the interactive shell (unparseable output); ${fallbackNote()}`,
        );
    })
    .finally(() => {
      settled = true;
      inflight = null;
    });
  return inflight;
}

/** The resolved interactive PATH, or null when unresolved/unavailable. */
export function getUserShellPath(): string | null {
  return isDisabled() ? null : (resolved?.path ?? null);
}

/** Marks the cached result stale so the next resolveUserShellEnv() re-runs the
 * shell (an explicit agent rescan, after the user edited their rc file). The
 * old PATH stays in effect until the new one lands, so a session launched
 * mid-rescan doesn't briefly lose it. */
export function invalidateUserShellEnv(): void {
  settled = false;
}

/** Exported for tests only — production never needs to clear this. */
export function resetUserShellEnvForTests(): void {
  resolved = null;
  settled = false;
  inflight = null;
}
