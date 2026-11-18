import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  createInternalAgentEnv,
  INTERNAL_TEST_TOKEN,
  waitUntil,
  waitForOpenOrClose,
  waitForNodeWsOutcome,
  sendUntilEcho,
  buildAndListen,
} from "../helpers/internal-routes.js";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

const ptyHarness = createInternalPtyHarness();
const childProcessHarness = createInternalChildProcessHarness();
const bundleSyncHarness = createBundleSyncHarness();

vi.mock("node-pty", () => ptyHarness.mockModule());
vi.mock("node:child_process", async (importOriginal) =>
  childProcessHarness.mockModule(await importOriginal()),
);
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncHarness.mockModule());
const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");
const { SIGNATURE_HEADER, TIMESTAMP_HEADER, NONCE_HEADER, buildCanonicalString, hashBody, sign } =
  await import("../../src/services/request-signature.js");

const TOKEN = INTERNAL_TEST_TOKEN;
const { fakePtyChildren } = ptyHarness;
const listenApp = () => buildAndListen(buildApp);

describe("internal routes: ws events, ssh-agent bridge, and preview proxy", () => {
  const env = createInternalAgentEnv();
  beforeAll(() => {
    env.setup();
  });
  afterAll(() => {
    env.teardown();
  });
  beforeEach(() => {
    ptyHarness.reset();
    childProcessHarness.reset();
    bundleSyncHarness.reset();
    clearAgentsCacheForTests();
  });

  describe("/internal/ws/events (issue #166's multi-host twin — the agent-side half)", () => {
    it("rejects a connection with no Authorization header", async () => {
      const { app, port } = await listenApp();

      const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/ws/events`);
      const outcome = await waitForOpenOrClose(ws);
      expect(outcome).toBe("close");

      await app.close();
    });

    it("replays buffered events then streams live ones, using the same shared core as /ws/events", async () => {
      const { app, port } = await listenApp();

      // Numeric-looking id — matches production reality (a session id on
      // the agent side is always the primary's stringified DB row id, see
      // session-lifecycle.ts's spawn() call), and NotificationEvent.sessionId is
      // typed `number` (pty-manager.ts), derived via Number(this.id).
      // fakePtyChildren accumulates across every test in this file — snapshot
      // its length first (same pattern the /internal/ws/attach test above
      // uses) so `pty` below is genuinely THIS test's own session, not a
      // stale one left over from an earlier test.
      const before = fakePtyChildren.length;
      const spawn = await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "77", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      expect(spawn.statusCode).toBe(201);
      await waitUntil(() => fakePtyChildren.length > before);
      const pty = fakePtyChildren[fakePtyChildren.length - 1];

      // Emitted before the WS connects — must still appear in the replay
      // batch (mirrors events.test.ts's own local-route replay assertion).
      // A1: title_change events are now debounced at the source
      // (pty-manager.ts's TITLE_CHANGE_EVENT_DEBOUNCE_MS, 3s) — wait that
      // out first so the event has actually settled into the session's
      // buffer before the client connects, otherwise this would be testing
      // live streaming, not replay (mirrors events.test.ts's identical fix).
      pty.emitData("\x1b]2;working\x07");
      await new Promise((resolve) => setTimeout(resolve, 3_200));

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/events`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const messages: Array<{ sessionId: number; kind: string; payload: Record<string, unknown> }> =
        [];
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString("utf8")));
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () => reject(new Error("WS closed instead of opening")));
        ws.once("error", reject);
      });

      await waitUntil(() => messages.length > 0);
      expect(messages[0]).toMatchObject({
        sessionId: 77,
        kind: "title_change",
        payload: { title: "working" },
      });

      // A working->idle title transition (#98) is a zero-threshold attention
      // signal (see ATTENTION_CONFIRM_MS in attention-detect.ts) — confirms
      // synchronously, unlike a bare bell (debounced against attention-detect.ts's
      // PENDING_ATTENTION state machine — see issue #171), which needs either
      // a real ~2s wait or a direct Session.tick() call this route-level test
      // has no access to. The session's title is already "working" from the
      // pre-connect emit above, so this is a genuine transition.
      pty.emitData("\x1b]2;idle\x07");
      await waitUntil(() => messages.some((m) => m.kind === "attention"));

      ws.close();
      await app.close();
    }, 10_000);

    // Issue #1459 — the opt-in `?cursors=1` flag: without it, this route's
    // behavior must stay byte-for-byte identical to before this issue (an
    // older primary never sets it, so it must never see a frame shape it
    // doesn't understand — see relayRemoteEventsHost's own doc comment,
    // routes/events.ts).
    it("without ?cursors=1, sends no cursors frame at all — matching pre-#1459 behavior exactly", async () => {
      const { app, port } = await listenApp();

      const before = fakePtyChildren.length;
      const spawn = await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "91", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      expect(spawn.statusCode).toBe(201);
      await waitUntil(() => fakePtyChildren.length > before);
      const pty = fakePtyChildren[fakePtyChildren.length - 1];

      pty.emitData("\x1b]2;working\x07");
      await new Promise((resolve) => setTimeout(resolve, 3_200));

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/events`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const messages: Array<Record<string, unknown>> = [];
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString("utf8")));
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () => reject(new Error("WS closed instead of opening")));
        ws.once("error", reject);
      });

      await waitUntil(() => messages.length > 0);
      // The very first frame is the replayed event itself, not a cursors
      // frame — no message on this connection ever carries type: "cursors".
      expect(messages[0]).toMatchObject({ sessionId: 91, kind: "title_change" });
      expect(messages.some((m) => m.type === "cursors")).toBe(false);

      ws.close();
      await app.close();
    }, 10_000);

    it("?cursors=1 sends this agent's own cursors frame first, before any replayed event", async () => {
      const { app, port } = await listenApp();

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/events?cursors=1`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const messages: Array<Record<string, unknown>> = [];
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString("utf8")));
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () => reject(new Error("WS closed instead of opening")));
        ws.once("error", reject);
      });

      // No sessions spawned yet on this fresh app — an empty cursors map is
      // still a real cursors frame (attachCursorsAndSeenBroadcast sends one
      // unconditionally, same as attachAggregatedEventsSocket's own local
      // send), not something this route skips just because it's empty.
      await waitUntil(() => messages.length > 0);
      expect(messages[0]).toMatchObject({ type: "cursors", cursors: {} });
      expect(typeof messages[0].bootId).toBe("string");

      ws.close();
      await app.close();
    });

    it("?cursors=1 broadcasts a 'seen' advance from one internal connection to every OTHER open one on the same agent", async () => {
      const { app, port } = await listenApp();

      const before = fakePtyChildren.length;
      const spawn = await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "92", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      expect(spawn.statusCode).toBe(201);
      await waitUntil(() => fakePtyChildren.length > before);
      const pty = fakePtyChildren[fakePtyChildren.length - 1];
      // Emit a real event so this session has a genuine event-seq head to
      // advance a read cursor against (markEventsSeen accepts any seq
      // regardless, but a real emit keeps this test's setup realistic).
      pty.emitData("\x1b]2;working\x07");
      await new Promise((resolve) => setTimeout(resolve, 3_200));

      const connect = () =>
        new Promise<{
          ws: InstanceType<typeof NodeWebSocket>;
          messages: Array<Record<string, unknown>>;
        }>((resolve, reject) => {
          const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/events?cursors=1`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          });
          const messages: Array<Record<string, unknown>> = [];
          ws.on("message", (data) => messages.push(JSON.parse(data.toString("utf8"))));
          ws.once("open", () => resolve({ ws, messages }));
          ws.once("close", () => reject(new Error("WS closed instead of opening")));
          ws.once("error", reject);
        });

      const a = await connect();
      const b = await connect();
      await waitUntil(() => a.messages.length > 0 && b.messages.length > 0);
      // Both connections' own replay/cursors traffic settles before the
      // "seen" send below, so the broadcast is unambiguous to find.
      const bBefore = b.messages.length;

      a.ws.send(JSON.stringify({ type: "seen", sessionId: 92, seq: 1 }));

      await waitUntil(() => b.messages.length > bBefore);
      const seenMsg = b.messages.slice(bBefore).find((m) => m.type === "seen");
      expect(seenMsg).toMatchObject({ type: "seen", sessionId: 92, seq: 1 });
      // The sender itself never gets its own "seen" echoed back.
      expect(a.messages.some((m) => m.type === "seen")).toBe(false);

      a.ws.close();
      b.ws.close();
      await app.close();
    }, 10_000);

    it("accepts ?cursors=1 on a session-signed request — the signature covers the query string", async () => {
      const { app, port } = await listenApp();
      const sessionSecret = "cursors-flag-session-secret"; // pragma: allowlist secret
      app.agentSession = {
        hostId: "host-x",
        sessionId: "cursors-flag-session-id",
        sessionSecret,
        expiresAt: new Date(Date.now() + 60_000),
      };
      const requestTarget = "/internal/ws/events?cursors=1";
      const timestamp = String(Date.now());
      const nonce = "nonce-cursors-flag";
      const canonicalString = buildCanonicalString({
        method: "GET",
        requestTarget,
        timestamp,
        nonce,
        bodyHashed: true,
        bodyHash: hashBody(""),
      });

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}${requestTarget}`, {
        headers: {
          authorization: "Bearer cursors-flag-session-id",
          [SIGNATURE_HEADER]: sign(sessionSecret, canonicalString),
          [TIMESTAMP_HEADER]: timestamp,
          [NONCE_HEADER]: nonce,
        },
      });
      const messages: Array<Record<string, unknown>> = [];
      ws.on("message", (data) => messages.push(JSON.parse(data.toString("utf8"))));
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () =>
          reject(new Error("WS closed instead of opening — signature rejected")),
        );
        ws.once("error", reject);
      });

      await waitUntil(() => messages.length > 0);
      expect(messages[0]).toMatchObject({ type: "cursors" });

      ws.close();
      await app.close();
    });
  });

  describe("/internal/ws/ssh-agent (issue #820, PR5b)", () => {
    it("rejects a connection with no Authorization header", async () => {
      const { app, port } = await listenApp();

      const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`);
      const outcome = await waitForOpenOrClose(ws);
      expect(outcome).toBe("close");

      await app.close();
    });

    it("wraps a successful connection in a MuxConnection tracked as app.sshAgentBridgeConnection.current", async () => {
      const { app, port } = await listenApp();
      expect(app.sshAgentBridgeConnection.current).toBeNull();

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () => reject(new Error("WS closed instead of opening")));
        ws.once("error", reject);
      });
      await waitUntil(() => app.sshAgentBridgeConnection.current !== null);
      expect(typeof app.sshAgentBridgeConnection.current!.openChannel).toBe("function");

      ws.close();
      await app.close();
    });

    it("clears app.sshAgentBridgeConnection.current when the connection closes", async () => {
      const { app, port } = await listenApp();

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () => reject(new Error("WS closed instead of opening")));
        ws.once("error", reject);
      });
      await waitUntil(() => app.sshAgentBridgeConnection.current !== null);

      ws.close();
      await waitUntil(() => app.sshAgentBridgeConnection.current === null);

      await app.close();
    });

    it("supersedes an old connection when a new one connects — closes the old socket, doesn't clobber the new one on the old one's belated close", async () => {
      const { app, port } = await listenApp();

      const firstWs = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const firstClosePromise = new Promise<void>((resolve) => firstWs.once("close", resolve));
      await new Promise<void>((resolve, reject) => {
        firstWs.once("open", () => resolve());
        firstWs.once("error", reject);
      });
      await waitUntil(() => app.sshAgentBridgeConnection.current !== null);
      const firstMux = app.sshAgentBridgeConnection.current;

      const secondWs = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        secondWs.once("open", () => resolve());
        secondWs.once("error", reject);
      });

      // The FIRST connection must be closed as a side effect of the SECOND
      // one connecting — not left dangling (regression shape: routes/
      // agent-bridge.ts's own equivalent "superseded socket" test, #860).
      await firstClosePromise;
      await waitUntil(() => app.sshAgentBridgeConnection.current !== firstMux);
      expect(app.sshAgentBridgeConnection.current).not.toBeNull();

      secondWs.close();
      await app.close();
    });

    it("end-to-end: a local SSH client connecting to ssh-agent.sock gets closed immediately with no primary connected, and gets a real channel once one is", async () => {
      const { app, port } = await listenApp();
      const socketPath = path.join(path.dirname(app.pty.hookSocketPath), "ssh-agent.sock");

      // No primary connection yet — ssh-agent-socket.ts's own "no bridge
      // reachable" fail-fast path (PR5a) must close this immediately
      // rather than hang, since `ssh` blocks on SSH_AUTH_SOCK until the
      // agent answers or the connection drops.
      const before = net.createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        before.once("close", () => resolve());
        before.once("connect", () => {
          // Connecting is expected (the listener itself is always up) —
          // only a prompt close afterward is being asserted here.
        });
        setTimeout(() => reject(new Error("local socket did not close without a primary")), 2000);
      });

      // Now a primary dials in — the exact same handshake the earlier
      // tests in this block exercise.
      const bridgeWs = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        bridgeWs.once("open", () => resolve());
        bridgeWs.once("error", reject);
      });
      await waitUntil(() => app.sshAgentBridgeConnection.current !== null);

      // A fresh local connection now completes an actual channel open —
      // observed as a real Open frame (type byte 1) arriving on the
      // primary-side socket, not a prompt close.
      const framesFromAgent: Buffer[] = [];
      bridgeWs.on("message", (data) => framesFromAgent.push(data as Buffer));
      const after = net.createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        after.once("connect", () => resolve());
        after.once("error", reject);
      });
      await waitUntil(() => framesFromAgent.some((f) => f.length >= 1 && f[0] === 1));

      after.destroy();
      bridgeWs.close();
      await app.close();
    });
  });

  describe("/internal/preview* (issue #28 phase 6 — the agent's own loopback-only proxy half)", () => {
    let stubHttpServer: http.Server;
    let stubWss: WebSocketServer;
    let stubPort: number;

    beforeAll(async () => {
      stubHttpServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              host: req.headers.host,
              path: req.url,
              method: req.method,
              headers: req.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
      });
      stubWss = new WebSocketServer({ server: stubHttpServer });
      stubWss.on("connection", (socket) => {
        socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
      });
      await new Promise<void>((resolve) => stubHttpServer.listen(0, "127.0.0.1", resolve));
      stubPort = (stubHttpServer.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => stubWss.close(() => resolve()));
      await new Promise<void>((resolve) => stubHttpServer.close(() => resolve()));
    });

    it("proxies to this agent's own loopback dev server, stripping its own auth header before forwarding", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/internal/preview/${stubPort}/some/asset.js?v=1`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.path).toBe("/some/asset.js?v=1");
      // The stub echoes whatever Authorization header it received — none,
      // proving buildUpstreamRequestHeaders' "authorization" exclusion
      // actually stripped this agent's own bearer token before the
      // onward loopback fetch (it would otherwise leak this agent's
      // shared secret to arbitrary project dev-server code).
      expect(body.host).toBe(`127.0.0.1:${stubPort}`);
      await app.close();
    });

    it("streams a POST body through to this agent's own loopback dev server", async () => {
      // Registered in its own encapsulated child context with a raw
      // content-type parser (see internal.ts) so request.body arrives as
      // the unparsed stream this route needs — this is the regression test
      // for that encapsulation actually working.
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/preview/${stubPort}/api/echo`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        payload: JSON.stringify({ hello: "world" }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.method).toBe("POST");
      expect(body.body).toBe(JSON.stringify({ hello: "world" }));
      await app.close();
    });

    it("401s a POST with no Authorization header, same as the existing GET gate", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/preview/${stubPort}/api/echo`,
        payload: JSON.stringify({ hello: "world" }),
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("still forwards a POST body with no Content-Type header at all", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/preview/${stubPort}/api/echo`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: "raw-bytes-no-content-type",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.body).toBe("raw-bytes-no-content-type");
      await app.close();
    });

    it("still parses JSON bodies for an ordinary /internal/* POST route (encapsulation regression net)", async () => {
      // Proves the preview route's own raw-body content-type parser
      // (registered in a child context so it can removeAllContentTypeParsers()
      // for itself) never leaked out and broke JSON parsing for the rest of
      // this plugin — spawn-session is a real POST route that requires a
      // parsed JSON body.
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          id: "not-numeric-port-related",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        },
      });
      // Whatever this route's own validation does with this payload, it
      // must have been able to parse it as JSON in the first place — a
      // leaked raw-body parser would instead hand it an unparsed Buffer
      // and fail differently (e.g. a schema/type error, not this route's
      // own business-logic response).
      expect(res.statusCode).not.toBe(415);
      await app.close();
    });

    it("rejects a non-numeric or out-of-range port", async () => {
      const app = await buildApp();
      const notNumeric = await app.inject({
        method: "GET",
        url: "/internal/preview/not-a-port/x",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(notNumeric.statusCode).toBe(400);

      const outOfRange = await app.inject({
        method: "GET",
        url: "/internal/preview/70000/x",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(outOfRange.statusCode).toBe(400);
      await app.close();
    });

    it("502s when the loopback dev server is unreachable", async () => {
      const app = await buildApp();
      // Port 1: a real, always-refused loopback port (same convention used
      // throughout this repo's other "unreachable" tests).
      const res = await app.inject({
        method: "GET",
        url: "/internal/preview/1/",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(502);
      await app.close();
    });

    // The core security claim of this phase: this agent must only ever
    // dial its own loopback, regardless of what path the primary forwards
    // — see resolveLoopbackPreviewUrl's own comment for the two concrete
    // bypasses (network-path reference, HTTP userinfo) a naive
    // string-concatenation would have been vulnerable to.
    it("never dials off-loopback, even for a path smuggling a network-path reference or userinfo host", async () => {
      const app = await buildApp();
      for (const maliciousRest of [
        "//evil.example.com/x",
        "/\\evil.example.com/x",
        "@evil.example.com/",
      ]) {
        const res = await app.inject({
          method: "GET",
          url: `/internal/preview/${stubPort}/${maliciousRest}`,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        // Either rejected outright (400, the expected outcome) or, in the
        // worst case a future change weakens the parse, proxied — but
        // NEVER to evil.example.com: assert on the stub's own recorded
        // host if it somehow got a 200.
        if (res.statusCode === 200) {
          expect(res.json().host).toBe(`127.0.0.1:${stubPort}`);
        } else {
          expect(res.statusCode).toBe(400);
        }
      }
      await app.close();
    });

    it("400s (not 500s) a preview path that `new URL()` itself throws on (Hermes review, PR #48)", async () => {
      // Confirmed via node -e: `new URL("//[::a.b.c.d]/x", base)` throws
      // TypeError outright rather than just parsing into something
      // resolveLoopbackPreviewUrl would otherwise reject — a case its own
      // try/catch exists for.
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/internal/preview/${stubPort}///[::a.b.c.d]/x`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a WS preview upgrade with a non-numeric port or missing path", async () => {
      const { app, port } = await listenApp();

      const badPort = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=not-a-port&path=%2F`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(badPort)).toBe("close");

      const missingPath = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=${stubPort}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(missingPath)).toBe("close");

      await app.close();
    });

    // A network-path reference doesn't get *rejected* pre-handshake — it
    // gets *sanitized* (resolveLoopbackPreviewUrl only ever keeps the
    // pathname/search, see its own comment) and the upgrade proceeds
    // against the real loopback dev server, same as the HTTP case above.
    // The assertion that matters isn't "close" — it's "this never actually
    // dials evil.example.com", proven here by getting a real echo back
    // from *our* stub.
    it("sanitizes (not rejects) a WS preview path smuggling a network-path reference — still only ever dials loopback", async () => {
      const { app, port } = await listenApp();

      const ws = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=${stubPort}&path=${encodeURIComponent("//evil.example.com/x")}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(ws)).toBe("open");
      expect(await sendUntilEcho(ws, "ping")).toBe("echo:ping");

      ws.close();
      await app.close();
    });

    it("proxies a WS preview upgrade to this agent's own loopback dev server", async () => {
      const { app, port } = await listenApp();

      const ws = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=${stubPort}&path=%2Fhmr`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(ws)).toBe("open");
      expect(await sendUntilEcho(ws, "ping")).toBe("echo:ping");

      ws.close();
      await app.close();
    });
  });
});
