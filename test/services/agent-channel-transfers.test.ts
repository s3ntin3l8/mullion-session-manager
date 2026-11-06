import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocketServer, WebSocket } from "ws";
import { createMuxConnection } from "../../src/services/ssh-agent-mux.js";
import {
  AGENT_CHANNEL_AUTH_HEADER,
  AGENT_CHANNEL_MAX_CHANNELS,
  channelFetchStream,
  serveChannelRequest,
} from "../../src/services/agent-channel-tunnel.js";
import {
  HostRequestError,
  HostUnreachableError,
  RemoteHostClient,
} from "../../src/services/remote-host-client.js";
import { FILE_STREAM_CONTENT_TYPE } from "../../src/shared/constants.js";
import type { ConnectedAgentChannel } from "../../src/plugins/agent-channel.js";

// Issue #2620 — uploads, downloads, the HTTP preview forward and the health
// ping over the outbound channel, against a Fastify "agent" behind the same
// kind of gate as routes/internal.ts. The client's baseUrl points nowhere, and
// global fetch is spied on: a bound host must never touch either.

const TOKEN = "t".repeat(64);
const MIB = 1024 * 1024;
const closers: Array<() => Promise<void> | void> = [];
let fetchSpy: ReturnType<typeof vi.spyOn>;
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

interface Rig {
  entry: ConnectedAgentChannel;
  client: RemoteHostClient;
  transport: { current: "up" | "down" | "inbound" };
  uploads: Array<{ bytes: number; sha: string; query: unknown }>;
  previewHeaders: Array<Record<string, unknown>>;
}

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

async function rig(opts: { download?: Buffer } = {}): Promise<Rig> {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as { port: number }).port;
  const serverSide = new Promise<WebSocket>((r) => wss.once("connection", r));
  const agentSocket = new WebSocket(`ws://127.0.0.1:${port}`);
  const primarySocket = await serverSide;
  await new Promise((r) => agentSocket.once("open", r));
  const primaryMux = createMuxConnection(primarySocket as never, {
    channelIdParity: "even",
    maxChannels: AGENT_CHANNEL_MAX_CHANNELS,
  });
  const agentMux = createMuxConnection(agentSocket as never, {
    channelIdParity: "odd",
    maxChannels: AGENT_CHANNEL_MAX_CHANNELS,
  });

  const uploads: Rig["uploads"] = [];
  const previewHeaders: Rig["previewHeaders"] = [];
  const agent: FastifyInstance = Fastify({ bodyLimit: 8 * MIB });
  agent.addHook("onRequest", async (request, reply) => {
    if (request.headers[AGENT_CHANNEL_AUTH_HEADER] !== TOKEN) {
      return reply.code(401).send({ message: "no channel credential" });
    }
  });
  agent.addContentTypeParser(FILE_STREAM_CONTENT_TYPE, (_req, payload, done) =>
    done(null, payload),
  );
  agent.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  agent.post("/internal/project-files/upload", async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const c of request.body as Readable) chunks.push(c as Buffer);
    const all = Buffer.concat(chunks);
    uploads.push({ bytes: all.length, sha: sha(all), query: request.query });
    return reply.send({ path: "up.bin", size: all.length });
  });
  agent.post("/internal/project-files/download", async (request, reply) => {
    const { path: p } = request.body as { cwd: string; path: string };
    if (p === "missing") return reply.code(404).send({ message: "not found" });
    const file = opts.download ?? Buffer.alloc(0);
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-length", String(file.length))
      .send(file);
  });
  agent.get("/internal/protocol", async () => ({ protocolVersion: 1 }));
  agent.all("/internal/preview/:port/*", async (request, reply) => {
    previewHeaders.push(request.headers);
    const wildcard = (request.params as { "*": string })["*"];
    if (wildcard === "gone") return reply.code(404).send("nope");
    if (wildcard === "unchanged") return reply.code(304).send();
    return reply
      .header("set-cookie", ["a=1; Path=/", "b=2; Path=/"])
      .header("x-up", "1")
      .type("text/plain")
      .send(`hello ${request.method} ${request.url}`);
  });
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
  const transport = { current: "up" as Rig["transport"]["current"] };
  const client = new RemoteHostClient({
    hostId: "h1",
    baseUrl: "http://127.0.0.1:1",
    token: "unused",
    resolveTransport: () =>
      transport.current === "up"
        ? { kind: "channel", channel: entry }
        : transport.current === "down"
          ? { kind: "channel-down" }
          : { kind: "inbound" },
  });
  closers.push(async () => {
    primaryMux.close();
    agentMux.close();
    primarySocket.terminate();
    agentSocket.terminate();
    wss.close();
    await agent.close();
  });
  return { entry, client, transport, uploads, previewHeaders };
}

