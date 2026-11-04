# Outbound agent channel (transport contract)

Issue #2450, epic #2230. Enrollment is agent-initiated, but ongoing control
still dials the agent's advertised address (`src/services/remote-host-client.ts`),
which needs inbound reachability on laptops. This channel is the transport
seam that lets the **agent dial the primary** instead. It carries **no
operations yet**: request/response operations move over it in #2451, streams in
#2571, and #2572 drops the advertised URL. Until then the channel is
established, authenticated and observable, nothing more.

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
   - `carriedOperations`: operations actually carried by this channel. **Always
     `[]` until each migration lands**; nothing may claim an operation earlier.
3. Error codes: `bad-handshake`, `invalid-credential`, `revoked`,
   `incompatible-protocol`. The credential is checked first, so an
   unauthenticated peer learns nothing about protocol support.
4. After `ready` the socket carries the binary mux of
   `src/services/ssh-agent-mux.ts`. The primary is the "even" side, the agent
   (the dialer) the "odd" side. Peer-initiated channels are refused for now.

## Binding and revocation

The channel is bound to the **server-issued host id** that the credential
authenticates; one host's credential cannot open another host's channel. The
check (`checkMachineCredential`) is read-only: it accepts the current
credential and a graced previous one but never rotates or slides expiry, so
redialing does not churn the credential (renewal stays on the HTTP path).
`POST /api/hosts/:id/revoke` and host deletion close a live channel with code
4002 immediately; a revoked identity is refused with `revoked`.

## Replacement, limits, backpressure

- At most one channel per host. A newer authenticated connection **replaces**
  the older one deterministically: the old socket is closed with code 4001
  (`superseded`) and all its mux channels are closed (in-flight work is
  cancelled) before the new one is registered. The agent does not fight a
  supersede; it backs off and redials like any drop.
- Per connection: 64 channels, a 16 KiB handshake frame, and an 8 MiB
  `ws.bufferedAmount` ceiling **on both sides**. The mux closes (terminates)
  the connection rather than queue past it (`maxBufferedBytes`).
- A disconnect closes every channel on it, which is the cancellation signal
  for in-flight work. Mutations are never replayed automatically.

## Reconnect

The agent redials with exponential backoff, 1 s to 60 s, +-20% jitter; the
curve resets after a connection that reached `ready`. A refused identity or
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
`app.agentChannelStatus.state` is `idle | connecting | ready | backoff | rejected`.
