import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { DEFAULT_SETTINGS, getStoredSettings } from "../services/settings.js";
import { readAgentBundleDisabled } from "../services/agent-bundle-state.js";
import { isAuthEnabled } from "../services/auth.js";
import { startKeepAwake } from "../services/keep-awake.js";
import { PtyManager } from "../services/pty-manager.js";
import {
  resolveSshAuthSock,
  materializesBridgeSocket,
  describeBridgeShadowing,
  sshAgentSocketPath,
} from "../services/ssh-agent-socket.js";
import { probeSocket } from "../services/unix-socket.js";
import { recordSessionsDir } from "../services/sessions-dir-history.js";
import { reconcileExitedSessions } from "../services/session-reconciler.js";
import { detectCodexRateLimits } from "../services/codex-rate-limit.js";
import { reconcileTasks } from "../services/task-reconciler.js";
import { fitsSunPath, maxSunPathBytes } from "../cli/sun-path.mjs";

const DEFAULT_RECONCILE_INTERVAL_MS = DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds * 1000;
const MIN_RECONCILE_INTERVAL_MS = 1000;

function readReconcileIntervalMs(app: FastifyInstance): number {
  return getStoredSettings(app.db).sessions.reconcileIntervalSeconds * 1000;
}

// Issue #437c — same "read fresh, don't cache" shape as
// readReconcileIntervalMs above, passed to PtyManager as a closure (see its
// own getInjectAgentGuide doc comment) rather than a value computed once
// here, since sessions.injectAgentGuide is toggleable at runtime and this
// closure is called on every new session, not just once at plugin
// registration. Unlike readReconcileIntervalMs (only ever invoked from the
// primary-role settings-patch path), this closure is invoked from inside
// PtyManager.getOrCreate() on every spawn — including the multi-host
// "agent" role, where app.db is genuinely absent (see hooks.ts's own
// `app.db ? ... : DEFAULT_SETTINGS` guard for the same reason). Falling
// back to DEFAULT_SETTINGS there mirrors hooks.ts exactly.
function readInjectAgentGuide(app: FastifyInstance): boolean {
  return app.db
    ? getStoredSettings(app.db).sessions.injectAgentGuide
    : DEFAULT_SETTINGS.sessions.injectAgentGuide;
}

// Mirrors readInjectAgentGuide immediately above, exactly — same closure
// shape, same multi-host "agent" role app.db-absent fallback — for the
// independent sessions.injectProjectBriefing setting.
function readInjectProjectBriefing(app: FastifyInstance): boolean {
  return app.db
    ? getStoredSettings(app.db).sessions.injectProjectBriefing
    : DEFAULT_SETTINGS.sessions.injectProjectBriefing;
}

// Mirrors readInjectAgentGuide immediately above in the app.db-present
// branch, but NOT in the app.db-absent (multi-host "agent" role) branch —
// unlike injectAgentGuide/injectProjectBriefing, injectMullionBundle has a
// durable per-agent-host "stay uninstalled" flag (agent-bundle-state.ts,
// issue #1089) that must survive across sessions, not just a live DB
// setting. Falling back to DEFAULT_SETTINGS.sessions.injectMullionBundle
// (unconditionally true) here would silently reinstall bundle content an
// operator explicitly removed via /api/bundle-sync/remove's fan-out, the
// next time PtyManager.getOrCreate() constructs a fresh Session for this
// closure's caller (getInjectMullionBundle) rather than reusing an
// in-memory one — this is a real, live path, not just a version-skew
// backstop: routes/terminal.ts's attachSocketToSession (the primary's own
// /ws/terminal and the agent's /internal/ws/attach) never sets
// opts.injectMullionBundle, so a dtach-master-died respawn (host reboot,
// dtach crash — not an ordinary redeploy) falls straight through to this
// closure. plugins/bundle-sync.ts's identically-shaped readInjectMullionBundle
// hits the same class of bug for its own (separate) boot-time-sync purpose
// and takes the identical fix; see that file's own comment for why the two
// call sites can't share one function despite reading the same flag.
function readInjectMullionBundle(app: FastifyInstance): boolean {
  return app.db
    ? getStoredSettings(app.db).sessions.injectMullionBundle
    : !readAgentBundleDisabled();
}

// Rich statuses — the errorState TTL backstop reads its own threshold fresh
// on every tick (not just once at arm-time), same "PATCH /api/settings takes
// effect immediately" posture the reconcile interval itself has, at
// negligible cost since this is a settings-table read already happening
// every tick for the interval above.
function readStaleErrorMs(app: FastifyInstance): number {
  return getStoredSettings(app.db).sessions.staleErrorSeconds * 1000;
}

// Issue #320 follow-up — busy latches (compactState/subagentCount) get their
// own, longer-default TTL distinct from staleErrorMs (see AppSettings.sessions.
// staleBusySeconds' own doc comment for why).
function readStaleBusyMs(app: FastifyInstance): number {
  return getStoredSettings(app.db).sessions.staleBusySeconds * 1000;
}

// Issue #404 — a fixed, non-user-configurable cadence for the dev-server
// detection sweep below, deliberately its OWN timer rather than piggybacked
// onto the reconcile timer's user-configurable reconcileIntervalSeconds
// (5..3600s, see settings.ts's sanitizeSettings): coupling the two would mean
// a large reconcileIntervalSeconds silently starves this feature for
// minutes, and a small one re-`toString("utf8")`s + regex-scans every
// eligible session's up-to-1MiB scrollback (SCROLLBACK_MAX_BYTES,
// scrollback-buffer.ts) far more often than a once-per-startup banner needs. 10s
// is much LESS frequent than the 500ms attention-eval tick (issue #404 asks
// for throttling well below that tick's rate, i.e. a much longer interval
// between scans, not a faster one).
const DEV_SERVER_DETECT_INTERVAL_MS = 10_000;

