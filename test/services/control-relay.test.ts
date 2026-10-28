import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { buildTestApp } from "../helpers/app.js";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../../src/db/schema.js";
import {
  createDuplexPair,
  encodeRelayHeader,
  parseRelayHeader,
  relayErrorFrame,
} from "../../src/services/control-relay.js";
import {
  materializeControlRelaySocket,
  type ControlRelayAgentHandle,
} from "../../src/services/control-relay-agent.js";
import {
  acceptControlRelayConnection,
  type ControlRelayHolder,
} from "../../src/plugins/control-relay.js";
import { serveRelayChannel } from "../../src/services/control-relay-fanout.js";
import { createMuxConnection, type MuxConnection } from "../../src/services/ssh-agent-mux.js";

// Minimal ws double: two linked instances deliver send() as the peer's
// "message" synchronously, which is all the mux's frame protocol needs.
class FakeSocket {
  readyState = 1;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  peer: FakeSocket | null = null;
  private listeners = new Map<string, Array<(...args: never[]) => void>>();
  on(event: string, listener: (...args: never[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  private emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
  send(data: Buffer): void {
    this.peer?.emit("message", data, true);
  }
  close(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
    this.peer?.peerClosed();
  }
  peerClosed(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
  }
  terminate(): void {
    this.readyState = this.CLOSED;
  }
}

function muxPair(): { agent: MuxConnection; primary: MuxConnection } {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return {
    agent: createMuxConnection(a as never, { channelIdParity: "even" }),
    primary: createMuxConnection(b as never, { channelIdParity: "odd" }),
  };
}

const dirs: string[] = [];
function tmpSock(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-"));
  dirs.push(dir);
  return path.join(dir, "relay.sock");
}
const handles: ControlRelayAgentHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Connects, writes `lines`, resolves with the parsed NDJSON replies until the
 * peer ends or `count` frames arrived. */
function talk(socketPath: string, lines: string[], count = 1): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const frames: Record<string, unknown>[] = [];
    let buffer = "";
    const socket = net.connect(socketPath);
    socket.on("error", reject);
    socket.on("connect", () => socket.write(lines.map((l) => `${l}\n`).join("")));
    const finish = () => {
      socket.destroy();
      resolve(frames);
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
        frames.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
      if (frames.length >= count) finish();
    });
    socket.on("end", finish);
  });
}

describe("relay header", () => {
  it("round-trips a session id and rejects anything else", () => {
    expect(parseRelayHeader(encodeRelayHeader("42").toString("utf8").trim())).toEqual({
      sessionId: "42",
    });
    for (const bad of [
      "not json",
      "[]",
      '{"relay":2,"sessionId":"1"}',
      '{"relay":1,"sessionId":1}',
      '{"relay":1,"sessionId":"0"}',
      '{"relay":1,"sessionId":"1; drop"}',
      '{"relay":1}',
      '{"relay":1,"sessionId":"1234567890123456"}',
    ]) {
      expect(parseRelayHeader(bad)).toBeNull();
    }
    expect(JSON.parse(relayErrorFrame(403, "no").toString("utf8"))).toEqual({
      id: null,
      ok: false,
      fatal: true,
      status: 403,
      error: "no",
    });
  });
});

describe("createDuplexPair", () => {
  it("carries bytes both ways and propagates end and destroy", async () => {
    const [a, b] = createDuplexPair();
    const got: string[] = [];
    b.on("data", (c: Buffer) => got.push(c.toString()));
    a.write("hello");
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(["hello"]);
    const back: string[] = [];
    a.on("data", (c: Buffer) => back.push(c.toString()));
    b.write("world");
    await new Promise((r) => setTimeout(r, 10));
    expect(back).toEqual(["world"]);
    const closed = new Promise<void>((r) => b.once("close", () => r()));
    a.destroy();
    await closed;
    expect(b.destroyed).toBe(true);
  });

  it("delivers a large write in socket-sized pieces", async () => {
    const [a, b] = createDuplexPair();
    const sizes: number[] = [];
    b.on("data", (c: Buffer) => sizes.push(c.length));
    a.write(Buffer.alloc(600 * 1024));
    await new Promise((r) => setTimeout(r, 50));
    expect(sizes.reduce((x, y) => x + y, 0)).toBe(600 * 1024);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
    a.destroy();
  });

  it("holds a write until the reader drains (backpressure)", async () => {
    const [a, b] = createDuplexPair();
    b.pause();
    let written = 0;
    const big = Buffer.alloc(64 * 1024);
    for (let i = 0; i < 20; i++) a.write(big, () => written++);
    await new Promise((r) => setTimeout(r, 10));
    expect(written).toBeLessThan(20);
    b.resume();
    await new Promise((r) => setTimeout(r, 50));
    expect(written).toBe(20);
    a.destroy();
  });
});

