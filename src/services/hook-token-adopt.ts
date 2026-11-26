import { readdirSync } from "node:fs";
import path from "node:path";
import { readPersistedHookToken } from "./hook-token.js";
import { forgetHookToken, registerHookToken } from "./hook-token-registry.js";
import { SESSION_ID_PATTERN } from "./session-limits.js";
import { sessionSocketPath } from "./scope/dtach.js";
import { probeSocket } from "./unix-socket.js";
import type { ScopeLiveness } from "./scope/types.js";

// Issue #3166 — a session's hook token is persisted next to its socket
// (`<sessionsDir>/<id>.token`, minted by `loadOrCreateHookToken` in
// hook-token.ts) and therefore SURVIVES a restart of the Mullion process that
// created it. What does not survive is the process-wide hook-token registry
// (src/services/hook-token-registry.ts) of token -> session id: after a
// restart it is empty, so every hook handshake the surviving session's agent
// makes is refused with
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
//
// Issue #3206 — the sweep above is a SNAPSHOT, and the invariant it leaves
// behind ("a dead scope's token is never accepted") only held as of the
// moment it ran. The registry it writes into is PROCESS state, and the only
// thing that ever took an entry back out was `PtyManager.kill()` — which
// only knows the sessions THIS PROCESS TRACKS. An ADOPTED id has no
// `Session` object here (that is the whole point of the adoption: the
// session was never rebuilt), so nothing ever dropped its token: a session
// whose scope died after the sweep kept its token resolvable until the
// process exited.
//
// So this module also OWNS the bookkeeping of what it adopted, and offers
// the re-check that closes the gap: `recheckAdoptedHookTokens` below asks
// the SAME liveness question the sweep asked, and forgets the token of an id
// whose scope is CONFIRMED dead. It fails CLOSED — an "unknown" verdict
// (a systemctl failure, an id this instance cannot place, a socket probe
// that timed out) keeps the token registered, because the agent inside a
// scope that is merely unconfirmed is exactly the party presenting that
// token.

/** The suffix of a persisted hook token file. */
const TOKEN_SUFFIX = ".token";

/**
 * The tokens THIS PROCESS adopted — session id -> token.
 *
 * Issue #3206 — the bookkeeping the boot sweep needs so its registrations
 * can be taken back out. It is PROCESS state on purpose, for the same reason
 * the hook-token registry is (see hook-token-registry.ts's own header): a
 * session's hook token is a bearer secret that outlives any one of this
 * process's objects, and the thing being tracked here — "this process
 * accepted a token for an id it does not track" — is exactly a property of
 * the process.
 *
 * Only ids this process ADOPTED are in here. A session this process tracks
 * has a `Session` object carrying its token, and the manager's own `kill()`
 * path drops that one — see hook-token-registry.ts's `forgetHookToken`. An
 * adopted id that LATER becomes tracked leaves this bookkeeping on the next
 * re-check (without its token being dropped) — see
 * `RecheckAdoptedHookTokensOptions.isTracked`.
 */
const adoptedTokens = new Map<string, string>();

/** Why a candidate session's token was not registered. */
export type HookTokenSkipReason =
  /** The token file is missing, unreadable, or not a well-formed token. */
  | "malformed-token"
  /**
   * This host holds no live scope for that id — the scope is gone, OR it
   * belongs to a different Mullion instance (the scope backend answers
   * "dead" for both: a scope this instance does not own is not one of its
   * scopes, and ownership is resolved by the scope's socket path, never by
   * unit name).
   */
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
    // And the bookkeeping that lets a LATER re-check take this entry back
    // out if the scope dies (issue #3206) — see `recheckAdoptedHookTokens`
    // below.
    adoptedTokens.set(candidate.sessionId, candidate.token);
    result.registered.push(candidate.sessionId);
  }

  return result;
}

export interface RecheckAdoptedHookTokensOptions {
  /**
   * The host's scope backend's liveness answer for a set of ids — a TOTAL
   * map, so an id this instance cannot place is "unknown", never a missing
   * key (see `ScopeBackend.isAliveBatch`).
   *
   * The SAME question the boot sweep asked, asked again: on Linux that is
   * `listOwnedScopes` resolving ownership by the scope's dtach socket path
   * (never by unit name), on macOS the detached backend's probe of that
   * same socket.
   */
  isAliveBatch: (ids: string[]) => Promise<Record<string, ScopeLiveness>>;
  /**
   * Whether THIS PROCESS tracks `id` right now — i.e. whether the manager
   * holds a `Session` object for it.
   *
   * An id that BECAME tracked after the boot sweep is not ours to forget:
   * the manager rebuilt the session, registered the token itself (the token
   * FILE is reused verbatim, so it is the very same token the adoption
   * registered), and its own `kill()` path is what drops that token. A
   * re-check that forgot it here would unregister a LIVE session's token —
   * and a re-check tick can land inside the re-spawn window, where the
   * scope listing still answers "dead" for the scope that is being brought
   * back. So a tracked id leaves the bookkeeping here WITHOUT its token
   * being dropped.
   *
   * Optional: a caller that cannot tell keeps the older behaviour (the id
   * is treated as adopted). The agent boot path DOES pass it.
   */
  isTracked?: (id: string) => boolean;
}

