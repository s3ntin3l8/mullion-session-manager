import { describe, it, expect, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { setTimeout as realSleep } from "node:timers/promises";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { agentChannelClientPlugin } from "../../src/plugins/agent-channel-client.js";
import { saveAgentIdentity, identityStatePath } from "../../src/services/agent-identity.js";
import { createMuxConnection } from "../../src/services/ssh-agent-mux.js";
import {
  AGENT_CHANNEL_AUTH_HEADER,
  channelFetch,
} from "../../src/services/agent-channel-tunnel.js";
import {
  AGENT_CHANNEL_REJECTED_RETRY_MS,
  AGENT_CHANNEL_SUPERSEDED_RETRY_MS,
  AgentChannelCloseCode,
} from "../../src/shared/agent-channel.js";

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

  it("serves a request the primary opens on the channel through the agent's own routes (#2451)", async () => {
    let response: { status: number; body: string } | undefined;
    const primary = await startPrimary((_frame, ws) => {
      ready(ws);
      const mux = createMuxConnection(ws as never, { channelIdParity: "even" });
      void channelFetch({ mux, terminal: null } as never, {
        method: "GET",
        path: "/internal/ping",
        timeoutMs: 3000,
      }).then((res) => {
        response = { status: res.status, body: res.body.toString("utf8") };
      });
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-channel-client-"));
    dirs.push(dir);
    await saveAgentIdentity(identityStatePath(dir), {
      hostId: "host-1",
      machineCredential: "c".repeat(64),
    });
    const app = Fastify();
    app.decorate("config", {
      MULLION_ROLE: "agent",
      MULLION_PRIMARY_URL: primary.url,
      SESSIONS_DIR: dir,
    } as never);
    await app.register(agentChannelClientPlugin);
    // The same shape of gate routes/internal.ts applies.
    app.get("/internal/ping", async (request, reply) =>
      request.headers[AGENT_CHANNEL_AUTH_HEADER] === app.agentChannelRequestToken
        ? { pong: true }
        : reply.code(401).send({ message: "no" }),
    );
    apps.push(app);
    await app.ready();
    await waitUntil(() => response !== undefined);
    expect(response).toEqual({ status: 200, body: '{"pong":true}' });
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

  describe("superseded (fake timers)", () => {
    afterEach(() => vi.useRealTimers());
    // Minutes of fake time in 1 s steps, each yielding to real socket I/O.
    vi.setConfig({ testTimeout: 30_000 });

    // Real sockets, fake timers: advance in small steps, yielding to real I/O.
    // One-second steps stay far under the 10 s handshake timeout, and each
    // step lets pending socket I/O finish before time moves on.
    async function settleIo(): Promise<void> {
      // node:timers/promises is not patched by the fake clock: real I/O time.
      await realSleep(5);
    }
    async function advance(ms: number, step = 1000): Promise<void> {
      for (let left = ms; left > 0; left -= step) {
        await vi.advanceTimersByTimeAsync(Math.min(step, left));
        await settleIo();
      }
    }
    // A stand-in primary that also speaks the mux, so it answers the agent's
    // keepalive PINGs; without one a held connection drops after ~25 s.
    const readyMux = (ws: WebSocket) => {
      ready(ws);
      createMuxConnection(ws, { channelIdParity: "even" });
    };
    const fake = () =>
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });

    it("does not redial on the short curve after a 4001, only after the long interval", async () => {
      fake();
      const primary = await startPrimary((_f, ws, n) => {
        readyMux(ws);
        if (n === 1) ws.close(AgentChannelCloseCode.Superseded, "superseded");
      });
      const app = await startAgent(primary.url);
      await advance(2000);
      await settleIo();
      expect(primary.connections()).toBe(1);
      expect(app.agentChannelStatus.state).toBe("superseded");
      expect(app.agentChannelStatus.lastError).toBe("superseded by a newer connection");
      await advance(AGENT_CHANNEL_SUPERSEDED_RETRY_MS - 2000 - 60_000);
      expect(primary.connections()).toBe(1);
      await advance(AGENT_CHANNEL_SUPERSEDED_RETRY_MS);
      await settleIo();
      expect(primary.connections()).toBe(2);
    });

    it("a plain drop after ready still redials within about a second", async () => {
      fake();
      const primary = await startPrimary((_f, ws, n) => {
        ready(ws);
        if (n === 1) ws.terminate();
      });
      const app = await startAgent(primary.url);
      await advance(2500);
      // Real socket I/O races the fake clock: give the redial (due ~1 s in)
      // a few more real-I/O rounds to land instead of one fixed window.
      for (let i = 0; i < 20 && primary.connections() < 2; i++) {
        await advance(1000);
      }
      await settleIo();
      expect(primary.connections()).toBe(2);
      expect(app.agentChannelStatus.state).toBe("ready");
    });

    it("revoked still waits the rejected interval", async () => {
      fake();
      const primary = await startPrimary((_f, ws, n) => {
        ready(ws);
        if (n === 1) ws.close(AgentChannelCloseCode.Revoked, "revoked");
      });
      const app = await startAgent(primary.url);
      await advance(5000);
      await settleIo();
      expect(primary.connections()).toBe(1);
      expect(app.agentChannelStatus).toMatchObject({
        state: "rejected",
        lastError: "identity revoked",
      });
      await advance(AGENT_CHANNEL_REJECTED_RETRY_MS);
      await settleIo();
      expect(primary.connections()).toBe(2);
    });

    it("two clients sharing one credential make a bounded number of connects", async () => {
      fake();
      // Like the real primary: a new connection supersedes the previous one.
      let current: WebSocket | undefined;
      const primary = await startPrimary((_f, ws) => {
        current?.close(AgentChannelCloseCode.Superseded, "superseded");
        current = ws;
        readyMux(ws);
      });
      await startAgent(primary.url);
      await startAgent(primary.url);
      await advance(10 * 60_000);
      await settleIo();
      // Unbounded fighting would be ~600 connects (1 s curve); the long
      // interval allows a handful over ten minutes.
      expect(primary.connections()).toBeLessThanOrEqual(6);
    });
  });

  it("answers a malformed peer-initiated request and closes the channel", async () => {
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
    channel.send(Buffer.from("not json\n"));
    channel.eof();
    // The agent answers 400 and closes (it may do so before this continuation
    // runs; `closed` covers that).
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
