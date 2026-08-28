import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket, RawData } from "ws";
import {
  encodePairingPayload,
  issuePairingCode,
  redeemPairingCode,
  touchBridgeLastSeen,
  verifyBridgeSession,
} from "../services/bridge-registry.js";

// Issue #820 — the primary-side half of the SSH-agent bridge's laptop-
// facing surface (see the design plan). Two routes:
//   - POST /api/bridges — Settings generates a pairing code. A normal,
//     in-app-auth-gated admin action (same posture as POST /api/hosts),
//     NOT exempted from authPlugin's global gate.
//   - GET /ws/agent-bridge — the helper's actual persistent connection.
//     Authenticated by its OWN credential (pairing code on first connect,
//     a rotating session on every one after), carried in the connection's
//     own first frame rather than an Authorization header, so a plain
//     global `WebSocket` — no custom-header support — works as the client
//     (see PR6's `mullion helper` CLI). Deliberately exempted from
//     authPlugin's global gate (src/plugins/auth.ts's isProtectedPath) the
//     same way /api/internal/register and /api/internal/deregister are:
//     the helper is never going to hold this deployment's
//     MULLION_AUTH_TOKEN or an OIDC session cookie.
//
// Primary-only (registered from src/app.ts's primary branch only — an
// agent has no `bridges` table to pair a helper into).
//
// Scope note: this PR only gets a connection authenticated and tracked in
// `app.connectedBridges` — it does not yet wire the connection into
// ssh-agent-mux.ts's MuxConnection or fan out to any agent host. That's
// the next PR in the same sequence. A successful handshake here leaves the
// socket open and otherwise idle.

const HANDSHAKE_TIMEOUT_MS = 10_000;

// Same posture as enrollment.ts's REGISTER_RATE_LIMIT — CodeQL's
// js/missing-rate-limiting query (and plain good sense) wants a
// credential-checking endpoint bounded regardless.
const PAIR_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };
const BRIDGE_CONNECT_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

interface PairResponse {
  bridge_id: string;
  /** The full one-paste payload — base64url of `{baseUrl, code}` (see
   * bridge-registry.ts's encodePairingPayload). The helper needs nothing
   * else: no separate URL to type in, no separate config. `baseUrl` is
   * derived from THIS request's own Host header, which — for a Settings
   * page reached through whatever reverse proxy fronts this deployment —
   * already reflects the externally-reachable address better than any
   * server-side guess could (there's no MULLION_PUBLIC_URL-style config;
   * the browser calling this endpoint is standing at the correct vantage
   * point already). Respects `trustProxy` (src/plugins/env.ts) the same
   * way every other proxy-aware request field in this app does.
   *
   * Accepted risk (Hermes review, PR #860): a caller who can influence
   * this request's Host header could in principle point the generated
   * payload at a server they control. Not validated against an
   * allowlist here — there is no expected-host config value anywhere
   * else in this app to validate against, and the practical exposure is
   * low: the admin who called this endpoint sees the resulting payload
   * themselves before ever pasting it into a helper, so a spoofed host
   * would need to survive that visual check too. Revisit only if this
   * app ever grows an actual expected-host / allowed-origins config
   * surface for other reasons — bolting one on for this endpoint alone
   * wouldn't be worth the new config knob. */
  pairing_payload: string;
  expires_at: string;
}

type ClientHandshake =
  | { type: "pair"; code: string; name?: string; platform?: string }
  | { type: "auth"; bridge_id: string; session_id: string };

function isClientHandshake(value: unknown): value is ClientHandshake {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === "pair") return typeof v.code === "string" && v.code.length > 0;
  if (v.type === "auth") {
    return typeof v.bridge_id === "string" && typeof v.session_id === "string";
  }
  return false;
}

function sendError(socket: NodeWebSocket, message: string): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify({ type: "error", message }));
  socket.close();
}

/** Records `socket` as the live connection for `bridgeId`, closing
 * whatever socket was PREVIOUSLY tracked there first (Hermes review, PR
 * #860). Without this, a reconnect (the "auth" path — a "pair" redeem
 * can't collide, since a pairing code always produces a brand-new
 * bridgeId) that lands before the OLD TCP connection has fired its own
 * "close" event (a flake or a silent network drop, not a clean
 * disconnect) would silently orphan that old socket: it stays OPEN, but
 * is no longer in the map, so its own close handler — which only deletes
 * the entry pointing at ITSELF — never runs the cleanup. Repeated
 * flapping would leak a growing number of live-but-untracked sockets
 * until TCP's own idle timeout eventually reaps them. Closing the
 * superseded socket here means there is only ever at most one tracked
 * (and one about-to-be-tracked) socket per bridge at any moment. */
