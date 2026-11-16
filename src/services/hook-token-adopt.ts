import { readdirSync } from "node:fs";
import path from "node:path";
import { readPersistedHookToken } from "./hook-token.js";
import { registerHookToken } from "./hook-token-registry.js";
import { SESSION_ID_PATTERN } from "./session-limits.js";
import { sessionSocketPath } from "./scope/dtach.js";
import { probeSocket } from "./unix-socket.js";
import type { ScopeLiveness } from "./scope/types.js";

// Issue #3166 — a session's hook token is persisted next to its socket
// (`<sessionsDir>/<id>.token`, minted by `loadOrCreateHookToken` in
// hook-token.ts) and therefore SURVIVES a restart of the Mullion process that
// created it. What does not survive is `PtyManager`'s in-memory map of
// token -> session id: after a restart the map is empty, so every hook
// handshake the surviving session's agent makes is refused with
// "hook connection presented an unknown or invalid token" (plugins/hooks.ts's
// own log line) — including the final `Stop`, which is how a Task Master
// worker reports that it finished.
//
// On the primary, `adoptActiveTaskSessions` (src/services/session-adopt.ts,
// #2945) rebuilds the `Session` for the surviving local task sessions, and
// rebuilding a `Session` re-reads the token file, so the token becomes
// resolvable again as a side effect. That path reads the `sessions` and
// `projects` TABLES, so it cannot run on an agent-role host — which has no
// database at all (see app.ts's role branch) — and it cannot run for a
// session the primary has no row for.
//
// This module is the database-free half: it finds the sessions this host
// still owns, and makes each one's persisted token resolvable again WITHOUT
// rebuilding the session, WITHOUT a database row, and WITHOUT touching the
// running program.
//
// Two independent facts have to hold before a token is registered, and both
// are checked here:
//
//   1. THE SCOPE IS LIVE AND OURS. The host's scope backend answers that
//      question (`ScopeBackend.isAliveBatch`), which is the platform-neutral
//      seam this repo built for exactly this purpose (issue #1715): on Linux
//      it is `listOwnedScopes` (src/services/session-process.ts) resolving
//      ownership by the scope's DTACH SOCKET PATH — never by unit name —
//      and on macOS it is the detached backend's probe of that same socket
//      (scope/detached.ts). "alive" is the ONLY answer that registers
//      anything: "dead" and "unknown" are both skipped, because a token
//      whose scope cannot be confirmed alive must never be accepted.
//
//   2. THE TOKEN FILE IS THE ONE THAT SCOPE USES. The token file and the
//      scope's socket live side by side in the same dir, so the scope's
//      socket is probed AT THE CANDIDATE'S OWN DIR. That is what keeps a
//      token from being paired with the wrong scope when the same id exists
//      in two of this instance's dirs (the compat roots of issue #1770): the
//      backend's liveness answer is per ID, while the socket's path is what
//      identifies the scope.
//
// Everything here is READ-ONLY with respect to the session: it reads files,
// asks the scope backend for liveness, and probes a socket. It never
// respawns or reattaches a program, never calls `terminate()`, and never
// stops a scope — a dead session stays dead, exactly as it did before this
// module existed.
//
// One platform-shaped limit, stated rather than hidden: a candidate whose
// token file lives in one of this instance's COMPAT roots (issue #1770 — a
// sessions dir that moved) is only adopted on a host whose scope backend can
// still place that scope. The systemd backend can (its ownership set spans
// the compat roots), the detached (macOS) one cannot — it only knows the
// sessions dir in use today — so such a session is skipped there rather
// than adopted against the wrong scope. That is the same gap issue #1771
// records for the DB-less agent role, and it fails CLOSED.

/** The suffix of a persisted hook token file. */
const TOKEN_SUFFIX = ".token";

/** Why a candidate session's token was not registered. */
export type HookTokenSkipReason =
  /** The token file is missing, unreadable, or not a well-formed token. */
  | "malformed-token"
  /** The scope is confidently not running. */
  | "dead-scope"
  /** The scope's liveness (or its ownership) could not be confirmed. */
  | "unverified-scope";

