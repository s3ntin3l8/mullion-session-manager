import { describe, it, expect, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { agentChannelClientPlugin } from "../../src/plugins/agent-channel-client.js";
import { saveAgentIdentity, identityStatePath } from "../../src/services/agent-identity.js";
import { createMuxConnection } from "../../src/services/ssh-agent-mux.js";
import { AgentChannelCloseCode } from "../../src/shared/agent-channel.js";

// The agent-side dialer against a stand-in primary. Vitest's fake timers are
// not used: the first dial is immediate and a clean drop redials after the
// backoff floor (~1s), which these tests wait out only where they must.

const servers: WebSocketServer[] = [];
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    s.close();
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function startPrimary(
  onAuth: (frame: Record<string, unknown>, ws: WebSocket, n: number) => void,
): Promise<{ url: string; connections: () => number }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/ws/agent-channel" });
  servers.push(wss);
  await new Promise((r) => wss.once("listening", r));
  let n = 0;
  wss.on("connection", (ws) => {
    const count = ++n;
    ws.once("message", (d) => onAuth(JSON.parse(d.toString()), ws, count));
  });
  const port = (wss.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, connections: () => n };
}

async function startAgent(primaryUrl: string, identity = true): Promise<FastifyInstance> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-channel-client-"));
  dirs.push(dir);
  if (identity) {
    await saveAgentIdentity(identityStatePath(dir), {
      hostId: "host-1",
      machineCredential: "c".repeat(64),
    });
  }
  const app = Fastify();
  app.decorate("config", {
    MULLION_ROLE: "agent",
    MULLION_PRIMARY_URL: primaryUrl,
    SESSIONS_DIR: dir,
  } as never);
  await app.register(agentChannelClientPlugin);
  apps.push(app);
  await app.ready();
  return app;
}

async function waitUntil(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition never became true");
}

const ready = (ws: WebSocket) =>
  ws.send(
    JSON.stringify({
      type: "ready",
      hostId: "host-1",
      protocolVersion: 1,
      negotiatedOperations: [],
      carriedOperations: [],
    }),
  );

describe("agent channel client (#2450)", () => {
  it("presents hostId, credential and protocol, then reports ready with nothing carried", async () => {
    let seen: Record<string, unknown> | undefined;
    const primary = await startPrimary((frame, ws) => {
      seen = frame;
      ready(ws);
    });
    const app = await startAgent(primary.url);
    await waitUntil(() => app.agentChannelStatus.state === "ready");
    expect(seen).toMatchObject({ type: "auth", hostId: "host-1", credential: "c".repeat(64) });
    expect((seen!.protocol as { protocolVersion: number }).protocolVersion).toBe(1);
    expect(app.agentChannelStatus.carriedOperations).toEqual([]);
  });

  it("reconnects after the connection drops", async () => {
    const primary = await startPrimary((_f, ws, n) => {
      ready(ws);
      if (n === 1) setTimeout(() => ws.terminate(), 20);
    });
    const app = await startAgent(primary.url);
    await waitUntil(() => primary.connections() >= 2 && app.agentChannelStatus.state === "ready");
  });

  it("stays idle and dials nothing without a persisted identity", async () => {
    const primary = await startPrimary(() => {});
    const app = await startAgent(primary.url, false);
    await new Promise((r) => setTimeout(r, 100));
    expect(primary.connections()).toBe(0);
    expect(app.agentChannelStatus.state).toBe("idle");
    expect(app.agentChannelStatus.hostId).toBeNull();
  });

  it("surfaces a refusal as rejected and does not hammer the primary", async () => {
    const primary = await startPrimary((_f, ws) => {
      ws.send(
        JSON.stringify({ type: "error", code: "revoked", message: "machine identity revoked" }),
      );
    });
    const app = await startAgent(primary.url);
    await waitUntil(() => app.agentChannelStatus.state === "rejected");
    expect(app.agentChannelStatus.lastError).toMatch(/revoked/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(primary.connections()).toBe(1);
  });

  it("does not claim readiness when superseded and retries", async () => {
    const primary = await startPrimary((_f, ws, n) => {
      ready(ws);
      if (n === 1) setTimeout(() => ws.close(AgentChannelCloseCode.Superseded, "superseded"), 20);
    });
    await startAgent(primary.url);
    await waitUntil(() => primary.connections() >= 2);
  });

  it("refuses peer-initiated channels (nothing is carried yet)", async () => {
    let peer: WebSocket | undefined;
    const primary = await startPrimary((_f, ws) => {
      peer = ws;
      ready(ws);
    });
    const app = await startAgent(primary.url);
    await waitUntil(() => app.agentChannelStatus.state === "ready");
    // The stand-in primary speaks the mux ("even", as the real one does).
    const mux = createMuxConnection(peer!, { channelIdParity: "even" });
    const channel = await mux.openChannel();
    // The agent may close before this continuation runs; `closed` covers that.
    await waitUntil(() => channel.closed);
    expect(app.agentChannelStatus.state).toBe("ready");
  });

  it("stops dialing on close", async () => {
    const primary = await startPrimary((_f, ws) => ready(ws));
    const app = await startAgent(primary.url);
    await waitUntil(() => app.agentChannelStatus.state === "ready");
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect(app.agentChannelStatus.state).toBe("idle");
    const n = primary.connections();
    await new Promise((r) => setTimeout(r, 1300));
    expect(primary.connections()).toBe(n);
  });

  describe("plain-text primary warning", () => {
    async function warningsFor(primaryUrl: string): Promise<string[]> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-channel-client-"));
      dirs.push(dir);
      const app = Fastify();
      const warn = vi.spyOn(app.log, "warn");
      app.decorate("config", {
        MULLION_ROLE: "agent",
        MULLION_PRIMARY_URL: primaryUrl,
        SESSIONS_DIR: dir,
      } as never);
      await app.register(agentChannelClientPlugin);
      apps.push(app);
      await app.ready();
      return warn.mock.calls.map((c) => String(c[0]));
    }

    it("warns once for http:// on a non-loopback host", async () => {
      const warnings = await warningsFor("http://primary.example.com:3000");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/plain http/);
    });

    it.each([
      "https://primary.example.com",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "http://[::1]:3000",
    ])("does not warn for %s", async (url) => {
      expect(await warningsFor(url)).toEqual([]);
    });
  });
});
