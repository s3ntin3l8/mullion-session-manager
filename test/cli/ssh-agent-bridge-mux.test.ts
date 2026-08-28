import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { WebSocketServer } from "ws";
import { createMuxConnection, type MuxConnection } from "../../src/services/ssh-agent-mux.js";
import { attachInboundMux, pipeNetSocketToChannel } from "../../src/cli/ssh-agent-bridge-mux.mjs";

// Issue #820 (PR6) — the discriminating test for ssh-agent-bridge-mux.mjs:
// a codec tested only against itself would happily pass while disagreeing
// with the real server on every field (wrong byte offset, wrong parity,
// wrong Ping/Pong handling — all invisible to a self-consistent fake).
// Instead this runs a REAL `ws` WebSocketServer wrapping the actual
// src/services/ssh-agent-mux.ts createMuxConnection() on one side (exactly
// what routes/agent-bridge.ts does), and a real global `WebSocket` client
// wrapping this file's own .mjs codec on the other (exactly what the
// laptop helper does) — over a real loopback TCP connection, the same
// transport both sides use in production.

function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitUntil: timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function startServer() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (typeof address === "string" || address === null) throw new Error("expected a real address");
  return { wss, port: address.port };
}

describe("ssh-agent-bridge-mux.mjs vs. the real ssh-agent-mux.ts", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it("round-trips data both directions through a server-opened channel", async () => {
    const { wss, port } = await startServer();
    cleanups.push(() => wss.close());

    const serverMuxReady = new Promise<MuxConnection>((resolve) => {
      wss.once("connection", (socket) => {
        resolve(createMuxConnection(socket, { channelIdParity: "even" }));
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => client.close());

    let acceptedChannel: unknown;
    attachInboundMux(client, {
      onChannel(channel) {
        acceptedChannel = channel;
      },
    });

    await new Promise<void>((resolve) =>
      client.addEventListener("open", () => resolve(), { once: true }),
    );
    const serverMux = await serverMuxReady;

    const serverChannel = await serverMux.openChannel();
    await waitUntil(() => acceptedChannel !== undefined);
    // biome-ignore lint: test-only cast, matches the shape attachInboundMux hands to onChannel
    const clientChannel = acceptedChannel as {
      onData: (cb: (chunk: Buffer) => void) => void;
      send: (chunk: Buffer) => void;
    };

    const receivedOnClient: Buffer[] = [];
    clientChannel.onData((chunk) => receivedOnClient.push(chunk));
    serverChannel.send(Buffer.from("hello from server"));
    await waitUntil(() => receivedOnClient.length > 0);
    expect(Buffer.concat(receivedOnClient).toString()).toBe("hello from server");

    const receivedOnServer: Buffer[] = [];
    serverChannel.onData((chunk) => receivedOnServer.push(chunk));
    clientChannel.send(Buffer.from("hello from client"));
    await waitUntil(() => receivedOnServer.length > 0);
    expect(Buffer.concat(receivedOnServer).toString()).toBe("hello from client");
  });

  // A slow, wall-clock-real-time version of this test (opening a channel
  // and confirming it stays alive well past PING_INTERVAL_MS/PONG_TIMEOUT_MS
  // — both hardcoded, unexported constants in ssh-agent-mux.ts) would be the
  // most literal proof, but at 15s+10s minimum per run that's a bad trade
  // for CI. This asserts on the exact frame instead: feed a real
  // FrameType.Ping frame in as a "message" event and check attachInboundMux
  // sends back FrameType.Pong on channel id 0 — the identical branch a real
  // server-initiated Ping would hit, verified with a fake-but-precise
  // WHATWG-shaped socket rather than a real one, since attachInboundMux
  // only needs addEventListener/send/readyState from its `ws` argument.
  it("answers a Ping frame with a Pong frame on channel id 0 — a helper that didn't would get disconnected by the real server's PONG_TIMEOUT_MS", () => {
    const sent: Buffer[] = [];
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const fakeWs = {
      readyState: 1,
      binaryType: "blob",
      addEventListener(event: string, listener: (event: unknown) => void) {
        const arr = listeners.get(event) ?? [];
        arr.push(listener);
        listeners.set(event, arr);
      },
      send(frame: Buffer) {
        sent.push(frame);
      },
      close() {},
    };
    // fakeWs.readyState (1) matches the real global WebSocket.OPEN's value
    // (also 1, per the WHATWG spec both implement) — attachInboundMux's own
    // sendFrame() compares against that global constant, not anything on
    // `ws` itself, so this fake needs no further stubbing to pass that check.
    // @ts-expect-error — fake only implements the subset attachInboundMux uses
    attachInboundMux(fakeWs, { onChannel: () => {} });
    expect(fakeWs.binaryType).toBe("arraybuffer");

    const PING_FRAME = Buffer.from([8, 0, 0, 0, 0]); // type=8 (Ping), channelId=0
    for (const listener of listeners.get("message") ?? []) {
      listener({
        data: PING_FRAME.buffer.slice(
          PING_FRAME.byteOffset,
          PING_FRAME.byteOffset + PING_FRAME.byteLength,
        ),
      });
    }

    expect(sent).toHaveLength(1);
    expect(sent[0].readUInt8(0)).toBe(9); // FrameType.Pong
    expect(sent[0].readUInt32BE(1)).toBe(0); // channel id 0
  });

  it("pipeNetSocketToChannel (the .mjs port) delivers real net.Socket bytes through to the real server side", async () => {
    const { wss, port } = await startServer();
    cleanups.push(() => wss.close());

    const serverMuxReady = new Promise<MuxConnection>((resolve) => {
      wss.once("connection", (socket) => {
        resolve(createMuxConnection(socket, { channelIdParity: "even" }));
      });
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => client.close());

    const localAgent = net.createServer((socket) => {
      socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    });
    await new Promise<void>((resolve) => localAgent.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => localAgent.close());
    const localAgentAddress = localAgent.address();
    if (localAgentAddress === null || typeof localAgentAddress === "string") {
      throw new Error("expected a real address");
    }

    attachInboundMux(client, {
      onChannel(channel) {
        const socket = net.connect({ port: localAgentAddress.port, host: "127.0.0.1" });
        pipeNetSocketToChannel(socket, channel);
      },
    });
    await new Promise<void>((resolve) =>
      client.addEventListener("open", () => resolve(), { once: true }),
    );
    const serverMux = await serverMuxReady;

    const serverChannel = await serverMux.openChannel();
    const received: Buffer[] = [];
    serverChannel.onData((chunk) => received.push(chunk));
    serverChannel.send(Buffer.from("ping"));
    await waitUntil(() => received.length > 0);
    expect(Buffer.concat(received).toString()).toBe("echo:ping");
  });
});