describe("agent relay socket", () => {
  it("refuses a handshake with no token or an unknown one, never granting scope", async () => {
    const socketPath = tmpSock();
    handles.push(
      await materializeControlRelaySocket({
        socketPath,
        resolveToken: () => undefined,
        getMux: () => null,
      }),
    );
    for (const hs of ["{}", '{"token":"nope"}']) {
      const [frame] = await talk(socketPath, [hs]);
      expect(frame).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("answers relay-unavailable when the primary never dials in", async () => {
    const socketPath = tmpSock();
    handles.push(
      await materializeControlRelaySocket({
        socketPath,
        resolveToken: () => "7",
        getMux: () => null,
        unavailableTimeoutMs: 50,
      }),
    );
    const [frame] = await talk(socketPath, ['{"token":"t"}']);
    expect(frame).toMatchObject({ ok: false, status: 503 });
    expect(String(frame.error)).toContain("relay-unavailable");
  });

  it("answers 503 instead of crashing when the channel closed as it was opened", async () => {
    const socketPath = tmpSock();
    const closedChannel = {
      send: () => {
        throw new Error("send() on closed channel");
      },
      close: () => {},
    };
    handles.push(
      await materializeControlRelaySocket({
        socketPath,
        resolveToken: () => "7",
        getMux: () => ({ openChannel: async () => closedChannel }) as never,
      }),
    );
    const [frame] = await talk(socketPath, ['{"token":"t"}']);
    expect(frame).toMatchObject({ ok: false, fatal: true, status: 503 });
  });

  it("tells relayed clients the relay dropped", async () => {
    const socketPath = tmpSock();
    const { agent, primary } = muxPair();
    primary.onChannel(() => {
      /* accepts and stays silent */
    });
    const handle = await materializeControlRelaySocket({
      socketPath,
      resolveToken: () => "7",
      getMux: () => agent,
    });
    handles.push(handle);
    const pending = talk(socketPath, ['{"token":"t"}', '{"id":1,"op":"x"}']);
    await new Promise((r) => setTimeout(r, 50));
    handle.relayDown("test drop");
    const [frame] = await pending;
    expect(frame).toMatchObject({ ok: false, status: 503 });
    expect(String(frame.error)).toContain("relay-disconnected");
  });
});

describe("loopback relay: agent socket -> mux -> primary handler", () => {
  async function setup() {
    const app = await buildTestApp();
    await app.ready();
    const hostId = "remote-1";
    const projectId = Number(
      app.db.insert(projects).values({ name: "r", cwd: "/tmp/r" }).run().lastInsertRowid,
    );
    const insertSession = (values: Partial<typeof sessions.$inferInsert> = {}) =>
      String(
        Number(
          app.db
            .insert(sessions)
            .values({ projectId, command: "bash", cwd: "/tmp/r", hostId, ...values })
            .run().lastInsertRowid,
        ),
      );
    const { agent, primary } = muxPair();
    const openSockets = new Set<net.Socket>();
    const counter = { open: 0 };
    primary.onChannel((channel) => serveRelayChannel(app, hostId, channel, openSockets, counter));
    const socketPath = tmpSock();
    const tokens = new Map<string, string>();
    const handle = await materializeControlRelaySocket({
      socketPath,
      resolveToken: (t) => tokens.get(t),
      getMux: () => agent,
    });
    handles.push(handle);
    return { app, insertSession, tokens, socketPath, hostId, counter, projectId };
  }

  it("serves a session-scope op for a session this process does not host", async () => {
    const { insertSession, tokens, socketPath } = await setup();
    const id = insertSession();
    tokens.set("tok", id);
    const [frame] = await talk(socketPath, ['{"token":"tok"}', '{"id":5,"op":"projects.actions"}']);
    expect(frame).toMatchObject({ id: 5, ok: true });
  });

  it("never grants full scope, even with auth disabled on the primary", async () => {
    const { insertSession, tokens, socketPath } = await setup();
    tokens.set("tok", insertSession());
    const [frame] = await talk(socketPath, ['{"token":"tok"}', '{"id":6,"op":"projects.list"}']);
    expect(frame).toMatchObject({ id: 6, ok: false, status: 403 });
  });

  it("pins the session by the header: later frames cannot name another", async () => {
    const { insertSession, tokens, socketPath } = await setup();
    const own = insertSession();
    const other = insertSession();
    tokens.set("tok", own);
    const [frame] = await talk(socketPath, [
      '{"token":"tok"}',
      JSON.stringify({ id: 7, token: "other", op: "sessions.get", body: { sessionId: other } }),
    ]);
    expect(frame).toMatchObject({ id: 7, ok: false });
    expect([403, 404]).toContain(frame.status);
  });

  it("refuses a session that another host hosts", async () => {
    const { insertSession, tokens, socketPath } = await setup();
    tokens.set("tok", insertSession({ hostId: "someone-else" }));
    const [frame] = await talk(socketPath, ['{"token":"tok"}', '{"id":1,"op":"projects.actions"}']);
    expect(frame).toMatchObject({ ok: false, status: 403 });
    expect(String(frame.error)).toContain("not hosted by the relaying host");
  });

  it("refuses a session that is no longer active", async () => {
    const { insertSession, tokens, socketPath } = await setup();
    tokens.set("tok", insertSession({ status: "exited" }));
    const [frame] = await talk(socketPath, ['{"token":"tok"}', '{"id":1,"op":"projects.actions"}']);
    expect(frame).toMatchObject({ ok: false, status: 403 });
  });

  it("answers streaming ops with not-available-over-relay", async () => {
    const { insertSession, tokens, socketPath } = await setup();
    tokens.set("tok", insertSession());
    const [frame] = await talk(socketPath, [
      '{"token":"tok"}',
      '{"id":3,"op":"events.subscribe","body":{}}',
    ]);
    expect(frame).toMatchObject({ id: 3, ok: false, status: 501 });
  });

  it("re-checks the session on every request", async () => {
    const { app, insertSession, tokens, socketPath } = await setup();
    const id = insertSession();
    tokens.set("tok", id);
    const socket = net.connect(socketPath);
    const frames: Record<string, unknown>[] = [];
    let buffer = "";
    socket.on("data", (c) => {
      buffer += c.toString();
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
        frames.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
    });
    socket.write('{"token":"tok"}\n{"id":1,"op":"projects.actions"}\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(frames[0]).toMatchObject({ id: 1, ok: true });
    app.db
      .update(sessions)
      .set({ status: "exited" })
      .where(eq(sessions.id, Number(id)))
      .run();
    socket.write('{"id":2,"op":"projects.actions"}\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(frames[1]).toMatchObject({ id: 2, ok: false, status: 403 });
    socket.destroy();
  });
});

describe("serveRelayChannel header handling", () => {
  it("denies a malformed header and a too-large one", async () => {
    const app = await buildTestApp();
    await app.ready();
    for (const payload of [Buffer.from("garbage\n"), Buffer.alloc(8 * 1024, 0x61)]) {
      const { agent, primary } = muxPair();
      primary.onChannel((channel) => serveRelayChannel(app, "h", channel, new Set(), { open: 0 }));
      const channel = await agent.openChannel();
      const got = new Promise<Buffer>((r) => channel.onData(r));
      channel.send(payload);
      const frame = JSON.parse((await got).toString("utf8"));
      expect(frame).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("caps relayed connections per host", async () => {
    const app = await buildTestApp();
    await app.ready();
    const { agent, primary } = muxPair();
    primary.onChannel((channel) =>
      serveRelayChannel(app, "h", channel, new Set(), { open: 1_000 }),
    );
    const channel = await agent.openChannel();
    const got = new Promise<Buffer>((r) => channel.onData(r));
    channel.send(encodeRelayHeader("1"));
    expect(JSON.parse((await got).toString("utf8"))).toMatchObject({ ok: false, status: 503 });
  });
});

describe("acceptControlRelayConnection", () => {
  const holderOf = () => {
    const relayDown = vi.fn();
    return {
      holder: { current: null, handle: { relayDown } } as unknown as ControlRelayHolder,
      relayDown,
    };
  };
  const log = { debug: vi.fn() } as never;

  it("adopts the connection, supersedes an earlier one, and tells clients when it drops", () => {
    const { holder, relayDown } = holderOf();
    const app = { controlRelayConnection: holder, log };
    const first = new FakeSocket();
    acceptControlRelayConnection(app, first as never);
    const firstMux = holder.current;
    expect(firstMux).not.toBeNull();
    const second = new FakeSocket();
    acceptControlRelayConnection(app, second as never);
    expect(holder.current).not.toBe(firstMux);
    // The superseded connection closing must not clear its replacement.
    expect(holder.current).not.toBeNull();
    const before = relayDown.mock.calls.length;
    second.close();
    expect(relayDown.mock.calls.length).toBe(before + 1);
    expect(holder.current).toBeNull();
  });
});
