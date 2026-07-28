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

This document covers the transport and handshake (Phase 4.1, #185), session
lifecycle ops (Phase 4.3, #187), and PTY I/O streaming (Phase 4.2, #186).
Notification events and browser-action ops are added by later Phase 4
sub-issues and documented here as they land.

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
base64'd screenshot or a scrollback replay chunk once those ops land). This
cap is enforced on **inbound** lines only — nothing today caps an outbound
frame's size, since scrollback and PTY-output frames stay well under 2 MiB
even after base64 inflation (`SCROLLBACK_MAX_BYTES`, `pty-manager.ts`). If a
future op's outbound payload could exceed that, a symmetric outbound cap
(and a defined behavior for exceeding it) would need to be added then — it
isn't a gap this PR needs to close.

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
  correlate concurrent in-flight requests. For a streaming op (below), `id`
  additionally names the stream itself: every subsequent message belonging
  to that stream (`sessions.input`/`resize`/`detach`) reuses the same `id`
  that opened it.
- `op` — one of the ops below.
- `body` — optional object; for a GET-shaped op it's serialized as a query
  string, matching the REST route's own query parameters. For an op that
  targets one specific session (`sessions.get`/`scrollback`/`rename`/`kill`/
  `attach`), `body.sessionId` names it.

## Ops

| Op                    | Scope         | REST equivalent                       |
| --------------------- | ------------- | ------------------------------------- |
| `ping`                | full, session | — (answered in-process, no REST call) |
| `sessions.list`       | full          | `GET /api/sessions`                   |
| `sessions.get`        | full, session | `GET /api/sessions/:id`               |
| `sessions.create`     | full          | `POST /api/sessions`                  |
| `sessions.kill`       | full          | `DELETE /api/sessions/:id`            |
| `sessions.rename`     | full, session | `PATCH /api/sessions/:id`             |
| `sessions.scrollback` | full, session | `GET /api/sessions/:id/scrollback`    |
| `sessions.attach`     | full, session | stream — see below                    |
| `sessions.input`      | full, session | stream — see below                    |
| `sessions.resize`     | full, session | stream — see below                    |
| `sessions.detach`     | full, session | stream — see below                    |
| `projects.list`       | full          | `GET /api/projects`                   |

**Session-targeted ops** (`sessions.get`/`scrollback`/`rename`) work
differently depending on scope:

- **Full scope** must pass `body.sessionId` explicitly — a full-scope
  connection has no session of its own to default to. Omitting it gets a
  `400`.
- **Session scope** may omit `body.sessionId` entirely, defaulting to the
  connection's own pinned session — this is what lets an agent inside a
  session say `{"op":"sessions.get"}` with no target at all. Naming a
  _different_ session id gets a `403`, never a silent redirect to its own.

`sessions.create` and `sessions.kill` are **full scope only** — deliberately:
an agent inside a session has no business spawning an unrelated session, and
a session may not kill itself (or any other session) through this socket.
`body.sessionId` is required for `sessions.kill` (there's no implicit self).

A session-scoped connection invoking an op outside its allowed scopes, or
naming a session id it isn't pinned to, gets
`{"ok":false,"status":403,"error":"..."}`. An unrecognized `op` gets a `404`.

## PTY I/O streams (`sessions.attach`/`input`/`resize`/`detach`)

One connection can multiplex several concurrent PTY streams — `id` (the
same request-correlation number every op uses) is the stream key. A client
opens a stream with `sessions.attach`, then reuses that stream's `id` for
every `sessions.input`/`sessions.resize`/`sessions.detach` addressing it:

```jsonc
{ "id": 9, "op": "sessions.attach", "body": { "sessionId": 42, "cols": 120, "rows": 40 } }
{ "id": 9, "type": "data", "b64": "G1s…" }              // server→client, scrollback replay, then live output
{ "id": 9, "op": "sessions.input", "body": { "b64": "bHM=" } }   // client→server keystrokes
{ "id": 9, "op": "sessions.resize", "body": { "cols": 100, "rows": 30 } }
{ "id": 9, "type": "exited" }                            // server→client, the program exited
{ "id": 9, "op": "sessions.detach" }
{ "id": 9, "ok": true, "status": 200 }
```

- **`sessions.attach`** — `body.sessionId` follows the same rules as
  `sessions.get`/`scrollback`/`rename` (omit at session scope to attach to
  the connection's own pinned session; a full-scope connection must supply
  it). `body.cols`/`body.rows` default to `80`/`24` when omitted, matching
  `/ws/terminal`'s own query-param defaults. A killed, exited, or unknown
  session id gets an error reply (`{"ok":false,"status":...}`); attaching
  twice on the same `id` without an intervening `detach` gets a `400`.

  **There is no separate success acknowledgment.** The scrollback replay —
  an unsolicited `{id,type:"data",b64}` frame — is written synchronously as
  part of handling the attach, before any ack could be sent, and it's
  unconditional (the synthesized alt-screen preamble is never actually
  empty, even for a session with no real output yet). That first data frame
  on the stream's `id` **is** the success signal. Only a failed attach gets
  a `reply()` on this `id`.

- **`sessions.input`** — `body.b64` (required) is base64-decoded and written
  to the PTY as raw keystrokes, exactly like a WS binary frame. Silent on
  success (acking every keystroke would flood an interactive session); an
  unknown/closed stream `id` or a missing `b64` still gets an error reply.
- **`sessions.resize`** — `body.cols`/`body.rows` (both required numbers).
  Silent on success, same posture as `sessions.input`.
- **`sessions.detach`** — ends this one stream only; the underlying
  connection and any other stream multiplexed on it are untouched, and the
  session itself is **not** killed (matching `/ws/terminal`'s own "socket
  close ≠ session death" behavior — use `sessions.kill` for that). Unlike
  `input`/`resize`, this one does reply `{"ok":true,"status":200}` on
  success, since there's no follow-up data frame to imply it. Closing the
  whole connection (dropping it without an explicit `detach` first) closes
  every stream still open on it.

**A stream can also end without an explicit `sessions.detach`** — most
notably, a multi-host session's attach is proxied to the owning agent host
(`proxyToRemoteAttach`), and that upstream connection can itself fail
(agent restart, network error) at any point after the attach succeeded, with
no request/response op involved. When that happens, the server writes an
unsolicited `{"id":<stream id>,"type":"closed"}` frame — the same signal a
client should treat as "this stream is gone, `sessions.attach` again (or
give up)". This frame is never sent for a `sessions.detach`-initiated close
(that op's own `{"ok":true}"` reply already says so) or when the whole
connection is dropping (there's no one left to write to).

Both request/response ops (`sessions.get`, etc.) and these streaming ops
dispatch through the same `resolveTargetSessionId()` authorization used
everywhere else on this socket — a session-scoped connection can never
`attach` to, or otherwise address, a session other than the one it's pinned
to.

**Reusing an in-flight stream `id` for an unrelated request/response op is
protocol misuse, not a supported pattern.** E.g. sending
`{"id":5,"op":"sessions.get"}` while stream `id=5` is still open from an
earlier `sessions.attach` produces a reply indistinguishable on the wire
from that stream's own data frames (both lack any envelope beyond
`type` vs. `ok`) — a well-behaved client picks a request `id` for each
concurrent op the same way it already must for concurrent request/response
calls, and never overloads a currently-open stream's `id` for anything
other than that stream's own `input`/`resize`/`detach`.

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
  no scope or session-id claim of its own — authorization happens entirely
  before that cookie is ever minted. Full-scope-only ops (`sessions.list`,
  `sessions.create`, `sessions.kill`, `projects.list`) go through
  `injectRoute()`, which hard-fails any connection that isn't `scope ===
"full"`. Ops reachable at both scopes (`sessions.get`/`scrollback`/`rename`)
  instead call `resolveTargetSessionId()` first — which resolves and
  authorizes the _target_ session id (defaulting to the connection's own pin
  at session scope, rejecting a mismatched one) — and only then call
  `injectAndShape()` directly. **Any new op that needs session-scoped REST
  access must follow this second pattern**, not call `injectRoute()`
  unchanged; that function's own doc comment states this as a hard
  invariant, not a suggestion.
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
- `sessions.attach`'s open streams (`conn.openChannels`) are scoped to the
  connection that opened them, never shared or looked up globally — a
  session-scoped connection can only ever `input`/`resize`/`detach` a stream
  it opened itself (attach itself already enforced the session pin via
  `resolveTargetSessionId`). Dropping the whole connection without an
  explicit `detach` first closes every stream still open on it, the same way
  a real WebSocket's own `close` event would.
