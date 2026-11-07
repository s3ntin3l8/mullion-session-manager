// The bounds the agent-side attach path and the session routes share.
//
// They live here, in a module with no dependencies at all, because the
// canonical home (session-lifecycle.ts) pulls in the primary's DB schema and
// the agent-side schema file (routes/internal-schemas.ts) has no business
// importing that for two numeric bounds — so the two were DUPLICATED,
// "kept in sync by hand", which is exactly the drift the constants' own
// comment below claims to prevent. This module has no DB dependency, so
// there is one copy now.
//
// Issue #822 — the bounds are shared between routes/sessions.ts's `env`
// schema property, the agent-side spawn schema in
// routes/internal-schemas.ts, and services/dock-config.ts's own env
// validation, so "how much env is too much" has one answer regardless of
// which write path a caller used. Not a security boundary (a full-scope
// caller can already achieve an arbitrary env var via `command` composition,
// e.g. `FOO=bar claude`) — the real constraint is transport, not intent:
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

// A session id is always the primary's stringified integer row id
// (String(sessionId) — see terminal.ts/sessions.ts) by construction, but
// this pattern is the agent's only defense against a malformed one: it
// flows straight into pty-manager.ts's scopeUnitName(instanceId, id) ->
// `crs-session-<instanceId>-<id>`, naming a real systemd --user scope and
// dtach socket file. An id with systemd- or filesystem-illegal characters
// (e.g. "/") wouldn't be an injection (spawn/stop always use an argv
// array, never a shell string), but would make bootstrap/terminate
// silently target the wrong unit/file.
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