// Issue #404 — the DB-side half of the plain-session dev-server-detection
// feature: finds every session eligible for a rescan (kind !== "dock" — a
// dock session's own devServerUrl pre-fill is the existing, separate
// GET /api/projects-driven feature in dev-server-detect.ts/routes/
// projects.ts — active, and whose project (a) is on this same local host
// (app.pty, and therefore Session.getScrollback(), only ever tracks a
// session this process itself spawned/attached — see dev-server-detect.ts's
// own scoping comment) and (b) has no devServerUrl set yet. Returns a
// sessionId -> projectId map, exactly the shape PtyManager.
// sweepDevServerDetection expects — see that method's doc comment for why
// Session/PtyManager can't do this DB join themselves.
// Exported for the test that pins its eligibility rule (issue #1722) —
// the rule CHANGED in that issue (the host is the session's own, not its
// project's), so it needs a test that can call it directly.
export function findEligibleDevServerSessions(app: FastifyInstance): Map<string, number | null> {
  // Issue #1722 / roadmap 8.8 — eligibility is about the SESSION's own
  // host: the sweep probes THIS process's PtyManager, so only a session
  // that actually lives here can be probed. A session placed on a remote
  // host (whose project may well live here) is not this process's to
  // sweep. A session with no host of its own inherits its project's (the
  // coalesce), so every pre-existing row keeps behaving exactly as before.
  const rows = app.db
    .select({ id: sessions.id, projectId: sessions.projectId })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(
      and(
        eq(sessions.kind, "terminal"),
        eq(sessions.status, "active"),
        sql`coalesce(${sessions.hostId}, ${projects.hostId}) = ${LOCAL_HOST_ID}`,
        isNull(projects.devServerUrl),
      ),
    )
    .all();
  return new Map(rows.map((row) => [String(row.id), row.projectId]));
}

function runDevServerDetectionSweep(app: FastifyInstance, manager: PtyManager): void {
  if (getStoredSettings(app.db).dock.autoDetectDevServer !== "ask") return;
  const eligible = findEligibleDevServerSessions(app);
  if (eligible.size === 0) return;
  const detected = manager.sweepDevServerDetection(eligible);
  if (detected.length > 0) {
    app.log.info({ detected }, "detected a dev server in a plain session");
  }
}

/**
 * The `sockaddr_un.sun_path` limit, in bytes, and the socket paths a
 * sessions dir has to hold — ONE implementation, shared with
 * scripts/demo/env.mjs and the test suite's temp-dir helper.
 *
 * `src/cli/sun-path.mjs` is plain ESM (src/cli is copied into dist/ verbatim,
 * see package.json's "build"), so the demo script — which is .mjs and cannot
 * import this module — and the suite helper can use the same rule instead of
 * each keeping a copy of the platform table. A copy is a copy that can
 * drift, and the drift shows up as a bare `listen EINVAL` with nothing
 * pointing at the path.
 *
 * Re-exported from here because this module is the backend's public surface
 * for the rule, and the existing importers (test/plugins/pty-sessions-dir.test.ts,
 * test/scripts/demo-env.test.ts) name it that way.
 */
export {
  DEFAULT_SUN_PATH_BYTES,
  fitsSunPath,
  longestSocketPath,
  maxSunPathBytes,
  SUN_PATH_BYTES_BY_PLATFORM,
} from "../cli/sun-path.mjs";

/**
 * The pre-#1748 fallback root: a hardcoded POSIX `/tmp` — and the LAST
 * RESORT the fallback falls back to when the per-user root is unavailable.
 *
 * Empty on Windows, where that path does not exist (Windows support is
 * tracked separately, issue #1728). Empty roots are filtered out of every
 * root list below, so a root that does not exist on this platform simply
 * never appears.
 */
function legacyTmpRoot(): string {
  return process.platform === "win32" ? "" : "/tmp";
}

/**
 * The per-user directory the fallback lives under: `~/.mullion/sessions`.
 *
 * A per-user HOME directory — the repo's existing `~/.mullion/` convention
 * (the hooks shim and the bundle-sync manifest live there). It is PRIVATE
 * by construction (no world-writable shared parent), STABLE across app
 * restarts, reboots and TMPDIR changes (which is what keeps this instance's
 * id stable — see currentFallbackRoots' own comment), and short enough to
 * hold the sockets on every realistic HOME length.
 *
 * Empty when the home directory cannot be determined (no HOME and no passwd
 * entry) — the caller then falls back to the POSIX last resort.
 */
function homeSessionsRoot(): string {
  const home = os.homedir();
  return home === "" ? "" : path.join(home, ".mullion", "sessions");
}

/**
 * The home directory itself — the operator-facing lever when the per-user
 * root is the problem (too long, or not writable).
 */
function homeDir(): string {
  return os.homedir();
}

/**
 * The roots the fallback may be PLACED under today, in order of
 * preference. The first one whose `ms-<hash>` dir fits the platform's
 * sun_path budget is used.
 *
 * A fallback root has to satisfy three properties:
 *
 *   - **SHORT** — the sessions dir holds the sockets, and every socket path
 *     in it has to fit the platform's `sun_path` budget (see
 *     maxSunPathBytes above).
 *   - **PER-USER and PRIVATE** — it holds live dtach sockets plus hook
 *     tokens, so another local user must not be able to pre-create it or
 *     plant a symlink in it (see secureFallbackDir below).
 *   - **STABLE** — the fallback dir IS this instance's sessions dir, and
 *     deriveInstanceId (session-process.ts) hashes it to namespace this
 *     instance's systemd scopes. A root that CHANGES moves the instance's
 *     sockets AND changes its id, which orphans every scope the instance
 *     already owns — issue #1770. That is why the root is the per-user home
 *     directory and not the platform's temp dir: the temp dir is a function
 *     of TMPDIR, so it changes with the environment, while the home
 *     directory does not.
 *
 * The POSIX `/tmp` is the last resort — for the pathological case where the
 * home directory cannot be determined, or is itself too long to hold the
 * sockets. It is a world-writable dir, so it gets the same hardening
 * (secureFallbackDir) as every other root.
 */
