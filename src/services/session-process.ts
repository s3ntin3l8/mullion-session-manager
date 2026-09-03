// Extracted from pty-manager.ts (systemd `--user` scope naming/lifecycle and
// dtach-scope process listing only — see that file's own header comment on
// why it's flagged as this repo's highest-risk file, and
// docs/architecture.md's "non-obvious session model" note before touching
// it or the terminal WS protocol).
//
// This module owns everything that talks to `systemctl --user` keyed off a
// bare session id string — scope naming (scopeUnitName), stopping a scope
// (stopScope), the two liveness checks (isMasterAlive/isMasterAliveBatch) —
// plus listSessionProcesses(), which derives the scope unit name the same
// way and hands it to cgroup-inventory.ts's listScopeProcesses() (the actual
// cgroup-walk/procfs logic already lived there, extracted independently;
// this is just the "which unit does session `id` map to" glue).
//
// Unlike ScrollbackBuffer/SessionStateFile/RedrawNudge (scrollback-buffer.ts,
// session-state-file.ts, redraw-nudge.ts), none of these carry per-Session
// instance state — every one operates on `id` (or a list of ids) alone, with
// no fields to hold between calls. So this module is a set of plain exported
// functions, not a class: forcing a class shape here (one instance per
// Session, like the other three) would just be a wrapper around functions
// that ignore `this` entirely.
//
// PtyManager keeps thin instance methods (isMasterAlive, isMasterAliveBatch,
// listSessionProcesses) that delegate to the functions here, rather than
// having callers import the functions directly — that keeps `app.pty.*` the
// one call surface routes/session-reconciler.ts/session-backend.ts and their
// tests already use (session-reconciler.test.ts spies on
// `app.pty.isMasterAliveBatch` directly; pty-manager.test.ts calls
// `manager.isMasterAlive`/`manager.isMasterAliveBatch`) — those keep working
// unchanged. scopeUnitName/stopScope, by contrast, were already plain
// module-level functions (not PtyManager methods) before this extraction, so
// pty-manager.ts now just imports and calls them directly, same as before.
//
// Deliberately NOT included here: the `systemd-run --user --scope --collect
// -u <unit> -- dtach -n ...` spawn itself (Session.bootstrapMaster() in
// pty-manager.ts) that actually CREATES a scope. That's the other half of
// process control, but it's entangled with env/hook-adapter/launch-command
// composition that is its own, larger, separately-planned extraction (the
// roadmap's PR 32, buildLaunchPlan) — pulling it in here would mix a
// stateless id->unit-name/liveness module with Session's per-instance launch
// state. bootstrapMaster() still calls this module's scopeUnitName(id) for
// the unit name it passes to systemd-run.

import { spawn as spawnChild } from "node:child_process";
import { listScopeProcesses } from "./cgroup-inventory.js";
import type { CgroupProcess } from "./cgroup-inventory.js";

// Deterministic (no timestamp) so a *future* process — one that never
// tracked this session in memory at all, e.g. right after a restart — can
// still reference the exact same scope to fully terminate it. See
// PtyManager.terminate() in pty-manager.ts.
export function scopeUnitName(id: string): string {
  return `crs-session-${id}`;
}

/** Stop a session's systemd scope, killing its dtach master + program. Safe
 * to call even if the scope doesn't exist or is already gone. */
export function stopScope(id: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawnChild("systemctl", ["--user", "stop", `${scopeUnitName(id)}.scope`], {
      stdio: "ignore",
    });
    // "unit not loaded" (already stopped / never existed) is an expected,
    // ignorable outcome here — this is a best-effort cleanup, not a
    // correctness-critical step whose failure should propagate.
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

/**
 * Whether `id`'s systemd scope — the true owner of the dtach master and
 * the program running inside it, per PtyManager.terminate()'s doc comment
 * in pty-manager.ts — is still active. False for "inactive" (the program
 * exited on its own; dtach exits with its child and the `--collect` scope
 * is then reaped), "failed", or "unknown" (never existed), and for any
 * spawn error. This is the source of truth session-reconciler.ts polls to
 * catch a program that exited without an explicit DELETE
 * /api/sessions/:id — deliberately NOT based on anything tracked in this
 * process's memory, so it works correctly even right after a restart,
 * before anything has re-attached.
 */
export function isMasterAlive(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawnChild("systemctl", ["--user", "is-active", `${scopeUnitName(id)}.scope`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(false));
    // 'close', not 'exit' — see agent-detect.ts's probe() for the exact
    // same race this avoids: 'exit' fires once the process itself has
    // ended, but doesn't guarantee every stdout 'data' chunk has been
    // delivered yet, which reconcileExitedSessions() polling many
    // sessions concurrently could hit in the same way.
    //
    // "active" or "deactivating" both count as alive — issue #988: a scope
    // Mullion itself asked systemd to stop (stopScope() below) sits in
    // "deactivating" for up to systemd's own DefaultTimeoutStopSec (90s in
    // the incident that motivated this) before settling, and is NOT "the
    // program exited on its own," the only thing this function exists to
    // catch. `is-active` exits non-zero for a deactivating unit while still
    // printing "deactivating" on stdout — this reads only stdout already
    // (the `close` handler ignores the exit code entirely), so widening the
    // string check is sufficient on its own; do not add an exit-code guard
    // alongside it, that would undo this fix.
    child.on("close", () => {
      const state = stdout.trim();
      resolve(state === "active" || state === "deactivating");
    });
  });
}

