import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { WebSocket as NodeWebSocket } from "ws";
import { identityStatePath, loadAgentIdentity } from "../services/agent-identity.js";
import { createMuxConnection, type MuxConnection } from "../services/ssh-agent-mux.js";
import { toWsUrl } from "../services/ws-pipe.js";
import { localProtocolInfo } from "../shared/agent-protocol.js";
import {
  AGENT_CHANNEL_HANDSHAKE_TIMEOUT_MS,
  AGENT_CHANNEL_MAX_BUFFERED_BYTES,
  AGENT_CHANNEL_MAX_CHANNELS,
  AGENT_CHANNEL_PATH,
  AGENT_CHANNEL_REJECTED_RETRY_MS,
  AGENT_CHANNEL_SUPERSEDED_RETRY_MS,
  AgentChannelCloseCode,
  backoffDelayMs,
  type AgentChannelAuthFrame,
  type AgentChannelErrorFrame,
  type AgentChannelReadyFrame,
} from "../shared/agent-channel.js";

// Issue #2450 — the agent (daemon) half of the outbound channel: dial the
// primary, authenticate with the persisted machine identity (#2568), keep the
// connection up with bounded backoff. Owned by this process, never by Mullion
// Helper: closing or updating Helper does not touch it, and nothing here
// depends on the tray being alive.
//
// Nothing is carried yet (operations migrate in #2451 / #2571), so the
// primary's peer-initiated channels are refused and `ready` only means "an
// authenticated, compatible channel is open".

export type AgentChannelClientState =
  /** No identity, no primary URL, or not started: nothing to dial. */
  | "idle"
  | "connecting"
  | "ready"
  /** The primary refused the identity or protocol; retrying slowly. */
  | "rejected"
  /** A newer connection for this host took over; waiting a long interval
   * before redialing rather than fighting it. */
  | "superseded"
  /** Waiting out a backoff after a failed or dropped connection. */
  | "backoff";