export interface AdoptSurvivingHookTokensOptions {
  /**
   * Every dir this instance may own scopes in — its current sessions dir plus
   * the compat roots an earlier release shipped for the same configured path
   * (issue #1770). A token file outside this set is not this instance's, and
   * is never even read.
   */
  ownedDirs: ReadonlySet<string>;
  /**
   * The host's scope backend's liveness answer for a set of ids — a TOTAL
   * map, so an id this instance cannot place is "unknown", never a missing
   * key (see `ScopeBackend.isAliveBatch`).
   */
  isAliveBatch: (ids: string[]) => Promise<Record<string, ScopeLiveness>>;
}

export interface AdoptSurvivingHookTokensResult {
  /** The session ids whose persisted token is now resolvable. */
  registered: string[];
  /** The session ids that were NOT registered, and why. */
  skipped: Array<{ sessionId: string; reason: HookTokenSkipReason }>;
}

/** A `<id>.token` file found under one of this instance's own dirs. */
interface TokenCandidate {
  sessionId: string;
  /** The dir the token file (and the scope's socket) lives in. */
  dir: string;
  /** The well-formed token, or null when the file was missing/unreadable/malformed. */
  token: string | null;
}

/**
 * Every `<id>.token` file under this instance's own dirs.
 *
 * The id is validated against `SESSION_ID_PATTERN` — the same shape every
 * session id in this codebase has — so a stray file in the sessions dir
 * (`notes.token`, `..token`) can never turn into a session id, and never
 * into a path traversal into some other dir.
 */
function collectCandidates(ownedDirs: ReadonlySet<string>): TokenCandidate[] {
  const candidates: TokenCandidate[] = [];
  for (const dir of ownedDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // A dir that does not exist (a compat root this install never
      // created), or cannot be read: no candidates, and no failure — this
      // is a best-effort sweep over dirs the instance merely MAY own.
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(TOKEN_SUFFIX)) continue;
      const sessionId = entry.slice(0, -TOKEN_SUFFIX.length);
      if (!SESSION_ID_PATTERN.test(sessionId)) continue;
      candidates.push({
        sessionId,
        dir,
        token: readPersistedHookToken(path.join(dir, entry)),
      });
    }
  }
  return candidates;
}

/**
 * Re-registers the hook tokens of the sessions that survived this host's
 * restart, so their agents can complete a hook handshake again.
 *
 * Returns what was registered and what was skipped, with a reason per skip —
 * the caller logs that summary. NO TOKEN VALUE is ever returned or logged:
 * the ids are enough to diagnose, and the token itself is a bearer secret
 * (see hooks.ts's own "log only a short, non-secret prefix" rule).
 */
export async function adoptSurvivingHookTokens(
  opts: AdoptSurvivingHookTokensOptions,
): Promise<AdoptSurvivingHookTokensResult> {
  const result: AdoptSurvivingHookTokensResult = { registered: [], skipped: [] };

  const candidates = collectCandidates(opts.ownedDirs);
  if (candidates.length === 0) return result;

  // A malformed token file is skipped before the liveness question is even
  // asked: there is nothing to register for it, so there is no reason to
  // spend a listing or a probe on it.
  const usable = candidates.filter((candidate): candidate is TokenCandidate & { token: string } => {
    if (candidate.token !== null) return true;
    result.skipped.push({ sessionId: candidate.sessionId, reason: "malformed-token" });
    return false;
  });
  if (usable.length === 0) return result;

  const liveness = await opts.isAliveBatch([...new Set(usable.map((c) => c.sessionId))]);

  for (const candidate of usable) {
    const state = liveness[candidate.sessionId];
    if (state !== "alive") {
      result.skipped.push({
        sessionId: candidate.sessionId,
        reason: state === "dead" ? "dead-scope" : "unverified-scope",
      });
      continue;
    }
    // The token file's own dir must be where THIS scope's socket lives —
    // the scope's identity is its socket path, never its id.
    const probe = await probeSocket(sessionSocketPath(candidate.dir, candidate.sessionId));
    if (probe !== "live") {
      result.skipped.push({
        sessionId: candidate.sessionId,
        reason: probe === "dead" ? "dead-scope" : "unverified-scope",
      });
      continue;
    }
    // The one write this performs: the token -> id entry the hook socket's
    // handshake resolves against (`registerHookToken` in
    // src/services/hook-token-registry.ts). A registered token is not
    // privileged over a minted one in any way — same map, same
    // constant-time compare.
    registerHookToken(candidate.token, candidate.sessionId);
    result.registered.push(candidate.sessionId);
  }

  return result;
}