function currentFallbackRoots(): string[] {
  return [homeSessionsRoot(), legacyTmpRoot()].filter((root) => root !== "");
}

/**
 * Every root this repo has ever shipped the fallback under: the current
 * candidates plus the ones earlier releases used.
 *
 * A scope created under one of the OLDER roots stays OWNED (see
 * resolveSessionsDirs below), so moving the fallback root never orphans a
 * running session — the old dir is still recognized as this instance's own,
 * and its scope stays alive and stoppable.
 */
function shippedFallbackRoots(): string[] {
  // The platform's temp dir is #1748's root: compat-only now (it is
  // environment-dependent — TMPDIR — which is what made this instance's id
  // unstable, issue #1770), but it stays in the set so the scopes created
  // under it survive the move to the per-user root.
  return [...currentFallbackRoots(), os.tmpdir()].filter((root) => root !== "");
}

/**
 * Where this instance's sessions live, and every dir it may own sockets in.
 *
 * `current` is the dir the sessions actually live in: the configured one
 * when it fits the platform's sun_path budget, otherwise the fallback.
 *
 * `owned` is the set of dirs this instance may own SCOPES in — `current`
 * plus every fallback root this repo has ever shipped, for the same
 * configured path. Ownership is resolved by the scope's dtach socket path
 * (session-process.ts's own doctrine, issue #1140), so a scope whose socket
 * lives in a dir this instance used EARLIER (a fallback root an earlier
 * release picked) is still recognized as this instance's own. Without that,
 * a root change silently re-derives the instance id, the scope stops
 * matching this instance's ownership rule, and the reconciler reads it as
 * "dead" and flips the session's row to "exited" while the scope keeps
 * running (issue #1770).
 */
export interface ResolvedSessionsDirs {
  /** The dir this instance uses NOW — where new sockets are created, and
   *  what deriveInstanceId is taken over. */
  current: string;
  /** Every dir this instance may own sockets in. Always contains
   *  `current`. */
  owned: string[];
  /** The fallback roots that were SKIPPED, with the reason each one was
   *  unusable — so the caller can say so. A root is skipped when it cannot
   *  hold the fallback: the mkdir failed (an unwritable or stale home
   *  directory), or the hardening refused it (a symlink, a dir owned by
   *  another user). The refusal is never silent: the dir is not followed
   *  and not used, but the operator is told. */
  skipped: ReadonlyArray<{ root: string; reason: string }>;
  /** Why the sessions-dir HISTORY could not be read or written (issue
   *  #1771) — never fatal, but not silent either: the caller says so, and
   *  the boot continues with the dirs the resolver can derive on its own. */
  historyWarning?: string;
}

/**
 * Resolves the configured sessions dir to the dir this instance actually
 * uses, plus the set of dirs it may own scopes in.
 *
 * It has ONE side effect: the resolved dir is RECORDED in the install
 * root's trail of dirs this install has used (issue #1771 — see
 * `options.mullionHome` and services/sessions-dir-history.ts). That trail is
 * what lets the owned set keep naming a dir the operator moved away from,
 * or one a changed TMPDIR produced. With no install root (a dev checkout)
 * nothing is read and nothing is written, and the result is exactly what it
 * was before the trail existed.
 *
 * The fallback's NAME is a fixed 8-hex-char hash of the resolved configured
 * path, and it is never shortened to buy bytes. The name is not decoration:
 * it is what makes the fallback distinct per configured path, and that
 * distinctness is load-bearing — deriveInstanceId (session-process.ts)
 * hashes the resolved sessions dir to namespace this instance's systemd
 * scopes, so two projects sharing one fallback dir would share one scope
 * namespace and could stop each other's scopes. Shortening the hash to
 * squeeze the path into a shrinking budget trades that away: at 2 hex chars
 * there are only 256 buckets, and at 0 the name is the SAME for every
 * configured path — a certain collision, not a probable one.
 *
 * The compat roots are derived from the CONFIGURED path (the hash input),
 * never by pattern-matching the resolved dir's basename: a configured dir
 * that happens to be named `ms-<8 hex>` would otherwise make this instance
 * claim ownership of a dir that may belong to a different project.
 *
 * On what the owned set may claim: every dir in it is one this instance
 * itself created — the current one, and the ones an earlier release created
 * for the same configured path. The only way a dir that is NOT ours lands
 * under one of those names is the 32-bit md5 collision the fallback name
 * already accepts (two projects hashing to one dir), and the scope listing
 * is per-user (`systemctl --user`), so a different user cannot inject a row
 * into it. That is why the compat dirs need no separate hardening pass the
 * way the current fallback dir gets one in secureFallbackDir.
 *
 * Issue #1771 — the set also grows by the HISTORY: the dirs this install
 * has resolved before, kept in the install root (MULLION_HOME). The compat
 * roots can only name what an earlier RELEASE would have used for the same
 * configured path, so they cannot name the dir an operator moved
 * SESSIONS_DIR away from, nor the fallback a changed TMPDIR produced. A
 * scope living in one of those is this instance's own, and without the
 * history the reconciler reads it as "dead" and tears the session down
 * while the scope keeps running. The history records only what this
 * instance itself resolved (see services/sessions-dir-history.ts), so it
 * cannot widen the set beyond dirs this instance made.
 */
