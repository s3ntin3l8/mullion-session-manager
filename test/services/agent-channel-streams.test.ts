import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer, WebSocket } from "ws";
import { createMuxConnection, type MuxConnection } from "../../src/services/ssh-agent-mux.js";
import {
  failedChannelStream,
  openChannelStream,
  serveChannel,
  type AgentStreamHandlers,
} from "../../src/services/agent-channel-streams.js";
import type { ChannelSocket } from "../../src/services/channel-socket.js";
import { channelFetch } from "../../src/services/agent-channel-tunnel.js";
import { RemoteHostClient } from "../../src/services/remote-host-client.js";
import type { ConnectedAgentChannel } from "../../src/plugins/agent-channel.js";
import {
  carriedOperationsFor,
  AGENT_CHANNEL_REQUESTS_OPERATION,
  AGENT_CHANNEL_STREAMS_OPERATION,
} from "../../src/shared/agent-channel.js";
import { localProtocolInfo } from "../../src/shared/agent-protocol.js";
import {
  bindChannelHost,
  resolveHostTransport,
  unbindChannelHost,
} from "../../src/services/agent-channel-tunnel.js";
import { acceptControlRelayConnection } from "../../src/plugins/control-relay.js";
import { materializeControlRelaySocket } from "../../src/services/control-relay-agent.js";
import { serveRelayChannel } from "../../src/plugins/control-relay-fanout.js";
import { buildTestApp } from "../helpers/app.js";
import { projects, sessions } from "../../src/db/schema.js";

// Both ends of the stream transport over a real loopback WebSocket carrying
// the real mux (the shape of the outbound channel), with stub handlers on the
// agent in place of the PTY/event machinery.

const TOKEN = "t".repeat(64);
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

interface Rig {
  app: FastifyInstance;
  entry: ConnectedAgentChannel;
  primaryMux: MuxConnection;
  agentMux: MuxConnection;
  calls: { kind: string; query?: unknown }[];
  sockets: ChannelSocket[];
}

async function rig(overrides: Partial<AgentStreamHandlers> = {}): Promise<Rig> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as { port: number }).port;
  const serverSide = new Promise<WebSocket>((r) => wss.once("connection", r));
  const agentSocket = new WebSocket(`ws://127.0.0.1:${port}`);
  const primarySocket = await serverSide;
  await new Promise((r) => agentSocket.once("open", r));
  const primaryMux = createMuxConnection(primarySocket as never, { channelIdParity: "even" });
  const agentMux = createMuxConnection(agentSocket as never, { channelIdParity: "odd" });
  const app = Fastify();
  await app.ready();

  const calls: Rig["calls"] = [];
  const sockets: ChannelSocket[] = [];
  const echo = (kind: string) => (socket: ChannelSocket, query?: unknown) => {
    calls.push({ kind, query });
    sockets.push(socket);
    socket.on("message", (data: Buffer, isBinary: boolean) =>
      socket.send(data, { binary: isBinary }),
    );
  };
  const handlers: AgentStreamHandlers = {
    validateAttach: (q) => (q.id ? null : "id, cwd, and command query params are required"),
    attach: echo("attach"),
    events: echo("events"),
    controlRelay: echo("control-relay"),
    sshAgent: echo("ssh-agent"),
    validatePreview: (q) => (q.port ? null : "port must be 1-65535"),
    preview: echo("preview"),
    validateConfiguredPreview: (q) => (q.url ? null : "Invalid configured preview destination"),
    configuredPreview: echo("configured-preview"),
    ...overrides,
  };
  agentMux.onChannel((channel) => serveChannel(app, channel, TOKEN, handlers));

  const entry = {
    hostId: "h1",
    socket: primarySocket,
    mux: primaryMux,
    connectedAt: 1000,
    protocolVersion: 1,
    negotiatedOperations: ["channel-requests", "channel-streams"],
    carriedOperations: ["channel-requests", "channel-streams"],
    terminal: null,
    close: () => primaryMux.close(),
  } as unknown as ConnectedAgentChannel;
  closers.push(async () => {
    primaryMux.close();
    agentMux.close();
    primarySocket.terminate();
    agentSocket.terminate();
    wss.close();
    await app.close();
  });
  return { app, entry, primaryMux, agentMux, calls, sockets };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const opened = (s: unknown) =>
  new Promise<void>((resolve, reject) => {
    (s as ChannelSocket).once("open", resolve);
    (s as ChannelSocket).once("error", reject);
  });