/**
 * Lists the genuine OS processes currently running inside `id`'s systemd
 * scope — the dtach master, the agent process, and anything the agent
 * itself spawns (MCP servers, `Bash run_in_background` jobs, nested CLIs,
 * dev servers). This is NOT subagent detection: Claude Code subagents run
 * in-process with no PID of their own (see agent-detect.ts). Returns `[]`
 * for a scope that isn't active, same as isMasterAlive() would report.
 */
export function listSessionProcesses(id: string): Promise<CgroupProcess[]> {
  return listScopeProcesses(`${scopeUnitName(id)}.scope`);
}

/**
 * Perf audit finding B8(2) — batched counterpart to isMasterAlive() above,
 * for a caller checking liveness of MANY sessions in one go
 * (session-backend.ts's LocalSessionBackend.isMasterAlive, and
 * routes/internal.ts's `/internal/sessions/liveness` for a remote agent's
 * own sessions). Both used to call isMasterAlive(id) once per id via
 * `Promise.all` — N simultaneous `systemctl --user is-active` subprocess
 * spawns every reconcile tick, scaling with the number of active
 * sessions. A single `systemctl --user list-units`, filtered to this
 * app's own `crs-session-*` scope naming convention (scopeUnitName) and
 * to active units only, returns every currently-active scope in one
 * spawn; membership in that result is then a plain in-memory Set lookup
 * per id, no further subprocesses.
 *
 * Trust rule — deliberately NOT the same "unknown collapses to false"
 * posture isMasterAlive() takes for a single id: `is-active` on one
 * specific, already-known unit failing IS a real, trustworthy negative
 * signal for that one unit. A *list-units spawn/parse failure* here is a
 * different kind of event — an infrastructure problem (systemctl
 * missing, a `--user` D-Bus hiccup, an unexpected output shape) that
 * says nothing about whether any particular session is actually alive.
 * Collapsing that to "every id is false" would mass-flip every active
 * session to exited on a single transient systemctl error — exactly the
 * "missing key -> false" mass-exit landmine session-reconciler.ts's own
 * doc comment calls out and specifically protects against for the
 * multi-host case (a key a REACHABLE host's response merely omits is
 * treated as "unknown," never "not alive"). So on spawn error or a
 * non-zero exit (systemctl's own signal that this list-units call itself
 * failed, not "no matches" — verified empirically: a `--state=active`
 * query matching zero units still exits 0 with empty stdout), this
 * returns an EMPTY record — every id "unknown," not "false" — which
 * every caller already handles correctly via that same
 * `alive === undefined` -> skip path. Only a clean, successfully-parsed
 * response asserts real true/false answers.
 */
export function isMasterAliveBatch(ids: string[]): Promise<Record<string, boolean>> {
  if (ids.length === 0) return Promise.resolve(Object.create(null));

  return new Promise((resolve) => {
    let stdout = "";
    const child = spawnChild(
      "systemctl",
      [
        "--user",
        "list-units",
        "--type=scope",
        // "active" or "deactivating" — issue #988, same fix as
        // isMasterAlive() above: a scope Mullion itself asked systemd to
        // stop sits in "deactivating" for up to systemd's own
        // DefaultTimeoutStopSec before settling, and must not read as
        // exited for that whole window.
        "--state=active,deactivating",
        "--no-legend",
        "--plain",
        "crs-session-*.scope",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    // Spawn failure (systemctl missing, etc.) — unknown for every id, per
    // this method's own trust-rule doc comment above.
    child.on("error", () => resolve(Object.create(null)));
    // 'close', not 'exit' — same stdout-delivery race isMasterAlive()
    // guards against above.
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(Object.create(null));
        return;
      }
      // `--plain --no-legend` output is one unit per line: "UNIT LOAD
      // ACTIVE SUB DESCRIPTION", whitespace-separated (DESCRIPTION may
      // itself contain spaces, but only the first field — the unit name
      // — is needed here).
      const activeUnits = new Set(
        stdout
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0])
          .filter((unit): unit is string => Boolean(unit)),
      );
      const result: Record<string, boolean> = Object.create(null);
      for (const id of ids) {
        result[id] = activeUnits.has(`${scopeUnitName(id)}.scope`);
      }
      resolve(result);
    });
  });
}
