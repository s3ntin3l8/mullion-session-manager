import { SERVER_ENV_KEYS } from "./session-env.js";

// Issue #822 — the reserved-key predicate shared by dock-config.ts's write
// path (throws on a reserved key), project-config.ts's read path (drops one
// leniently), and session-lifecycle.ts's createSessionRecord (throws on a
// reserved key for a DIRECT `POST /api/sessions` caller — dock-config.ts is
// not the only producer of a session's env, and a key reserved here is
// unconditionally reserved regardless of which one supplied it). One
// function, not independently-maintained lists per call site: a key
// reserved here is unconditionally reserved, regardless of whether
// MULLION_SSH_AUTH_SOCK happens to be configured on the host resolving this
// config — a dock control is per-project and may be read on a host with
// different config than the one that will eventually launch it.
//
// Hermes review, this PR — the original version of this comment claimed
// createSessionRecord's reserved-key check was unnecessary because
// "dock-config.ts is the one gate." That was wrong: a full-scope
// `POST /api/sessions` caller never goes through dock-config.ts at all, so
// its `env` reached launch-plan.ts's buildLaunchPlan completely
// unvalidated — silently re-introducing exactly the server-identity vars
// buildSessionEnv()'s scrub exists to strip (session-env.ts's SERVER_ENV_KEYS
// — PORT, DATABASE_URL, SESSIONS_DIR, DB_ENCRYPTION_KEY, the GIT_* keys,
// NODE_ENV, ...), since buildLaunchPlan only re-injects a handful of
// MULLION_*-prefixed keys after applying session.env, not the full list.
const VALID_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_SERVER_ENV_KEYS = new Set<string>(SERVER_ENV_KEYS);

export function isReservedSessionEnvKey(key: string): boolean {
  if (key.length === 0) return true;
  if (!VALID_ENV_KEY_PATTERN.test(key)) return true;
  if (key.startsWith("MULLION_")) return true;
  // SSH_AUTH_SOCK (issue #819) — the one non-MULLION_-prefixed var Mullion's
  // own launch-plan.ts conditionally injects. Reserved unconditionally, not
  // just when MULLION_SSH_AUTH_SOCK happens to be configured — see this
  // module's own header comment.
  if (key === "SSH_AUTH_SOCK") return true;
  // Every key buildSessionEnv() strips from the inherited process env
  // (session-env.ts) is reserved too — session.env is applied to a FRESH
  // copy of that scrubbed env, so an unvalidated caller-supplied key here
  // would re-introduce the exact leak the scrub exists to prevent, just
  // from a different source (issue #822, Hermes review).
  if (RESERVED_SERVER_ENV_KEYS.has(key)) return true;
  return false;
}
