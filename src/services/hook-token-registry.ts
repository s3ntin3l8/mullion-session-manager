import { timingSafeTokenMatch } from "./crypto-utils.js";

// The registry of hook tokens -> session ids, and the only lookup the hook
// socket handshake resolves against.
//
// MOVED out of `PtyManager` (issue #3166). It used to be one of that class's
// in-memory maps, which made two things impossible at once: a token for a
// session THIS PROCESS DOES NOT TRACK could not be registered (the map only
// ever learned about sessions `getOrCreate()` built, and a session that
// survived a restart is rebuilt by nobody on an agent host), and the class
// could not grow to hold the boot sweep that registers those tokens (the
// repo's file-size ratchet forbids that — see
// `scripts/check-max-file-lines.mjs`).
//
// The registry's lifetime is the PROCESS's, not one manager's, and that is
// the right scope: a session's hook token is a bearer secret for one session
// of one host, and a host runs one Mullion process (an agent host included).
// It is the same shape as the session GitHub credential store
// (`src/services/session-github-token.ts`), which is likewise process state
// keyed by a per-session secret.
//
// Deliberately resolved via a linear scan + `timingSafeTokenMatch` rather
// than a plain `Map.get(token)` — see the `Session.hookToken` field's own doc
// comment and `crypto-utils.ts` for why a constant-time compare matters even
// for an already-filesystem-scoped (0600) socket: the socket's OS access
// control is the first line of defense, this compare is the second.

/** Token -> session id, for every token this process accepts. */
const hookTokens = new Map<string, string>();

/**
 * Makes `token` resolve to `sessionId`.
 *
 * Called when a session is created (`PtyManager.getOrCreate`) and when a
 * surviving session's persisted token is re-registered at boot (issue #3166,
 * `src/services/hook-token-adopt.ts`).
 */
export function registerHookToken(token: string, sessionId: string): void {
  hookTokens.set(token, sessionId);
}

/**
 * Drops `token` — the session it belonged to is gone, so nothing may
 * present it again.
 *
 * Deliberately NOT called from `PtyManager.kill()`: that path also runs on
 * every graceful shutdown/redeploy, which is NOT terminal for the session —
 * the dtach master and the agent process inside it survive, still holding
 * that exact token in their environment (see kill()'s own doc comment, and
 * the persistence of the token to `<id>.token` that makes it survive).
 */
export function forgetHookToken(token: string): void {
  hookTokens.delete(token);
}

/**
 * Resolves a handshake token to the session id it belongs to, or undefined
 * when it matches nothing this process accepts (unknown, stale, or forged).
 */
export function resolveHookToken(token: string): string | undefined {
  for (const [candidate, id] of hookTokens) {
    // Issue #1059 — both sides are fixed-length (a minted token vs an
    // inbound bearer); same fixed-length assumption as auth.ts /
    // internal.ts — see crypto-utils.ts for the full constraint.
    if (timingSafeTokenMatch(token, candidate)) return id;
  }
  return undefined;
}