const drain = async (r: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

const webBody = (buf: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });

describe("file transfers over the outbound channel (#2620)", () => {
  it("round-trips a multi-MB upload without touching the inbound URL", async () => {
    const r = await rig();
    const file = crypto.randomBytes(12 * MIB + 17);
    const result = await r.client.uploadProjectFile(
      "/proj",
      "up.bin",
      Readable.from(
        // small pieces: the writer, not the source, decides the pace
        (function* () {
          for (let o = 0; o < file.length; o += 100_000) yield file.subarray(o, o + 100_000);
        })(),
      ),
      { mkdirs: true },
    );
    expect(result).toEqual({ path: "up.bin", size: file.length });
    expect(r.uploads).toEqual([
      {
        bytes: file.length,
        sha: sha(file),
        query: { cwd: "/proj", path: "up.bin", mkdirs: "1" },
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("round-trips a multi-MB download as a stream and reports its size", async () => {
    const file = crypto.randomBytes(20 * MIB + 3);
    const r = await rig({ download: file });
    const dl = await r.client.downloadProjectFile("/proj", "dir/big.bin");
    expect(dl.size).toBe(file.length);
    expect(dl.name).toBe("big.bin");
    const got = await drain(dl.stream);
    expect(got.length).toBe(file.length);
    expect(sha(got)).toBe(sha(file));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a refused download as a rejection before any byte is returned", async () => {
    const r = await rig({ download: Buffer.from("x") });
    await expect(r.client.downloadProjectFile("/proj", "missing")).rejects.toMatchObject({
      constructor: HostRequestError,
      statusCode: 404,
    });
  });

  it("does not run an upload whose source failed halfway", async () => {
    const r = await rig();
    const body = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024));
        setImmediate(() => this.destroy(new Error("browser hung up")));
      },
    });
    const err = await r.client.uploadProjectFile("/proj", "up.bin", body).catch((e) => e);
    expect(err).toBeInstanceOf(HostUnreachableError);
    expect((err as { outcomeUnknown?: boolean }).outcomeUnknown).toBeUndefined();
    await new Promise((res) => setTimeout(res, 50));
    expect(r.uploads).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails a response that outgrows the limit instead of buffering it", async () => {
    const file = crypto.randomBytes(2 * MIB);
    const r = await rig({ download: file });
    const res = await channelFetchStream(r.entry, {
      method: "POST",
      path: "/internal/project-files/download",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/p", path: "f" }),
      timeoutMs: 5000,
      maxResponseBytes: MIB,
    });
    await expect(drain(res.stream)).rejects.toThrow(/exceeds the channel limit/);
  });
});

