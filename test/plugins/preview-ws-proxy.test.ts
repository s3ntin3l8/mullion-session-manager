import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

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
) {
  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "ws-proxy-test", cwd: "/tmp/preview-ws-proxy-test" },
  });
  const projectId = created.json().id as number;
  await app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    payload: { devServerUrl },
  });
  return projectId;
}

async function createProjectPreview(app: Awaited<ReturnType<typeof buildApp>>, projectId: number) {
  const res = await app.inject({
    method: "POST",
    url: "/api/previews",
    payload: { kind: "project", projectId },
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
