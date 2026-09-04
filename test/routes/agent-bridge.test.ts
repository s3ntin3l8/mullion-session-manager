import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { WebSocket as NodeWebSocket } from "ws";
import { buildTestApp } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { decodePairingPayload, issuePairingCode } from "../../src/services/bridge-registry.js";

// Real integration tests against a genuine listening server — same harness
// shape as test/routes/ws-tasks.test.ts — app.inject() can't drive a full
// WebSocket upgrade.

const tmpDb = path.join(os.tmpdir(), `agent-bridge-test-${process.pid}.db`);

interface HandshakeReply {
  type: "ready" | "error";
  bridge_id?: string;
  session_id?: string;
  session_secret?: string;
  expires_at?: string;
  message?: string;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
}

function waitForMessage(ws: WebSocket): Promise<HandshakeReply> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (event) => resolve(JSON.parse(event.data as string) as HandshakeReply),
      { once: true },
    );
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
}

// The CLIENT's own "close" event and the SERVER's "close" handler (which
// runs the app.connectedBridges cleanup) aren't guaranteed to land in the
// same tick — they're two independent listeners on two ends of the same
// TCP connection. Polling briefly after the client sees "close" avoids a
// flaky race, same pattern as ws-tasks.test.ts's own waitUntil.
async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

async function buildAndListen() {
  const app = await buildTestApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real bound address");
  }
  return { app, port: address.port };
}