export interface RecheckAdoptedHookTokensResult {
  /** The adopted ids whose token is no longer resolvable (their scope died). */
  forgotten: string[];
  /**
   * The adopted ids whose token is STILL resolvable — either their scope is
   * alive, or its liveness could not be confirmed ("unknown"), or this
   * process has since started TRACKING the session itself (the manager
   * owns that token now).
   */
  retained: string[];
}

/**
 * The ids this process ADOPTED at boot and has not dropped yet — the
 * bookkeeping `recheckAdoptedHookTokens` works on.
 *
 * Exported for the caller that has to report the outcome of a FAILED
 * re-check: nothing was forgotten, so every one of these ids still has its
 * token registered.
 */
export function adoptedHookTokenIds(): string[] {
  return [...adoptedTokens.keys()];
}

/**
 * Re-checks the liveness of every scope this process ADOPTED, and forgets
 * the token of an id whose scope is confirmed dead (issue #3206).
 *
 * The boot sweep is a snapshot; this is what keeps the invariant it leaves
 * behind true over time: "a dead scope's token is never accepted". The
 * adoption itself is still the only way a token for an untracked id gets
 * registered — this function can only ever REMOVE entries.
 *
 * **It fails CLOSED.** Only a confident "dead" drops a token. "unknown" —
 * a systemctl failure, an id this instance cannot place, a socket probe that
 * timed out — KEEPS it: the agent inside a scope that is merely unconfirmed
 * is exactly the party that presents the token, so treating "I don't know"
 * as "dead" would break the hooks of a live session over a transient error.
 * A liveness map that breaks its own TOTAL contract (an id missing from the
 * answer) is read as "unknown" for the same reason.
 *
 * **It is READ-ONLY towards the session.** It asks the scope backend for
 * liveness and forgets a token — nothing else. It never calls
 * `terminate()`/`stopScope()`, never respawns or reattaches anything, and
 * never touches a scope this host does not own: ownership stays resolved by
 * the scope's socket path, never by unit name (see
 * `ScopeBackend.isAliveBatch` and the ownership rules in
 * src/services/session-process.ts).
 *
 * **It never forgets a token this process TRACKS.** An adopted id can
 * become a tracked session later (the user re-opens it: the manager rebuilds
 * the `Session`, registers the token itself and spawns a fresh scope). From
 * that moment the manager's own `kill()` path owns the token, and the
 * re-check must keep its hands off it — including in the re-spawn window,
 * where the scope listing still answers "dead" for the scope that is coming
 * back. See `RecheckAdoptedHookTokensOptions.isTracked`.
 */
export async function recheckAdoptedHookTokens(
  opts: RecheckAdoptedHookTokensOptions,
): Promise<RecheckAdoptedHookTokensResult> {
  const result: RecheckAdoptedHookTokensResult = { forgotten: [], retained: [] };

  const ids = [...adoptedTokens.keys()];
  if (ids.length === 0) return result;

  const liveness = await opts.isAliveBatch(ids);

  for (const id of ids) {
    // An id THIS PROCESS TRACKS is the manager's business now, not ours:
    // it registered the token itself when it rebuilt the session, and its
    // `kill()` path is what drops that token. Forgetting it here would
    // unregister a LIVE session's token — and the check happens AFTER the
    // liveness answer came back, so it also covers an id that became
    // tracked WHILE the answer was in flight (the re-spawn window).
    if (opts.isTracked?.(id)) {
      adoptedTokens.delete(id);
      result.retained.push(id);
      continue;
    }
    // Only "dead" drops a token. Anything else — "alive", "unknown", or a
    // missing key from a backend that broke its own TOTAL contract — keeps
    // it registered.
    if (liveness[id] !== "dead") {
      result.retained.push(id);
      continue;
    }
    const token = adoptedTokens.get(id);
    if (token !== undefined) {
      // The registry is keyed by token, so the drop is by (token, id): it
      // only takes the entry out while it still belongs to THIS id.
      forgetHookToken(token, id);
      adoptedTokens.delete(id);
    }
    result.forgotten.push(id);
  }

  return result;
}
