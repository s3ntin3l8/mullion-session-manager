import type { WebSocket as NodeWebSocket } from "ws";
import type { AgentChannelStreamKind } from "../shared/agent-channel.js";
import { attachStreamQuery } from "./agent-channel-streams.js";
import type { OpenAttachOptions } from "./remote-host-client-types.js";

// RemoteHostClient streams facet (issue #3289 / #3303; convention in
// remote-host-devices.ts).

export interface StreamsClientDeps {
  openInbound: (requestTarget: string, capPayload: boolean) => NodeWebSocket;
  openChannel: (
    kind: AgentChannelStreamKind,
    identity: string,
    query?: Record<string, string>,
  ) => NodeWebSocket | null;
}

export function createStreamsClient({ openInbound, openChannel }: StreamsClientDeps) {
  return {
    /**
     * Opens (but does not wait for) a WS connection to this agent's
     * `/internal/ws/attach`, bearer-authed via a request header (the `ws`
     * package is required for this — the browser/global WebSocket API can't
     * set one). Callers (routes/terminal.ts) own the open/error/close
     * lifecycle and the actual byte piping; this just constructs the socket.
     */
    attach(opts: OpenAttachOptions): NodeWebSocket {
      const viaChannel = openChannel("attach", opts.id, attachStreamQuery(opts));
      if (viaChannel) return viaChannel;
      const query = new URLSearchParams({
        id: opts.id,
        cwd: opts.cwd,
        command: opts.command,
        cols: String(opts.cols),
        rows: String(opts.rows),
      });
      if (opts.projectId !== undefined) {
        query.set("projectId", String(opts.projectId));
      }
      if (opts.env !== undefined) {
        query.set("env", JSON.stringify(opts.env));
      }
      const requestTarget = `/internal/ws/attach?${query.toString()}`;
      return openInbound(requestTarget, false);
    },

    /**
     * Opens (but does not wait for) a WS connection to this agent's
     * `/internal/ws/events` (issue #166) — the events-channel counterpart to
     * attach() above, bearer-authed the same header-only way (the `ws`
     * package, not the browser/global WebSocket API, is what makes a custom
     * Authorization header possible on the upgrade request). Unlike
     * attach(), this takes no per-session target — it's one aggregated
     * stream covering every session this agent tracks, so there are no query
     * params to build. Callers (routes/events.ts's relayRemoteEventsHost,
     * services/remote-event-subscriber.ts) own the open/error/close lifecycle
     * and the actual frame relaying/handling.
     *
     * `maxPayload` bounds inbound frames on this (client) socket, matching
     * plugins/websocket.ts's own 1 MiB server-side cap (Hermes review, PR
     * #564 round 4) — without it, `ws`'s 100 MiB default leaves both callers
     * exposed to an oversized frame from a buggy or compromised agent: an
     * unbounded `JSON.parse` and, for remote-event-subscriber.ts, an
     * unbounded flush-buffer entry. A frame over the cap makes `ws` close the
     * connection (RFC 6455 1009) rather than deliver it — both callers
     * already handle an unexpected close via their normal reconnect/relay
     * teardown paths, so this doesn't need its own error handling.
     *
     * Issue #1459 — `opts.cursors` (only ever passed by
     * routes/events.ts's relayRemoteEventsHost, never by
     * remote-event-subscriber.ts's own history-capture subscription, which has
     * no browser-facing cursors/seen story to opt into) appends `?cursors=1`
     * to `requestTarget` — BEFORE it's used for both the actual URL and the
     * signature's canonical request-target string, so the two can never
     * diverge (buildCanonicalString's own doc comment: the signed target must
     * match byte-for-byte what's actually sent on the wire). This is what
     * tells the agent's own `/internal/ws/events` route to also send its own
     * `cursors` frame and join its seenSubscribers broadcast set — see
     * relayRemoteEventsHost's own doc comment for why this is opt-in rather
     * than unconditional.
     */
    events(opts?: { cursors?: boolean }): NodeWebSocket {
      const cursors = opts?.cursors ? { cursors: "1" } : undefined;
      const viaChannel = openChannel("events", cursors ? "cursors" : "", cursors);
      if (viaChannel) return viaChannel;
      const requestTarget = opts?.cursors ? "/internal/ws/events?cursors=1" : "/internal/ws/events";
      return openInbound(requestTarget, true);
    },

    /**
     * Opens (but does not wait for) a WS connection to this agent's
     * `/internal/ws/ssh-agent` (issue #820, PR5b) — bearer+signature-authed
     * the same header-only way as events() above. The caller
     * (ssh-agent-fanout.ts's subscriber, PR5c) is expected to immediately
     * wrap the returned socket in `createMuxConnection(socket,
     * {channelIdParity: "odd"})` — THIS side (primary) dials out, so it must
     * be "odd" to match the agent's own "even" pin (routes/internal.ts's
     * `/internal/ws/ssh-agent` handler). `maxPayload` matches
     * events()'s own 1 MiB cap (plugins/websocket.ts's identical
     * server-side limit) — well above `CHANNEL_WINDOW_BYTES` (256 KiB,
     * ssh-agent-mux.ts), the largest a single mux Data frame's payload can
     * legitimately be.
     */
    sshAgent(): NodeWebSocket {
      const viaChannel = openChannel("ssh-agent", "");
      if (viaChannel) return viaChannel;
      const requestTarget = "/internal/ws/ssh-agent";
      return openInbound(requestTarget, true);
    },

    /**
     * Opens this agent's `/internal/ws/control-relay` (issue #1656): the mux
     * the primary dials so sessions on the agent can reach the primary's
     * control surface. Same bearer, signing and pinning as every other stream
     * here; `maxPayload` matches the mux's largest Data frame.
     */
    controlRelay(): NodeWebSocket {
      const viaChannel = openChannel("control-relay", "");
      if (viaChannel) return viaChannel;
      const requestTarget = "/internal/ws/control-relay";
      return openInbound(requestTarget, true);
    },
  };
}

export type StreamsClient = ReturnType<typeof createStreamsClient>;