export interface AgentChannelClientStatus {
  state: AgentChannelClientState;
  hostId: string | null;
  lastError: string | null;
  connectedAt: number | null;
  carriedOperations: string[];
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

export const agentChannelClientPlugin = fp(async (app: FastifyInstance) => {
  const status: AgentChannelClientStatus = {
    state: "idle",
    hostId: null,
    lastError: null,
    connectedAt: null,
    carriedOperations: [],
  };
  app.decorate("agentChannelStatus", status);
  if (app.config.MULLION_ROLE !== "agent" || !app.config.MULLION_PRIMARY_URL) return;

  // The first frame carries the machine credential, so a plain-text primary
  // URL exposes it on the wire. Warned, not refused: a trusted LAN is legitimate.
  const primaryUrl = new URL(app.config.MULLION_PRIMARY_URL);
  if (primaryUrl.protocol === "http:" && !isLoopbackHost(primaryUrl.hostname)) {
    app.log.warn(
      `[agent-channel] MULLION_PRIMARY_URL is plain http://; the machine credential is sent unencrypted. Use https:// outside a trusted network.`,
    );
  }

  const channelUrl = (() => {
    const url = toWsUrl(new URL(app.config.MULLION_PRIMARY_URL));
    url.pathname = `${url.pathname.replace(/\/$/, "")}${AGENT_CHANNEL_PATH}`;
    return url.href;
  })();
  const statePath = identityStatePath(app.config.SESSIONS_DIR);

  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let socket: NodeWebSocket | null = null;
  let mux: MuxConnection | null = null;

  function schedule(delayMs: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(connect, delayMs);
    timer.unref?.();
  }

  function settle(next: AgentChannelClientState, error: string | null, delayMs: number): void {
    status.state = next;
    status.lastError = error;
    status.connectedAt = null;
    status.carriedOperations = [];
    schedule(delayMs);
  }

  function connect(): void {
    timer = null;
    if (stopped || socket) return;
    // Re-read every attempt: the enrollment plugin rotates the persisted
    // credential, and a stale in-memory copy would be refused after the
    // grace window.
    const identity = loadAgentIdentity(statePath);
    if (!identity) {
      // Not enrolled with a machine identity yet (or a legacy agent).
      status.hostId = null;
      settle("idle", null, backoffDelayMs(attempt++));
      return;
    }
    status.hostId = identity.hostId;
    status.state = "connecting";
    const ws = new NodeWebSocket(channelUrl, {
      handshakeTimeout: AGENT_CHANNEL_HANDSHAKE_TIMEOUT_MS,
      maxPayload: 4 * 1024 * 1024,
    });
    socket = ws;
    let ready = false;
    let rejected: string | null = null;
    let finished = false;

    const finish = (reason: string, closeCode?: number): void => {
      if (finished) return;
      finished = true;
      mux = null;
      socket = null;
      if (stopped) return;
      if (rejected) {
        attempt = 0;
        settle("rejected", rejected, AGENT_CHANNEL_REJECTED_RETRY_MS);
      } else if (closeCode === AgentChannelCloseCode.Revoked) {
        settle("rejected", "identity revoked", AGENT_CHANNEL_REJECTED_RETRY_MS);
      } else if (closeCode === AgentChannelCloseCode.Superseded) {
        // Another daemon holds this credential. Neither reset the curve nor
        // redial on it: a short retry would supersede the other side in turn.
        settle(
          "superseded",
          "superseded by a newer connection",
          Math.round(AGENT_CHANNEL_SUPERSEDED_RETRY_MS * (0.8 + 0.4 * Math.random())),
        );
      } else {
        // A connection that reached ready and then dropped restarts the
        // curve; one that never got there keeps climbing it.
        if (ready) attempt = 0;
        settle("backoff", reason, backoffDelayMs(attempt++));
      }
    };

    ws.once("open", () => {
      const auth: AgentChannelAuthFrame = {
        type: "auth",
        hostId: identity.hostId,
        credential: identity.machineCredential,
        protocol: localProtocolInfo(),
      };
      ws.send(JSON.stringify(auth));
    });

    const onHandshakeReply = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void => {
      ws.off("message", onHandshakeReply);
      let frame: AgentChannelReadyFrame | AgentChannelErrorFrame | null = null;
      try {
        if (!isBinary) {
          const buf = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : (data as Buffer);
          frame = JSON.parse(buf.toString("utf8"));
        }
      } catch {
        frame = null;
      }
      if (frame?.type === "ready" && frame.hostId === identity.hostId) {
        ready = true;
        clearTimeout(replyTimer);
        status.state = "ready";
        status.lastError = null;
        status.connectedAt = Date.now();
        // Nothing is carried until a migration lands: report what the primary
        // says, which is empty today.
        status.carriedOperations = frame.carriedOperations ?? [];
        // We dialed, so we are the "odd" side (the primary accepts as "even").
        mux = createMuxConnection(ws, {
          channelIdParity: "odd",
          maxChannels: AGENT_CHANNEL_MAX_CHANNELS,
          maxBufferedBytes: AGENT_CHANNEL_MAX_BUFFERED_BYTES,
        });
        mux.onChannel((channel) => channel.close());
        app.log.info({ hostId: identity.hostId }, "[agent-channel] ready");
        return;
      }
      if (frame?.type === "error") {
        rejected = `${frame.code}: ${frame.message}`;
        app.log.error({ code: frame.code }, `[agent-channel] primary refused: ${frame.message}`);
      } else {
        rejected = null;
        app.log.warn("[agent-channel] unrecognized handshake reply");
      }
      ws.close();
    };
    ws.on("message", onHandshakeReply);
    ws.once("close", (code, reason) => {
      finish(`closed (code=${code}${reason?.length ? `, reason=${reason}` : ""})`, code);
    });
    ws.once("error", (err) => {
      // 'close' follows; remember why for status.
      status.lastError = err.message;
      finish(err.message);
    });
    // A primary that accepts the socket but never replies.
    const replyTimer = setTimeout(() => {
      if (!ready && !finished) ws.terminate();
    }, AGENT_CHANNEL_HANDSHAKE_TIMEOUT_MS);
    replyTimer.unref?.();
    ws.once("close", () => clearTimeout(replyTimer));
  }

  app.addHook("onReady", () => {
    schedule(0);
  });
  app.addHook("onClose", async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    mux?.close();
    socket?.terminate();
    status.state = "idle";
  });
});

declare module "fastify" {
  interface FastifyInstance {
    /** Agent role: the outbound channel's state (readiness is separate from
     * pairing / credential state). Always "idle" on a primary. */
    agentChannelStatus: AgentChannelClientStatus;
  }
}
