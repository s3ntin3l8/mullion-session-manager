import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { createExternalPreview } from "../../src/services/preview-registry.js";
import { PREVIEW_COOKIE_NAME, mintPreviewCookie } from "../../src/services/preview-auth.js";
import { resetPreviewAuthFailuresForTests } from "../../src/plugins/preview-proxy.js";

// Real integration test against a real listening server and real WS
// clients/servers — mirrors terminal.test.ts's own rationale: app.inject()
// can't drive a full-duplex WS upgrade. Uses the `ws` package's own client
// (not the global WebSocket, which has no way to set a custom Host header)
// so a real socket to this test's own ephemeral port can still present
// itself as "preview-<slug>.<PREVIEW_BASE_HOST>" — exactly what the server
// only ever inspects (the Host *header*, never the actual TCP destination).
const tmpDb = path.join(os.tmpdir(), `preview-ws-proxy-test-${process.pid}.db`);
const PREVIEW_BASE_HOST = "preview.test";

let stubHttpServer: http.Server;
let stubWss: WebSocketServer;
let stubPort: number;

function waitForOpenOrClose(ws: NodeWebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("close", () => resolve("close"));
    // A rejected upgrade (non-101 response, e.g. this proxy's own 404/503)
    // surfaces as an 'error' event, not just 'close' — and the `ws` client
    // throws if 'error' has no listener at all (Node's EventEmitter special
    // case for unhandled 'error'), which was silently breaking every
    // rejection-path test's Promise before this existed (it never reached
    // 'close', just hung until the timeout).
    ws.once("error", () => resolve("close"));
  });
}

// Distinguishes *why* an upgrade was rejected (401 vs. 429), unlike
// waitForOpenOrClose above which only reports open/close. rejectUpgrade
// (preview-proxy.ts) hand-writes a raw pre-upgrade HTTP response rather than
// going through Node's http response machinery, but it's still
// syntactically a real status line + headers + blank line, so `ws`'s own
// client parses it as a normal (non-101) HTTP response and emits
// 'unexpected-response' with the real status code, exactly as it would for
// a response built the ordinary way.
function waitForRejectionStatus(ws: NodeWebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("open", () => reject(new Error("expected the upgrade to be rejected, but it opened")));
  });
}

// The browser side of a preview WS connection opens (previewWss.handleUpgrade
// completes its handshake) *before* the proxy's own upstream connection to
// the dev server necessarily has — opening a new socket to it takes a real,
// nonzero amount of time. A message sent immediately after the browser's own
// "open" can therefore land while `upstream.readyState !== OPEN`, which
// pipePreviewWsFrames — deliberately, mirroring proxyToRemoteAttach's own
// documented tradeoff — silently drops rather than queues. Retrying the send
// until a response arrives (rather than sending once and awaiting a fixed
// delay) is what this repo's own polling convention elsewhere
// (terminal.test.ts's waitUntil) does for equivalent "some async setup
// finishes shortly after" gaps.
function sendUntilEcho(ws: NodeWebSocket, message: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const onMessage = (data: Buffer) => {
      clearInterval(interval);
      resolve(data.toString());
    };
    ws.once("message", onMessage);
    const interval = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(interval);
        ws.off("message", onMessage);
        reject(new Error("no response received before timeout"));
        return;
      }
      if (ws.readyState === NodeWebSocket.OPEN) ws.send(message);
    }, 20);
  });
}

async function buildAndListen() {
  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real bound address");
  }
  return { app, port: address.port };
}

async function createProjectWithDevServer(
  app: Awaited<ReturnType<typeof buildApp>>,
  devServerUrl: string,
  // Empty by default — only the "preview-host auth token" describe block
  // below needs this: it also sets MULLION_AUTH_TOKEN (required by app.ts's
  // own boot invariant once PREVIEW_AUTH_REQUIRED is on), which turns
  // authPlugin's gate on for these dashboard-host setup requests too.
  headers: Record<string, string> = {},
) {
  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "ws-proxy-test", cwd: "/tmp/preview-ws-proxy-test" },
    headers,
  });
  const projectId = created.json().id as number;
  await app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    payload: { devServerUrl },
    headers,
  });
  return projectId;
}

async function createProjectPreview(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: number,
  headers: Record<string, string> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/previews",
    payload: { kind: "project", projectId },
    headers,
  });
  return res.json().slug as string;
}

