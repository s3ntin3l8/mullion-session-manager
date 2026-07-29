import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import {
  MullionSocketClient,
  MullionSocketError,
  resolveSocketPath,
  resolveToken,
} from "../../src/cli/client.mjs";

// Same "real net server, real client" posture as test/mcp/client.test.ts and
// test/hooks/forwarder.test.ts — MullionSocketClient's own protocol logic
// (id correlation, request vs. stream framing) is exactly the kind of thing
// a mocked socket would under-test.

function listen(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

/** Reads line-buffered NDJSON off a server-side connection, invoking `onMessage`
 * once per parsed JSON line (mirrors control-socket.ts's own line-buffering). */
function readLines(socket: net.Socket, onMessage: (msg: unknown) => void): void {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      onMessage(JSON.parse(line));
    }
  });
}

describe("resolveSocketPath", () => {
  it("prefers MULLION_SOCKET_PATH when set", () => {
    expect(resolveSocketPath({ MULLION_SOCKET_PATH: "/explicit/mullion.sock" })).toBe(
      "/explicit/mullion.sock",
    );
  });

  it("falls back to SESSIONS_DIR/mullion.sock", () => {
    expect(resolveSocketPath({ SESSIONS_DIR: "/data/sessions" })).toBe(
      path.join("/data/sessions", "mullion.sock"),
    );
  });

  it("falls back to the XDG state dir when neither is set", () => {
    const result = resolveSocketPath({});
    expect(result).toBe(
      path.join(os.homedir(), ".local", "state", "mullion", "sessions", "mullion.sock"),
    );
  });

  it("ignores an empty-string MULLION_SOCKET_PATH", () => {
    expect(resolveSocketPath({ MULLION_SOCKET_PATH: "", SESSIONS_DIR: "/data" })).toBe(
      path.join("/data", "mullion.sock"),
    );
  });
});

describe("resolveToken", () => {
  it("prefers MULLION_AUTH_TOKEN over MULLION_HOOK_TOKEN when both are set", () => {
    expect(
      resolveToken({ MULLION_AUTH_TOKEN: "auth-tok", MULLION_HOOK_TOKEN: "hook-tok" }),
    ).toEqual({ token: "auth-tok", source: "MULLION_AUTH_TOKEN" });
  });

  it("falls back to MULLION_HOOK_TOKEN", () => {
    expect(resolveToken({ MULLION_HOOK_TOKEN: "hook-tok" })).toEqual({
      token: "hook-tok",
      source: "MULLION_HOOK_TOKEN",
    });
  });

  it("returns null with no source when neither is set", () => {
    expect(resolveToken({})).toEqual({ token: null, source: null });
  });

  it("ignores empty-string tokens", () => {
    expect(resolveToken({ MULLION_AUTH_TOKEN: "", MULLION_HOOK_TOKEN: "" })).toEqual({
      token: null,
      source: null,
    });
  });
});

