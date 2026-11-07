# Outbound agent channel (transport contract)

Issue #2450, epic #2230. Enrollment is agent-initiated, but ongoing control
still dials the agent's advertised address (`src/services/remote-host-client.ts`),
which needs inbound reachability on laptops. This channel is the transport
seam that lets the **agent dial the primary** instead. Since #2451 it carries
the primary's **request/response** operations (below); since #2571 also the four
**streams** (attach, events, control relay, ssh-agent). #2572 drops the
advertised URL.

## Endpoint and handshake

`GET /ws/agent-channel` on the primary (`src/routes/agent-channel.ts`), exempt
from the normal auth gate like `/ws/agent-bridge` because the agent holds the
machine credential (#2568), not `MULLION_AUTH_TOKEN`. Wire constants and frame
types live in `src/shared/agent-channel.ts`.

1. The agent opens the WebSocket and sends, within 10 s, one JSON text frame:
   `{"type":"auth","hostId","credential","protocol":{protocolVersion,operations,launchOptions}}`.
   `protocol` is exactly what the agent serves on `GET /internal/protocol`.
2. The primary replies `{"type":"ready","hostId","protocolVersion","negotiatedOperations","carriedOperations"}`
   or `{"type":"error","code","message"}` and closes.
   - `negotiatedOperations`: operations both ends know (support, not use).
   - `carriedOperations`: operations actually carried by this channel.
     `channel-requests` and/or `channel-streams` for each one both ends
     negotiated (an agent advertises them when it can serve the tunnels below),
     otherwise `[]`. Nothing may claim an operation earlier than its migration.
3. Error codes: `bad-handshake`, `invalid-credential`, `revoked`,
   `incompatible-protocol`. The credential is checked first, so an
   unauthenticated peer learns nothing about protocol support.
4. After `ready` the socket carries the binary mux of
   `src/services/ssh-agent-mux.ts`. The primary is the "even" side, the agent
   (the dialer) the "odd" side. Peer-initiated channels are refused for now.

## Request/response operations (#2451)

Every `RemoteHostClient` call that goes through `request()` (JSON calls, the
session upload and the update calls included) rides the channel when the host
negotiated `channel-requests`. The primary opens one mux channel per request and
sends a head line (JSON + `\n`: `method`, `path`, `headers`), the raw body and
EOF; the agent answers a head line (`status`, `headers`), the raw body and EOF.
The agent **does not reimplement anything**: it replays the request into its own
Fastify instance (`app.inject`), so each `/internal/*` route, its validation and
its authorization are the ones the inbound transport runs. The differences:

- **Credential.** The channel was authenticated by the machine credential and is
  bound to one host id, so the primary can only reach a host over _that host's_
  channel. The replay presents a per-process random token
  (`x-mullion-channel-auth`) that `routes/internal.ts` accepts instead of the
  bearer + signature; the peer cannot choose it (the agent overwrites that
  header and forwards nothing but `content-type`, `accept` and `x-mullion-*`).
  Per-session authorization stays where it was (the primary's routes, the
  agent's session lookups).
- **Only the agent API.** Paths must start with `/internal/`, are validated
  and percent-decoded, and may not contain double-encoded segments, undecodable
  sequences, dot segments, control characters, or `/internal/ws/`; anything else
  is answered 400 without being replayed.
- **Timeouts and body limits.** Timeouts are the same per-call budgets as inbound
  and cover opening the channel, sending and the full response. Bodies default
  to 2 MiB for requests and 8 MiB for responses (`AGENT_CHANNEL_DEFAULT_MAX_REQUEST_BYTES`,
  `AGENT_CHANNEL_DEFAULT_MAX_RESPONSE_BYTES`), with explicit overrides up to 64 MiB
  for operations like `/internal/uploads` and `/internal/project-files/{upload,write}`.
- **Errors keep their meaning.** A 4xx from the agent is a rejection
  (`HostRequestError`); a 5xx or a transport failure is `HostUnreachableError`.
  When all 64 outbound channel slots are busy, callers queue up to 5 seconds
  (`AGENT_CHANNEL_SLOT_WAIT_MS`) before failing with `HostBusyError`,
  which callers treat as retryable rather than marking the host unreachable.
  The health ping keeps busy apart (`RemoteHostClient.probe()` returns `ok`,
  `busy` or `down`): a busy sweep records neither success nor failure, so a
  saturated channel does not trigger the recovery rescan and does not hide a
  host that then stops answering. The heartbeat counts consecutive busy sweeps
  and, at `DEGRADED_AFTER_BUSY` (3), marks the host degraded with the reason
  "channel saturated" (`healthReason` on `GET /api/hosts`). Any `ok` or `down`
  result resets the count. `ping()` stays a boolean (busy is true) for the
  Settings "Test connection" button; it is a prototype method (not a class
  property) so `vi.spyOn(RemoteHostClient.prototype, "ping")` works. The
  Settings host row and `HostStatusLabel` show `healthReason` in place of
  "missed a ping".

Since #2620 the same exchange also carries the file-browser transfers
(`uploadProjectFile` / `downloadProjectFile`, with a streamed request body and a
streamed response body, under an idle timeout) and the HTTP preview forward
(`/internal/preview/:port/*`, `/internal/configured-preview`). For the preview
paths the agent replays all of the browser's request headers except `host`,
framing, `authorization`, the request-signature headers and `x-mullion-*`, and
answers with all response headers (a repeated `set-cookie` is an array); the
other paths keep the narrow `content-type`/`accept`/`x-mullion-*` set and a
`content-type`-only answer, plus `content-length` where the response has one. The
health ping is `GET /internal/protocol` over the channel, not `/health`. The
browser WebSocket stays on the inbound transport.

## Streams (#2571)

Every stream opener passes `{ stream: true }` to `openChannel`: the attach and
events streams, the control relay (both ends), the ssh-agent fan-out and each
per-SSH-connection ssh-agent session channel. The mux counts streams
separately from requests: a stream counter is incremented on a stream open and
released on close (or a failed open), and `AGENT_CHANNEL_MAX_STREAM_CHANNELS` (32)
applies to that counter only. A stream open that has to queue because the total
is full keeps its flag: queued stream opens count against the cap while they
wait, so the cap cannot be exceeded by a burst of queued opens, and a stream
open over the cap is refused at once, never queued.

Preview responses (`previewHttpOverChannel`, `{ preview: true }`) and preview
WebSockets (the `preview` and `configured-preview` stream kinds, e.g. Vite HMR,
opened by `openChannelStream` with `{ preview: true }`) are a stream
subclass with their own, smaller budget: `AGENT_CHANNEL_MAX_PREVIEW_CHANNELS`
(a quarter of the stream slots, 8). A page loading many modules in parallel or a
few open SSE previews therefore cannot starve attach, events, control-relay and
ssh-agent streams. A preview past its cap fails as `HostBusyError`, which the
preview proxy answers with `503` and `Retry-After` (a preview WebSocket past
the cap is refused at the open). A 413 for an over-limit _request_ body is
passed through as 413; a dev-server _response_ that outgrows the channel limit
(`HostResponseTooLargeError`, the agent's marked 413) is a `502`, since it is
the upstream's doing; other failures stay `502`. A response that fails after its
head went out resets the browser connection (the relay sets
`transfer-encoding: chunked` so an abort is not mistaken for a close-delimited
end). In-flight requests and peer-opened channels no
longer eat stream slots, and 32 open streams still leave
`AGENT_CHANNEL_REQUEST_RESERVED_CHANNELS` (32) free for requests.

Terminal attach, the events stream, the control relay and ssh-agent forwarding
ride the channel when the host negotiated `channel-streams`. Each stream is one
mux channel (`src/services/agent-channel-streams.ts`):

1. The primary opens a channel and sends an open head line: `{"stream":
"attach"|"events"|"control-relay"|"ssh-agent"|"preview"|"configured-preview","query":{...},"resumed":true?}`.
   `query` is the query string of the matching `/internal/ws/*` route.
2. The agent answers one accept head line, `{"status":200,"resumed"?}`, or a
   refusal (`400` for an attach that fails validation, `404` for an unknown
   stream) and closes the channel.
3. After that both sides exchange WebSocket-shaped messages, framed
   `[flags:1][length:4 BE][payload]` (flag bit 0 = binary; at most 1 MiB), so
   attach keeps its text-control / binary-PTY distinction. This is
   `src/services/channel-socket.ts`: a `ws`-surfaced view of the channel, which
   is why the existing callers (`proxyToRemoteAttach`, `relayRemoteEventsHost`,
   the event subscriber, the control-relay and ssh-agent fan-outs) are unchanged.

The control relay and ssh-agent streams are themselves muxes; they nest inside
the stream channel, so their 64-connection / 16-stream / 256-channel limits and
the primary's `relayedSessionDenied` host binding apply unchanged. The agent runs
the same code as the inbound routes (`src/routes/internal-streams.ts`), so the
attach query validation is shared, not copied.

- **Authorization.** The channel is bound to one host id by its machine
  credential, so a stream can only reach (or come from) that host. Per-session
  checks stay where they were: the primary's routes decide which host a session
  belongs to before opening an attach, the events relay still drops cursors for
  sessions placed on another host, and a control-relay connection is pinned to
  the relaying host and is denied for a session hosted elsewhere.
- **SSH-agent stays opt-in.** The fan-out still opens its stream only while a
  bridge for that host is connected; pairing a host for execution does not
  enable key sharing.
- **Rejected vs unreachable.** A refused stream surfaces as `unexpected-response`
  with the status (the caller treats it as a rejection, as on the inbound
  route); a stream that could not be opened because the channel is down or lost
  fails with an `error` and `close` (unreachable).
- **Flow control and stalls.** Each stream has its own credit window. Bytes
  waiting for that window are reported as `bufferedAmount`, so the callers'
  existing backpressure (the 4 MiB terminal drop and in-place resync) works
  as it does on a socket; a stream that queues past 8 MiB is closed rather than
  grown, and the connection-level `maxBufferedBytes` ceiling still applies.
- **Cancellation.** A lost connection closes every channel on it, so the
  agent-side attach/events/relay handlers see `close` and detach; the
  agent's sessions themselves keep running. The primary does **not** reopen a
  stream by itself: the browser's reconnect (attach), the event subscriber and the
  relay/ssh-agent fan-outs redial on their own backoff, over the channel again.
  A fan-out skips a host bound to the channel while the channel is down (a debug
  log line, no warning per attempt), and when the channel comes up the primary
  reconnects that host's fan-outs immediately, whether or not the host also has
  an address.
- **Resume signal.** A stream reopened on a later connection of the same host
  (the primary compares the channel's `connectedAt`) carries `resumed: true` in
  its open head; the agent echoes it in the accept head, the socket exposes
  `resumed`, and the primary logs it. It is a signal, not a different protocol:
  the attach scrollback replay and the events replay snapshot are what
  resynchronize the stream, exactly as on a reconnect over the inbound URL.
- **Never switched.** Like requests, a host that negotiated `channel-streams`
  in this process fails its streams as unreachable while the channel is down; it
  never opens them on the advertised URL. A legacy peer keeps the inbound
  WebSocket routes.

### Never replayed, never switched

- A failure **before** the request started sending (the channel could not be
  opened) is plain unreachability (`HostUnreachableError`), or `HostBusyError`
  if the outbound channel cap was saturated: nothing ran.
- A failure **after** it started (the link dropped, the request timed out) on a
  non-idempotent request surfaces as `HostOutcomeUnknownError` (a
  `HostUnreachableError` with `outcomeUnknown: true`): the agent may have
  applied it. It is **never retried** by the client and **never repeated on the
  inbound URL**. Read-only requests (GETs and a short list of read-only POSTs,
  `isIdempotentRequest`) report plain unreachability. The caller checks the
  result (session list, `git status`) before deciding to run it again.
- The transport is chosen from **negotiated support**, not from whether a socket
  happens to be open. Once a host has negotiated `channel-requests` in this
  primary process, its requests fail as unreachable while the channel is down
  rather than falling back to the advertised URL. A host that never negotiated
  it (an older agent, a manual deployment) keeps using the inbound URL.
  Revoking or deleting the host, or a handshake that no longer negotiates it,
  clears the binding. After a primary restart the binding is empty until the
  agent redials (seconds): requests in that gap use the inbound URL if there is
  one.

## Binding and revocation

The channel is bound to the **server-issued host id** that the credential
authenticates; one host's credential cannot open another host's channel. The
check (`checkMachineCredential`) is read-only: it accepts the current
credential and a graced previous one but never rotates or slides expiry, so
redialing does not churn the credential (renewal stays on the HTTP path).
`POST /api/hosts/:id/revoke` and host deletion close a live channel with code
4002 immediately; a revoked identity is refused with `revoked`.

The credential is also **re-validated while the channel is open** (every 60 s):
once the 90-day expiry passes, or the previous-credential grace window ends
after a renewal, the primary closes the channel with code 4004 (`expired`). The
agent re-reads its persisted (renewed) identity and redials on its normal
backoff. An operation in flight when the primary closes the channel for
revocation or expiry fails as **rejected** (`HostRequestError` 401), not as
unreachable.

## Replacement, limits, backpressure

- At most one channel per host. A newer authenticated connection **replaces**
  the older one deterministically: the old socket is closed with code 4001
  (`superseded`) and all its mux channels are closed (in-flight work is
  cancelled) before the new one is registered. The agent does not fight a
  supersede: it does not reset its backoff curve and waits about 5 minutes
  (`AGENT_CHANNEL_SUPERSEDED_RETRY_MS`, +-20% jitter) before redialing, reporting
  state `superseded` with `lastError` "superseded by a newer connection". Two
  daemons sharing one credential (a cloned VM, a restored backup) therefore swap
  the channel at most once per interval instead of looping. The primary logs a
  warning naming only the host id when one host is superseded twice within 60 s.
- Per connection: 64 channels, a 16 KiB handshake frame, and an 8 MiB
  `ws.bufferedAmount` ceiling **on both sides**. The mux closes (terminates)
  the connection rather than queue past it (`maxBufferedBytes`).
- A disconnect closes every channel on it, which is the cancellation signal
  for in-flight work. Mutations are never replayed automatically. An agent that
  never receives a complete request closes the channel after two minutes.

## Reconnect

The agent redials with exponential backoff, 1 s to 60 s, +-20% jitter; the
curve resets after a connection that reached `ready` (but not after a
supersede, see above). A refused identity or
protocol (`rejected`) retries every 5 minutes instead. The persisted identity is
re-read on every attempt, so credential renewal is picked up. No identity
(legacy agent) means the dialer stays idle and dials nothing; there is no silent
fallback to another host.

## Ownership

The dialer is a plugin of the **daemon** (`src/plugins/agent-channel-client.ts`).
Mullion Helper only configures and shows status: closing or updating Helper does
not stop the daemon, its channel, or running sessions.

## Readiness

Channel readiness is reported separately from pairing and credential state:
`GET /api/hosts` returns `channel: {ready, connectedAt, carriedOperations}`
next to `hasMachineIdentity` / `machineIdentityRevoked`. On the agent,
`app.agentChannelStatus.state` is `idle | connecting | ready | backoff | rejected | superseded`.
