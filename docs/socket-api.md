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
lifecycle ops (Phase 4.3, #187), PTY I/O streaming (Phase 4.2, #186),
notification events (Phase 4.4, #188), browser-action ops (Phase 4.5, #189),
and the persisted-history query op (Phase 4.7, #213).

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
even after base64 inflation (`SCROLLBACK_MAX_BYTES`, `scrollback-buffer.ts`). If a
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
  `attach`, `browser.action`/`find`/`bindings`), `body.sessionId` names it.
  `events.query`'s `body.sessionId` is different — a filter, not a required
  target (see its own section below).

## Ops

See [`docs/agent-guide.md`](agent-guide.md) (issue #405) for this same table
condensed for an in-session agent, alongside the scope caveats most likely
to trip one up (the auth-disabled full-scope-for-everyone mode in
particular).

| Op                     | Scope         | REST equivalent                       |
| ---------------------- | ------------- | ------------------------------------- |
| `ping`                 | full, session | — (answered in-process, no REST call) |
| `sessions.list`        | full          | `GET /api/sessions`                   |
| `sessions.get`         | full, session | `GET /api/sessions/:id`               |
| `sessions.create`      | full          | `POST /api/sessions`                  |
| `sessions.spawn_child` | full, session | `POST /api/sessions`                  |
| `sessions.kill`        | full          | `DELETE /api/sessions/:id`            |
| `sessions.rename`      | full, session | `PATCH /api/sessions/:id`             |
| `sessions.scrollback`  | full, session | `GET /api/sessions/:id/scrollback`    |
| `sessions.attach`      | full, session | stream — see below                    |
| `sessions.input`       | full, session | stream — see below                    |
| `sessions.resize`      | full, session | stream — see below                    |
| `sessions.detach`      | full, session | stream — see below                    |
| `events.subscribe`     | full, session | stream — see below                    |
| `events.seen`          | full, session | stream — see below                    |
| `events.unsubscribe`   | full, session | stream — see below                    |
| `events.query`         | full, session | `GET /api/events`                     |
| `browser.action`       | full, session | `POST /api/sessions/:id/browser`      |
| `browser.find`         | full, session | `POST /api/sessions/:id/browser/find` |
| `browser.bindings`     | full, session | `GET /api/sessions/:id/browser`       |
| `projects.list`        | full          | `GET /api/projects`                   |
| `projects.actions`     | full, session | `GET /api/projects/:id/actions`       |
| `projects.dock`        | full          | `GET /api/projects/:id/dock`          |
| `previews.create`      | full          | `POST /api/previews`                  |
| `previews.get`         | full          | `GET /api/previews/:slug`             |
| `previews.delete`      | full          | `DELETE /api/previews/:slug`          |
| `previews.list`        | full          | `GET /api/previews`                   |
| `agents.list`          | full          | `GET /api/agents`                     |

`events.query` (issue #213, roadmap 4.7) is a one-shot request/response query
over the _persisted_ `session_events` table — distinct from `events.subscribe`
above, which is a live push feed of the in-memory ring buffer only. Full
scope may pass `body.sessionId` to scope the query to one session, or omit it
entirely to query every session; session scope may omit it (defaulting to
its own pinned session) or pass that same id explicitly, but never a
different one — same isolation `events.subscribe`'s own `sessionIdFilter`
already enforces, not a new mechanism. Also takes `body.kind`/`since`/
`until`/`limit`/`cursor`, forwarded straight through to `GET /api/events`'s
own query parameters (see below). **Fleet-wide**: covers every enrolled
host's events, not just this process's own PtyManager — see
`src/plugins/event-store.ts`'s doc comment for how
`remote-event-subscriber.ts` captures a remote host's events independent of
any browser tab being open. When `sessions.eventPersistence` is off, the
response is `{"persistenceEnabled":false,"events":[],"nextCursor":null}`,
never an error — that flag is what lets a caller tell "no history because
persistence is off" apart from "no history because nothing happened yet."

`projects.actions` targets a project the same way session-targeted ops target
a session: full scope must pass `body.projectId` explicitly; session scope
may omit it, defaulting to the connection's own pinned session's project
(400 if that session has no associated project). `projects.dock` is full
scope only and always requires `body.projectId` — dock controls are an
operator-facing concept, not something an agent inside a session needs to
introspect about itself. Its response array (issue #73) may include entries
with `source: "docker"` and a `docker: {...}` payload — a discovered
Compose service, synthesized alongside `.crs/dock.json`'s own controls; see
`docs/dock.md`'s "Docker Compose services" section for the full shape. This
is transparent to every existing consumer of this op: the MCP
`start_dock_session` tool and `mullion dock start` both resolve a control to
start purely by `id` off this same list, so they start a compose log
monitor with no code change on their side. `previews.get`/`.delete` take
`body.slug`.
`previews.list` takes no body and returns every preview registered on the
host — previews are host-global (no session/user scoping column exists on
the table), which is also why this op is full-scope only: a session-scoped
connection listing all previews would leak every external preview's URL to
whichever session happens to hold a hook token.

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
Optional `body.cascade` (`"detach"` default, or `"kill"`) governs the target
session's own LIVE children, if any: `"detach"` lets them survive as
independent top-level sessions (the `sessions.parentSessionId` FK's own
`ON DELETE SET NULL` behavior), `"kill"` recurses one level to kill them too
(nesting is capped at one level, so this never recurses further).

**`sessions.spawn_child`** (Phase 5, issue #193 5.3b) is the narrow
exception to "`sessions.create` is full scope only" — it creates a REAL
child session (own PTY, own dtach socket) of a specific parent, and is
reachable at **session scope**: an agent inside a session may spawn a child
OF ITSELF (never of an unrelated session) by calling
`{"op":"sessions.spawn_child","body":{"command":"claude"}}` with no
`parentSessionId` at all — it defaults to, and can never be overridden away
from, the connection's own pinned session. Full scope must instead pass
`body.parentSessionId` explicitly (there's no pinned session to default to).
`body.projectId` is never read from the caller in either scope — it's always
derived server-side from the resolved parent session's own project, via a
real `GET /api/sessions/:id`, never trusted from the request. The rest of
`body` (`command` required; optional `name`/`cwd`/`kind`/`skipPermissions`/
`env`) maps onto `POST /api/sessions`; `worktree`/`worktreeRefresh` are
stripped even if present, since a child spawn's cwd-containment check assumes
no worktree was requested. **`kind`, `skipPermissions`, and `env` are
additionally stripped for a SESSION-scoped caller** (`kind`/`skipPermissions`:
independent review, PR #426; `env`: issue #822): all three are
privilege-adjacent — `skipPermissions` disables permission prompts,
`kind:"dock"` hides the child from the normal per-project session list, and
`env` lets the caller inject arbitrary child-process environment — and a
session-scoped connection's hook token is inherited by every subprocess an
agent spawns, so letting it set any of the three would let an
already-compromised or merely misbehaving subprocess grant itself a
strictly more privileged, less visible, or differently-configured session
than its own. Full scope keeps all three, matching `sessions.create`'s own
behavior for that scope.
Server-side validation (not just this op's own scope check) additionally
enforces: the parent must be in the target project (always true here,
since the project IS derived from the parent), the parent must not itself
be a child (one level of nesting only), `cwd` must resolve inside the
project directory, and a hard cap on that parent's LIVE children
(`settings.sessions.maxChildSessionsPerParent`, default 5, checked and the
new row inserted inside one transaction so concurrent spawns can't both
slip past the same check) — each violation is a clean 4xx (`400` for the
first three, `429` for the cap), never a `500`. The cap bounds the worst
case (every child staying busy at once) but not a sustained low-rate abuse
pattern (spawn to the cap, wait for a child to exit, spawn again) — a rate
limiter would be the real fix for that, tracked as a follow-up. Every spawn
is logged (`app.log.info`) regardless of scope.

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

**Backpressure (`bufferedAmount`) is tracked per stream, not per connection.**
One underlying socket can multiplex several `sessions.attach` streams at
once, and a naive `net.Socket.writableLength` reading reflects the whole
connection's outstanding writes — under that, one chatty session's output
would throttle an unrelated session multiplexed on the same connection. Each
stream instead tracks its own queued-but-not-yet-flushed byte count (updated
from the underlying write's own completion callback), so `bufferedAmount` is
a real signal for that one stream alone, matching the isolation a client
would get from one WebSocket per session.

## Notification events stream (`events.subscribe`/`seen`/`unsubscribe`)

The socket counterpart to `/ws/events` (issue #166): one multiplexed stream
per `events.subscribe`, replaying every already-buffered
[`NotificationEvent`](../src/services/pty-manager.ts) on connect and then
pushing new ones live, exactly like the WS route.

```jsonc
{ "id": 11, "op": "events.subscribe" }
{ "id": 11, "seq": 3, "sessionId": 42, "kind": "attention", "ts": 172..., "payload": { /* ... */ } }
{ "id": 11, "ok": true, "status": 200 }
{ "id": 11, "seq": 4, "sessionId": 42, "kind": "title_change", "ts": 172..., "payload": { "title": "done" } }
{ "id": 11, "op": "events.seen", "body": { "sessionId": 42, "seq": 4 } }
{ "id": 11, "op": "events.unsubscribe" }
{ "id": 11, "ok": true, "status": 200 }
```

- **`events.subscribe`** takes no `body`. **Unlike `sessions.attach`, this
  DOES send an explicit `{"ok":true,"status":200}` ack** — a
  `sessions.attach` success is implied by its scrollback replay frame, which
  is unconditionally non-empty; an events replay batch can genuinely be
  empty (an idle system with nothing buffered yet), so there's no data frame
  guaranteed to arrive that could serve as an implicit signal instead. The
  ack is sent AFTER attaching, which flushes any already-buffered replay
  events first — so a client can rely on: everything received on this `id`
  before the ack is replay, everything after is live. Subscribing twice on
  the same `id` without an intervening `unsubscribe` gets a `400`, same as
  `sessions.attach`.
- **Event frames carry no `type` field** — unlike every other unsolicited
  frame on this socket (`{"type":"data"}`, `{"type":"exited"}`,
  `{"type":"closed"}`), an event frame is the `NotificationEvent` object
  itself with `id` merged in: `{id, seq, sessionId, kind, ts, payload}`.
  `kind` is that object's own discriminator (`"attention"`,
  `"title_change"`, etc.) and is **not** renamed to `type` — do not
  normalize this; a client recognizes an event frame by the presence of
  `seq`/`kind` rather than a generic `type` tag.
- **`events.seen`** — `body.sessionId`/`body.seq` (both required, finite
  numbers) forwards a read-cursor update for one session, exactly the
  `{"type":"seen",...}` message a real `/ws/events` browser connection
  already sends over the same channel. Silent on success (acking every
  cursor update would be as much of a reply flood as acking every
  `sessions.input` keystroke); errors still reply.
- **`events.unsubscribe`** — ends this one stream; replies
  `{"ok":true,"status":200}` on success (no follow-up frame implies it, so
  unlike `sessions.input`/`resize` an explicit ack is needed here too).

**Session scope is filtered, full scope is the full aggregate.** A
session-scoped connection's `events.subscribe` only ever replays/streams
events belonging to its own pinned session, and an `events.seen` naming a
different session is silently ignored (there is nothing to have corrupted,
since that other session's events were never delivered to this connection
in the first place) — the same isolation `resolveTargetSessionId` gives the
request/response ops. A full-scope `events.subscribe` gets the complete,
unfiltered aggregate across every session, local and remote-hosted alike
(the same multi-host relay `/ws/events` itself uses) — there is currently no
way for a full-scope connection to filter down to one session's events via
this op; use `sessions.get`'s own polling shape, or a session-scoped
connection, for that.

## Browser automation ops (`browser.action`/`find`/`bindings`)

See [browser-automation.md](browser-automation.md) for the full action set
and REST equivalents; this section covers only the socket transport.

Request/response, not streams — a single `browser.action` call already
returns a full snapshot/console/errors envelope in one shot (same as
`POST /api/sessions/:id/browser` itself), so there's nothing here that needs
multiplexing the way PTY output or the events feed does.

```jsonc
{ "id": 20, "op": "browser.action", "body": { "sessionId": 42, "action": "navigate", "url": "https://example.com" } }
{ "id": 20, "ok": true, "status": 200, "result": { "ok": true, "url": "https://example.com", "title": "Example", "snapshot": { /* ... */ }, "console": [], "errors": [] } }

{ "id": 21, "op": "browser.find", "body": { "sessionId": 42, "by": "text", "value": "Sign in" } }
{ "id": 21, "ok": true, "status": 200, "result": { "ok": true, "matchCount": 1, "elements": [ /* ... */ ] } }

{ "id": 22, "op": "browser.bindings", "body": { "sessionId": 42 } }
{ "id": 22, "ok": true, "status": 200, "result": [ /* browser pane bindings */ ] }
```

- **`browser.action`** — `body` is `AgentAction`
  (`src/routes/browser-automation.ts`) plus `body.sessionId` targeting the
  session, following the exact same rules as `sessions.get`/`scrollback`/
  `rename`/`attach` (omit at session scope to default to the connection's
  own pinned session; a full-scope connection must supply it explicitly).
  `sessionId` is stripped before forwarding — the REST route's own schema
  has no such field, only the action body it already expects. Every one of
  the REST route's 19 actions (`navigate`, `snapshot`, `click`, `fill`,
  `eval`, `screenshot`, `press`, `type`, `select`, `check`, `uncheck`,
  `wait`, `dialog`, `hover`, `scroll`, `get`, `console`, `errors`,
  `download`) works unchanged — this op is a pure transport, not a
  reimplementation. `body` may also include `frame` (issue #382) — a CSS
  selector scoping the action to an iframe's own document; see
  `docs/browser-automation.md`. `download` (issue #381) returns a `path`
  naming a file on whichever host actually ran the browser — meaningless to
  a caller connected to a different host's socket; use `contents` (base64)
  instead when the connection isn't necessarily local to that host.
- **`browser.find`** — same target-id rules; `body`'s remaining fields
  (`by`/`value`/`name`/`limit`/`frame`) are `FindElementsBody` verbatim.
- **`browser.bindings`** — read-only inspect of which browser pane(s) a
  session is bound to; no body fields beyond `sessionId`. Unlike
  `action`/`find`, its REST route (`GET /api/sessions/:id/browser`) is a
  plain local DB read — no `BROWSER_ENABLED` gate and no multi-host
  proxying, since a session's browser-pane bindings are recorded
  independently of whether a Playwright instance is actually running.

Errors (an unknown/killed session, an invalid action, or — for
`action`/`find` specifically — `BROWSER_ENABLED` off) come back shaped
exactly like every other op's error reply —
`{"ok":false,"status":...,"error":...}` — since these dispatch through the
same `injectAndShape()` every other session-targeted op uses.

**`eval` is arbitrary in-page JavaScript execution** — the control socket
adds no restriction beyond what `POST /api/sessions/:id/browser` itself
already allows an authenticated caller to do; see that route's own doc
comment for the trust-boundary reasoning (same tier as shell access through
a terminal session, scoped to whatever the browser can reach).

## Security notes

- The socket is created with mode `0600` — only the user Mullion runs as can
  connect at all. Verified against the real on-disk mode (not just ajv/unit
  coverage) in
  [`test/e2e/control-socket.e2e.test.ts`](../test/e2e/control-socket.e2e.test.ts)
  (`make test-e2e`, opt-in — see [`test/e2e/README.md`](../test/e2e/README.md)).
- `MULLION_SOCKET_PATH` is injected into every spawned session, the same
  env-leak class documented for the hook socket in
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
- `events.subscribe` streams share that same per-connection `openChannels`
  map with `sessions.attach` streams (keyed by the same request `id`
  namespace) — reusing an `id` that's already open for the other kind of
  stream gets the same `400` `sessions.attach` gets for a duplicate attach,
  rather than silently overwriting it.