export function resolveSessionsDirs(
  configured: string,
  options: { mullionHome?: string } = {},
): ResolvedSessionsDirs {
  const resolved = path.resolve(configured);
  const limit = maxSunPathBytes();
  const hash = createHash("md5").update(resolved).digest("hex").slice(0, 8);
  const name = `ms-${hash}`;
  // The fallback dir each shipped root would hold for THIS configured path.
  // These are the dirs a scope from an earlier release can still live in.
  const compatDirs = shippedFallbackRoots().map((root) => path.join(root, name));

  // The install root's trail of dirs this install has resolved. It is read
  // AND written by the resolver (see finish() below): a dir recorded by an
  // EARLIER boot is in the owned set even when this boot resolves
  // somewhere else. No install root (a dev checkout) means no trail at all,
  // and the behaviour is exactly today's.
  const mullionHome = options.mullionHome ?? "";

  const owned = (current: string, recorded: readonly string[]): string[] => {
    const all = [current, ...compatDirs, ...recorded];
    return [...new Set(all.map((dir) => path.resolve(dir)))].sort();
  };
  const skipped: Array<{ root: string; reason: string }> = [];

  /**
   * Finishes the resolution: records the resolved dir in the trail and
   * assembles the owned set.
   *
   * The recording happens HERE, once the dir is settled — the trail may
   * only hold dirs this instance actually resolved (issue #1137), and the
   * resolved dir is the only one it may name. Both callers of this function
   * (pty.ts's plugin and device.ts's) resolve the same configured path, so
   * both record the same dir; the write is atomic, so the second write is
   * harmless.
   */
  function finish(current: string): ResolvedSessionsDirs {
    const trail = recordSessionsDir(mullionHome, current);
    return {
      current,
      owned: owned(current, trail.dirs),
      skipped,
      ...(trail.warning === undefined ? {} : { historyWarning: trail.warning }),
    };
  }

  // The limit counts the NUL terminator, so the usable path is one byte
  // shorter than it — that off-by-one lives in fitsSunPath (src/cli/sun-path.mjs),
  // once, rather than at each comparison.
  if (fitsSunPath(resolved)) {
    return finish(resolved);
  }

  // The fallback has to fit TOO: it lives under one of the roots above, and
  // a root long enough to push the CONFIGURED path over the limit can push
  // the fallback over it as well — and a fallback that cannot hold a socket
  // is worse than no fallback at all. When even the full-width name does not
  // fit under any root, that is a real, operator-actionable failure: name
  // the roots and both levers, rather than silently landing two projects in
  // one directory.
  // Every root is TRIED, not just the first one that fits the budget: a root
  // that fits on length can still be unusable (an unwritable or stale home
  // directory, a symlink, a dir owned by another user), and that is a reason
  // to move on to the next root — not a reason to refuse to start. The last
  // failure is kept so that "no root worked" can say WHY.
  let lastFailure: Error | null = null;
  for (const root of currentFallbackRoots()) {
    const candidate = path.join(root, name);
    if (!fitsSunPath(candidate)) continue;
    try {
      secureFallbackDir(candidate);
      return finish(candidate);
    } catch (err) {
      // This root cannot hold the fallback — the mkdir failed (an unwritable
      // or stale home directory), or the hardening refused it (a symlink, a
      // dir owned by another user). Either way the dir is not followed and
      // not used; the reason is kept so the caller can report it.
      lastFailure = err instanceof Error ? err : new Error(String(err));
      skipped.push({ root: candidate, reason: lastFailure.message });
    }
  }
  const roots = currentFallbackRoots().join(", ");
  throw new Error(
    `the sessions dir ${resolved} is unusable: the longest socket path in it ` +
      `does not fit this platform's ${limit}-byte sun_path limit, and the ` +
      `fallback could not be created under any of the roots [${roots}] — set ` +
      `SESSIONS_DIR to a shorter path, or point HOME at a shorter, writable ` +
      `directory (${homeDir() || "unset"})` +
      (lastFailure === null ? "" : ` (the last attempt failed: ${lastFailure.message})`),
  );
}

// The `sockaddr_un.sun_path` limit is platform-specific (see
// maxSunPathBytes above). Worktree paths (.mullion-worktrees/<branch>/,
// .wt/<branch>/, or any deep server CWD) can push the socket path over it.
// When that happens, redirect the entire sessionsDir to a deterministic
// short path under a fallback root so Unix socket creation always succeeds
// regardless of project layout.
// Exported — src/plugins/device.ts calls this with the identical
// app.config.SESSIONS_DIR input so DeviceManager's scope-ownership
// namespace (deriveInstanceId, device-process.ts) always agrees with
// PtyManager's, rather than each plugin risking drift by deriving its own
// notion of "the real sessionsDir" independently.
//
// Note that it is no longer a PURE function of its one input: the resolver
// it delegates to also RECORDS the dir it resolved in the install root's
// trail (issue #1771) — but only when it is given one. With no install root
// (the default, and every dev checkout) nothing is read and nothing is
// written, so the call leaves the disk untouched; with one, it records the
// dir. Callers that want the trail to be kept pass the install root, and
// calling it more than once is safe either way: the record is the same dir,
// and the write is atomic.
//
// The OWNERSHIP set (resolveSessionsDirs) is what callers that resolve
// SCOPES need; this wrapper is the "which dir do the sockets live in"
// question on its own.
export function ensureSessionsDir(
  configured: string,
  options: { mullionHome?: string } = {},
): string {
  return resolveSessionsDirs(configured, options).current;
}

