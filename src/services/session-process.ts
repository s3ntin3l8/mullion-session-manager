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
// PtyManager keeps thin instance methods (isMasterAliveState,
// isMasterAliveStateBatch, isMasterAliveBatch, listSessionProcesses) that
// delegate to the functions here, rather than having callers import the
// functions directly — that keeps `app.pty.*` the one call surface routes/
// session-reconciler.ts/session-backend.ts and their tests already use
// (session-reconciler.test.ts spies on `app.pty.isMasterAliveStateBatch`
// directly; pty-manager.test.ts calls `manager.isMasterAliveState`/
// `manager.isMasterAliveStateBatch`) — those keep working unchanged.
// scopeUnitName/stopScope, by contrast, were already plain
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
// state. bootstrapMaster() still calls this module's
// scopeUnitName(instanceId, id) for the unit name it passes to systemd-run.
//
// Issue #1140 — `scopeUnitName` names a scope in a Unix-user-global systemd
// namespace while `sessions.id` is per-database, so two Mullion backends on
// one host can collide on a low id. #1137 already covered the CREATION-time
// half of that collision (`systemd-run --collect` refuses a unit name that
// already exists) with a diagnostic (describeScope() below). This landed in
// two PRs:
//
//   PR 1 fixed the READ/STOP half first — a scope another instance's
//   session already legitimately owns getting misread as this instance's
//   own, or worse, stopped by mistake (`terminate("1")` from one instance
//   killing a different instance's real session "1") — by having
//   stopScope/isMasterAlive/isMasterAliveBatch/listSessionProcesses confirm
//   OWNERSHIP of a `crs-session-*` unit via its dtach socket path (always
//   `<sessionsDir>/<id>.sock`, systemd's own rendering of the launch argv —
//   see extractDtachSocketPath below) rather than trusting the unit name
//   alone. This is the PERMANENT ownership mechanism, not a transition
//   shim — see listOwnedScopes()'s own doc comment.
//
//   PR 2 (this one) fixes the CREATION-time collision itself: `scopeUnitName`
//   now folds `deriveInstanceId(sessionsDir)` into the unit name
//   (`crs-session-<instanceId>-<id>`), so a fresh session's unit name can
//   never collide with a different instance's. This is a near-pure rename —
//   PR 1's ownership-by-socket-path check already recognized this namespaced
//   shape as a candidate (candidateIdForUnit() below) before any namespaced
//   unit existed, so it needed no changes here. A session already running
//   under its legacy bare `crs-session-<id>` name at upgrade time keeps
//   working unchanged (ownership is socket-path-derived, not name-derived);
//   only sessions created after the upgrade get the namespaced name.

