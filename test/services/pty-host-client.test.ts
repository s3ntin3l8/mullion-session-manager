// Issue #1728 — the in-process attach client for a pty-host master, tested
// against a fake master speaking the same framed protocol over a real local
// endpoint (a unix socket here, a named pipe on Windows — via ipcPath).

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_INPUT_BACKLOG_BYTES, attachPtyHost } from "../../src/services/pty-host-client.js";
import { ipcPath } from "../../src/cli/ipc-path.mjs";
import {
  FRAME_DATA,
  FRAME_HELLO,
  FRAME_RESIZE,
  PROTOCOL_VERSION,
  createDeframer,
  encodeExit,
  encodeFrame,
  encodeVersion,
} from "../../src/pty-host/protocol.mjs";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tmpEndpoint(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-host-client-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return ipcPath(path.join(dir, "1.sock"));
}

/** A fake master: records the frames it receives, and hands back the socket. */
async function fakeMaster(endpoint: string) {
  const received: Array<{ type: number; payload: Buffer }> = [];
  let resolveSocket: (s: net.Socket) => void;
  const connected = new Promise<net.Socket>((r) => (resolveSocket = r));
  const server = net.createServer((socket) => {
    socket.on(
      "data",
      createDeframer((type, payload) => received.push({ type, payload })),
    );
    resolveSocket(socket);
  });
  await new Promise<void>((r) => server.listen(endpoint, r));
  cleanups.push(() => server.close());
  return { received, connected, server };
}

