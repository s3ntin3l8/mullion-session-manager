import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

// Two real buildApp() instances in one process — a primary (issue #28's own
// preview proxy) and an agent (issue #26) — proving the whole two-hop
// preview chain end-to-end (issue #28 phase 6): browser -> primary's
// subdomain proxy -> RemoteHostClient -> agent's own /internal/preview* ->
// a real dev-server stub bound to the agent's own loopback. Mirrors
// test/integration/multi-host.test.ts's own two-app harness; faked
// node-pty/child_process the same way even though this suite never spawns a
// session, since buildApp() for MULLION_ROLE=agent still registers
// ptyPlugin.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    throw new Error("not used by this suite");
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("close", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");

const AGENT_TOKEN = "integration-preview-agent-token";
const PREVIEW_BASE_HOST = "preview.test";
const primaryDb = path.join(
  os.tmpdir(),
  `multi-host-preview-primary-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
);

async function buildAndListen(env: Record<string, string>) {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    prev[key] = process.env[key];
    process.env[key] = env[key];
  }
  const app = await buildApp();
  for (const key of Object.keys(env)) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real bound address");
  }
  return { app, port: address.port };
}

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

function waitForOpenOrClose(ws: NodeWebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("close", () => resolve("close"));
    ws.once("error", () => resolve("close"));
  });
}

describe("multi-host preview proxy (issue #28 phase 6)", () => {
  let agent: Awaited<ReturnType<typeof buildAndListen>>;
  let primary: Awaited<ReturnType<typeof buildAndListen>>;
  let hostId: string;
  let projectId: number;
  let stubHttpServer: http.Server;
  let stubWss: WebSocketServer;
  let stubPort: number;

  beforeAll(async () => {
    fs.rmSync(primaryDb, { force: true });

    // The "dev server" — bound to 127.0.0.1, reachable only from the same
    // host the agent runs on (simulated here by both processes genuinely
    // sharing loopback, since this is one OS process either way).
    stubHttpServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ host: req.headers.host, path: req.url }));
    });
    stubWss = new WebSocketServer({ server: stubHttpServer });
    stubWss.on("connection", (socket) => {
      socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
    });
    await new Promise<void>((resolve) => stubHttpServer.listen(0, "127.0.0.1", resolve));
    stubPort = (stubHttpServer.address() as AddressInfo).port;

    agent = await buildAndListen({
      MULLION_ROLE: "agent",
      MULLION_AGENT_TOKEN: AGENT_TOKEN,
      PROJECTS_ROOTS: os.tmpdir(),
    });
    primary = await buildAndListen({
      DATABASE_URL: `file:${primaryDb}`,
      PREVIEW_BASE_HOST,
    });

    const hostRes = await primary.app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: "integration-preview-agent",
        baseUrl: `http://127.0.0.1:${agent.port}`,
        token: AGENT_TOKEN,
      },
    });
    hostId = hostRes.json().id;

    const projectRes = await primary.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "remote-preview", cwd: "/tmp/remote-preview-project", hostId },
    });
    projectId = projectRes.json().id;
    await primary.app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { devServerUrl: String(stubPort) },
    });
  });

  afterAll(async () => {
    await primary.app.close();
    await agent.app.close();
    await new Promise<void>((resolve) => stubWss.close(() => resolve()));
    await new Promise<void>((resolve) => stubHttpServer.close(() => resolve()));
    fs.rmSync(primaryDb, { force: true });
  });

  it("proxies an HTTP preview request through the owning agent to its own loopback dev server", async () => {
    const previewRes = await primary.app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    const slug = previewRes.json().slug as string;

    const res = await primary.app.inject({
      method: "GET",
      url: "/some/asset.js?v=1",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe("/some/asset.js?v=1");
    // The agent forces the Host header to its own loopback (127.0.0.1:<port>),
    // never the primary's own "preview-<slug>.<baseHost>" — proving both
    // hops actually happened rather than this being served locally.
    expect(body.host).toBe(`127.0.0.1:${stubPort}`);
  });

  it("proxies a WS (HMR) preview upgrade through the owning agent to its own loopback dev server", async () => {
    const previewRes = await primary.app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    const slug = previewRes.json().slug as string;

    const ws = new NodeWebSocket(`ws://127.0.0.1:${primary.port}/hmr`, {
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(await waitForOpenOrClose(ws)).toBe("open");
    expect(await sendUntilEcho(ws, "ping")).toBe("echo:ping");

    ws.close();
  });

  it("502s when the owning agent itself is unreachable", async () => {
    const deadHost = await primary.app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "dead-preview-agent", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const deadProject = await primary.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "dead-preview-project", cwd: "/x", hostId: deadHost.json().id },
    });
    await primary.app.inject({
      method: "PATCH",
      url: `/api/projects/${deadProject.json().id}`,
      payload: { devServerUrl: "5173" },
    });
    const previewRes = await primary.app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId: deadProject.json().id },
    });
    const slug = previewRes.json().slug as string;

    const res = await primary.app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(res.statusCode).toBe(502);
  });
});