describe("streams over the outbound channel (#2571)", () => {
  it("negotiates channel-streams as a carried operation, only when both ends advertise it", () => {
    expect(localProtocolInfo().operations).toContain(AGENT_CHANNEL_STREAMS_OPERATION);
    expect(carriedOperationsFor(["channel-requests", "channel-streams"])).toEqual([
      AGENT_CHANNEL_REQUESTS_OPERATION,
      AGENT_CHANNEL_STREAMS_OPERATION,
    ]);
    expect(carriedOperationsFor(["channel-requests"])).toEqual([AGENT_CHANNEL_REQUESTS_OPERATION]);
    expect(carriedOperationsFor([])).toEqual([]);
  });

  it("carries an events stream both ways, text and binary kept apart", async () => {
    const r = await rig();
    const s = openChannelStream(r.app, r.entry, "events", {
      cursors: "1",
    }) as never as ChannelSocket;
    await opened(s);
    const got: Array<[string, boolean]> = [];
    s.on("message", (d: Buffer, bin: boolean) => got.push([d.toString(), bin]));
    s.send('{"type":"x"}', { binary: false });
    s.send(Buffer.from("raw"), { binary: true });
    await sleep(100);
    expect(got).toEqual([
      ['{"type":"x"}', false],
      ["raw", true],
    ]);
    expect(r.calls).toEqual([{ kind: "events", query: { cursors: "1" } }]);
  });

  it("an attach the agent refuses is a rejection, not an unreachable host", async () => {
    const r = await rig();
    const s = openChannelStream(r.app, r.entry, "attach", {}, "7") as never as ChannelSocket;
    const status = new Promise<number>((resolve) =>
      s.once("unexpected-response", (_req: unknown, res: { statusCode: number }) =>
        resolve(res.statusCode),
      ),
    );
    const err = vi.fn();
    s.on("error", err);
    expect(await status).toBe(400);
    await sleep(50);
    expect(err).not.toHaveBeenCalled();
    expect(r.calls).toHaveLength(0);
  });

  it("an unknown stream kind is refused 404 without reaching a handler", async () => {
    const r = await rig();
    const channel = await r.primaryMux.openChannel();
    const reply = new Promise<string>((resolve) => channel.onData((c) => resolve(c.toString())));
    channel.send(Buffer.from('{"stream":"shell"}\n'));
    expect(await reply).toContain('"status":404');
    expect(r.calls).toHaveLength(0);
  });

  it("still serves request/response channels on the same connection", async () => {
    const r = await rig();
    // The tunnel answers a request head: here an unreplayable path -> 400.
    const res = await channelFetch(r.entry, { method: "GET", path: "/api/x", timeoutMs: 2000 });
    expect(res.status).toBe(400);
  });

  it("a lost link closes the stream (cancellation) and a re-open is flagged resumed", async () => {
    const r = await rig();
    const first = openChannelStream(
      r.app,
      r.entry,
      "attach",
      { id: "s1" },
      "s1",
    ) as never as ChannelSocket;
    await opened(first);
    expect(first.resumed).toBe(false);
    const closed = new Promise<void>((res) => first.once("close", () => res()));
    // The link drops: every channel on it is closed.
    r.primaryMux.close();
    await closed;

    // The agent redials: a new connection of the same host, new connectedAt.
    const r2 = await rig();
    const entry2 = { ...r2.entry, connectedAt: 2000 } as ConnectedAgentChannel;
    const second = openChannelStream(
      r.app,
      entry2,
      "attach",
      { id: "s1" },
      "s1",
    ) as never as ChannelSocket;
    await opened(second);
    expect(second.resumed).toBe(true);
    // A different session is not a resume.
    const other = openChannelStream(
      r.app,
      entry2,
      "attach",
      { id: "s2" },
      "s2",
    ) as never as ChannelSocket;
    await opened(other);
    expect(other.resumed).toBe(false);
    // A second stream on the SAME connection is not a resume either.
    const again = openChannelStream(
      r.app,
      entry2,
      "attach",
      { id: "s1" },
      "s1",
    ) as never as ChannelSocket;
    await opened(again);
    expect(again.resumed).toBe(false);
    expect(r2.calls.map((c) => c.kind)).toEqual(["attach", "attach", "attach"]);
  });

  it("the agent stream closes when the primary's channel does", async () => {
    const r = await rig();
    const s = openChannelStream(r.app, r.entry, "events", undefined) as never as ChannelSocket;
    await opened(s);
    const agentEnd = r.sockets[0]!;
    const closed = vi.fn();
    agentEnd.on("close", closed);
    s.close();
    await sleep(100);
    expect(closed).toHaveBeenCalled();
  });

  it("a channel that is down fails the stream as unreachable", async () => {
    const s = failedChannelStream("outbound channel is not connected") as never as ChannelSocket;
    const errors: Error[] = [];
    s.on("error", (e: Error) => errors.push(e));
    const closed = new Promise<void>((res) => s.once("close", () => res()));
    await closed;
    expect(errors[0]?.message).toContain("outbound channel");
  });

  it("every stream kind opens its channel as a stream (counted against the stream cap)", async () => {
    const r = await rig();
    const spy = vi.spyOn(r.primaryMux, "openChannel");
    for (const kind of ["attach", "events", "control-relay", "ssh-agent"] as const) {
      openChannelStream(r.app, r.entry, kind, undefined);
    }
    expect(spy).toHaveBeenCalledTimes(4);
    for (const call of spy.mock.calls) expect(call[0]).toEqual({ stream: true });
  });

  it("preview WebSocket kinds count against the preview WebSocket cap, not the HTTP preview cap", async () => {
    const r = await rig();
    const spy = vi.spyOn(r.primaryMux, "openChannel");
    for (const kind of ["preview", "configured-preview"] as const) {
      openChannelStream(r.app, r.entry, kind, undefined);
    }
    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) expect(call[0]).toEqual({ previewWs: true });
  });

  it("an open refused by the mux (channel cap) is an unreachable failure", async () => {
    const r = await rig();
    vi.spyOn(r.primaryMux, "openChannel").mockRejectedValue(new Error("channel limit"));
    const s = openChannelStream(r.app, r.entry, "events", undefined) as never as ChannelSocket;
    const err = new Promise<Error>((res) => s.once("error", res));
    expect((await err).message).toContain("channel limit");
  });
});

