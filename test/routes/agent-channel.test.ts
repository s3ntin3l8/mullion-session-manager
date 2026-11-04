import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { WebSocket as NodeWebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { enrollHost, revokeMachineIdentity } from "../../src/services/host-registry.js";
import { localProtocolInfo } from "../../src/shared/agent-protocol.js";
import { AgentChannelCloseCode } from "../../src/shared/agent-channel.js";

const tmpDb = path.join(os.tmpdir(), `agent-channel-test-${process.pid}.db`);

interface Reply {
  type: "ready" | "error";
  hostId?: string;
  code?: string;
  carriedOperations?: string[];
  negotiatedOperations?: string[];
}

const open: NodeWebSocket[] = [];
let app: FastifyInstance;
let port: number;

function dial(): NodeWebSocket {
  const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/ws/agent-channel`);
  open.push(ws);
  return ws;
}
const opened = (ws: NodeWebSocket) => new Promise<void>((r) => ws.once("open", () => r()));
const reply = (ws: NodeWebSocket) =>
  new Promise<Reply>((r) => ws.once("message", (d) => r(JSON.parse(d.toString()) as Reply)));
const closed = (ws: NodeWebSocket) =>
  new Promise<number>((r) => ws.once("close", (code) => r(code)));

async function handshake(frame: unknown): Promise<{ ws: NodeWebSocket; reply: Reply }> {
  const ws = dial();
  await opened(ws);
  const replied = reply(ws);
  ws.send(JSON.stringify(frame));
  return { ws, reply: await replied };
}

function enroll(): { hostId: string; credential: string } {
  const reg = enrollHost(app, {
    baseUrl: `http://agent-${Math.random().toString(36).slice(2)}:4000`,
    hostname: "laptop",
    wantsMachineCredential: true,
  });
  return { hostId: reg.hostId, credential: reg.machineCredential! };
}
const authFrame = (id: { hostId: string; credential: string }, protocol = localProtocolInfo()) => ({
  type: "auth",
  hostId: id.hostId,
  credential: id.credential,
  protocol,
});
async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition never became true");
}

describe("GET /ws/agent-channel (#2450)", () => {
  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  beforeEach(async () => {
    app = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });
  afterEach(() => {
    for (const ws of open.splice(0)) ws.terminate();
  });
  afterAll(async () => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("authenticates with the machine credential and binds to the host id", async () => {
    const id = enroll();
    const { reply: r } = await handshake(authFrame(id));
    expect(r.type).toBe("ready");
    expect(r.hostId).toBe(id.hostId);
    // Nothing is carried until an operation's migration lands.
    expect(r.carriedOperations).toEqual([]);
    expect(r.negotiatedOperations).toContain("sessions");
    expect(app.agentChannels.get(id.hostId)?.hostId).toBe(id.hostId);
  });

  it("reports readiness on GET /api/hosts separately from credential state", async () => {
    const id = enroll();
    const list = async () =>
      (
        (await app.inject({ method: "GET", url: "/api/hosts" })).json() as Array<{
          id: string;
          hasMachineIdentity: boolean;
          channel: { ready: boolean; carriedOperations: string[] };
        }>
      ).find((h) => h.id === id.hostId)!;
    expect((await list()).channel.ready).toBe(false);
    expect((await list()).hasMachineIdentity).toBe(true);
    await handshake(authFrame(id));
    const after = await list();
    expect(after.channel.ready).toBe(true);
    expect(after.channel.carriedOperations).toEqual([]);
  });

  it("rejects a wrong credential and an unknown host without binding anything", async () => {
    const id = enroll();
    const bad = await handshake(authFrame({ ...id, credential: "x".repeat(64) }));
    expect(bad.reply).toMatchObject({ type: "error", code: "invalid-credential" });
    const unknown = await handshake(authFrame({ hostId: "nope", credential: id.credential }));
    expect(unknown.reply).toMatchObject({ type: "error", code: "invalid-credential" });
    expect(app.agentChannels.has(id.hostId)).toBe(false);
  });

  it("does not let one host's credential bind another host's channel", async () => {
    const a = enroll();
    const b = enroll();
    const { reply: r } = await handshake(authFrame({ hostId: b.hostId, credential: a.credential }));
    expect(r.code).toBe("invalid-credential");
    expect(app.agentChannels.has(b.hostId)).toBe(false);
  });

  it("rejects a revoked credential", async () => {
    const id = enroll();
    revokeMachineIdentity(app, id.hostId);
    const { reply: r } = await handshake(authFrame(id));
    expect(r).toMatchObject({ type: "error", code: "revoked" });
  });

  it("closes a live channel when the identity is revoked through the API", async () => {
    const id = enroll();
    const { ws } = await handshake(authFrame(id));
    const code = closed(ws);
    const res = await app.inject({ method: "POST", url: `/api/hosts/${id.hostId}/revoke` });
    expect(res.statusCode).toBe(204);
    expect(await code).toBe(AgentChannelCloseCode.Revoked);
    await waitUntil(() => !app.agentChannels.has(id.hostId));
  });

  it("rejects an incompatible protocol, after authenticating", async () => {
    const id = enroll();
    const { reply: r } = await handshake(
      authFrame(id, { ...localProtocolInfo(), protocolVersion: 99 }),
    );
    expect(r).toMatchObject({ type: "error", code: "incompatible-protocol" });
    // An unauthenticated peer learns nothing about protocol support.
    const probe = await handshake(
      authFrame(
        { ...id, credential: "y".repeat(64) },
        { ...localProtocolInfo(), protocolVersion: 99 },
      ),
    );
    expect(probe.reply.code).toBe("invalid-credential");
  });

  it("rejects malformed first frames", async () => {
    for (const frame of [{ type: "pair" }, { type: "auth", hostId: "h" }, "nope"]) {
      const { reply: r } = await handshake(frame);
      expect(r).toMatchObject({ type: "error", code: "bad-handshake" });
    }
  });

  it("a newer connection deterministically replaces the older one", async () => {
    const id = enroll();
    const first = await handshake(authFrame(id));
    const firstEntry = app.agentChannels.get(id.hostId);
    const firstClosed = closed(first.ws);
    const second = await handshake(authFrame(id));
    expect(second.reply.type).toBe("ready");
    expect(await firstClosed).toBe(AgentChannelCloseCode.Superseded);
    // The old connection's teardown must not evict the new one.
    await new Promise((r) => setTimeout(r, 50));
    const current = app.agentChannels.get(id.hostId);
    expect(current).toBeDefined();
    expect(current).not.toBe(firstEntry);
    expect(second.ws.readyState).toBe(NodeWebSocket.OPEN);
  });

  it("drops the entry when the agent disconnects", async () => {
    const id = enroll();
    const { ws } = await handshake(authFrame(id));
    ws.close();
    await waitUntil(() => !app.agentChannels.has(id.hostId));
  });
});