describe("MullionSocketClient", () => {
  let dir: string;
  let server: net.Server | null = null;
  let socketPath: string;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function startServer(onConnection: (socket: net.Socket) => void) {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-cli-client-"));
    socketPath = path.join(dir, "mullion.sock");
    server = await listen(socketPath);
    server.on("connection", onConnection);
  }

  describe("connect", () => {
    it("writes the handshake with a token when configured", async () => {
      const handshakes: unknown[] = [];
      await startServer((socket) => {
        readLines(socket, (msg) => handshakes.push(msg));
      });
      const client = new MullionSocketClient({ socketPath, token: "tok" });
      await client.connect();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handshakes).toEqual([{ token: "tok" }]);
      client.close();
    });

    it("writes an empty handshake when no token is configured", async () => {
      const handshakes: unknown[] = [];
      await startServer((socket) => {
        readLines(socket, (msg) => handshakes.push(msg));
      });
      const client = new MullionSocketClient({ socketPath, token: null, env: {} });
      await client.connect();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handshakes).toEqual([{}]);
      client.close();
    });

    it("rejects with a clear message when nothing is listening", async () => {
      const client = new MullionSocketClient({
        socketPath: "/nonexistent/path/mullion.sock",
        token: null,
      });
      await expect(client.connect()).rejects.toThrow(/cannot connect to control socket/);
    });

    it("is idempotent — a second connect() call returns the same in-flight/completed connection", async () => {
      // resume(), not a no-op handler: an unconsumed handshake write left
      // sitting in a paused readable stream keeps the server-side socket
      // from ever fully closing once the client destroys its end, which
      // hangs this test's own afterEach (server.close() waits for every
      // accepted connection to actually end).
      await startServer((socket) => socket.resume());
      const client = new MullionSocketClient({ socketPath, token: null });
      const [a, b] = await Promise.all([client.connect(), client.connect()]);
      expect(a).toBe(b);
      client.close();
    });
  });

  describe("request", () => {
    it("resolves with `result` on an ok:true reply", async () => {
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number; op?: string };
          if (m.op)
            socket.write(
              `${JSON.stringify({ id: m.id, ok: true, status: 200, result: { pong: true } })}\n`,
            );
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      const result = await client.request("ping", {});
      expect(result).toEqual({ pong: true });
      client.close();
    });

    it("rejects with a MullionSocketError carrying `status` on an ok:false reply", async () => {
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number; op?: string };
          if (m.op) {
            socket.write(
              `${JSON.stringify({ id: m.id, ok: false, status: 403, error: "nope" })}\n`,
            );
          }
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      await expect(client.request("sessions.list", {})).rejects.toMatchObject({
        status: 403,
        message: "nope",
      });
      client.close();
    });

    it("rejects with a MullionSocketError instance specifically", async () => {
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number };
          socket.write(`${JSON.stringify({ id: m.id, ok: false, status: 400, error: "bad" })}\n`);
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      await expect(client.request("x", {})).rejects.toBeInstanceOf(MullionSocketError);
      client.close();
    });

    it("correlates concurrent requests by id even when replies arrive out of order", async () => {
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number; op?: string };
          if (!m.op) return;
          // Reply to id 2 before id 1 — the client must still route each
          // reply to its own caller, not just the oldest pending one.
          if (m.id === 1) {
            setTimeout(() => {
              socket.write(
                `${JSON.stringify({ id: 1, ok: true, status: 200, result: "first" })}\n`,
              );
            }, 20);
          } else {
            socket.write(
              `${JSON.stringify({ id: m.id, ok: true, status: 200, result: "second" })}\n`,
            );
          }
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      const [a, b] = await Promise.all([client.request("op1", {}), client.request("op2", {})]);
      expect(a).toBe("first");
      expect(b).toBe("second");
      client.close();
    });

    it("times out with a clear message when no reply ever arrives", async () => {
      // resume(), not a no-op handler: an unconsumed handshake write left
      // sitting in a paused readable stream keeps the server-side socket
      // from ever fully closing once the client destroys its end, which
      // hangs this test's own afterEach (server.close() waits for every
      // accepted connection to actually end).
      await startServer((socket) => socket.resume());
      const client = new MullionSocketClient({ socketPath, token: null, requestTimeoutMs: 30 });
      await expect(client.request("ping", {})).rejects.toThrow(/timed out waiting for a reply/);
      client.close();
    });

    it("rejects every pending request when the connection closes", async () => {
      let serverSocket: net.Socket | null = null;
      await startServer((socket) => {
        serverSocket = socket;
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      const pending = client.request("ping", {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      serverSocket?.destroy();
      await expect(pending).rejects.toThrow(/connection closed/);
    });
  });

  describe("openStream", () => {
    it("opens with no explicit ack — the first unsolicited frame IS the open signal (sessions.attach shape)", async () => {
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number; op?: string };
          if (m.op === "sessions.attach") {
            socket.write(`${JSON.stringify({ id: m.id, type: "data", b64: "aGk=" })}\n`);
          }
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      const stream = await client.openStream("sessions.attach", { sessionId: "1" });
      const frame = await new Promise((resolve) => stream.on("frame", resolve));
      await stream.opened;
      expect(frame).toEqual({ id: stream.id, type: "data", b64: "aGk=" });
      client.close();
    });

    it("opens on an explicit ok:true ack with no data frame required (events.subscribe shape)", async () => {
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number; op?: string };
          if (m.op === "events.subscribe") {
            socket.write(`${JSON.stringify({ id: m.id, ok: true, status: 200 })}\n`);
          }
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      const stream = await client.openStream("events.subscribe", {});
      await expect(stream.opened).resolves.toBeUndefined();
      client.close();
    });

    it("rejects `opened` and emits 'error' on an ok:false reply", async () => {
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number; op?: string };
          if (m.op)
            socket.write(
              `${JSON.stringify({ id: m.id, ok: false, status: 404, error: "no such session" })}\n`,
            );
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      const stream = await client.openStream("sessions.attach", { sessionId: "999" });
      await expect(stream.opened).rejects.toMatchObject({ status: 404 });
      client.close();
    });

    it("send() forwards a follow-up message reusing the same stream id", async () => {
      const received: unknown[] = [];
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number; op?: string };
          received.push(m);
          if (m.op === "sessions.attach") {
            socket.write(`${JSON.stringify({ id: m.id, type: "data", b64: "" })}\n`);
          }
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      const stream = await client.openStream("sessions.attach", { sessionId: "1" });
      await stream.opened;
      stream.send("sessions.input", { b64: "eA==" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toContainEqual({
        id: stream.id,
        op: "sessions.input",
        body: { b64: "eA==" },
      });
      client.close();
    });

    it("marks the stream closed and emits 'close' on a type:'exited' frame", async () => {
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number; op?: string };
          if (m.op === "sessions.attach") {
            socket.write(`${JSON.stringify({ id: m.id, type: "exited" })}\n`);
          }
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      const stream = await client.openStream("sessions.attach", { sessionId: "1" });
      await new Promise((resolve) => stream.on("close", resolve));
      expect(stream.closed).toBe(true);
      client.close();
    });

    it("marks the stream closed and emits 'close' on a type:'closed' frame — a stream ending with no explicit sessions.detach (e.g. a multi-host proxy failure)", async () => {
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number; op?: string };
          if (m.op === "sessions.attach") {
            // First open (no ack — the sessions.attach shape), THEN the
            // upstream fails and SocketChannel.close()'s own unsolicited
            // {type:"closed"} frame arrives, per docs/socket-api.md.
            socket.write(`${JSON.stringify({ id: m.id, type: "data", b64: "" })}\n`);
            socket.write(`${JSON.stringify({ id: m.id, type: "closed" })}\n`);
          }
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      const stream = await client.openStream("sessions.attach", { sessionId: "1" });
      // Registered before any further await: both frames can arrive in the
      // same TCP chunk, so awaiting `opened` first risks the "close" event
      // firing (a no-op with zero listeners, unlike "error") before this
      // test ever attaches one.
      const closed = new Promise((resolve) => stream.on("close", resolve));
      await stream.opened;
      await closed;
      expect(stream.closed).toBe(true);
      expect(client.streams.has(stream.id)).toBe(false);
      client.close();
    });

    it("close() sends the given closing op and stops tracking the stream", async () => {
      const received: unknown[] = [];
      await startServer((socket) => {
        readLines(socket, (msg) => {
          const m = msg as { id?: number; op?: string };
          received.push(m);
          if (m.op === "events.subscribe")
            socket.write(`${JSON.stringify({ id: m.id, ok: true, status: 200 })}\n`);
        });
      });
      const client = new MullionSocketClient({ socketPath, token: null });
      const stream = await client.openStream("events.subscribe", {});
      await stream.opened;
      stream.close("events.unsubscribe");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toContainEqual({ id: stream.id, op: "events.unsubscribe", body: undefined });
      expect(client.streams.has(stream.id)).toBe(false);
      client.close();
    });
  });
});