describe("preview proxy plugin — HMR websocket (issue #28, phase 3)", () => {
  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_BASE_HOST = PREVIEW_BASE_HOST;

    stubHttpServer = http.createServer();
    stubWss = new WebSocketServer({ server: stubHttpServer });
    stubWss.on("connection", (socket, req) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.send(data, { binary: true });
          return;
        }
        socket.send(`echo:${data.toString()}:path=${req.url}`);
      });
    });
    await new Promise<void>((resolve) => stubHttpServer.listen(0, "127.0.0.1", resolve));
    stubPort = (stubHttpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stubWss.close(() => resolve()));
    await new Promise<void>((resolve) => stubHttpServer.close(() => resolve()));
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
  });

  it("proxies frames both ways to the dev server's own websocket endpoint", async () => {
    const { app, port } = await buildAndListen();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(await waitForOpenOrClose(ws)).toBe("open");

    expect(await sendUntilEcho(ws, "ping")).toBe("echo:ping:path=/hmr");

    ws.close();
    await app.close();
  });

  it("preserves a full-URL devServerUrl's own base path in the upgrade request", async () => {
    const { app, port } = await buildAndListen();
    const projectId = await createProjectWithDevServer(app, `http://127.0.0.1:${stubPort}/sub`);
    const slug = await createProjectPreview(app, projectId);

    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(await waitForOpenOrClose(ws)).toBe("open");

    expect(await sendUntilEcho(ws, "ping")).toBe("echo:ping:path=/sub/hmr");

    ws.close();
    await app.close();
  });

  it("refuses an external-kind preview whose stored URL points at loopback (issue #250)", async () => {
    const { app, port } = await buildAndListen();
    // Seeded via the service layer, not POST /api/previews: the route's
    // SSRF guard rejects a loopback URL like this stub server's, by
    // design — see the equivalent note in preview-proxy.test.ts for why
    // this went from "proxies frames both ways" to "refuses".
    //
    // This transport is the one the change matters most for: `redirect:
    // "manual"` isn't available on a WS upgrade and no undici Dispatcher
    // reaches it, so before issue #250 this hop had no guard whatsoever.
    const preview = createExternalPreview(app, `http://127.0.0.1:${stubPort}/ext`);

    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { host: `preview-${preview.slug}.${PREVIEW_BASE_HOST}` },
    });
    // Same shape as "rejects an upgrade when the dev server is unreachable"
    // below, and for the same reason: the slug resolves fine, so the
    // browser's handshake is accepted first and the upstream leg is only
    // refused afterwards — it opens, then closes. A rejection *before* the
    // handshake would mean the slug never resolved, which is a different
    // failure and would not prove the guard ran.
    expect(await waitForOpenOrClose(ws)).toBe("open");
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));

    await app.close();
  });

  it("rejects (closes, never opens) an upgrade for an unknown slug before completing", async () => {
    const { app, port } = await buildAndListen();

    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { host: `preview-does-not-exist.${PREVIEW_BASE_HOST}` },
    });
    expect(await waitForOpenOrClose(ws)).toBe("close");

    await app.close();
  });

  it("rejects an upgrade for a project with no devServerUrl configured", async () => {
    const { app, port } = await buildAndListen();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "no-dev-server", cwd: "/tmp/preview-ws-proxy-no-dev-server" },
    });
    const slug = await createProjectPreview(app, created.json().id as number);

    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(await waitForOpenOrClose(ws)).toBe("close");

    await app.close();
  });

  it("rejects an upgrade when the dev server is unreachable", async () => {
    const { app, port } = await buildAndListen();
    // Port 1: a real, always-refused loopback port (same convention used
    // throughout this repo's other "unreachable" tests).
    const projectId = await createProjectWithDevServer(app, "1");
    const slug = await createProjectPreview(app, projectId);

    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    // Unlike the two rejections above (which reject *before* the browser's
    // own handshake completes), an unreachable upstream is only discovered
    // *after* accepting the browser's side (see the plugin's own comment on
    // why) — so this one does open, then closes shortly after.
    expect(await waitForOpenOrClose(ws)).toBe("open");
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));

    await app.close();
  });

  describe("preview-host auth token (issue #383)", () => {
    const TEST_SECRET = "test-preview-auth-secret-0123456789";
    const TEST_AUTH_TOKEN = "test-preview-ws-proxy-dashboard-token-0123456789";
    // src/app.ts's own boot invariant requires in-process auth to be
    // configured whenever PREVIEW_AUTH_REQUIRED is on (see issue #383), so
    // this also turns authPlugin's dashboard-host gate on — every
    // createProjectWithDevServer/createProjectPreview setup call below
    // passes this as a Bearer header (those go through app.inject() to the
    // dashboard host, not a preview Host, so they don't get authPlugin's
    // preview bypass).
    const DASHBOARD_AUTH_HEADERS = { authorization: `Bearer ${TEST_AUTH_TOKEN}` };

    beforeAll(() => {
      process.env.PREVIEW_AUTH_REQUIRED = "true";
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      process.env.MULLION_AUTH_TOKEN = TEST_AUTH_TOKEN;
    });

    afterAll(() => {
      delete process.env.PREVIEW_AUTH_REQUIRED;
      delete process.env.MULLION_SESSION_SECRET;
      delete process.env.MULLION_AUTH_TOKEN;
    });

    it("rejects an upgrade with no cookie before the handshake completes", async () => {
      const { app, port } = await buildAndListen();
      const projectId = await createProjectWithDevServer(
        app,
        String(stubPort),
        DASHBOARD_AUTH_HEADERS,
      );
      const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/hmr`, {
        headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
      });
      expect(await waitForOpenOrClose(ws)).toBe("close");

      await app.close();
    });

    it("accepts the upgrade with a valid preview cookie", async () => {
      const { app, port } = await buildAndListen();
      const projectId = await createProjectWithDevServer(
        app,
        String(stubPort),
        DASHBOARD_AUTH_HEADERS,
      );
      const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);
      const cookieValue = mintPreviewCookie(TEST_SECRET, slug);

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/hmr`, {
        headers: {
          host: `preview-${slug}.${PREVIEW_BASE_HOST}`,
          cookie: `${PREVIEW_COOKIE_NAME}=${cookieValue}`,
        },
      });
      expect(await waitForOpenOrClose(ws)).toBe("open");

      ws.close();
      await app.close();
    });

    it("rejects a preview cookie minted for a different slug", async () => {
      const { app, port } = await buildAndListen();
      const projectId = await createProjectWithDevServer(
        app,
        String(stubPort),
        DASHBOARD_AUTH_HEADERS,
      );
      const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);
      const otherProjectId = await createProjectWithDevServer(
        app,
        String(stubPort),
        DASHBOARD_AUTH_HEADERS,
      );
      const otherSlug = await createProjectPreview(app, otherProjectId, DASHBOARD_AUTH_HEADERS);
      const cookieForOtherSlug = mintPreviewCookie(TEST_SECRET, otherSlug);

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/hmr`, {
        headers: {
          host: `preview-${slug}.${PREVIEW_BASE_HOST}`,
          cookie: `${PREVIEW_COOKIE_NAME}=${cookieForOtherSlug}`,
        },
      });
      expect(await waitForOpenOrClose(ws)).toBe("close");

      await app.close();
    });

    it("rate-limits repeated failed upgrade attempts (429) — the WS transport's own branch, not just the HTTP one (security review, PR #427)", async () => {
      // The HTTP-path test in preview-proxy.test.ts already exercises
      // isPreviewAuthRateLimited() itself (the 30-attempt threshold,
      // per-IP isolation, authenticated-client-unaffected behavior) — this
      // test's only job is proving the WS dispatcher's own call site
      // (`if (isPreviewAuthRateLimited(...)) return rejectUpgrade(socket,
      // "429...")`) is actually wired up and reachable, since an inverted
      // condition or wrong status string there would otherwise ship with
      // zero direct coverage.
      resetPreviewAuthFailuresForTests();
      const { app, port } = await buildAndListen();
      const projectId = await createProjectWithDevServer(
        app,
        String(stubPort),
        DASHBOARD_AUTH_HEADERS,
      );
      const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);

      let lastStatus = 0;
      for (let i = 0; i < 31; i++) {
        const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/hmr`, {
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
        });
        lastStatus = await waitForRejectionStatus(ws);
      }
      // Max is 30 failed attempts per window — the 31st trips the limiter.
      expect(lastStatus).toBe(429);

      resetPreviewAuthFailuresForTests();
      await app.close();
    });
  });

  it("leaves the existing /ws/terminal route working — the capture-and-wrap dispatcher delegates non-preview hosts", async () => {
    const { app, port } = await buildAndListen();

    const ws = new NodeWebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?sessionId=999999&cols=80&rows=24`,
    );
    // Same assertion terminal.test.ts itself makes for an unknown
    // sessionId: preValidation rejects before the upgrade completes. The
    // point here isn't that specific behavior — it's that /ws/terminal's
    // own preValidation hook ran *at all*, proving previewProxyPlugin's
    // dispatcher (registered *after* websocketPlugin, having captured and
    // removed its 'upgrade' listener — see app.ts and preview-proxy.ts's
    // own comments) correctly called through to that captured listener for
    // a non-preview Host, instead of the dispatcher itself either handling
    // or swallowing the request.
    expect(await waitForOpenOrClose(ws)).toBe("close");

    await app.close();
  });
});
