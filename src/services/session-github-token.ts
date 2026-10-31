// The GitHub credential a session's own git/gh may use (issue #2246).
//
// Held in MEMORY only, keyed by session id, in whichever process owns the
// session: the primary for a local session, the agent for a remote one (the
// primary sends it over the signed /internal/* channel at launch and re-sends
// an App token before it expires). It is never written to `.git/config`, the
// session env or any file: the session asks for it over its own hook socket
// (hooks.ts `github_token`) each time git or gh needs it, and the handshake
// token on that socket is what limits a session to its own entry.

/** Who the session acts as (decides which credential wins, see below).
 * - `manual`: a session the user drives. The host's own credentials are tried
 *   first and Mullion's user-account token last, so activity shows as the user.
 * - `task`: a Task Master worker/reviewer. Mullion's token comes first (the
 *   helper chain is reset), so a host's ambient login can never be used. */
export type SessionGithubMode = "manual" | "task";

/** What travels primary -> host (spawn body / refresh route). */
export interface SessionGithubAuth {
  mode: SessionGithubMode;
  /** Absent when no token could be resolved; `hint` then says what to do. */
  token?: string;
  /** git's basic-auth username for the token. */
  username?: string;
  /** Epoch ms after which the token must not be served (App tokens, ~1h). */
  expiresAt?: number;
  /** Actionable message for a session with no token. */
  hint?: string;
}

/** Shown by the credential helper and the `gh` wrapper when a session has no
 * token, in place of hanging or falling through to a prompt. */
export const GITHUB_TOKEN_MISSING_HINT =
  "Mullion has no GitHub token for this session: connect GitHub in Mullion " +
  "Settings, or install the Mullion GitHub App on this repository.";

const EXPIRED_HINT =
  "Mullion's GitHub token for this session expired and has not been renewed " +
  "yet; retry in a moment (the primary re-sends it before it expires).";

const store = new Map<string, SessionGithubAuth>();

export function setSessionGithubAuth(sessionId: string, auth: SessionGithubAuth): void {
  // A session that ended without a terminate leaves its entry behind; expiry
  // is what bounds that, so prune here rather than run a timer.
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) store.delete(id);
  }
  store.set(sessionId, auth);
}

export function getSessionGithubAuth(sessionId: string): SessionGithubAuth | undefined {
  return store.get(sessionId);
}

export function dropSessionGithubAuth(sessionId: string): void {
  store.delete(sessionId);
}

export function clearSessionGithubAuthForTests(): void {
  store.clear();
}

/** The hook-socket reply for a `github_token` request. */
export type GithubTokenReply =
  | { token: string; username: string; hostFirst: boolean }
  // `hostFirst` rides along on an error too: a manual session with no Mullion
  // token may still use the host's own login, a task session never does.
  | { error: string; hostFirst: boolean };

export function buildGithubTokenReply(
  auth: SessionGithubAuth | undefined,
  now: number = Date.now(),
): GithubTokenReply {
  // No entry at all: the mode is unknown, so the safe answer (task) applies.
  if (!auth) return { error: GITHUB_TOKEN_MISSING_HINT, hostFirst: false };
  const hostFirst = auth.mode === "manual";
  if (!auth.token) return { error: auth.hint ?? GITHUB_TOKEN_MISSING_HINT, hostFirst };
  if (auth.expiresAt !== undefined && auth.expiresAt <= now) {
    return { error: EXPIRED_HINT, hostFirst };
  }
  return { token: auth.token, username: auth.username ?? "x-access-token", hostFirst };
}
