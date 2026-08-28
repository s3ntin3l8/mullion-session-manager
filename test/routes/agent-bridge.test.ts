import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
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
      expect(typeof reply.session_secret).toBe("string");
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

      expect(reply).toEqual({ type: "ready", bridge_id });
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
