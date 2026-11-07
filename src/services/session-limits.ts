// The bounds the agent-side attach path and the session routes share.
//
// They live here, in a module with no dependencies at all, because three
// different callers need them and none of them should have to import a
// heavy module (or a route) to get two numbers:
//
//   - src/routes/sessions.ts's `env` schema property,
//   - src/routes/internal-schemas.ts's agent-side spawn schema, and
//   - src/services/session-lifecycle.ts's own session spawn.
//
// The env bounds used to be DUPLICATED between session-lifecycle.ts and
// internal-schemas.ts — "kept in sync by hand" — which is exactly the drift
// the comment on the constants claims to prevent ("so 'how much env is too
// much' has one answer regardless of which write path a caller used"). The
// duplication existed only because the canonical home pulled in the primary's
// DB schema; this module has no DB dependency, so there is no reason for it
// any more.
//
// Issue #822 — bounds shared between routes/sessions.ts's `env` schema
// property, routes/internal-schemas.ts's duplicate for the agent-side
// spawn schema, and services/dock-config.ts's own env validation, so "how
// much env is too much" has one answer regardless of which write path a
// caller used. Not a security boundary (a full-scope caller can already
// achieve an arbitrary env var via `command` composition, e.g. `FOO=bar
// claude`) — the real constraint is transport, not intent:
// remote-host-client.ts's openAttach() has nowhere to put `env` but the WS
// upgrade's query string (a GET has no body, and the `ws` package exposes
// no custom-body-on-upgrade option), which shares Node's 16 KB
// --max-http-header-size with the request line, the Bearer token, and the
// three HMAC signature headers. A worst-case env at these bounds
// JSON-stringifies to ~4.2 KB and, after URLSearchParams percent-encoding
// (the dominant multiplier — `{`, `}`, `"`, `:`, `,` all escape to 3 bytes
// each), lands the full request target at ~4.6 KB — comfortably clear of
// the limit even alongside the other query params and auth headers. Do not
// raise these without recomputing that encoded size (see the PR that added
// this comment for the calculation) — the old 64×4096 bound encoded to
// ~263 KB, well past --max-http-header-size, the moment a dock control
// actually used a meaningful chunk of it. (Untested what Node/`ws` actually
// do past the limit — a rejected upgrade or a hang, take your pick — the
// point of this bound is staying clear of it, not characterizing the
// failure.)
export const MAX_SESSION_ENV_ENTRIES = 16;
export const MAX_SESSION_ENV_VALUE_LENGTH = 256;

/** A session id is always the primary's stringified integer row id
 * (String(sessionId) — see terminal.ts/sessions.ts) by construction, but
 * writes it as a string, and an array, never a shell string), but would
 * make bootstrap/terminate silently target the wrong unit/file. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