describe("agent-bridge routes (POST/GET/DELETE /api/bridges, GET /ws/agent-bridge, #820)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  describe("POST /api/bridges", () => {
    it("issues a pairing code and returns a payload that decodes to this request's own host", async () => {
      const { port } = await buildAndListen();
      // A real fetch through the actual listener, not app.inject() — inject()
      // synthesizes a fake "localhost:80" Host header rather than routing
      // through the real bound socket, which would defeat the exact thing
      // this test checks (that the route reflects the REQUEST's own host).
      const res = await fetch(`http://127.0.0.1:${port}/api/bridges`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        bridge_id: string;
        pairing_payload: string;
        expires_at: string;
      };
      expect(typeof body.bridge_id).toBe("string");
      expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());

      const decoded = decodePairingPayload(body.pairing_payload);
      expect(decoded).not.toBeNull();
      expect(decoded!.baseUrl).toBe(`http://127.0.0.1:${port}`);
      // The payload's own code is opaque base64url, not the raw secret in
      // plain sight.
      expect(body.pairing_payload).not.toContain(decoded!.code);
    });

    it("reflects https when X-Forwarded-Proto is https (behind a TLS-terminating proxy)", async () => {
      const { app } = await buildAndListen();
      const res = await app.inject({
        method: "POST",
        url: "/api/bridges",
        headers: {
          "x-forwarded-proto": "https",
          host: "mullion.dev-01.in.s3ntin3l8.de",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        bridge_id: string;
        pairing_payload: string;
        expires_at: string;
      };

      const decoded = decodePairingPayload(body.pairing_payload);
      expect(decoded).not.toBeNull();
      expect(decoded!.baseUrl).toBe("https://mullion.dev-01.in.s3ntin3l8.de");
    });

    it("uses only the first hop's X-Forwarded-Proto value with comma-separated proxies", async () => {
      const { app } = await buildAndListen();
      const res = await app.inject({
        method: "POST",
        url: "/api/bridges",
        headers: {
          "x-forwarded-proto": "https, http",
          host: "mullion.dev-01.in.s3ntin3l8.de",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        bridge_id: string;
        pairing_payload: string;
        expires_at: string;
      };

      const decoded = decodePairingPayload(body.pairing_payload);
      expect(decoded).not.toBeNull();
      expect(decoded!.baseUrl).toBe("https://mullion.dev-01.in.s3ntin3l8.de");
    });

    it("treats uppercase X-Forwarded-Proto (HTTPS) as https", async () => {
      const { app } = await buildAndListen();
      const res = await app.inject({
        method: "POST",
        url: "/api/bridges",
        headers: {
          "x-forwarded-proto": "HTTPS",
          host: "mullion.dev-01.in.s3ntin3l8.de",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        bridge_id: string;
        pairing_payload: string;
        expires_at: string;
      };

      const decoded = decodePairingPayload(body.pairing_payload);
      expect(decoded).not.toBeNull();
      expect(decoded!.baseUrl).toBe("https://mullion.dev-01.in.s3ntin3l8.de");
    });
  });

  describe("GET /ws/agent-bridge — pair handshake", () => {
    it("redeems a valid pairing code, replies ready with a fresh session, and tracks the bridge", async () => {
      const { app, port } = await buildAndListen();
      const pairRes = await app.inject({ method: "POST", url: "/api/bridges" });
      const { code } = decodePairingPayload(pairRes.json().pairing_payload)!;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "pair", code, name: "MacBook", platform: "darwin" }));
      const reply = await replyPromise;

      expect(reply.type).toBe("ready");
      expect(reply.bridge_id).toBe(pairRes.json().bridge_id);
      expect(typeof reply.session_id).toBe("string");
      // Round 3 — session_secret is deliberately no longer sent (never used
      // to reconnect or renew; both authenticate on session_id alone).
      expect(reply.session_secret).toBeUndefined();
      expect(new Date(reply.expires_at!).getTime()).toBeGreaterThan(Date.now());
      expect(app.connectedBridges.has(reply.bridge_id!)).toBe(true);

      ws.close();
    });

    it("rejects a code that's already been redeemed — single-use", async () => {
      const { app, port } = await buildAndListen();
      const pairRes = await app.inject({ method: "POST", url: "/api/bridges" });
      const { code } = decodePairingPayload(pairRes.json().pairing_payload)!;

      const firstWs = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(firstWs);
      const firstReply = waitForMessage(firstWs);
      firstWs.send(JSON.stringify({ type: "pair", code }));
      expect((await firstReply).type).toBe("ready");
      firstWs.close();

      const secondWs = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(secondWs);
      const secondReplyPromise = waitForMessage(secondWs);
      const closePromise = waitForClose(secondWs);
      secondWs.send(JSON.stringify({ type: "pair", code }));
      const secondReply = await secondReplyPromise;

      expect(secondReply.type).toBe("error");
      expect(secondReply.message).toMatch(/invalid or expired/);
      await closePromise;
    });

    it("rejects an unknown pairing code without throwing, closing the connection", async () => {
      const { port } = await buildAndListen();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      const closePromise = waitForClose(ws);
      ws.send(JSON.stringify({ type: "pair", code: "not-a-real-code" }));

      expect((await replyPromise).type).toBe("error");
      await closePromise;
    });
  });

  describe("GET /ws/agent-bridge — auth (reconnect) handshake", () => {
    async function pairFreshBridge(port: number) {
      const res = await fetch(`http://127.0.0.1:${port}/api/bridges`, { method: "POST" });
      const body = (await res.json()) as { bridge_id: string; pairing_payload: string };
      const { code } = decodePairingPayload(body.pairing_payload)!;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "pair", code }));
      const reply = await replyPromise;
      ws.close();
      await waitForClose(ws);
      return reply as Required<Pick<HandshakeReply, "bridge_id" | "session_id">>;
    }

    it("re-authenticates with a valid session id and re-tracks the bridge", async () => {
      const { app, port } = await buildAndListen();
      const { bridge_id, session_id } = await pairFreshBridge(port);
      await waitUntil(() => !app.connectedBridges.has(bridge_id)); // closed above

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "auth", bridge_id, session_id }));
      const reply = await replyPromise;

      expect(reply.type).toBe("ready");
      expect(reply.bridge_id).toBe(bridge_id);
      // Round 3 — the auth reply now also carries the session's current
      // expiry, so the client can arm its renewal timer from an
      // authoritative value rather than guessing (see agent-bridge.ts's own
      // comment on the "auth" branch for why this doesn't rotate the id).
      expect(new Date(reply.expires_at!).getTime()).toBeGreaterThan(Date.now());
      expect(app.connectedBridges.has(bridge_id)).toBe(true);
      ws.close();
    });

    it("closes a superseded socket when a new connection re-authenticates for the same bridge before the old one has disconnected (regression: Hermes review, PR #860 — a reconnect landing before the old TCP connection fires its own close event used to orphan it, live but untracked, until TCP's own idle timeout eventually reaped it)", async () => {
      const { app, port } = await buildAndListen();
      const pairRes = await app.inject({ method: "POST", url: "/api/bridges" });
      const { code } = decodePairingPayload(pairRes.json().pairing_payload)!;

      // First connection stays open — deliberately NOT closed, simulating
      // a flake/silent network drop rather than a clean disconnect.
      const firstWs = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(firstWs);
      const firstReadyPromise = waitForMessage(firstWs);
      firstWs.send(JSON.stringify({ type: "pair", code }));
      const { bridge_id, session_id } = await firstReadyPromise;
      const firstClosePromise = waitForClose(firstWs);

      const secondWs = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(secondWs);
      const secondReplyPromise = waitForMessage(secondWs);
      secondWs.send(JSON.stringify({ type: "auth", bridge_id, session_id: session_id! }));
      await secondReplyPromise;

      // The FIRST socket must have been closed by the server as a side
      // effect of the second connection's successful auth — not left
      // dangling.
      await firstClosePromise;
      expect(app.connectedBridges.get(bridge_id!)).not.toBeUndefined();

      secondWs.close();
    });

    it("rejects a wrong session id for a real bridge, closing the connection", async () => {
      const { port } = await buildAndListen();
      const { bridge_id } = await pairFreshBridge(port);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      const closePromise = waitForClose(ws);
      ws.send(JSON.stringify({ type: "auth", bridge_id, session_id: "wrong" }));

      expect((await replyPromise).type).toBe("error");
      await closePromise;
    });

    it("rejects auth against an unknown bridge id", async () => {
      const { port } = await buildAndListen();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      const closePromise = waitForClose(ws);
      ws.send(JSON.stringify({ type: "auth", bridge_id: "does-not-exist", session_id: "x" }));

      expect((await replyPromise).type).toBe("error");
      await closePromise;
    });
  });

  describe("POST /api/bridges/renew (round 3, session renewal)", () => {
    async function pairFreshBridge(port: number) {
      const res = await fetch(`http://127.0.0.1:${port}/api/bridges`, { method: "POST" });
      const body = (await res.json()) as { bridge_id: string; pairing_payload: string };
      const { code } = decodePairingPayload(body.pairing_payload)!;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "pair", code }));
      const reply = await replyPromise;
      ws.close();
      await waitForClose(ws);
      return reply as Required<Pick<HandshakeReply, "bridge_id" | "session_id" | "expires_at">>;
    }

    it("rotates the session and returns a fresh id + expiry", async () => {
      const { port } = await buildAndListen();
      const { bridge_id, session_id, expires_at } = await pairFreshBridge(port);

      const res = await fetch(`http://127.0.0.1:${port}/api/bridges/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bridge_id, session_id }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { session_id: string; expires_at: string };
      expect(typeof body.session_id).toBe("string");
      expect(body.session_id).not.toBe(session_id);
      // A fresh session gets a fresh 24h deadline, not the same instant as
      // the one just replaced — confirms this is a real rotation, not an
      // echo of the row's unchanged expiry.
      expect(new Date(body.expires_at).getTime()).toBeGreaterThan(new Date(expires_at).getTime());
    });

    it("invalidates the OLD session id — a later auth with it is rejected", async () => {
      const { port } = await buildAndListen();
      const { bridge_id, session_id } = await pairFreshBridge(port);

      await fetch(`http://127.0.0.1:${port}/api/bridges/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bridge_id, session_id }),
      });

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      const closePromise = waitForClose(ws);
      ws.send(JSON.stringify({ type: "auth", bridge_id, session_id }));
      expect((await replyPromise).type).toBe("error");
      await closePromise;
    });

    it("a renewed session id DOES authenticate a later auth handshake", async () => {
      const { app, port } = await buildAndListen();
      const { bridge_id, session_id } = await pairFreshBridge(port);

      const renewRes = await fetch(`http://127.0.0.1:${port}/api/bridges/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bridge_id, session_id }),
      });
      const { session_id: renewedSessionId } = (await renewRes.json()) as { session_id: string };

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "auth", bridge_id, session_id: renewedSessionId }));
      const reply = await replyPromise;
      expect(reply.type).toBe("ready");
      expect(app.connectedBridges.has(bridge_id)).toBe(true);
      ws.close();
    });

    it("does NOT disrupt an already-open, actively-forwarding connection", async () => {
      const { app, port } = await buildAndListen();
      const { bridge_id, session_id } = await pairFreshBridge(port);

      // A second, live connection for the SAME bridge (a fresh auth,
      // distinct from the one pairFreshBridge already closed).
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const readyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "auth", bridge_id, session_id }));
      await readyPromise;
      const bridge = app.connectedBridges.get(bridge_id)!;

      // Renew via the HTTP route while that connection stays open — this is
      // the entire point of a route separate from the WS: the live
      // connection must be completely unaffected.
      const renewRes = await fetch(`http://127.0.0.1:${port}/api/bridges/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bridge_id, session_id }),
      });
      expect(renewRes.status).toBe(200);

      // Still the SAME tracked connection (not superseded, re-tracked, or
      // torn down) and the raw socket is still open — the renewal touched
      // only the DB row, never this live WS. (Not exercising a full
      // channel round-trip here: that needs a real peer-side mux to ack the
      // Open frame, which this bare test `ws` isn't; test/cli/ssh-agent-
      // helper.test.ts's real-helper harness covers that side.)
      expect(app.connectedBridges.get(bridge_id)).toBe(bridge);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    });

    it("rejects a stale/wrong session id without rotating anything", async () => {
      const { port } = await buildAndListen();
      const { bridge_id } = await pairFreshBridge(port);

      const res = await fetch(`http://127.0.0.1:${port}/api/bridges/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bridge_id, session_id: "wrong" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects renewal against an unknown bridge id", async () => {
      const { port } = await buildAndListen();
      const res = await fetch(`http://127.0.0.1:${port}/api/bridges/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bridge_id: "does-not-exist", session_id: "x" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects renewal of a session that's since been revoked", async () => {
      const { port } = await buildAndListen();
      const { bridge_id, session_id } = await pairFreshBridge(port);

      const deleteRes = await fetch(`http://127.0.0.1:${port}/api/bridges/${bridge_id}`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(204);

      const res = await fetch(`http://127.0.0.1:${port}/api/bridges/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bridge_id, session_id }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects a malformed body without throwing", async () => {
      const { port } = await buildAndListen();
      const res = await fetch(`http://127.0.0.1:${port}/api/bridges/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonsense: true }),
      });
      expect(res.status).toBe(400);
    });

    // The actual isProtectedPath exemption (does this route stay reachable
    // with MULLION_AUTH_TOKEN genuinely enabled and no session cookie
    // presented) is covered where it belongs — test/plugins/auth.test.ts's
    // own "POST /api/bridges/renew exemption" block, which turns real auth
    // on. This file's buildTestApp() never sets MULLION_AUTH_TOKEN, so the
    // global hook is a no-op here regardless of what isProtectedPath says —
    // a test in THIS file asserting "reachable with no credential" would
    // pass even with the exemption deleted, proving nothing.
  });

  describe("GET /ws/agent-bridge — malformed handshakes", () => {
    it("rejects a binary first frame", async () => {
      const { port } = await buildAndListen();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      const closePromise = waitForClose(ws);
      ws.send(new Uint8Array([1, 2, 3]));

      const reply = await replyPromise;
      expect(reply.type).toBe("error");
      expect(reply.message).toMatch(/binary/);
      await closePromise;
    });

    it("rejects a non-JSON first frame", async () => {
      const { port } = await buildAndListen();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      const closePromise = waitForClose(ws);
      ws.send("not json at all");

      const reply = await replyPromise;
      expect(reply.type).toBe("error");
      expect(reply.message).toMatch(/valid JSON/);
      await closePromise;
    });

    it("rejects well-formed JSON with an unrecognized shape", async () => {
      const { port } = await buildAndListen();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      const closePromise = waitForClose(ws);
      ws.send(JSON.stringify({ type: "not-a-real-type" }));

      expect((await replyPromise).type).toBe("error");
      await closePromise;
    });

    it("rejects a pair handshake missing its code field", async () => {
      const { port } = await buildAndListen();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      const closePromise = waitForClose(ws);
      ws.send(JSON.stringify({ type: "pair" }));

      expect((await replyPromise).type).toBe("error");
      await closePromise;
    });
  });

  describe("connectedBridges cleanup", () => {
    it("removes the bridge from connectedBridges when the socket closes", async () => {
      const { app, port } = await buildAndListen();
      const pairRes = await app.inject({ method: "POST", url: "/api/bridges" });
      const { code } = decodePairingPayload(pairRes.json().pairing_payload)!;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "pair", code }));
      const reply = await replyPromise;
      expect(app.connectedBridges.has(reply.bridge_id!)).toBe(true);

      const closePromise = waitForClose(ws);
      ws.close();
      await closePromise;
      await waitUntil(() => !app.connectedBridges.has(reply.bridge_id!));
    });

    // Issue #1047 — a transport-level error (ECONNRESET, malformed frame,
    // TLS handshake failure, midstream reset) fires the WebSocket's "error"
    // event before its "close". Without an "error" listener attached,
    // Node's EventEmitter throws on the unhandled "error" event and the
    // server process dies before the existing "close" handler can run its
    // connectedBridges cleanup. Uses the `ws` package's client (not the
    // global WebSocket) to reach `_socket` for the raw-byte trigger the
    // protocol parser actually rejects — the global WebSocket has no way
    // to bypass its own framing.
    it("removes the bridge from connectedBridges when a transport-level error fires the WS error event (issue #1047)", async () => {
      const { app, port } = await buildAndListen();
      const pairRes = await app.inject({ method: "POST", url: "/api/bridges" });
      const { code } = decodePairingPayload(pairRes.json().pairing_payload)!;

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const reply = await new Promise<HandshakeReply>((resolve, reject) => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
        ws.once("error", reject);
        ws.send(JSON.stringify({ type: "pair", code }));
      });
      expect(app.connectedBridges.has(reply.bridge_id!)).toBe(true);

      // Raw bytes that fail the server's frame parser — the receiver
      // rejects them with "Invalid WebSocket frame: …" and emits "error"
      // on the WebSocket before "close". Exactly the failure shape issue
      // #1047 reproduces: a transport-level fault that lands BEFORE close.
      ws._socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));

      await waitUntil(() => !app.connectedBridges.has(reply.bridge_id!));
    });

    // Issue #1047, regression guard. The original test above only asserts
    // on `connectedBridges` cleanup, which is a side effect of the close
    // path — `ws`'s Receiver calls `websocket.close()` BEFORE
    // `emit('error', err)`, so the existing close handler runs regardless
    // of whether the route attached an "error" listener, and the test
    // passed whether or not the fix was in place (Hermes review).
    //
    // This test isolates the route's own error listener. The route is
    // the only thing that registers a listener for the window between
    // upgrade completion and handshake — MuxConnection only attaches its
    // `teardown` error listener AFTER a successful handshake. The
    // fastify-websocket plugin also attaches a generic
    // `(error) => { fastify.log.error(error) }` listener, which alone
    // would swallow the error; this test strips that one too so the only
    // listener left protecting the server is the route's `() => {}`.
    // Without the fix, that strip leaves the WebSocket with zero error
    // listeners, the receiver's emit('error') throws, and the test
    // process gets an `uncaughtException`.
    it("attaches an error listener on the bridge-route WebSocket so a pre-handshake transport error doesn't crash the server (issue #1047)", async () => {
      const { app, port } = await buildAndListen();

      // Open the WS but deliberately do NOT send a handshake — that's the
      // window where only the route's own listeners (and the
      // fastify-websocket plugin's generic one) are on the socket.
      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      // Wait for the route handler to attach its listeners (server-side
      // socket is registered synchronously during the upgrade, but we
      // give the event loop a tick in case anything is deferred).
      const wss = (app as { websocketServer?: { clients: Set<NodeWebSocket> } }).websocketServer;
      expect(wss).toBeDefined();
      await waitUntil(() => wss!.clients.size > 0);
      const serverWs = [...wss!.clients][0];

      // Strip the fastify-websocket plugin's generic error logger — its
      // only job is to swallow errors, so leaving it in place would mask
      // whether the ROUTE'S listener (the one this PR adds) is needed.
      for (const listener of serverWs.listeners("error")) {
        const src = (listener as (...args: unknown[]) => unknown).toString();
        if (src.includes("fastify.log.error")) {
          serverWs.off("error", listener as (...args: unknown[]) => void);
        }
      }

      // Capture any uncaughtException the malformed-frame write triggers.
      const uncaught: Error[] = [];
      const onUncaught = (err: Error) => uncaught.push(err);
      process.on("uncaughtException", onUncaught);

      // Malformed frame: RSV bits set, which the receiver rejects with
      // "Invalid WebSocket frame: RSV2 and RSV3 must be clear" and
      // surfaces as 'error' on the WebSocket. Without the route's
      // `() => {}` listener and with the fastify one removed, this
      // throw has nowhere to go and surfaces as uncaughtException.
      ws._socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));

      await new Promise((resolve) => setTimeout(resolve, 200));
      process.off("uncaughtException", onUncaught);

      expect(uncaught).toEqual([]);
    });
  });

  describe("MuxConnection wrapping (issue #820, PR5b)", () => {
    it("wraps a successfully-paired socket in a usable MuxConnection — closing it tears down the underlying socket too", async () => {
      const { app, port } = await buildAndListen();
      const pairRes = await app.inject({ method: "POST", url: "/api/bridges" });
      const { code } = decodePairingPayload(pairRes.json().pairing_payload)!;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "pair", code }));
      const reply = await replyPromise;

      const bridge = app.connectedBridges.get(reply.bridge_id!);
      expect(bridge).toBeDefined();
      expect(typeof bridge!.mux.openChannel).toBe("function");
      expect(typeof bridge!.mux.onChannel).toBe("function");

      // MuxConnection.close() closes every open channel AND the
      // underlying WebSocket (ssh-agent-mux.ts) — proving `.mux` is a real,
      // live wrapper around the SAME socket the client is holding, not an
      // inert decoration, and that the route's own pre-existing "close"
      // handler still fires (and cleans up connectedBridges) as a
      // consequence, exactly as it would for a client-initiated close.
      const closePromise = waitForClose(ws);
      bridge!.mux.close();
      await closePromise;
      await waitUntil(() => !app.connectedBridges.has(reply.bridge_id!));
    });
  });

  // This file's other describe blocks share ONE persistent DB (the outer
  // beforeAll's tmpDb) across every test, run in declaration order — by
  // the time these blocks run, earlier tests (pairing, MuxConnection,
  // connectedBridges cleanup) have already left their own bridge rows
  // behind. So these tests find/filter their own bridge by id rather than
  // assert the full list's exact contents, the same accommodation any
  // later-declared test in a shared-fixture file has to make.
  describe("GET /api/bridges (PR7b)", () => {
    it("returns a well-formed array (smoke test — this file's shared DB may already hold bridges from earlier tests)", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/bridges" });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it("lists a paired bridge with its name/platform, hasLiveSession and connected both true", async () => {
      const { app, port } = await buildAndListen();
      const pairRes = await app.inject({ method: "POST", url: "/api/bridges" });
      const { code } = decodePairingPayload(pairRes.json().pairing_payload)!;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "pair", code, name: "laptop-1", platform: "darwin" }));
      const reply = await replyPromise;

      const listRes = await app.inject({ method: "GET", url: "/api/bridges" });
      const entry = (listRes.json() as Array<Record<string, unknown>>).find(
        (b) => b.id === reply.bridge_id,
      );
      expect(entry).toMatchObject({
        name: "laptop-1",
        platform: "darwin",
        hasLiveSession: true,
        connected: true,
      });
      // BridgeListItem must only ever carry bridge-registry.ts's already-
      // sanitized BridgeSummary fields, never a raw BridgeRow (which has
      // pairingSecretEnc/sessionIdEnc/sessionSecretEnc columns) — pinned
      // explicitly rather than left to toMatchObject's subset match above,
      // which would stay green even if a future edit reintroduced one of
      // these into the response.
      expect(Object.keys(entry!).sort()).toEqual(
        ["connected", "createdAt", "hasLiveSession", "id", "lastSeenAt", "name", "platform"].sort(),
      );
      ws.close();
    });

    // Distinguishes "paired, credential still valid" from "a helper is
    // actually reachable right now" — the exact split BridgeListItem's own
    // comment documents. A false "connected: true" here would tell an
    // operator revoking a stale/offline bridge is pointless busywork when
    // it's actually the normal way to clean one up.
    it("reports connected: false once the socket closes, while hasLiveSession stays true", async () => {
      const { app, port } = await buildAndListen();
      const pairRes = await app.inject({ method: "POST", url: "/api/bridges" });
      const { code } = decodePairingPayload(pairRes.json().pairing_payload)!;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "pair", code }));
      const reply = await replyPromise;

      const closePromise = waitForClose(ws);
      ws.close();
      await closePromise;
      await waitUntil(() => !app.connectedBridges.has(reply.bridge_id!));

      const listRes = await app.inject({ method: "GET", url: "/api/bridges" });
      const entry = (listRes.json() as Array<Record<string, unknown>>).find(
        (b) => b.id === reply.bridge_id,
      );
      expect(entry).toMatchObject({ hasLiveSession: true, connected: false });
    });
  });

  describe("DELETE /api/bridges/:id (PR7b)", () => {
    it("404s an unknown bridge id", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "DELETE", url: "/api/bridges/does-not-exist" });
      expect(res.statusCode).toBe(404);
    });

    it("deletes an unpaired (pairing-code-only) row", async () => {
      const app = await buildTestApp();
      const pairing = issuePairingCode(app);

      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/bridges/${pairing.bridgeId}`,
      });
      expect(delRes.statusCode).toBe(204);

      const listRes = await app.inject({ method: "GET", url: "/api/bridges" });
      const entry = (listRes.json() as Array<Record<string, unknown>>).find(
        (b) => b.id === pairing.bridgeId,
      );
      expect(entry).toBeUndefined();
    });

    // The discriminating case (advisor review, PR7b): revoke must actually
    // sever an already-connected helper's channel, not just delete the DB
    // row — otherwise a "revoked" bridge keeps serving signatures through
    // its still-open mux until its socket happens to drop on its own,
    // defeating the entire point of revoke.
    it("closes the live connection AND removes it from connectedBridges when revoking a connected bridge — not just the row", async () => {
      const { app, port } = await buildAndListen();
      const pairRes = await app.inject({ method: "POST", url: "/api/bridges" });
      const { code } = decodePairingPayload(pairRes.json().pairing_payload)!;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "pair", code }));
      const reply = await replyPromise;
      expect(app.connectedBridges.has(reply.bridge_id!)).toBe(true);

      const closePromise = waitForClose(ws);
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/bridges/${reply.bridge_id}`,
      });
      expect(delRes.statusCode).toBe(204);

      // The helper's own socket must actually die — proves this isn't just
      // a DB delete, the live MuxConnection was really torn down.
      await closePromise;
      await waitUntil(() => !app.connectedBridges.has(reply.bridge_id!));

      const listRes = await app.inject({ method: "GET", url: "/api/bridges" });
      const entry = (listRes.json() as Array<Record<string, unknown>>).find(
        (b) => b.id === reply.bridge_id,
      );
      expect(entry).toBeUndefined();
    });
  });

  describe("auth gate exemption (issue #820)", () => {
    const TEST_TOKEN = "test-auth-token-0123456789"; // pragma: allowlist secret
    const TEST_SECRET = "test-session-secret-0123456789"; // pragma: allowlist secret

    // beforeEach/afterEach, not a manual set-then-delete inline in each
    // test body (PR7b — the original shape here left the two env vars set
    // for the rest of the file if an assertion above a test's own cleanup
    // lines ever threw, since only afterAll backstopped it, not afterEach).
    beforeEach(() => {
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
    });
    afterEach(() => {
      delete process.env.MULLION_AUTH_TOKEN;
      delete process.env.MULLION_SESSION_SECRET;
    });

    it("POST /api/bridges requires the configured MULLION_AUTH_TOKEN", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "POST", url: "/api/bridges" });
      expect(res.statusCode).toBe(401);
    });

    // PR7b — GET/DELETE /api/bridges are the same Settings-side admin
    // surface as POST just above (list/revoke enrolled bridges), not the
    // helper's own credentialed WS connection — they must stay behind the
    // normal gate too, not silently inherit /ws/agent-bridge's exemption
    // just by sharing the /api/bridges prefix.
    it("GET /api/bridges requires the configured MULLION_AUTH_TOKEN", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/bridges" });
      expect(res.statusCode).toBe(401);
    });

    it("DELETE /api/bridges/:id requires the configured MULLION_AUTH_TOKEN", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "DELETE", url: "/api/bridges/does-not-exist" });
      expect(res.statusCode).toBe(401);
    });

    it("GET /ws/agent-bridge's handshake is reachable with NO MULLION_AUTH_TOKEN credential, even when one is configured", async () => {
      const { app, port } = await buildAndListen();

      // Issue the pairing code via the registry directly (bypassing the
      // now-gated POST /api/bridges) so this test isolates exactly the
      // claim under test: the WS upgrade itself needs no Authorization
      // header or session cookie.
      const pairing = issuePairingCode(app);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-bridge`);
      await waitForOpen(ws);
      const replyPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "pair", code: pairing.code }));
      const reply = await replyPromise;

      expect(reply.type).toBe("ready");
      ws.close();
    });
  });
});
