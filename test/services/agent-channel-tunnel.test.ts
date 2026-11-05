import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer, WebSocket } from "ws";
import { createMuxConnection } from "../../src/services/ssh-agent-mux.js";
import {
  AGENT_CHANNEL_AUTH_HEADER,
  bindChannelHost,
  channelFetch,
  ChannelTransportError,
  resolveHostTransport,
  serveChannelRequest,
  unbindChannelHost,
} from "../../src/services/agent-channel-tunnel.js";
import {
  HostOutcomeUnknownError,
  HostRequestError,
  HostUnreachableError,
  RemoteHostClient,
} from "../../src/services/remote-host-client.js";
import type { ConnectedAgentChannel } from "../../src/plugins/agent-channel.js";

// Both ends of the request tunnel over a real loopback WebSocket, against a
// Fastify "agent" whose /internal/* routes sit behind the same kind of gate as
// routes/internal.ts (the channel's process-local token, no bearer).

const TOKEN = "t".repeat(64);
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

interface Rig {
  entry: ConnectedAgentChannel;
  client: RemoteHostClient;
  /** "down" makes the client see a negotiated-but-disconnected channel. */
  transport: { current: "up" | "down" };
}

type Routes = (agent: FastifyInstance, drop: () => void) => void;

async function rig(routes: Routes): Promise<Rig> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as { port: number }).port;
  const serverSide = new Promise<WebSocket>((r) => wss.once("connection", r));
  const agentSocket = new WebSocket(`ws://127.0.0.1:${port}`);
  const primarySocket = await serverSide;
  await new Promise((r) => agentSocket.once("open", r));

  const primaryMux = createMuxConnection(primarySocket as never, { channelIdParity: "even" });
  const agentMux = createMuxConnection(agentSocket as never, { channelIdParity: "odd" });
  const agent = Fastify({ bodyLimit: 8 * 1024 * 1024 });
  agent.addHook("onRequest", async (request, reply) => {
    if (request.headers[AGENT_CHANNEL_AUTH_HEADER] !== TOKEN) {
      return reply.code(401).send({ message: "no channel credential" });
    }
    if (request.headers.authorization) {
      return reply.code(400).send({ message: "peer credential leaked" });
    }
  });
  agent.addContentTypeParser(
    ["application/octet-stream", "image/png", "text/plain"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  routes(agent, () => agentSocket.terminate());
  await agent.ready();
  agentMux.onChannel((channel) => serveChannelRequest(agent, channel, TOKEN));

  const entry = {
    hostId: "h1",
    socket: primarySocket,
    mux: primaryMux,
    connectedAt: Date.now(),
    protocolVersion: 1,
    negotiatedOperations: ["channel-requests"],
    carriedOperations: ["channel-requests"],
    terminal: null,
    close: () => primaryMux.close(),
  } as unknown as ConnectedAgentChannel;
  const transport = { current: "up" as "up" | "down" };
  const client = new RemoteHostClient({
    hostId: "h1",
    baseUrl: "http://127.0.0.1:1",
    token: "unused",
    resolveTransport: () =>
      transport.current === "up" ? { kind: "channel", channel: entry } : { kind: "channel-down" },
  });
  closers.push(async () => {
    primaryMux.close();
    agentMux.close();
    primarySocket.terminate();
    agentSocket.terminate();
    wss.close();
    await agent.close();
  });
  return { entry, client, transport };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe("request/response over the outbound channel (#2451)", () => {
  it("replays a GET into the agent's own routes and returns the JSON", async () => {
    const r = await rig((agent) => {
      agent.get("/internal/config", async () => ({ role: "agent" }));
    });
    await expect(r.client.resolveConfig()).resolves.toEqual({ role: "agent" });
  });

  it("carries a raw upload body across several mux windows", async () => {
    const r = await rig((agent) => {
      agent.post("/internal/uploads", async (request) => ({
        path: `/up/${(request.body as Buffer).length}`,
      }));
    });
    const big = Buffer.alloc(1_500_000, 7);
    await expect(r.client.uploadImage("/work", big, "image/png")).resolves.toEqual({
      path: "/up/1500000",
    });
  });

  it("never lets the peer choose the credential the replay presents", async () => {
    const r = await rig((agent) => {
      agent.get("/internal/config", async () => ({ ok: true }));
    });
    const res = await channelFetch(r.entry, {
      method: "GET",
      path: "/internal/config",
      headers: { authorization: "Bearer x", [AGENT_CHANNEL_AUTH_HEADER]: "wrong" },
      timeoutMs: 2000,
    });
    expect(res.status).toBe(200);
  });

  it("refuses paths outside /internal/, websocket routes and dot segments without replaying them", async () => {
    const r = await rig((agent) => {
      agent.get("/api/hosts", async () => ({ leaked: true }));
    });
    for (const p of [
      "/api/hosts",
      "/internal/ws/attach",
      "/internal/../api/hosts",
      "/internal/%2e%2e/api/hosts",
    ]) {
      const res = await channelFetch(r.entry, { method: "GET", path: p, timeoutMs: 2000 });
      expect(res.status).toBe(400);
    }
  });

  it("keeps the rejection / unreachable distinction", async () => {
    const r = await rig((agent) => {
      agent.post("/internal/uploads", async (_req, reply) =>
        reply.code(422).send({ message: "no" }),
      );
      agent.get("/internal/config", async (_req, reply) => reply.code(503).send({}));
    });
    await expect(r.client.uploadImage("/w", Buffer.from("x"), "text/plain")).rejects.toMatchObject({
      constructor: HostRequestError,
      statusCode: 422,
    });
    const err = await r.client.resolveConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostUnreachableError);
    expect(err).not.toBeInstanceOf(HostOutcomeUnknownError);
  });

  it.each([
    [
      "spawn",
      "/internal/sessions",
      (c: RemoteHostClient) =>
        c.spawn({ id: "s1", cwd: "/w", command: "claude", cols: 80, rows: 24 }),
    ],
    [
      "prompt",
      "/internal/sessions/s1/prompt",
      (c: RemoteHostClient) => c.resolvePrompt("s1", { text: "hi", submit: true }),
    ],
    [
      "git mutation",
      "/internal/git-commit-wip",
      (c: RemoteHostClient) => c.resolveCommitWipChanges("/w", "wip"),
    ],
    [
      "upload",
      "/internal/uploads",
      (c: RemoteHostClient) => c.uploadFile("/w", Buffer.from("x"), "a.txt"),
    ],
  ])(
    "does not repeat a %s whose result is unknown after a disconnect, nor fall back to inbound",
    async (_name, route, call) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const hits = { n: 0 };
      const r = await rig((agent, drop) => {
        agent.post(route, async () => {
          hits.n++;
          drop(); // the work ran; the answer is lost
          await sleep(200);
          return {};
        });
      });
      const err = await call(r.client).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HostOutcomeUnknownError);
      expect((err as HostOutcomeUnknownError).outcomeUnknown).toBe(true);
      // The channel is gone: the next call is unreachable, not a silent
      // re-send over another transport.
      r.transport.current = "down";
      await expect(call(r.client)).rejects.toBeInstanceOf(HostUnreachableError);
      await sleep(300);
      expect(hits.n).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("treats a dropped read as plain unreachability", async () => {
    const r = await rig((agent, drop) => {
      agent.get("/internal/config", async () => {
        drop();
        await sleep(200);
        return {};
      });
    });
    const err = await r.client.resolveConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostUnreachableError);
    expect(err).not.toBeInstanceOf(HostOutcomeUnknownError);
  });

  it("fails an in-flight operation as rejected when the primary ended the channel for its credential", async () => {
    const r = await rig((agent) => {
      agent.post("/internal/uploads", async () => {
        await sleep(300);
        return { path: "/x" };
      });
    });
    const pending = r.client.uploadFile("/w", Buffer.from("x"), "a.txt").catch((e: unknown) => e);
    await sleep(50);
    (r.entry as { terminal: string | null }).terminal = "expired";
    r.entry.close(4004, "credential expired");
    const err = await pending;
    expect(err).toBeInstanceOf(HostRequestError);
    expect((err as HostRequestError).statusCode).toBe(401);
  });

  it("enforces the request timeout, reporting that the request had started", async () => {
    const r = await rig((agent) => {
      agent.post("/internal/uploads", async () => {
        await sleep(500);
        return { path: "/x" };
      });
    });
    const err = await channelFetch(r.entry, {
      method: "POST",
      path: "/internal/uploads",
      headers: { "content-type": "text/plain" },
      body: "x",
      timeoutMs: 50,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelTransportError);
    expect((err as ChannelTransportError).phase).toBe("after-send");
  });
});

describe("resolveHostTransport", () => {
  it("is inbound until the channel negotiates the request transport, then sticky", () => {
    const app = { agentChannels: new Map() } as unknown as FastifyInstance;
    expect(resolveHostTransport(app, "h").kind).toBe("inbound");
    bindChannelHost(app, "h");
    expect(resolveHostTransport(app, "h").kind).toBe("channel-down");
    const channel = { carriedOperations: ["channel-requests"] } as ConnectedAgentChannel;
    app.agentChannels.set("h", channel);
    expect(resolveHostTransport(app, "h")).toEqual({ kind: "channel", channel });
    app.agentChannels.set("h", { carriedOperations: [] } as unknown as ConnectedAgentChannel);
    expect(resolveHostTransport(app, "h").kind).toBe("channel-down");
    unbindChannelHost(app, "h");
    expect(resolveHostTransport(app, "h").kind).toBe("inbound");
  });
});