import { spawn as spawnChild, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { listScopeProcesses } from "./cgroup-inventory.js";
import type { CgroupProcess } from "./cgroup-inventory.js";

// Deterministic (no timestamp) so a *future* process — one that never
// tracked this session in memory at all, e.g. right after a restart — can
// still reference the exact same scope to fully terminate it. See
// PtyManager.terminate() in pty-manager.ts.
//
// Issue #1140 (PR 2 of 2) — namespaced by `instanceId` (deriveInstanceId()
// below) so two Mullion backends on one host never collide on the same
// low-numbered `sessions.id` (issue #1137's creation-time failure mode: a
// leaked or unrelated instance's scope squatting on a name `systemd-run
// --collect` then refuses to recreate). This name is NOT what identifies a
// scope as belonging to this instance, though — ownership is always
// resolved by dtach socket path (listOwnedScopes()/resolveOwningUnit()
// below, from PR 1), never by parsing this string back apart. Note:
// SESSION_ID_PATTERN (routes/internal-schemas.ts) allows `-` in `id`
// itself, so `crs-session-<instanceId>-<id>` is not unambiguously
// re-splittable — nothing needs to re-split it.
export function scopeUnitName(instanceId: string, id: string): string {
  return `crs-session-${instanceId}-${id}`;
}

/**
 * Whether this host has a real `systemd --user` session — a live user bus —
 * to talk to at all. A stock CI runner (this repo's own backend tests run on
 * plain `ubuntu-latest`, no user D-Bus session, no `dtach`) or a plain
 * container commonly has the `systemctl` binary but no bus. Shared by the
 * two callers that need to no-op rather than fail/hang without one:
 * scripts/check-scope-leaks.ts (issue #1137) and
 * test/services/pty-manager-file-change-ignore.test.ts's own regression
 * guard — a single source of truth for "how do we detect this," rather than
 * two copies of the same probe drifting apart if that detection ever needs
 * to change.
 *
 * Hermes review, PR #1142 — `systemctl --user --version` is NOT a valid
 * probe: it "print[s] a short version string and exit[s]" (systemctl(1))
 * without ever contacting the bus, so it exits 0 on any host with the
 * binary present regardless of whether a user session exists. Reproduced:
 * `env -i ... systemctl --user --version` exits 0 while
 * `systemctl --user list-units` in that same shell fails with "Failed to
 * connect to bus." `show-environment` is a real, minimal round-trip to the
 * user manager instead — unlike `is-system-running` (the other obvious
 * candidate), its exit code isn't affected by unit health, so a host with
 * one failed unit elsewhere ("degraded") doesn't false-negative here.
 */
// Issue #1232 — every systemctl spawn in this file except describeScope()
// had no timeout at all: a wedged `--user` D-Bus bus (systemd restart, OOM
// pressure) left the caller pending indefinitely. isSystemctlUserAvailable's
// execFileSync below is worse than the async cases — a synchronous call
// blocks the entire event loop, not just one promise. SYSTEMCTL_TIMEOUT_MS
// matches cgroup-inventory.ts's own SYSTEMCTL_TIMEOUT_MS budget for the same
// class of call; KILL_ESCALATION_MS mirrors every other spawn-with-timeout
// helper in this repo (git-status.ts, agent-detect.ts, ...) — SIGTERM first,
// SIGKILL only if the process is still alive after a short grace period.
const SYSTEMCTL_TIMEOUT_MS = 5_000;
const KILL_ESCALATION_MS = 2_000;

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
function armKillEscalation(
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

export function isSystemctlUserAvailable(): boolean {
  try {
    execFileSync("systemctl", ["--user", "show-environment"], {
      stdio: "ignore",
      // #1232 — bounds this synchronous call so a wedged bus can't block
      // the event loop forever. Node kills the child and throws on timeout;
      // the catch below already maps that to `false`, the correct
      // fail-closed answer for "couldn't confirm a bus is reachable."
      timeout: SYSTEMCTL_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
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
 * "active" or "deactivating" — same trust window as isMasterAliveStateBatch()'s
 * doc comment on that pair, a scope Mullion itself just asked to stop is not
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

export function describeScope(instanceId: string, id: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawnChild(
      "systemctl",
      [
        "--user",
        "show",
        `${scopeUnitName(instanceId, id)}.scope`,
        "-p",
        "Description",
        "-p",
        "ActiveState",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const onStdoutData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      child.stdout?.off("data", onStdoutData);
      resolve(value);
    };

    // #1232 — this probe already never rejects/hangs (see this function's
    // own doc comment); bounded by DESCRIBE_SCOPE_TIMEOUT_MS the same way
    // every other spawn below is.
    const armed = armKillEscalation(child, DESCRIBE_SCOPE_TIMEOUT_MS, () => finish(null));

    child.on("error", () => {
      armed.clearOnSettle();
      finish(null);
    });
    // 'close', not 'exit' — same stdout-delivery race isMasterAliveStateBatch()
    // below already guards against.
    child.on("close", () => {
      armed.clearOnSettle();
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

/**
 * Parses `systemctl --user list-units --type=scope --all --no-legend
 * --plain 'crs-session-*.scope'`-shaped output (one unit per line: "UNIT
 * LOAD ACTIVE SUB DESCRIPTION", whitespace-separated) into structured rows —
 * the same shape listOwnedScopes() below parses for its own ownership
 * check. Exported for scripts/check-scope-leaks.ts, which needs the
 * DESCRIPTION field too (to recover a scope's dtach socket path via
 * extractDtachSocketPath() below) — a second, hand-rolled copy of this same
 * line-splitting in a standalone script would drift from this one silently
 * over time. Pure and synchronous: callers own getting the actual
 * `systemctl` output.
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
// the rest of the command line. Three alternatives, tried in order —
// verified empirically against a real systemd --user: an argument
// containing a space is rendered double-quoted (`-n "/path with
// space/x.sock"`), so a bare `\S+` alone would silently truncate at the
// first space and recover the wrong (truncated) path. Single-quoted is
// handled the same way for symmetry, though not observed in practice.
const DTACH_SOCKET_PATTERN = /dtach\s+-n\s+(?:"([^"]+)"|'([^']+)'|(\S+))/;

/**
 * Recovers the dtach socket path a `crs-session-*` scope's Description
 * names, or `null` if the description doesn't match the expected shape at
 * all (a scope this app didn't create, or a systemd rendering quirk this
 * hasn't seen). Used by scripts/check-scope-leaks.ts, and by
 * listOwnedScopes() below, to decide whether a given scope's backing
 * session still plausibly exists / which instance it belongs to.
 */
export function extractDtachSocketPath(description: string): string | null {
  const match = DTACH_SOCKET_PATTERN.exec(description);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * A short, deterministic id for `sessionsDir`, folded into `crs-session-*`
 * unit names by scopeUnitName() above (PR 2's per-instance rename) — see
 * this module's own header comment. `path.resolve`, not `fs.realpathSync`:
 * production's `SESSIONS_DIR` is a real, persistent path OUTSIDE the
 * `current` release symlink (deploy/install.sh), but that symlink itself is
 * repointed on every deploy — resolving through it would change this id on
 * every release, making every already-running session's scope unnameable,
 * a strictly worse failure than the collision this exists to prevent. A
 * dev/test instance's cwd-relative default (`./data/sessions`, env.ts)
 * resolves per-checkout instead, which is exactly the discrimination
 * wanted — each `.wt/<slug>` worktree gets its own id for free.
 *
 * Callers must pass the SAME value PtyManager itself derived its
 * `sessionsDir` from (`this.sessionsDir`, already `path.resolve`d and, on a
 * host near the 108-byte AF_UNIX `sun_path` limit, redirected by
 * `ensureSessionsDir` — see src/plugins/pty.ts), not
 * `app.config.SESSIONS_DIR` directly — a host that hit that redirect would
 * otherwise derive a mismatched id from the two.
 *
 * Truncated to 8 hex characters (32 bits) of a sha256, not the full digest
 * — short enough to keep unit names readable, at the cost of a real (if
 * astronomically unlikely) collision space between two DIFFERENT
 * `sessionsDir` values hashing to the same id. `stopScope`'s namespaced
 * fallback (session-process.ts) and this module's header comment describe
 * that as "cannot name a foreign unit," which holds only absent such a
 * collision — worth knowing if a future change ever needs a stronger
 * guarantee than "practically never."
 */
export function deriveInstanceId(sessionsDir: string): string {
  return createHash("sha256").update(path.resolve(sessionsDir)).digest("hex").slice(0, 8);
}

// Recovers the id a `crs-session-*` unit NAME might refer to, for a row
// whose Description didn't parse to a socket path at all (see
// listOwnedScopes below) — the only place this module ever needs to reason
// about a unit name's shape rather than its Description. Matches both the
// legacy bare `crs-session-<id>` (still possible post-PR-2: a session
// created before the upgrade keeps running under its old name) and the
// namespaced `crs-session-<instanceId>-<id>` PR 2 now actually produces,
// for THIS instance's own instanceId only; a unit namespaced for some
// other instance is left alone (not a candidate), same as a unit whose
// shape this doesn't recognize at all. Not used for a row whose socket
// path DID parse — listOwnedScopes recovers the real id from the socket
// basename in that case instead, per this module's own naming-vs-ownership
// split.
//
// Hermes review, PR 1 — not ground truth for id identity: a legacy id that
// itself happens to begin with `<instanceId>-` (e.g. a literal id
// "aaaaaaaa-7" when this instance's own instanceId is "aaaaaaaa") would be
// misread as the namespaced form for id "7". Harmless (this only feeds the
// `unverifiable` guess for a row whose Description failed to parse at all
// — never the ownership path itself, which always reads the real id from
// the socket basename), and still true now that PR 2 mints real namespaced
// units: this split must stay a guess feeding `unverifiable`, never
// authoritative.
function candidateIdForUnit(unit: string, instanceId: string): string | null {
  const match = /^crs-session-(.+)\.scope$/.exec(unit);
  if (!match) return null;
  const rest = match[1];
  const prefix = `${instanceId}-`;
  return rest.startsWith(prefix) ? rest.slice(prefix.length) : rest;
}

/**
 * The ownership source of truth every id-keyed function below is built on —
 * issue #1140. A `crs-session-*` unit's systemd Description is always the
 * literal `dtach -n <sessionsDir>/<id>.sock ...` launch argv
 * (extractDtachSocketPath's own doc comment), and `sessionsDir` is
 * per-instance by construction, so the SOCKET PATH — never the unit name —
 * is what actually identifies which Mullion instance, and which session
 * id, a scope belongs to. This is the permanent mechanism, not a
 * transition shim: it already handles today's bare `crs-session-<id>`
 * names and a future per-instance-namespaced rename identically, with no
 * unit-name parsing at all on the success path (the id comes from the
 * socket basename, never from splitting the unit name).
 *
 * `opts.states`/`opts.all` are passed straight through to `--state=`/
 * `--all` — callers need different filters (isMasterAliveBatch's `active,
 * deactivating`, per issue #988's DefaultTimeoutStopSec window, vs.
 * stopScope's/listSessionProcesses's broader `--all`), so this stays one
 * parameterized listing rather than two near-duplicate ones.
 */
export interface ScopeOwnershipListing {
  /** Session id -> full unit name (e.g. "crs-session-5.scope"), for every
   *  row whose dtach socket resolves directly under `sessionsDir`. */
  owned: Map<string, string>;
  /** Ids some row's unit NAME could plausibly refer to (see
   *  candidateIdForUnit above) but whose Description didn't yield a socket
   *  path at all — ownership can't be confirmed OR denied for these. Every
   *  caller must treat this as "unknown," never as "not owned" — see this
   *  module's own header comment and isMasterAliveBatch's doc comment on
   *  the mass-exit landmine that collapsing "unknown" to "false" would
   *  reintroduce. */
  unverifiable: Set<string>;
  /** The systemctl listing spawn/parse itself failed — `owned` and
   *  `unverifiable` are both empty and must not be trusted; every id is
   *  unknown, not "not owned." */
  failed: boolean;
}

export function listOwnedScopes(
  sessionsDir: string,
  instanceId: string,
  opts: { states?: string; all?: boolean } = {},
): Promise<ScopeOwnershipListing> {
  return new Promise((resolve) => {
    const args = ["--user", "list-units", "--type=scope"];
    if (opts.all) args.push("--all");
    if (opts.states) args.push(`--state=${opts.states}`);
    args.push("--no-legend", "--plain", "crs-session-*.scope");

    let stdout = "";
    let settled = false;
    const child = spawnChild("systemctl", args, { stdio: ["ignore", "pipe", "ignore"] });

    const onStdoutData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);

    const finish = (result: ScopeOwnershipListing) => {
      if (settled) return;
      settled = true;
      child.stdout?.off("data", onStdoutData);
      resolve(result);
    };
    const fail = () => finish({ owned: new Map(), unverifiable: new Set(), failed: true });

    // Issue #1232 — this spawn had no timeout at all: a wedged `--user`
    // D-Bus bus left this promise pending forever, and every
    // isMasterAliveStateBatch/isMasterAliveBatch caller (including
    // routes/projects.ts's withStackLock-serialized stack-session mutex,
    // issue #1182) bottoms out here — one hung call there stalled every
    // OTHER queued stack action for the same (projectId, composeProject)
    // key indefinitely, not just the in-flight request. A timeout maps to
    // the SAME `fail()` the
    // 'error'/non-zero-exit paths below already use, never to a successful
    // empty listing — `failed: true` is the "everything unknown" contract
    // this interface's own doc comment documents, not "nothing is owned."
    const armed = armKillEscalation(child, SYSTEMCTL_TIMEOUT_MS, fail);

    // Spawn failure (systemctl missing, etc.) — everything unknown, per
    // this function's own doc comment on `failed`.
    child.on("error", () => {
      armed.clearOnSettle();
      fail();
    });
    // 'close', not 'exit' — same stdout-delivery race isMasterAliveStateBatch()
    // below already guards against.
    child.on("close", (code) => {
      armed.clearOnSettle();
      if (code !== 0) {
        fail();
        return;
      }
      const resolvedSessionsDir = path.resolve(sessionsDir);
      const owned = new Map<string, string>();
      const unverifiable = new Set<string>();
      for (const { unit, description } of parseScopeUnitsListing(stdout)) {
        const socketPath = extractDtachSocketPath(description);
        if (socketPath === null) {
          const candidateId = candidateIdForUnit(unit, instanceId);
          if (candidateId !== null) unverifiable.add(candidateId);
          continue;
        }
        if (path.dirname(socketPath) === resolvedSessionsDir) {
          owned.set(path.basename(socketPath, ".sock"), unit);
        }
      }
      finish({ owned, unverifiable, failed: false });
    });
  });
}

/**
 * Resolves which unit — if any — THIS instance should treat as `id`'s own
 * scope, per listOwnedScopes()'s ownership rule above. Shared by stopScope
 * and listSessionProcesses below, both of which need the identical
 * confirmed-owner-else-nothing resolution — see stopScope's own doc comment
 * for the full reasoning behind each branch, repeated here only in brief so
 * a future change to this policy has one place to change instead of two
 * silently drifting copies:
 *
 *   - a listing row resolves `id` to an owned unit -> that unit.
 *   - the listing succeeded and does not claim `id` at all -> `undefined`
 *     (confidently not ours).
 *   - a row's unit NAME could plausibly be `id` but its Description didn't
 *     parse (`unverifiable`) -> also `undefined`. Silent by design: this
 *     module is deliberately logger-free (plain, config-free functions —
 *     see this file's own header comment), and a genuinely-owned scope
 *     landing here at all would mean either a systemd Description-rendering
 *     quirk extractDtachSocketPath doesn't yet handle, or a bug in the
 *     namespaced name/description shape PR 2 introduces — both expected to
 *     be rare, and both still caught by
 *     scripts/check-scope-leaks.ts as an orphaned-looking unit rather than
 *     failing louder here.
 *   - the listing itself failed (systemctl/D-Bus problem) -> `undefined` if
 *     `fallbackOnListingFailure` is false, else `scopeUnitName(instanceId, id)`
 *     — see the two call sites below for why they disagree on this one case.
 *     Issue #1140 (PR 2) — this fallback name is now namespaced, so unlike
 *     PR 1 (where it was the legacy bare `crs-session-<id>`, ambiguous
 *     across instances on every host with more than one) it cannot name a
 *     different instance's scope absent an 8-hex-char `deriveInstanceId`
 *     hash collision between two instances' `sessionsDir` values (see that
 *     function's own doc comment) — astronomically unlikely, not
 *     structurally impossible. A listing failure now degrades to "possibly
 *     leaks this instance's own scope," never "possibly kills a foreign
 *     one."
 *
 * Residual race, accepted: the listing and whatever the caller does with
 * the resolved unit are two separate spawns, so a scope could in principle
 * be collected and its exact unit name reused by a different instance's
 * brand-new session in the gap between them. Narrower than before this PR
 * (which had no ownership check at all), not eliminated — closing it
 * fully would need an atomic list-then-act primitive systemd's CLI doesn't
 * expose here.
 */
async function resolveOwningUnit(
  sessionsDir: string,
  instanceId: string,
  id: string,
  opts: { fallbackOnListingFailure: boolean },
): Promise<string | undefined> {
  const listing = await listOwnedScopes(sessionsDir, instanceId, { all: true });
  if (listing.failed) {
    return opts.fallbackOnListingFailure ? `${scopeUnitName(instanceId, id)}.scope` : undefined;
  }
  return listing.owned.get(id);
}

/**
 * Stop a session's systemd scope, killing its dtach master + program. Safe
 * to call even if the scope doesn't exist or is already gone.
 *
 * Issue #1140 (PR 1) — resolves the OWNING unit via resolveOwningUnit()
 * above first; stopping a unit this instance hasn't confirmed it owns is
 * #1137 inverted (killing a live session belonging to a DIFFERENT instance
 * on the same host). See that function's own doc comment for the full
 * per-case breakdown (owned / not-ours / unverifiable / listing-failed).
 *
 * Issue #1140 (PR 2) — `fallbackOnListingFailure: true` here, using the now
 * NAMESPACED `scopeUnitName(instanceId, id)` as the fallback. PR 1 shipped
 * this as `false` (Hermes review, PR 1: falling back to the un-namespaced
 * legacy `scopeUnitName(id)` on a listing failure could still stop a unit
 * this instance never confirmed owning, since that bare name was ambiguous
 * across instances on every host with more than one). The namespaced name
 * doesn't have that problem the same way — `crs-session-<instanceId>-<id>`
 * cannot name a unit a DIFFERENT instance created absent an 8-hex-char
 * `deriveInstanceId` hash collision between the two instances'
 * `sessionsDir` values (astronomically unlikely, not structurally
 * impossible — see that function's own doc comment), so falling back to
 * it on a listing failure is safe regardless of what's actually running
 * under that name. This is a change in risk CLASS from PR 1, not degree:
 * there, a collision on the derived instanceId only ever fed the
 * `unverifiable` bucket (a fail-safe "do nothing" outcome); here, it feeds
 * this destructive fallback directly. Accepted because the collision
 * probability itself is unchanged and negligible either way. The residual
 * gap this reopens is narrower than PR 1's, not the same one: a listing failure
 * against a session that's still running under its pre-upgrade LEGACY name
 * (`crs-session-<id>`, no instanceId) won't match this fallback string at
 * all, so `systemctl stop` on it is a no-op and that scope leaks instead of
 * stopping. `scripts/check-scope-leaks.ts` is the tool that catches that —
 * same accepted trade as PR 1's leak-on-listing-failure case, just scoped
 * down to legacy-named sessions during the upgrade window instead of every
 * session. This function costs two sequential spawns (the listing, then
 * the stop itself) instead of one — `terminate()` is rare enough that the
 * added latency doesn't matter in practice.
 */
export async function stopScope(
  sessionsDir: string,
  instanceId: string,
  id: string,
): Promise<void> {
  const unit = await resolveOwningUnit(sessionsDir, instanceId, id, {
    fallbackOnListingFailure: true,
  });
  if (unit === undefined) return;
  return new Promise((resolve) => {
    let settled = false;
    const child = spawnChild("systemctl", ["--user", "stop", unit], {
      stdio: "ignore",
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // Issue #1232 — this spawn had no timeout either. Unlike
    // listOwnedScopes()'s read-only listing above, this issues a MUTATING
    // request: killing the child on timeout does not cancel the stop —
    // systemd already has the request over D-Bus — so timing out here means
    // only "stop requested, outcome unknown," exactly what this best-effort
    // cleanup already promises (see the 'error' handler's own comment
    // below). It must not be read as "stop failed," and must not trigger
    // any retry/teardown of its own.
    const armed = armKillEscalation(child, SYSTEMCTL_TIMEOUT_MS, finish);

    // "unit not loaded" (already stopped / never existed) is an expected,
    // ignorable outcome here — this is a best-effort cleanup, not a
    // correctness-critical step whose failure should propagate.
    child.on("error", () => {
      armed.clearOnSettle();
      finish();
    });
    child.on("exit", () => {
      armed.clearOnSettle();
      finish();
    });
  });
}

/** "alive" — this instance owns a currently active/deactivating scope for
 *  this id. "dead" — a confident negative, no row anywhere plausibly names
 *  this id as active. "unknown" — a row could name it but ownership can't
 *  be confirmed, or the underlying listing itself failed/timed out. See
 *  isMasterAliveStateBatch's own doc comment for the full trust rule this
 *  type exists to make un-ignorable: a caller that takes a DESTRUCTIVE
 *  action (mark-exited, kill, recreate) on "not alive" must treat "unknown"
 *  as "don't know," never silently fold it into "dead." */
export type SessionLiveness = "alive" | "dead" | "unknown";

/**
 * Perf audit finding B8(2) — the batched liveness check for MANY sessions in
 * one go (session-backend.ts's LocalBackend.liveness, and
 * routes/internal.ts's `/internal/sessions/liveness` for a remote agent's
 * own sessions, via the isMasterAliveBatch wire-adapter below). A single
 * `systemctl --user list-units` call (via listOwnedScopes(), filtered to
 * `--state=active,deactivating` — issue #988: a scope Mullion itself just
 * asked systemd to stop sits in "deactivating" for up to systemd's own
 * DefaultTimeoutStopSec before settling, and is NOT "the program exited on
 * its own," the only thing this function exists to catch) returns every
 * currently-active scope in one spawn; per-id liveness is then a plain
 * in-memory lookup, no further subprocesses.
 *
 * Issue #1265 — this is the TOTAL primitive every liveness caller in this
 * codebase should build on: every requested id is always present in the
 * result, so there is no omitted key left for a caller to collapse to
 * "dead" by mistake (the exact footgun #1232's isMasterAliveState closed
 * for two call sites specifically, and this closes for good — see that
 * issue). Trust rule:
 *
 *   - `listing.owned.has(id)` -> `"alive"`.
 *   - neither owned nor unverifiable -> `"dead"` (a confident negative — no
 *     row anywhere plausibly names this id as active). This includes a row
 *     whose socket parses CLEANLY but resolves under a DIFFERENT instance's
 *     sessionsDir (Hermes review, PR #1232): since systemd forbids two units
 *     sharing a name, if THIS instance's own session `id` were still alive
 *     it would hold that exact unit name itself — a foreign-owned
 *     `crs-session-<id>` scope existing at all means this instance's own
 *     same-id session has already ended (or, pre-any-namespacing, raced a
 *     genuine #1137 collision at creation and never held the name to begin
 *     with). `"dead"` is the correct, confident answer here, not
 *     `"unknown"` — see the dedicated test coverage in
 *     session-process.test.ts locking this outcome in.
 *   - `listing.unverifiable.has(id)` -> `"unknown"`. A row could name `id`,
 *     but this instance can't confirm ownership, so it must not assert
 *     either answer.
 *   - `listing.failed` (spawn/parse error, e.g. systemctl missing, a
 *     `--user` D-Bus hiccup, or a timeout) -> `"unknown"` for every id.
 *
 * Both "unknown" cases matter for the same reason: collapsing either to
 * `"dead"` would mass-flip active sessions to exited on a single ambiguous
 * row or a transient systemctl error — exactly the mass-exit landmine
 * session-reconciler.ts's own doc comment calls out and specifically
 * protects against for the multi-host case (a key a REACHABLE host's
 * response merely omits is treated as "unknown," never "not alive"). Only
 * ids resolved with real confidence get `"alive"`/`"dead"`.
 */
export async function isMasterAliveStateBatch(
  sessionsDir: string,
  instanceId: string,
  ids: string[],
): Promise<Record<string, SessionLiveness>> {
  if (ids.length === 0) return Object.create(null);
  const listing = await listOwnedScopes(sessionsDir, instanceId, {
    states: "active,deactivating",
  });
  const result: Record<string, SessionLiveness> = Object.create(null);
  for (const id of ids) {
    if (listing.failed) {
      result[id] = "unknown";
    } else if (listing.owned.has(id)) {
      result[id] = "alive";
    } else if (listing.unverifiable.has(id)) {
      result[id] = "unknown";
    } else {
      result[id] = "dead";
    }
  }
  return result;
}

/**
 * Single-id read off isMasterAliveStateBatch() above — see that function's
 * own doc comment for the trust rule this preserves (issue #1232's original
 * motivation: `startStackSession`/`findActiveStackSession` take a
 * DESTRUCTIVE action on "not alive" and must not fold a merely-unverifiable
 * or timed-out listing into a confident "dead").
 */
export async function isMasterAliveState(
  sessionsDir: string,
  instanceId: string,
  id: string,
): Promise<SessionLiveness> {
  const result = await isMasterAliveStateBatch(sessionsDir, instanceId, [id]);
  return result[id];
}

/**
 * Wire-format adapter for `/internal/sessions/liveness` ONLY — this
 * boolean-with-omitted-keys shape is preserved byte-for-byte (issue #1265)
 * purely so an already-deployed remote agent's response stays parseable by
 * an already-deployed primary and vice versa (remote agents run different
 * builds than the primary by design — see docs/multi-host.md's "Agent
 * updates"). Every OTHER caller in this codebase should use
 * isMasterAliveStateBatch()/isMasterAliveState() above instead — the
 * omitted-key convention this function preserves is exactly the footgun
 * #1265 exists to stop new callers from reaching for.
 */
export async function isMasterAliveBatch(
  sessionsDir: string,
  instanceId: string,
  ids: string[],
): Promise<Record<string, boolean>> {
  const state = await isMasterAliveStateBatch(sessionsDir, instanceId, ids);
  const result: Record<string, boolean> = Object.create(null);
  for (const id of ids) {
    if (state[id] === "alive") {
      result[id] = true;
    } else if (state[id] === "dead") {
      result[id] = false;
    }
    // "unknown" -> omitted, matching this route's existing wire contract.
  }
  return result;
}

/**
 * Lists the genuine OS processes currently running inside `id`'s systemd
 * scope — the dtach master, the agent process, and anything the agent
 * itself spawns (MCP servers, `Bash run_in_background` jobs, nested CLIs,
 * dev servers). This is NOT subagent detection: Claude Code subagents run
 * in-process with no PID of their own (see agent-detect.ts).
 *
 * Issue #1140 — same resolveOwningUnit() resolution stopScope() uses above
 * (see its doc comment for the full per-case breakdown), with
 * `fallbackOnListingFailure: true` here too as of PR 2 — a wrong
 * attribution is harmless (this is a best-effort inventory, not a security
 * boundary), so a transient systemctl failure degrades gracefully instead
 * of silently reporting no processes for a session that may well be alive.
 * Returns `[]` for a scope that isn't owned/active, same as
 * isMasterAliveState() would report — listScopeProcesses() itself already
 * returns `[]` for a unit with no live cgroup. This now costs two sequential
 * spawns (the ownership listing, then listScopeProcesses' own cgroup query)
 * instead of one — this is reachable from a route (GET /api/sessions/:id/processes,
 * src/routes/sessions.ts) that a client could poll, so the added latency
 * is more visible here than in stopScope (rare, terminate()-only); still
 * accepted, since correctness (never attributing another instance's
 * processes to this one on the success path) matters more than shaving one
 * spawn off a best-effort inventory call.
 */
export async function listSessionProcesses(
  sessionsDir: string,
  instanceId: string,
  id: string,
): Promise<CgroupProcess[]> {
  const unit = await resolveOwningUnit(sessionsDir, instanceId, id, {
    fallbackOnListingFailure: true,
  });
  if (unit === undefined) return [];
  return listScopeProcesses(unit);
}