describe("HTTP preview forward over the outbound channel (#2620)", () => {
  it("keeps the browser's headers, drops its credentials, and never sets its own", async () => {
    const r = await rig();
    const res = await r.client.openPreviewHttp(5173, "/app.js?v=1", {
      method: "GET",
      headers: new Headers({
        authorization: "Bearer browser-token",
        "x-request-signature": "forged",
        "x-request-timestamp": "1",
        "x-request-nonce": "n",
        [AGENT_CHANNEL_AUTH_HEADER]: "forged-channel-token",
        "x-mullion-anything": "forged",
        cookie: "sid=abc",
        "if-none-match": '"etag"',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello GET /internal/preview/5173/app.js?v=1");
    expect(res.headers.get("x-up")).toBe("1");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);

    const seen = r.previewHeaders[0]!;
    expect(seen.authorization).toBeUndefined();
    expect(seen["x-request-signature"]).toBeUndefined();
    expect(seen["x-request-timestamp"]).toBeUndefined();
    expect(seen["x-request-nonce"]).toBeUndefined();
    expect(seen["x-mullion-anything"]).toBeUndefined();
    // The only channel credential is the replay's own (the rig's gate checks it).
    expect(seen[AGENT_CHANNEL_AUTH_HEADER]).toBe(TOKEN);
    expect(seen.cookie).toBe("sid=abc");
    expect(seen["if-none-match"]).toBe('"etag"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes an upstream error status through, and a body-less status as an empty Response", async () => {
    const r = await rig();
    const gone = await r.client.openPreviewHttp(1, "/gone", {
      method: "GET",
      headers: new Headers(),
    });
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe("nope");
    const unchanged = await r.client.openPreviewHttp(1, "/unchanged", {
      method: "GET",
      headers: new Headers(),
    });
    expect(unchanged.status).toBe(304);
    expect(unchanged.body).toBeNull();
    const head = await r.client.openPreviewHttp(1, "/x", {
      method: "HEAD",
      headers: new Headers(),
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("streams a POST body to the dev server and uses the configured-preview path", async () => {
    const r = await rig();
    const res = await r.client.openPreviewHttp(1, "/submit", {
      method: "POST",
      headers: new Headers({ "content-type": "text/plain" }),
      body: webBody(Buffer.from("payload")),
      duplex: "half",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello POST /internal/preview/1/submit");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ping over the outbound channel (#2620)", () => {
  it("reports the channel plus one round trip, and never probes /health", async () => {
    const r = await rig();
    expect(await r.client.ping()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a bound host whose channel is down (#2620)", () => {
  it("fails every one of them and dials nothing", async () => {
    const r = await rig({ download: Buffer.from("x") });
    r.transport.current = "down";
    const unreachable = (p: Promise<unknown>) =>
      expect(p).rejects.toBeInstanceOf(HostUnreachableError);
    await unreachable(r.client.uploadProjectFile("/p", "f", Readable.from([Buffer.from("x")])));
    await unreachable(r.client.downloadProjectFile("/p", "f"));
    await unreachable(r.client.openPreviewHttp(1, "/", { method: "GET", headers: new Headers() }));
    await unreachable(
      r.client.openConfiguredPreviewHttp("http://x/", { method: "GET", headers: new Headers() }),
    );
    expect(await r.client.ping()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a host that never bound the channel (#2620)", () => {
  it("keeps the inbound path for ping, downloads, uploads and preview forwards", async () => {
    const r = await rig();
    r.transport.current = "inbound";
    fetchSpy.mockImplementation(async () => new Response("ok", { status: 200 }));
    expect(await r.client.ping()).toBe(true);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("http://127.0.0.1:1/health");
    await r.client.openPreviewHttp(1, "/", { method: "GET", headers: new Headers() });
    expect(String(fetchSpy.mock.calls[1]![0])).toBe("http://127.0.0.1:1/internal/preview/1/");
    await r.client.downloadProjectFile("/p", "f").catch(() => undefined);
    expect(String(fetchSpy.mock.calls[2]![0])).toBe(
      "http://127.0.0.1:1/internal/project-files/download",
    );
    await r.client
      .uploadProjectFile("/p", "f", Readable.from([Buffer.from("x")]))
      .catch(() => undefined);
    expect(String(fetchSpy.mock.calls[3]![0])).toContain("/internal/project-files/upload?");
  });
});