describe("transport selection for streams (#2571)", () => {
  it("keeps the inbound transport for a legacy peer and never falls back once bound", () => {
    const channels = new Map<string, ConnectedAgentChannel>();
    const app = { agentChannels: channels } as unknown as FastifyInstance;
    // Never negotiated: inbound.
    expect(resolveHostTransport(app, "h", AGENT_CHANNEL_STREAMS_OPERATION).kind).toBe("inbound");
    // Requests-only agent: requests ride the channel, streams stay inbound.
    channels.set("h", {
      hostId: "h",
      carriedOperations: ["channel-requests"],
    } as unknown as ConnectedAgentChannel);
    bindChannelHost(app, "h", ["channel-requests"]);
    expect(resolveHostTransport(app, "h").kind).toBe("channel");
    expect(resolveHostTransport(app, "h", AGENT_CHANNEL_STREAMS_OPERATION).kind).toBe("inbound");
    // Streams negotiated, then the link is lost: channel-down, never inbound.
    channels.set("h", {
      hostId: "h",
      carriedOperations: ["channel-requests", "channel-streams"],
    } as unknown as ConnectedAgentChannel);
    bindChannelHost(app, "h", ["channel-requests", "channel-streams"]);
    expect(resolveHostTransport(app, "h", AGENT_CHANNEL_STREAMS_OPERATION).kind).toBe("channel");
    channels.clear();
    expect(resolveHostTransport(app, "h", AGENT_CHANNEL_STREAMS_OPERATION).kind).toBe(
      "channel-down",
    );
    unbindChannelHost(app, "h");
    expect(resolveHostTransport(app, "h", AGENT_CHANNEL_STREAMS_OPERATION).kind).toBe("inbound");
  });

  it("RemoteHostClient opens streams over the channel, and fails them when it is down", async () => {
    const r = await rig();
    let mode: "up" | "down" = "up";
    const ops: Array<string | undefined> = [];
    const client = new RemoteHostClient({
      hostId: "h1",
      baseUrl: "http://127.0.0.1:1",
      token: "unused",
      channelApp: r.app,
      resolveTransport: (op) => {
        ops.push(op);
        return mode === "up" ? { kind: "channel", channel: r.entry } : { kind: "channel-down" };
      },
    });
    const ev = client.openEventsStream({ cursors: true }) as never as ChannelSocket;
    await opened(ev);
    expect(r.calls[0]).toEqual({ kind: "events", query: { cursors: "1" } });
    const att = client.openAttach({
      id: "s9",
      cwd: "/w",
      command: "bash",
      cols: 100,
      rows: 30,
      projectId: 4,
      env: { A: "b" },
    }) as never as ChannelSocket;
    await opened(att);
    expect(r.calls[1]).toEqual({
      kind: "attach",
      query: {
        id: "s9",
        cwd: "/w",
        command: "bash",
        cols: "100",
        rows: "30",
        projectId: "4",
        env: '{"A":"b"}',
      },
    });
    const relay = client.openControlRelayStream() as never as ChannelSocket;
    const ssh = client.openSshAgentStream() as never as ChannelSocket;
    await Promise.all([opened(relay), opened(ssh)]);
    expect(r.calls.slice(2).map((c) => c.kind)).toEqual(["control-relay", "ssh-agent"]);
    expect(new Set(ops)).toEqual(new Set(["channel-streams"]));

    mode = "down";
    const down = client.openAttach({
      id: "s9",
      cwd: "/w",
      command: "bash",
      cols: 1,
      rows: 1,
    }) as never as ChannelSocket;
    const err = new Promise<Error>((res) => down.once("error", res));
    expect((await err).message).toContain("not falling back");
  });
});