const until = async (cond: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("attachPtyHost", () => {
  it("sends the token, then its size, ahead of input written before it connected", async () => {
    const endpoint = tmpEndpoint();
    const master = await fakeMaster(endpoint);
    // Written immediately, before the connection is up — they must still
    // land after the HELLO and the initial size (review on PR #2077).
    const client = attachPtyHost(endpoint, { cols: 100, rows: 30 }, "tok");
    client.write("ls\r");
    client.write(Buffer.from("x"));
    client.resize(120, 40);
    await until(() => master.received.length === 5);
    const [hello, size, input, bytes, resize] = master.received;
    expect([hello.type, hello.payload.toString()]).toEqual([FRAME_HELLO, "tok"]);
    expect(size.type).toBe(FRAME_RESIZE);
    expect([size.payload.readUInt16BE(0), size.payload.readUInt16BE(2)]).toEqual([100, 30]);
    expect([input.type, input.payload.toString()]).toEqual([FRAME_DATA, "ls\r"]);
    expect(bytes.payload.toString()).toBe("x");
    expect([resize.payload.readUInt16BE(0), resize.payload.readUInt16BE(2)]).toEqual([120, 40]);
    client.kill();
  });

  it("delivers output as strings and reports the program's exit code once", async () => {
    const endpoint = tmpEndpoint();
    const master = await fakeMaster(endpoint);
    const client = attachPtyHost(endpoint, { cols: 80, rows: 24 }, "tok");
    const output: string[] = [];
    const exits: Array<{ exitCode: number }> = [];
    client.onData((d) => output.push(d));
    client.onExit((e) => exits.push(e));
    const socket = await master.connected;
    socket.write(encodeFrame(FRAME_DATA, Buffer.from("hello ")));
    socket.end(Buffer.concat([encodeFrame(FRAME_DATA, Buffer.from("world")), encodeExit(7)]));
    await until(() => exits.length > 0);
    expect(output.join("")).toBe("hello world");
    expect(exits).toEqual([{ exitCode: 7 }]);
    client.kill();
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toHaveLength(1);
  });

  it("detaches on kill(): exit fires with 0 and the master keeps running", async () => {
    const endpoint = tmpEndpoint();
    const master = await fakeMaster(endpoint);
    const client = attachPtyHost(endpoint, { cols: 80, rows: 24 }, "tok");
    const exits: Array<{ exitCode: number }> = [];
    const sub = client.onExit((e) => exits.push(e));
    await master.connected;
    client.kill();
    await until(() => exits.length > 0);
    expect(exits).toEqual([{ exitCode: 0 }]);
    expect(master.server.listening).toBe(true);
    // Writes and resizes after detaching are dropped, not thrown.
    expect(() => client.write("late")).not.toThrow();
    expect(() => client.resize(10, 10)).not.toThrow();
    sub.dispose();
  });

  it("reports a missing session as a failed attach (exit code 1)", async () => {
    const client = attachPtyHost(tmpEndpoint(), { cols: 80, rows: 24 }, "tok");
    const exits: Array<{ exitCode: number }> = [];
    client.onExit((e) => exits.push(e));
    await until(() => exits.length > 0);
    expect(exits).toEqual([{ exitCode: 1 }]);
  });

  it("drops the connection on a malformed frame from the master", async () => {
    const endpoint = tmpEndpoint();
    const master = await fakeMaster(endpoint);
    const client = attachPtyHost(endpoint, { cols: 80, rows: 24 }, "tok");
    const exits: Array<{ exitCode: number }> = [];
    client.onExit((e) => exits.push(e));
    const socket = await master.connected;
    const huge = Buffer.alloc(5);
    huge.writeUInt32BE(0xffffffff, 1);
    socket.write(huge);
    await until(() => exits.length > 0);
    expect(exits).toHaveLength(1);
  });
});

describe("attachPtyHost input backlog", () => {
  it("drops input once more than the cap is waiting to be sent", async () => {
    const endpoint = tmpEndpoint();
    const master = await fakeMaster(endpoint);
    const client = attachPtyHost(endpoint, { cols: 80, rows: 24 }, "tok");
    // Queued before the connection is up, so all of it is still unsent.
    client.write("x".repeat(MAX_INPUT_BACKLOG_BYTES));
    client.write("dropped");
    await until(() => master.received.length >= 3, 10_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(master.received.map((f) => f.payload.length)).toEqual([3, 4, MAX_INPUT_BACKLOG_BYTES]);
    client.kill();
  });
});

describe("attachPtyHost exit codes", () => {
  it("reports a connection the master ends without an EXIT frame as a failed attach (1)", async () => {
    // What a token refusal looks like from the client's side: a bare close.
    const endpoint = tmpEndpoint();
    const master = await fakeMaster(endpoint);
    const client = attachPtyHost(endpoint, { cols: 80, rows: 24 }, "stale-token");
    const exits: Array<{ exitCode: number }> = [];
    client.onExit((e) => exits.push(e));
    (await master.connected).destroy();
    await until(() => exits.length > 0);
    expect(exits).toEqual([{ exitCode: 1 }]);
  });

  // Issue #2168 - a master announces its protocol; a client that cannot talk
  // to it must say so rather than let it read as the program having exited.
  describe("master protocol version", () => {
    async function attachTo(announce: Buffer | null) {
      const endpoint = tmpEndpoint();
      const master = await fakeMaster(endpoint);
      const client = attachPtyHost(endpoint, { cols: 80, rows: 24 }, "tok");
      const seen = { output: "", exits: [] as unknown[] };
      client.onData((d) => (seen.output += d));
      client.onExit((e) => seen.exits.push(e));
      const socket = await master.connected;
      // The client may already have dropped this connection (incompatible).
      socket.on("error", () => {});
      if (announce) socket.write(announce);
      socket.write(encodeFrame(FRAME_DATA, Buffer.from("after-version")));
      return { client, seen };
    }

    it("attaches normally to a v1 master that never announces a version", async () => {
      const { client, seen } = await attachTo(null);
      await until(() => seen.output === "after-version");
      expect(seen.exits).toEqual([]);
      client.kill();
    });

    it("attaches normally to a master that serves this client's version", async () => {
      const { client, seen } = await attachTo(
        encodeVersion(PROTOCOL_VERSION + 1, PROTOCOL_VERSION),
      );
      await until(() => seen.output === "after-version");
      expect(seen.exits).toEqual([]);
      client.kill();
    });

    it("reports a master that needs a newer client as incompatible, delivering no output", async () => {
      const { seen } = await attachTo(encodeVersion(PROTOCOL_VERSION + 1, PROTOCOL_VERSION + 1));
      await until(() => seen.exits.length > 0);
      expect(seen.exits).toEqual([
        {
          exitCode: 1,
          incompatible: { masterVersion: PROTOCOL_VERSION + 1, minClient: PROTOCOL_VERSION + 1 },
        },
      ]);
      expect(seen.output).toBe("");
    });
  });
});
