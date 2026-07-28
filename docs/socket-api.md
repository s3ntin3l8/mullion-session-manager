# Control socket API

Mullion's HTTP REST API (`/api/*`) requires a base URL and, when in-process
auth is enabled, a bearer token or session cookie. That's fine for the
frontend, but awkward for a host-local script or CLI that just wants to list
sessions, tail output, or drive the browser. Phase 4 adds a second,
general-purpose transport for exactly that: a Unix domain control socket.

**Every socket operation has an HTTP equivalent — the socket is not a
separate API, it's an alternative transport.** Internally, each
request/response op re-enters Fastify via `app.inject()` against the real
REST route, so it inherits the same validation, multi-host proxying, and
side effects the HTTP route already has.

This document covers the transport and handshake (Phase 4.1, #185). Session
lifecycle, PTY I/O, notification events, and browser-action ops are added by
later Phase 4 sub-issues and documented here as they land.

## Locating the socket

| Variable              | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `MULLION_SOCKET_PATH` | Absolute path override. Empty (the default) derives the path from `SESSIONS_DIR`. |

With no override, the socket lives at `<SESSIONS_DIR>/mullion.sock`,
alongside the existing hook socket (`<SESSIONS_DIR>/hooks.sock` — see
[`docs/agent-hooks.md`](agent-hooks.md)). `SESSIONS_DIR` defaults to
`./data/sessions` in a dev checkout and is overridden to an absolute path by
a versioned install (`deploy/install.sh`).

## Wire protocol

Newline-delimited JSON, UTF-8 encoded, 2 MiB max per line (large enough for a
base64'd screenshot or a scrollback replay chunk once those ops land).

### Handshake (line 1)

```json
{ "token": "<credential>" }
```

Two accepted credentials, each resolved via a constant-time comparison:

- **`MULLION_AUTH_TOKEN`** (the operator's own credential, when in-process
  auth is enabled) → **full scope**: every op is available.
- **A live session's own `MULLION_HOOK_TOKEN`** (the same value injected as
  `$MULLION_HOOK_TOKEN` into that session's shell — see
  [`docs/agent-hooks.md`](agent-hooks.md)) → **session scope**: the
  connection is pinned to that one session for its lifetime. This is what
  lets an agent running inside a Mullion session use ops that target "my own
  session" with no session id at all.

When in-process auth is disabled entirely (no `MULLION_AUTH_TOKEN` and no
OIDC configured), **every** handshake is accepted at **full scope** — not
just an empty one — the socket's `0600` filesystem permissions are the only
gate in that mode, the same posture the HTTP API already takes when auth is
off (a Bearer header presented when `MULLION_AUTH_TOKEN` is unset isn't
rejected either; the whole gate is simply absent). This is checked before
any token comparison, so a stale or forged token in this mode is never
treated worse than presenting no token at all.

Note: an OIDC-only deployment (OIDC configured, no `MULLION_AUTH_TOKEN`) has
no static full-scope secret to present here — only session-scoped
connections work. Set `MULLION_AUTH_TOKEN` (it can coexist with OIDC) to use
full-scope ops like `sessions.list` from a bare shell.

A failed handshake (malformed JSON, or a token matching neither principal)
closes the connection with no reply.

### Requests (after a successful handshake)

```jsonc
{ "id": 7, "op": "sessions.list" }
{ "id": 7, "ok": true, "status": 200, "result": [ /* ... */ ] }
```

```jsonc
{ "id": 8, "op": "sessions.list", "body": { "projectId": "3" } }
{ "id": 8, "ok": false, "status": 400, "error": "kind must be 'terminal' or 'dock'" }
```

- `id` — caller-chosen number, echoed back on the reply so a client can
  correlate concurrent in-flight requests.
- `op` — one of the ops below.
- `body` — optional object; for a GET-shaped op it's serialized as a query
  string, matching the REST route's own query parameters.

## Ops (Phase 4.1)

| Op              | Scope         | REST equivalent                       |
| --------------- | ------------- | ------------------------------------- |
| `ping`          | full, session | — (answered in-process, no REST call) |
| `sessions.list` | full          | `GET /api/sessions`                   |
| `projects.list` | full          | `GET /api/projects`                   |

A session-scoped connection invoking an op outside its allowed scopes gets
`{"ok":false,"status":403,"error":"not permitted for this connection's scope"}`.
An unrecognized `op` gets a `404`.

## Security notes

- The socket is created with mode `0600` — only the user Mullion runs as can
  connect at all.
- `MULLION_SOCKET_PATH` is injected into every spawned session (a later
  Phase 4 PR), the same env-leak class documented for the hook socket in
  [`docs/agent-hooks.md`](agent-hooks.md). This is exactly why session-scoped
  connections are restricted to a narrow, explicit op allowlist rather than
  inheriting the full-scope surface — see the per-op `scopes` table above,
  which grows as later PRs add ops.
- The minted auth cookie (`buildAuthHeaders` in `control-socket.ts`) carries
  no scope or session-id claim of its own — a session-scoped connection's
  op is authorized _before_ that cookie is ever minted, by the op table's
  `scopes` allowlist and, for any op that forwards into `app.inject()`, by
  an explicit `conn.scope === "full"` check inside `injectRoute()`. **Any
  future op that legitimately needs session-scoped REST access** (e.g.
  `sessions.get`/`attach`/`scrollback`, targeting one specific session) must
  NOT call `injectRoute()` unchanged — it needs its own explicit
  `body.sessionId === conn.sessionId` check first, the same way the op
  table's scope check is itself explicit rather than assumed. This is a
  hard invariant for anyone extending the `OPS` table, not just a
  suggestion.
- Every op dispatched via `app.inject()` is tagged with a sentinel
  `remoteAddress` so it's exempt from the app-wide HTTP rate limiter (a
  `mullion ps` polling loop would otherwise be throttled the same way a
  hostile HTTP client is) — see `src/services/control-socket-addr.ts`. The
  exemption is checked against the raw socket's `remoteAddress`, not
  Fastify's `request.ip`, so it stays correct even if a future PR enables
  `trustProxy` (which would otherwise let an external client forge the
  exemption via `X-Forwarded-For`).
- A connection that never completes its handshake is force-closed after 10
  seconds, and every open connection is destroyed (not just stopped from
  accepting new ones) on graceful shutdown — `server.close()` alone only
  affects new connections.
