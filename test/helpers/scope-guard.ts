// Tripwire for issue #2003: a vitest run that reached a real `systemd-run`
// left up to 973 `crs-session-*` scopes behind (each a live dtach + shell,
// owned by a run that had long since exited), until the host had so many
// units that spawning a genuine session failed with "master bootstrap exited
// with code 1". AGENTS.md's rule — a test must never let a real systemd-run
// fire (issue #1137) — was enforced only by one file's own afterAll
// (pty-manager-file-change-ignore.test.ts), so any other suite that built an
// app and created a session slipped through unnoticed.
//
// Two layers, both owned by test/global-setup.ts so they cover every file:
//
//   1. PREVENT — a `systemd-run` shim first on PATH. A spawn that was not
//      mocked at `node:child_process` lands here instead of in the user's
//      real systemd: it records the call and exits non-zero, so the offending
//      test fails loudly rather than starting an unsupervised process.
//   2. DETECT — after the run, any attempt the shim recorded fails the run,
//      and so does any `crs-session-*` scope whose dtach socket lives under
//      this run's private temp root (the shim can be bypassed by an absolute
//      path; the listing cannot).
import { execFileSync } from "node:child_process";
import { dtachMastersFromPs, readPsTable } from "./reap-dtach.js";
import fs from "node:fs";
import path from "node:path";

/** Exit code of the shim — distinctive so a failing test's message names it. */
export const SHIM_EXIT_CODE = 97;

const LOG_NAME = "systemd-run-attempts.log";

export interface ScopeGuard {
  /** Directory holding the shim; first entry of PATH while the guard is armed. */
  binDir: string;
  /** File the shim appends one line per attempted launch to. */
  logPath: string;
}

/**
 * Writes the `systemd-run` shim under `<rootDir>/scope-guard-bin` and returns
 * where it and its log live. Caller prepends `binDir` to PATH.
 */
export function installSystemdRunShim(rootDir: string): ScopeGuard {
  const binDir = path.join(rootDir, "scope-guard-bin");
  const logPath = path.join(binDir, LOG_NAME);
  fs.mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, "systemd-run");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${logPath}'`,
    `echo "systemd-run blocked by the vitest scope guard (issue #2003): mock node:child_process / the ScopeBackend instead of launching a real scope" >&2`,
    `exit ${SHIM_EXIT_CODE}`,
    "",
  ].join("\n");
  fs.writeFileSync(shim, script, { mode: 0o755 });
  return { binDir, logPath };
}

/** The launches the shim blocked, one argv line each; empty when none. */
export function readBlockedLaunches(guard: ScopeGuard): string[] {
  try {
    return fs
      .readFileSync(guard.logPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * `crs-session-*` scope listing rows whose description names `rootDir` — i.e.
 * scopes this run's own tests created. `list` is injectable for tests; the
 * default asks the real user manager and returns [] when there is none.
 */
export function findLeakedScopes(rootDir: string, list: () => string = listScopes): string[] {
  return list()
    .split("\n")
    .filter((line) => line.includes(rootDir));
}

/**
 * dtach masters still running from this run, as `pid command` rows. Linux
 * covers these through the systemd scope listing above; macOS has no scopes,
 * so the process table is the only place a leaked master shows up (issue
 * #2112). `ps` is injectable for tests; the default reads the real table and
 * returns [] when it cannot.
 */
export function findLeakedDtachMasters(
  rootDir: string,
  ps: () => string | null = readPsTable,
): string[] {
  const out = ps();
  if (!out) return [];
  const { masters } = dtachMastersFromPs(out, rootDir);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => masters.includes(Number.parseInt(l, 10)));
}

function listScopes(): string {
  try {
    return execFileSync(
      "systemctl",
      [
        "--user",
        "list-units",
        "--type=scope",
        "--all",
        "--no-legend",
        "--plain",
        "crs-session-*.scope",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
  } catch {
    // No user bus (CI runners, containers): nothing could have been leaked.
    return "";
  }
}

/** Human-readable failure for the run, or null when the run was clean. */
export function describeScopeLeaks(
  blocked: string[],
  leaked: string[],
  leakedMasters: string[] = [],
): string | null {
  const parts: string[] = [];
  if (blocked.length > 0) {
    parts.push(
      `${blocked.length} test launch(es) reached a real systemd-run (blocked by the scope guard, issue #2003):\n` +
        blocked.map((l) => `  systemd-run ${l}`).join("\n") +
        "\nA test must mock node:child_process' spawn (or use a fake ScopeBackend) — see AGENTS.md.",
    );
  }
  if (leaked.length > 0) {
    parts.push(
      `${leaked.length} crs-session scope(s) left running by this run:\n` +
        leaked.map((l) => `  ${l}`).join("\n") +
        "\nStop them with `systemctl --user stop <unit>`.",
    );
  }
  if (leakedMasters.length > 0) {
    parts.push(
      `${leakedMasters.length} dtach master(s) left running by this run:\n` +
        leakedMasters.map((l) => `  ${l}`).join("\n") +
        "\nKill them by pid.",
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