describe("preview WebSockets over the channel (#2620)", () => {
  it("opens both preview kinds on the streams transport and carries frames", async () => {
    const r = await rig();
    const ops: Array<string | undefined> = [];
    const client = new RemoteHostClient({
      hostId: "h1",
      baseUrl: "http://127.0.0.1:1",
      token: "unused",
      channelApp: r.app,
      resolveTransport: (op) => {
        ops.push(op);
        return { kind: "channel", channel: r.entry };
      },
    });
    const preview = client.openPreviewWs(5173, "/@vite/client?x=1") as never as ChannelSocket;
    await opened(preview);
    const configured = client.openConfiguredPreviewWs(
      "http://127.0.0.1:3000/",
    ) as never as ChannelSocket;
    await opened(configured);
    expect(r.calls).toEqual([
      { kind: "preview", query: { port: "5173", path: "/@vite/client?x=1" } },
      { kind: "configured-preview", query: { url: "http://127.0.0.1:3000/" } },
    ]);
    expect(new Set(ops)).toEqual(new Set(["channel-streams"]));
    const got: string[] = [];
    preview.on("message", (d: Buffer) => got.push(d.toString()));
    preview.send("hmr", { binary: false });
    await sleep(100);
    expect(got).toEqual(["hmr"]);
  });

  it("refuses an invalid preview as a rejection, and fails (no inbound dial) when the channel is down", async () => {
    const r = await rig();
    const s = openChannelStream(r.app, r.entry, "preview", {}) as never as ChannelSocket;
    const status = new Promise<number>((resolve) =>
      s.once("unexpected-response", (_req: unknown, res: { statusCode: number }) =>
        resolve(res.statusCode),
      ),
    );
    expect(await status).toBe(400);
    expect(r.calls).toHaveLength(0);

    const down = new RemoteHostClient({
      hostId: "h1",
      baseUrl: "http://127.0.0.1:1",
      token: "unused",
      channelApp: r.app,
      resolveTransport: () => ({ kind: "channel-down" }),
    });
    for (const sock of [
      down.openPreviewWs(1, "/"),
      down.openConfiguredPreviewWs("http://127.0.0.1:1/"),
    ]) {
      const err = new Promise<Error>((res) => sock.once("error", res));
      expect((await err).message).toContain("not falling back");
    }
  });
});

