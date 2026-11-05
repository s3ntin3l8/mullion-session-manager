import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket, RawData } from "ws";
import { checkMachineCredential, markChannelConnected } from "../services/host-registry.js";
import { createMuxConnection } from "../services/ssh-agent-mux.js";
import { AGENT_OPERATIONS, localProtocolInfo } from "../shared/agent-protocol.js";
import {
  AGENT_CHANNEL_HANDSHAKE_TIMEOUT_MS,
  AGENT_CHANNEL_MAX_BUFFERED_BYTES,
  AGENT_CHANNEL_MAX_CHANNELS,
  AGENT_CHANNEL_MAX_HANDSHAKE_BYTES,
  AGENT_CHANNEL_PATH,
  AGENT_CHANNEL_SUPERSEDE_WARN_WINDOW_MS,
  AgentChannelCloseCode,
  parseAuthFrame,
  protocolMismatch,
  type AgentChannelErrorCode,
  type AgentChannelReadyFrame,
} from "../shared/agent-channel.js";
import type { ConnectedAgentChannel } from "../plugins/agent-channel.js";

// Issue #2450 — the primary side of an execution agent's OUTBOUND channel.
// Modelled on routes/agent-bridge.ts (exempt from the normal auth gate, first
// JSON frame within a handshake timeout, then the mux), but authenticated by
// the host's machine credential (#2568) and bound to that host id. Nothing is
// carried yet: operations migrate in #2451 / #2571. Contract:
// docs/agent-channel.md.

const CONNECT_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

function reject(
  app: FastifyInstance,
  socket: NodeWebSocket,
  code: AgentChannelErrorCode,
  message: string,
  hostId?: string,
): void {
  // hostId is peer-supplied and unauthenticated here: cap it before logging.
  app.log.warn({ hostId: hostId?.slice(0, 64), code }, "agent-channel handshake rejected");
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify({ type: "error", code, message }));
  socket.close();
}

/** Closes the host's channel, if any. Used on revoke / delete. */
export function closeAgentChannel(app: FastifyInstance, hostId: string, code: number): void {
  app.agentChannels.get(hostId)?.close(code, "closed by primary");
}

export async function agentChannelRoute(app: FastifyInstance) {
  // When each host was last superseded, to spot two daemons on one credential.
  const lastSupersededAt = new Map<string, number>();
  app.get(
    AGENT_CHANNEL_PATH,
    {
      websocket: true,
      config: { rateLimit: CONNECT_RATE_LIMIT },
      // A non-101 answer (429, 403, 404) leaves no other trace.
      onResponse: (request, reply, done) => {
        if (reply.statusCode !== 101) {
          app.log.warn(
            { url: request.url.split("?")[0], statusCode: reply.statusCode },
            "agent-channel websocket upgrade rejected",
          );
        }
        done();
      },
    },
    (socket: NodeWebSocket) => {
      let handshakeDone = false;
      const timer = setTimeout(() => {
        if (!handshakeDone) socket.terminate();
      }, AGENT_CHANNEL_HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      socket.once("close", () => clearTimeout(timer));

      function onFirstFrame(data: RawData, isBinary: boolean): void {
        socket.off("message", onFirstFrame);
        clearTimeout(timer);
        handshakeDone = true;
        if (isBinary) return reject(app, socket, "bad-handshake", "first frame must be JSON");
        const text = (
          Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : data
        ).toString("utf8");
        if (text.length > AGENT_CHANNEL_MAX_HANDSHAKE_BYTES) {
          return reject(app, socket, "bad-handshake", "handshake frame too large");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return reject(app, socket, "bad-handshake", "first frame must be valid JSON");
        }
        const auth = parseAuthFrame(parsed);
        if (!auth) {
          return reject(
            app,
            socket,
            "bad-handshake",
            "expected {type:'auth', hostId, credential, protocol}",
          );
        }

        // Credential first: an unauthenticated peer learns nothing about
        // protocol support.
        const check = checkMachineCredential(app, auth.hostId, auth.credential);
        if (check === "revoked") {
          return reject(app, socket, "revoked", "machine identity revoked", auth.hostId);
        }
        if (check !== "ok") {
          return reject(
            app,
            socket,
            "invalid-credential",
            "invalid or expired credential",
            auth.hostId,
          );
        }
        const mismatch = protocolMismatch(auth.protocol);
        if (mismatch) return reject(app, socket, "incompatible-protocol", mismatch, auth.hostId);

        const hostId = auth.hostId;
        const supported = new Set<string>(AGENT_OPERATIONS);
        const negotiated = auth.protocol.operations.filter((op) => supported.has(op));

        // A newer connection deterministically replaces the older one: the
        // old one is closed (and its channels, so in-flight work is
        // cancelled) BEFORE the new one is registered.
        const previous = app.agentChannels.get(hostId);
        if (previous) {
          const now = Date.now();
          const last = lastSupersededAt.get(hostId);
          if (last !== undefined && now - last <= AGENT_CHANNEL_SUPERSEDE_WARN_WINDOW_MS) {
            // Host id only: never the credential or peer-supplied detail.
            app.log.warn(
              { hostId },
              "[agent-channel] host superseded twice within 60s: two daemons appear to share one machine credential",
            );
          }
          lastSupersededAt.set(hostId, now);
          previous.close(AgentChannelCloseCode.Superseded, "superseded by a newer connection");
        }

        const mux = createMuxConnection(socket, {
          channelIdParity: "even",
          maxChannels: AGENT_CHANNEL_MAX_CHANNELS,
          maxBufferedBytes: AGENT_CHANNEL_MAX_BUFFERED_BYTES,
        });
        const entry: ConnectedAgentChannel = {
          hostId,
          socket,
          mux,
          connectedAt: Date.now(),
          protocolVersion: auth.protocol.protocolVersion,
          negotiatedOperations: negotiated,
          carriedOperations: [],
          close: (code, reason) => {
            // Our code first, then the mux teardown: mux.close() skips its
            // own plain socket.close() once the socket is no longer OPEN,
            // and cancels every channel (and so its in-flight work) now.
            if (socket.readyState === socket.OPEN) socket.close(code, reason);
            mux.close();
          },
        };
        app.agentChannels.set(hostId, entry);
        markChannelConnected(app, hostId);
        // Nothing is carried yet: refuse every peer-initiated channel.
        mux.onChannel((channel) => channel.close());
        mux.onClose((reason) => {
          // Only remove OUR entry: a superseding connection may already own the slot.
          if (app.agentChannels.get(hostId) === entry) app.agentChannels.delete(hostId);
          app.log.info({ hostId, reason }, "agent channel closed");
        });
        app.log.info({ hostId, protocolVersion: entry.protocolVersion }, "agent channel ready");

        const ready: AgentChannelReadyFrame = {
          type: "ready",
          hostId,
          protocolVersion: localProtocolInfo().protocolVersion,
          negotiatedOperations: negotiated,
          carriedOperations: [],
        };
        socket.send(JSON.stringify(ready));
      }
      socket.on("message", onFirstFrame);
    },
  );
}
