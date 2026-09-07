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

/**
 * Best-effort description of whatever is CURRENTLY occupying `id`'s scope
 * name, for diagnosing a `systemd-run --user --scope --collect -u
 * crs-session-<id>` bootstrap failure (pty-manager.ts's bootstrapMaster()).
 * `systemd-run --collect` refuses to create a transient scope whose unit
 * name already exists — issue #1137: a scope leaked by an earlier process
 * (a crashed test run, a stale scratch dev instance) can squat on a
 * low-numbered id that a later, unrelated backend's own fresh session then
 * collides with. Before this, that collision surfaced only as
 * `master bootstrap exited with code 1 (unit crs-session-1)` — sending the
 * investigation that traced #1137 looking at the wrong file for a long
 * time, the same "misleading raw error" failure mode bootstrapMaster's own
 * ENOENT-vs-vanished-cwd classification already exists to prevent for a
 * different case.
 *
 * Returns the squatting unit's `Description` (systemd's own rendering of
 * its `dtach -n <socket> ...` command line — see stopScope's own unit
 * naming) when it is genuinely occupying the name (`ActiveState` is
 * "active" or "deactivating" — same trust window as isMasterAlive()'s doc
 * comment on that pair, a scope Mullion itself just asked to stop is not
 * yet gone). Returns `null` for every other case — no such unit, a
 * `systemctl` spawn error, or an unparseable reply — so a caller can always
 * fall back to today's plain message with no special-casing. Deliberately
 * never rejects/hangs: a bootstrap failure must still surface promptly even
 * if this diagnostic probe itself can't complete — bounded by
 * DESCRIBE_SCOPE_TIMEOUT_MS below the same way git-ignore.ts's
 * isPathGitIgnored bounds its own best-effort subprocess (a wedged/slow
 * `systemctl` must not turn an already-failed bootstrap into a hang).
 */
const DESCRIBE_SCOPE_TIMEOUT_MS = 2_000;

export function describeScope(id: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawnChild(
      "systemctl",
      ["--user", "show", `${scopeUnitName(id)}.scope`, "-p", "Description", "-p", "ActiveState"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best-effort — this probe already never rejects/hangs (see this
        // function's own doc comment); a kill() failure on an already-dead
        // or non-standard child must not turn into an unhandled throw here.
      }
      finish(null);
    }, DESCRIBE_SCOPE_TIMEOUT_MS);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    // 'close', not 'exit' — same stdout-delivery race isMasterAlive() and
    // isMasterAliveBatch() above already guard against.
    child.on("close", () => {
      const fields = Object.create(null) as Record<string, string>;
      for (const line of stdout.split("\n")) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        fields[line.slice(0, eq)] = line.slice(eq + 1);
      }
      const active = fields.ActiveState === "active" || fields.ActiveState === "deactivating";
      finish(active && fields.Description ? fields.Description : null);
    });
  });
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
 * Parses `systemctl --user list-units --type=scope --all --no-legend
 * --plain 'crs-session-*.scope'`-shaped output (one unit per line: "UNIT
 * LOAD ACTIVE SUB DESCRIPTION", whitespace-separated) into structured rows —
 * the same shape isMasterAliveBatch() below parses inline for its own
 * narrower need (just the unit name). Exported (unlike that inline parse)
 * for scripts/check-scope-leaks.ts, which needs the DESCRIPTION field too
 * (to recover a scope's dtach socket path via extractDtachSocketPath()
 * below) — a second, hand-rolled copy of this same line-splitting in a
 * standalone script would drift from this one silently over time. Pure and
 * synchronous: callers own getting the actual `systemctl` output.
 */
export function parseScopeUnitsListing(
  stdout: string,
): Array<{ unit: string; description: string }> {
  const rows: Array<{ unit: string; description: string }> = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // UNIT, LOAD, ACTIVE, SUB, then DESCRIPTION (the remainder of the line,
    // which may itself contain arbitrary whitespace — e.g. a quoted command
    // line with multiple flags — so it is not itself split on whitespace).
    const match = /^(\S+)\s+\S+\s+\S+\s+\S+\s*(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ unit: match[1], description: match[2] });
  }
  return rows;
}

// Every `crs-session-*` scope's Description is systemd's own rendering of
// the exact argv bootstrapMaster() (pty-manager.ts) passed it: `dtach -n
// <socketPath> <shell> -lc <command>` — see launch-plan.ts's own argv
// comment. The socket path is always the first `-n` argument and is always
// itself an absolute path (PtyManager derives it from sessionsDir), so a
// small anchored regex is enough; this deliberately does not try to parse
// the rest of the command line.
const DTACH_SOCKET_PATTERN = /dtach\s+-n\s+(\S+)/;

/**
 * Recovers the dtach socket path a `crs-session-*` scope's Description
 * names, or `null` if the description doesn't match the expected shape at
 * all (a scope this app didn't create, or a systemd rendering quirk this
 * hasn't seen). Used by scripts/check-scope-leaks.ts to decide whether a
 * given scope's backing session still plausibly exists.
 */
export function extractDtachSocketPath(description: string): string | null {
  return DTACH_SOCKET_PATTERN.exec(description)?.[1] ?? null;
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