describe("control relay over the channel (#2571)", () => {
  it("serves a session of the relaying host and denies one hosted elsewhere", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "relay-ch-"));
    const socketPath = path.join(dir, "relay.sock");
    const holder = { current: null as MuxConnection | null, handle: null as never };
    const agentApp = { controlRelayConnection: holder, log: { debug: vi.fn() } };
    const r = await rig({
      controlRelay: (socket) => acceptControlRelayConnection(agentApp as never, socket as never),
    });
    const handle = await materializeControlRelaySocket({
      socketPath,
      resolveToken: (t) => ({ own: "1", foreign: "2" })[t],
      getMux: () => holder.current,
    });
    closers.push(async () => {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const primary = await buildTestApp();
    await primary.ready();
    closers.push(() => primary.close());
    const projectId = Number(
      primary.db.insert(projects).values({ name: "r", cwd: "/tmp/r" }).run().lastInsertRowid,
    );
    const insert = (hostId: string) =>
      primary.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: "/tmp/r", hostId })
        .run().lastInsertRowid;
    expect(Number(insert("h1"))).toBe(1);
    expect(Number(insert("someone-else"))).toBe(2);

    // The primary's side, exactly as control-relay-fanout wires it.
    const socket = openChannelStream(r.app, r.entry, "control-relay", undefined);
    await opened(socket);
    const mux = createMuxConnection(socket, { channelIdParity: "odd" });
    const openSockets = new Set<net.Socket>();
    const counter = { open: 0 };
    mux.onChannel((ch) => serveRelayChannel(primary, "h1", ch, openSockets, counter));
    closers.push(() => mux.close());
    await sleep(50);
    expect(holder.current).not.toBeNull();

    const talk = (token: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const c = net.connect(socketPath);
        c.on("error", reject);
        c.on("connect", () =>
          c.write(`${JSON.stringify({ token })}\n{"id":1,"op":"projects.actions"}\n`),
        );
        let buf = "";
        c.on("data", (d) => {
          buf += d.toString();
          const nl = buf.indexOf("\n");
          if (nl !== -1) {
            c.destroy();
            resolve(JSON.parse(buf.slice(0, nl)));
          }
        });
      });
    expect(await talk("own")).toMatchObject({ ok: true });
    const denied = await talk("foreign");
    expect(denied).toMatchObject({ ok: false, status: 403 });
    expect(String(denied.error)).toContain("not hosted by the relaying host");
  });
});

describe("ssh-agent forwarding stays opt-in (#2571)", () => {
  it("opens nothing on the channel until the fan-out dials, and the agent end closes with it", async () => {
    const r = await rig();
    // No bridge connected => the fan-out never calls openChannelStream.
    expect(r.calls).toHaveLength(0);
    expect(r.primaryMux).toBeDefined();
    const s = openChannelStream(r.app, r.entry, "ssh-agent", undefined) as never as ChannelSocket;
    await opened(s);
    const agentEnd = r.sockets[0]!;
    const gone = vi.fn();
    agentEnd.on("close", gone);
    s.close();
    await sleep(100);
    expect(gone).toHaveBeenCalled();
  });
});