function trackBridge(app: FastifyInstance, bridgeId: string, socket: NodeWebSocket): void {
  const previous = app.connectedBridges.get(bridgeId);
  if (previous && previous !== socket) previous.close();
  app.connectedBridges.set(bridgeId, socket);
}

export async function agentBridgeRoute(app: FastifyInstance) {
  app.post(
    "/api/bridges",
    { config: { rateLimit: PAIR_RATE_LIMIT } },
    async (request): Promise<PairResponse> => {
      const pairing = issuePairingCode(app);
      const baseUrl = `${request.protocol}://${request.headers.host}`;
      return {
        bridge_id: pairing.bridgeId,
        pairing_payload: encodePairingPayload({ baseUrl, code: pairing.code }),
        expires_at: pairing.expiresAt.toISOString(),
      };
    },
  );

  app.get(
    "/ws/agent-bridge",
    { websocket: true, config: { rateLimit: BRIDGE_CONNECT_RATE_LIMIT } },
    (socket: NodeWebSocket) => {
      let handshakeComplete = false;

      // Mirrors remote-event-subscriber.ts's own connect-timeout-then-
      // terminate shape: a peer that opens the WS but never sends (or
      // never finishes sending) its first frame must not hold the
      // connection open indefinitely.
      const handshakeTimeout = setTimeout(() => {
        if (!handshakeComplete) socket.terminate();
      }, HANDSHAKE_TIMEOUT_MS);
      handshakeTimeout.unref?.();

      function handleHandshake(data: RawData, isBinary: boolean): void {
        // Only the FIRST message is the handshake — every later "message"
        // event on this same listener would be actual mux traffic once a
        // later PR wires createMuxConnection() up to this socket. Removed
        // immediately (below), not just gated by `handshakeComplete`, so
        // this function fully stops competing with whatever the next PR
        // attaches to "message" instead of silently coexisting with it.
        socket.off("message", handleHandshake);
        clearTimeout(handshakeTimeout);
        handshakeComplete = true;

        if (isBinary) {
          sendError(socket, "first frame must be JSON, not binary");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString("utf8"));
        } catch {
          sendError(socket, "first frame must be valid JSON");
          return;
        }
        if (!isClientHandshake(parsed)) {
          sendError(socket, "unrecognized handshake — expected {type:'pair'|'auth', ...}");
          return;
        }

        if (parsed.type === "pair") {
          const session = redeemPairingCode(app, parsed.code, {
            name: parsed.name,
            platform: parsed.platform,
          });
          if (!session) {
            sendError(socket, "invalid or expired pairing code");
            return;
          }
          trackBridge(app, session.bridgeId, socket);
          socket.send(
            JSON.stringify({
              type: "ready",
              bridge_id: session.bridgeId,
              session_id: session.sessionId,
              // Handed to the helper so it can persist it for a future
              // reconnect, but NOT currently used for anything on the wire
              // — the "auth" path below re-authenticates on session_id
              // alone (a 256-bit random value, so this is fine
              // security-wise). Flagged so a later PR doesn't assume this
              // is already the reconnect credential and skip actually
              // wiring it in: rotateBridgeSession (bridge-registry.ts) is
              // the function that would need a route to make this
              // meaningful, and none exists yet.
              session_secret: session.sessionSecret,
              expires_at: session.expiresAt.toISOString(),
            }),
          );
          return;
        }

        // parsed.type === "auth"
        if (!verifyBridgeSession(app, parsed.bridge_id, parsed.session_id)) {
          sendError(socket, "invalid session credential");
          return;
        }
        touchBridgeLastSeen(app, parsed.bridge_id);
        trackBridge(app, parsed.bridge_id, socket);
        socket.send(JSON.stringify({ type: "ready", bridge_id: parsed.bridge_id }));
      }

      socket.on("message", handleHandshake);

      socket.on("close", () => {
        clearTimeout(handshakeTimeout);
        for (const [bridgeId, tracked] of app.connectedBridges) {
          if (tracked === socket) app.connectedBridges.delete(bridgeId);
        }
      });
    },
  );
}