// The fallback lives under the platform's temp dir under a predictable
// name, and holds live dtach sockets plus hook tokens, so another local
// user could pre-create it (or plant a symlink) to read or hijack them
// (H4). Create it 0700, then lstat (never follow a symlink) and refuse a
// symlink or a directory owned by anyone else. A directory that is ours but
// looser than 0700 (made by an older release under the umask) is tightened
// in place rather than refused, so upgrading doesn't break startup. The path
// itself must stay stable: socket-dir ownership resolution and
// deriveInstanceId both key off it.
//
// On Linux the temp dir is the world-writable /tmp, which is why the
// hardening above matters there. On macOS `os.tmpdir()` is a PER-USER
// directory (`/var/folders/.../T`), so the same pre-creation attack is not
// available to other users to begin with — the hardening is kept anyway,
// because it costs nothing and the temp dir is still a shared location
// within a user account.
function secureFallbackDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`refusing to use ${dir} as sessions dir: not a plain directory`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`refusing to use ${dir} as sessions dir: owned by uid ${st.uid}, not ${uid}`);
  }
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

// Decorates app.pty with the session manager (see src/services/pty-manager.ts
// for what it actually does and why). Attach-clients it spawns are only
// killed on process shutdown here — never on browser disconnect, which is
// the whole point of the tool.
export const ptyPlugin = fp(async (app: FastifyInstance) => {
  // Issue #1770 — the sessions dir is resolved ONCE, here, into both the dir
  // the sockets live in and the set of dirs this instance may own scopes in
  // (the current one plus every fallback root an earlier release shipped for
  // the same configured path). Both are handed to PtyManager, which is the
  // only thing that resolves scopes on this host.
  //
  // Issue #1771 — the install root (MULLION_HOME) is passed along so the
  // resolver can keep its trail of the dirs this install has resolved: the
  // compat roots can only name what an earlier RELEASE would have used for
  // the same configured path, so a dir an operator moved SESSIONS_DIR away
  // from (or a fallback a changed TMPDIR produced) is only nameable from
  // that trail. Empty in a dev checkout, where the behaviour is exactly
  // today's.
  const sessionsDirs = resolveSessionsDirs(app.config.SESSIONS_DIR, {
    mullionHome: app.config.MULLION_HOME,
  });
  const sessionsDir = sessionsDirs.current;
  if (sessionsDir !== path.resolve(app.config.SESSIONS_DIR)) {
    app.log.info(
      { from: app.config.SESSIONS_DIR, to: sessionsDir },
      `sessionsDir socket path approaches this platform's ${maxSunPathBytes()}-byte sun_path limit, using short fallback`,
    );
  }
  // A fallback root that could not hold the sessions dir (unwritable, stale,
  // a symlink, owned by another user) is skipped, not used — but that is
  // never silent: the operator is told which root was passed over and why.
  for (const skip of sessionsDirs.skipped) {
    app.log.warn(
      { root: skip.root, reason: skip.reason },
      "sessionsDir fallback root unusable, using the next one",
    );
  }
  // The history file is an aid, not a requirement: a corrupt or unwritable
  // one is reported here and the boot continues with the dirs the resolver
  // could derive. Reported ONCE — this plugin registers before device.ts's
  // (which resolves the same configured path through the same resolver), so
  // it is the one place that says it.
  if (sessionsDirs.historyWarning) {
    app.log.warn(
      { reason: sessionsDirs.historyWarning },
      "the sessions-dir history is incomplete, so a scope in a dir this install has moved away from may read as dead",
    );
  }
  // Issue #820 PR5d — see resolveSshAuthSock's own doc comment for the full
  // precedence (configured > ambient > bridge-materialized). Read once here,
  // at boot: PtyManager freezes this into every Session it spawns for the
  // life of this process (see pty-manager.ts's own sshAuthSock field
  // comments), so there is no later point where re-reading it would matter.
  // materializesBridgeSocket(...) can't read app.sshAgentBridgeConnection
  // directly instead, since sshAgentPlugin registers after ptyPlugin — see
  // that function's own comment for why this is a shared predicate rather
  // than an inline role check repeated at every call site.
  //
  // Computed once and threaded through the preflight probe below AND both
  // resolveSshAuthSock/describeBridgeShadowing calls further down —
  // describeBridgeShadowing's `null`-vs-shadow branching assumes this exact
  // value matches what actually produced `resolvedSshAuthSock` (mullion-
  // reviewer, PR #875 self-review).
  let willMaterializeBridgeSocket = materializesBridgeSocket(app.config.MULLION_ROLE);
  if (willMaterializeBridgeSocket) {
    // Post-ship audit follow-up (#873, PR-B) — a cheap, read-only preflight
    // BEFORE PtyManager is constructed and freezes its sshAuthSock. Why this
    // can't wait for sshAgentPlugin's own (later) bind attempt: that plugin
    // registers AFTER ptyPlugin, so by the time it would discover "something
    // else already owns this socket path," PtyManager has already frozen
    // "bridge" as the winning source for every session on this host. Without
    // this check, a live foreign listener at the bridge socket path (a
    // second Mullion process, or a stale `ssh -R` socket someone pointed
    // here) would still get handed to every session's SSH client — a
    // signing-oracle handoff to a process we don't own, not a safe degrade.
    // Treats "live" and "unknown" the same as reclaimSocketPath itself does
    // (unix-socket.ts) — an inconclusive probe gets the conservative
    // answer, not the optimistic one. A "dead" result is left for
    // sshAgentPlugin's own reclaimSocketPath to actually reclaim and bind;
    // this preflight only ever narrows materializesBridgeSocket from true to
    // false, never the reverse, so it can't create the hole it's closing.
    // The residual TOCTOU window between this probe and that later bind is
    // the same one reclaimSocketPath's own doc comment already accepts —
    // milliseconds at process startup, not the live-instance case that
    // function actually defends against.
    const preflightBridgePath = sshAgentSocketPath(sessionsDir);
    const probe = await probeSocket(preflightBridgePath);
    if (probe !== "dead") {
      willMaterializeBridgeSocket = false;
      app.log.error(
        { bridgePath: preflightBridgePath, probe },
        "refusing to offer a bridge-backed SSH_AUTH_SOCK to sessions on this host — " +
          "something is already at the ssh-agent bridge socket path and this process " +
          "cannot confirm it's safe to reclaim (see reclaimSocketPath)",
      );
    }
  }
  // Self-review (mullion-reviewer, PR #877) — sshAgentPlugin (registered
  // after this one) needs to know whether THIS decision actually committed
  // sessions to the bridge tier, to tell apart two very different bind
  // failures it might hit moments later at the same path: (a) the preflight
  // above already excluded the bridge tier, so nothing depends on that
  // socket working — any failure there is harmless and safe to degrade; (b)
  // the preflight found the path genuinely dead and PtyManager (below) is
  // about to freeze "bridge" as the winning source for every session on
  // this host, so a *subsequent* collision (something racing in during the
  // narrow window between this probe and sshAgentPlugin's own bind) means
  // those already-frozen sessions would be pointed at a process this host
  // doesn't own — sshAgentPlugin must crash rather than silently degrade in
  // that specific case. See that plugin's own comment for how it uses this.
  app.decorate("sshAuthSockBridgeExpected", willMaterializeBridgeSocket);
  // Captured once so the shadow-warning log below describes the exact same
  // inputs that produced `resolvedSshAuthSock`, rather than re-reading
  // process.env.SSH_AUTH_SOCK a second time (Hermes review, PR #875) — the
  // two calls are otherwise a hair's-width apart in time, but "describes
  // what actually happened" shouldn't depend on that gap staying empty.
  const ambientSshAuthSock = process.env.SSH_AUTH_SOCK;
  const resolvedSshAuthSock = resolveSshAuthSock({
    configured: app.config.MULLION_SSH_AUTH_SOCK,
    ambient: ambientSshAuthSock,
    materializesBridgeSocket: willMaterializeBridgeSocket,
    sessionsDir,
  });
  // Post-ship audit follow-up (#873) — the missing breadcrumb: without this,
  // a paired bridge can sit shadowed by `configured`/`ambient` with nothing
  // anywhere saying so. See describeBridgeShadowing's own doc comment.
  // Note this is a no-op (returns null) whenever the preflight above already
  // suppressed `willMaterializeBridgeSocket` — a host that isn't going to
  // materialize a bridge socket at all has nothing to shadow.
  const shadowing = describeBridgeShadowing(resolvedSshAuthSock, {
    materializesBridgeSocket: willMaterializeBridgeSocket,
    sessionsDir,
  });
  if (shadowing) {
    // `resolvedSshAuthSock.path` is "" in the `ambient` case by design
    // (resolveSshAuthSock's own doc comment: "" means "don't touch it," a
    // correct *injection* decision) — but this is a *diagnostic*, and an
    // operator debugging "why isn't my paired bridge used" needs the actual
    // winning path, not a placeholder. Reuse the exact `ambientSshAuthSock`
    // value already passed as `resolveSshAuthSock`'s `ambient` argument
    // above, rather than re-reading process.env; nothing sensitive here that
    // buildAgentConfig's own Settings diagnostic doesn't already surface
    // unredacted.
    const winningPath =
      shadowing.shadowedBy === "ambient"
        ? (ambientSshAuthSock ?? "(unset)")
        : resolvedSshAuthSock.path;
    app.log.warn(
      { shadowedBy: shadowing.shadowedBy, bridgePath: shadowing.bridgePath, winningPath },
      "this host materializes an ssh-agent bridge socket, but SSH_AUTH_SOCK resolves via a higher-precedence source — a paired bridge will not be used by sessions here until that source is removed",
    );
  }

  const manager = new PtyManager({
    sessionsDir,
    // Issue #1770 — every dir this instance may own scopes in, not just the
    // one it creates sockets in: a scope created before the fallback root
    // moved keeps its socket in the OLD dir, and ownership is resolved by
    // the socket path (session-process.ts), so without the old dir in this
    // set the scope stops being this instance's own — and the reconciler
    // then reads it as "dead" and flips the session's row to "exited" while
    // the scope keeps running.
    ownedSessionsDirs: new Set(sessionsDirs.owned),
    sshAuthSock: resolvedSshAuthSock.path,
    // Issue #949 — read once here, at boot, same posture as sshAuthSock
    // immediately above: PtyManager freezes this into every Session it
    // spawns for the life of this process, so there's no later point where
    // re-reading it would matter (isAuthEnabled(app.config) only changes
    // across a restart, since MULLION_AUTH_TOKEN/OIDC config are env-var-
    // derived, not DB-backed settings).
    authEnabled: isAuthEnabled(app.config),
    controlSocketPath: app.config.MULLION_SOCKET_PATH || undefined,
    // The control socket is primary-only (control-socket.ts no-ops here), so
    // tell the sessions rather than leave them a dead path (#1627).
    controlUnavailable: app.config.MULLION_ROLE === "agent",
    getInjectAgentGuide: () => readInjectAgentGuide(app),
    getInjectProjectBriefing: () => readInjectProjectBriefing(app),
    getInjectMullionBundle: () => readInjectMullionBundle(app),
  });

  app.decorate("pty", manager);

  // Issue #1719 (roadmap 8.5) — keep an idle macOS host awake while it has
  // live sessions. Starts on BOTH roles: an agent host runs sessions exactly
  // like a primary does, and it is the agent that is most likely to be a
  // laptop somebody closes the lid on.
  //
  // Inert everywhere but macOS, and no-ops when MULLION_KEEP_AWAKE=false — see
  // services/keep-awake.ts for why it is an app-level child armed on live
  // sessions rather than an always-on launchd job.
  const keepAwake = startKeepAwake(app);
  const unsubscribeResume = app.suspendWatcher.onResume(() => {
    // The caffeinate child is suspended with the app and resumes with it,
    // but the arm/disarm STATE can be stale across the gap — so recompute
    // it rather than trusting whatever was true before the sleep.
    keepAwake.sync();
  });

  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  // Re-entrancy guards (6.4/#217) — both reconcilers now make GitHub round
  // trips (reconcileExitedSessions via its #282 task-failed hook,
  // reconcileTasks via its transition syncs), on top of the liveStatus/
  // liveness calls they already made, so a slow GitHub makes
  // overlapping ticks meaningfully more likely than before this PR. Same
  // shape as task-watcher.ts's own `running` guard. Each reconciler's own
  // DB writes are already status-guarded against a stacked call actually
  // double-applying (session-reconciler.ts's #282 write is
  // `WHERE status IN ('claimed','in_progress')`, so a losing overlapped
  // call's UPDATE just matches zero rows) — these guards are the
  // network-request-volume backstop on top of that, not the correctness
  // mechanism itself.
  let sessionReconcileRunning = false;
  let taskReconcileRunning = false;

  // Re-armable: PATCH /api/settings calls this after a write that changes
  // sessions.reconcileIntervalSeconds, so the new interval takes effect
  // immediately rather than only after a process restart.
  function armReconcileTimer(intervalMs: number) {
    if (reconcileTimer) clearInterval(reconcileTimer);
    // Defense-in-depth floor: services/settings.ts's sanitizeSettings
    // already keeps a persisted reconcileIntervalSeconds sane, but a
    // non-finite or sub-second value here would otherwise reach
    // setInterval directly — 0/NaN coerces to a ~1ms busy-loop.
    const safeIntervalMs =
      Number.isFinite(intervalMs) && intervalMs >= MIN_RECONCILE_INTERVAL_MS
        ? intervalMs
        : DEFAULT_RECONCILE_INTERVAL_MS;
    // unref() so this timer alone never keeps the process (or, in tests, a
    // fastify instance that's about to be closed) alive — reconciliation is
    // opportunistic housekeeping, not core request-serving work.
    reconcileTimer = setInterval(() => {
      // Issue #1734 — the codex rate-limit sweep, on this same timer and
      // this same interval as the other periodic housekeeping below.
      //
      // A codex turn that hits a provider rate limit fires NO hook at all —
      // codex does not fire `Stop` for a failed turn, and its payloads carry
      // no error field to begin with — so nothing else in Mullion can see
      // the failure. The sweep reads the session's rollout file (whose path
      // the `SessionStart` hook reported) and reports a newly-failed turn as
      // a `stop_failure` message, which is what lights up Task Master's
      // rate-limit grace window.
      //
      // Deliberately ungated and cheap: it only touches sessions that have a
      // rollout path (codex sessions whose `SessionStart` hook fired), and
      // each read is a bounded tail read of one file.
      detectCodexRateLimits(app).catch((err) => {
        app.log.error({ err }, "codex rate-limit sweep failed");
      });
      if (!sessionReconcileRunning) {
        sessionReconcileRunning = true;
        reconcileExitedSessions(app)
          .catch((err) => {
            app.log.error({ err }, "session reconciliation failed");
          })
          .finally(() => {
            sessionReconcileRunning = false;
          });
      }
      // Phase 6 Task Master (6.2/#215) — piggybacks on this same primary-
      // role, same-interval timer rather than a dedicated one, matching
      // this codebase's own convention for related periodic housekeeping
      // (see the stale-error/stale-state sweeps just below).
      //
      // Deliberately UNGATED on Task Master's enabled state (independent
      // review, PR #480) — reconcileTasks is a safety-NET for tasks that
      // are ALREADY claimed/in_progress (budget force-fail, claimed ->
      // in_progress -> reviewing progression), not new autonomous work the
      // "enabled" toggle is meant to gate (that's the watcher's auto-claim
      // and this route's own claim endpoint). Gating it on "enabled" used
      // to mean: flip the toggle off while a task is running (now a
      // one-click Settings action, not just a restart-time env edit) and
      // its time budget stops being enforced, it never progresses past
      // claimed/in_progress, and it permanently occupies a concurrency-cap
      // slot — the exact opposite of what a safety toggle should do.
      // `reconcileTasks` itself still checks "enabled" per-pass wherever a
      // pass would do new autonomous work (the → reviewing transition,
      // `retryStrandedDraftPRs`, `processPendingReviewSpawns`'s review-agent
      // spawn) — this outer call is ungated only so the always-safe passes
      // (budget force-fail, status sync) still run while those are skipped.
      if (!taskReconcileRunning) {
        taskReconcileRunning = true;
        reconcileTasks(app)
          .catch((err) => {
            app.log.error({ err }, "task reconciliation failed");
          })
          .finally(() => {
            taskReconcileRunning = false;
          });
      }
      // Rich statuses — local-only (see PtyManager.sweepStaleErrors' doc
      // comment), so this piggybacks on the same primary-role, same-interval
      // timer as the exited-session reconciliation above rather than
      // needing its own.
      //
      // Unlike the two reconcilers above (which are async and already
      // `.catch()`-guarded), these reads/sweeps are synchronous — a bare
      // throw here (e.g. `readStaleErrorMs`'s `app.db` query landing after
      // the DB has closed: onClose hooks fire in reverse registration
      // order, so a normal app.close() always clears this timer before
      // dbPlugin's own onClose runs, but an app whose boot failed after
      // this plugin registered — e.g. a later plugin's register() rejecting
      // — never gets a close() call at all, leaving this same interval
      // armed against a since-recycled db) would otherwise become an
      // uncaught exception straight out of a bare Timeout callback, with no
      // promise chain to catch it. Same defensive wrapping as
      // devServerDetectTimer's own sweep just below — one missed tick is
      // harmless opportunistic housekeeping either way.
      try {
        const staleErrorMs = readStaleErrorMs(app);
        const clearedErrors = manager.sweepStaleErrors(staleErrorMs);
        if (clearedErrors.length > 0) {
          app.log.info({ sessionIds: clearedErrors }, "cleared stale errorState past its TTL");
        }
        // Issue #320 — the general blocked/busy-state staleness sweep: blocked
        // latches (permission/plan/gate/promote/elicitation) use staleErrorMs,
        // busy latches (compact/subagent) use their own, longer staleBusyMs —
        // see readStaleBusyMs's doc comment for why they need different TTLs.
        const staleBusyMs = readStaleBusyMs(app);
        const clearedBlocked = manager.sweepStaleStates(staleErrorMs, staleBusyMs);
        if (clearedBlocked.length > 0) {
          app.log.info(
            { sessionIds: clearedBlocked },
            "cleared stale blocked/busy states past their TTL",
          );
        }
      } catch (err) {
        app.log.error({ err }, "stale-state sweep failed");
      }

      // Issue #1681 — sweeps orphaned `<id>.tmp` directories under sessionsDir
      // left behind by aborted spawns, crashed processes, or hard restarts.
      // Primary-role only (matches all other periodic sweeps); remote agent-role
      // hosts rely on terminate()-time cleanupSessionFiles.
      manager
        .sweepOrphanedTmpDirs(app.log)
        .then((swept) => {
          if (swept > 0) {
            app.log.info({ swept }, "swept orphaned session tmp directories");
          }
        })
        .catch((err) => {
          app.log.error({ err }, "orphaned session tmp sweep failed");
        });
    }, safeIntervalMs);
    reconcileTimer.unref();
  }

  // Reconciliation reads DB intent (readReconcileIntervalMs -> getStoredSettings
  // -> app.db) and writes DB status — both meaningless on a DB-less "agent"
  // process (issue #26), which registers this plugin before dbPlugin is ever
  // registered (see src/app.ts's role branch, which skips dbPlugin for agent
  // entirely). An agent still gets app.pty for local session spawn/attach;
  // it just isn't the one deciding "exited" for anything.
  let devServerDetectTimer: ReturnType<typeof setInterval> | null = null;
  if (app.config.MULLION_ROLE === "primary") {
    armReconcileTimer(readReconcileIntervalMs(app));
    app.addHook("onReady", () => {
      manager
        .sweepOrphanedTmpDirs(app.log)
        .then((swept) => {
          if (swept > 0) {
            app.log.info({ swept }, "initial orphaned session tmp sweep finished");
          }
        })
        .catch((err) => {
          app.log.error({ err }, "initial orphaned session tmp sweep failed");
        });
    });
    app.decorate("reconfigureReconciler", (intervalSeconds: number) => {
      armReconcileTimer(intervalSeconds * 1000);
    });

    // Issue #404 — same DB-less-"agent"-role reasoning as the reconciler
    // just above: this timer reads app.db (settings + the sessions/projects
    // join in findEligibleDevServerSessions), so it must stay inside this
    // "primary" branch too, not run unconditionally the way PtyManager's own
    // in-memory attentionEvalTimer does.
    devServerDetectTimer = setInterval(() => {
      try {
        runDevServerDetectionSweep(app, manager);
      } catch (err) {
        app.log.error({ err }, "dev-server detection sweep failed");
      }
    }, DEV_SERVER_DETECT_INTERVAL_MS);
    devServerDetectTimer.unref();
  }

  // Dismissed in GHAS as alert #124 (js/missing-rate-limiting) — CodeQL
  // treats any app.addHook(...) callback as a candidate route handler, but
  // "onClose" is a Fastify lifecycle hook that fires once at process
  // shutdown, not a request handler. (See dock-config.ts's isSymlinkPath for
  // why a `codeql[...]` line comment here wouldn't have dismissed this on
  // its own — this repo's codeql.yml has no step that turns a SARIF
  // suppression into an actual Security-tab dismissal.)
  app.addHook("onClose", () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (devServerDetectTimer) clearInterval(devServerDetectTimer);
    unsubscribeResume();
    keepAwake.stop();
    manager.killAll();
    // Deliberately no rmSync of a fallback sessionsDir here: sessions
    // run in transient systemd scopes precisely so they survive a restart,
    // and removing the directory would delete their live dtach sockets and
    // hook tokens.
  });
});

declare module "fastify" {
  interface FastifyInstance {
    pty: PtyManager;
    reconfigureReconciler: (intervalSeconds: number) => void;
    /** Whether this boot's `resolveSshAuthSock` resolution (above) actually
     * committed every session on this host to the bridge tier — see the
     * decoration site's own comment. Read by `sshAgentPlugin`
     * (plugins/ssh-agent.ts) to decide whether a bind failure at the same
     * path is harmless (this is `false`) or a genuine race requiring a
     * crash rather than a silent degrade (this is `true`). */
    sshAuthSockBridgeExpected: boolean;
  }
}
