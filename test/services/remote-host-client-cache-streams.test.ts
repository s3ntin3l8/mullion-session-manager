import { describe, it, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { hosts } from "../../src/db/schema.js";
import { buildTestApp } from "../helpers/app.js";
import { getRemoteHostClient } from "../../src/services/remote-host-client-cache.js";
import { bindChannelHost } from "../../src/services/agent-channel-tunnel.js";
import type { ConnectedAgentChannel } from "../../src/plugins/agent-channel.js";

// Issue #2635 — streams must reach the outbound channel through the client the
// app actually builds (getRemoteHostClient), not only through a hand-built one.

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

let seq = 0;
let HOST = "h1";
const OPS = ["channel-requests", "channel-streams"];

async function inboundServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const dialed: string[] = [];
  wss.on("connection", (_s: WebSocket, req) => dialed.push(req.url ?? ""));
  closers.push(() => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });
  return { url: `http://127.0.0.1:${(wss.address() as { port: number }).port}`, dialed };
}

async function setup(opts: { baseUrl: string | null; channel: "up" | "down" | "never" }) {
  HOST = `h-2635-${++seq}`;
  const app = await buildTestApp();
  await app.ready();
  closers.push(() => app.close());
  app.db
    .insert(hosts)
    .values({
      id: HOST,
      name: HOST,
      baseUrl: opts.baseUrl,
      machineCredentialEnc: app.encryption.encryptString("machine-credential"),
      authTokenEnc: opts.baseUrl ? app.encryption.encryptString("t".repeat(64)) : null,
    })
    .run();
  const openChannel = vi.fn().mockRejectedValue(new Error("channel limit"));
  if (opts.channel !== "never") {
    bindChannelHost(app, HOST, OPS);
  }
  if (opts.channel === "up") {
    (app as FastifyInstance).agentChannels.set(HOST, {
      hostId: HOST,
      connectedAt: 1,
      protocolVersion: 1,
      negotiatedOperations: OPS,
      carriedOperations: OPS,
      mux: { openChannel },
      close: () => {},
    } as unknown as ConnectedAgentChannel);
  }
  return { app, openChannel };
}

type Stream = {
  once(ev: "error", cb: (e: Error) => void): void;
  terminate(): void;
};
const errorOf = (s: unknown) => new Promise<Error>((res) => (s as Stream).once("error", res));

function openAll(app: FastifyInstance) {
  const client = getRemoteHostClient(app, HOST);
  return [
    client.openAttach({ id: "s1", cwd: "/w", command: "bash", cols: 80, rows: 24 }),
    client.openEventsStream({ cursors: true }),
    client.openControlRelayStream(),
    client.openSshAgentStream(),
  ];
}

describe("getRemoteHostClient streams (#2635)", () => {
  it("opens attach, events, control-relay and ssh-agent over a live channel, never dialing baseUrl", async () => {
    const server = await inboundServer();
    const { app, openChannel } = await setup({ baseUrl: server.url, channel: "up" });
    const streams = openAll(app);
    const errors = await Promise.all(streams.map(errorOf));
    expect(openChannel).toHaveBeenCalledTimes(4);
    for (const e of errors) expect(e.message).toContain("channel limit");
    expect(server.dialed).toEqual([]);
  });

  it("fails every stream as not connected when the channel is down, still not dialing baseUrl", async () => {
    const server = await inboundServer();
    const { app } = await setup({ baseUrl: server.url, channel: "down" });
    const errors = await Promise.all(openAll(app).map(errorOf));
    for (const e of errors) expect(e.message).toContain("not connected");
    expect(server.dialed).toEqual([]);
  });

  it("keeps the inbound WebSocket for a host that never bound a channel", async () => {
    const server = await inboundServer();
    const { app, openChannel } = await setup({ baseUrl: server.url, channel: "never" });
    const streams = openAll(app);
    await vi.waitFor(() => expect(server.dialed.length).toBe(4));
    expect(openChannel).not.toHaveBeenCalled();
    for (const s of streams) {
      (s as unknown as Stream).once("error", () => {});
      (s as unknown as Stream).terminate();
    }
  });

  it("opens streams for a host with no baseUrl and a live channel", async () => {
    const { app, openChannel } = await setup({ baseUrl: null, channel: "up" });
    const errors = await Promise.all(openAll(app).map(errorOf));
    expect(openChannel).toHaveBeenCalledTimes(4);
    for (const e of errors) expect(e.message).toContain("channel limit");
  });
});

describe("RemoteHostClient construction sites (#2635)", () => {
  it("every non-test construction passes channelApp alongside resolveTransport", () => {
    const sites: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts")) {
          const src = readFileSync(p, "utf8");
          for (const m of src.matchAll(/new RemoteHostClient\(\{([\s\S]*?)\n\s*\}\);/g)) {
            if (m[1]!.includes("resolveTransport") && !m[1]!.includes("channelApp")) sites.push(p);
          }
        }
      }
    };
    walk(path.resolve(__dirname, "../../src"));
    expect(sites).toEqual([]);
  });
});

// MULLION_ALLOW_TAILNET_HOSTS reaches the transport only through the client
// the cache builds (remote-host-client-cache.ts); a client built by hand
// would not catch that wiring being dropped.
describe("getRemoteHostClient and MULLION_ALLOW_TAILNET_HOSTS", () => {
  const tailnetClient = async (flag: boolean) => {
    if (flag) process.env.MULLION_ALLOW_TAILNET_HOSTS = "true";
    try {
      const { app } = await setup({ baseUrl: "http://100.101.102.103:4000", channel: "never" });
      return getRemoteHostClient(app, HOST) as unknown as {
        transport: { pinnedDispatcher(): unknown };
      };
    } finally {
      delete process.env.MULLION_ALLOW_TAILNET_HOSTS;
    }
  };

  it("dials a tailnet baseUrl when the flag is on", async () => {
    expect((await tailnetClient(true)).transport.pinnedDispatcher()).toBeDefined();
  });

  it("refuses it when the flag is off", async () => {
    const client = await tailnetClient(false);
    expect(() => client.transport.pinnedDispatcher()).toThrow();
  });
});
