import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import type { execFile } from "node:child_process";
import {
  acceptMsysHandshake,
  formatMsysSocketFile,
  listenMsysSocket,
  MSYS_SOCKET_COOKIE_ENV,
  MSYS_SOCKET_FILE_EXISTS_EXIT,
  MSYS_SOCKET_FILE_SCRIPT,
  MSYS_SOCKET_PATH_ENV,
  parseMsysSocketFile,
  probeMsysSocket,
  reclaimMsysSocket,
  writeMsysSocketFile,
  type MsysSocketServer,
} from "../../src/services/msys-socket.js";
import { SocketAlreadyListeningError } from "../../src/services/unix-socket.js";
import { fitsMsysSunPath } from "../../src/cli/sun-path.mjs";

/** MSYS's sun_path: 108 bytes, NUL included. */
const MSYS_SOCKET_MAX_PATH_BYTES = 107;

// A fixed, low-entropy secret: the file format is what is under test.
const SECRET = Buffer.from("00112233445566778899aabbccddeeff", "hex");

/** Writes the socket file as plain text — PowerShell is not what these tests cover. */
const plainWriter = (p: string, contents: string) => {
  writeFileSync(p, contents);
  return Promise.resolve();
};

/** The MSYS client side of the handshake: resolves the connected socket. */
function connectMsys(socketPath: string, credPid = 4242): Promise<net.Socket> {
  const cookie = parseMsysSocketFile(readFileSync(socketPath, "latin1"));
  if (!cookie) throw new Error("not an MSYS socket file");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: cookie.port });
    let got = Buffer.alloc(0);
    socket.once("error", reject);
    socket.once("connect", () => {
      const cred = Buffer.alloc(12);
      cred.writeInt32LE(credPid, 0);
      cred.writeUInt32LE(197609, 4);
      cred.writeUInt32LE(197610, 8);
      socket.write(Buffer.concat([cookie.secret, cred]));
    });
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      if (got.length < 28) return;
      socket.removeListener("data", onData);
      expect(got.subarray(0, 16).equals(cookie.secret)).toBe(true);
      expect(got.readUInt32LE(20)).toBe(197609);
      expect(got.readUInt32LE(24)).toBe(197610);
      resolve(socket);
    };
    socket.on("data", onData);
  });
}

function waitForClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve();
    socket.once("close", () => resolve());
  });
}

describe("MSYS socket file format", () => {
  it("writes the port and the secret as four little-endian words in upper-case hex", () => {
    expect(formatMsysSocketFile(50426, SECRET)).toBe(
      "!<socket >50426 s 33221100-77665544-BBAA9988-FFEEDDCC",
    );
  });

  it("round-trips through the parser, which also takes lower case and a trailing NUL", () => {
    const text = formatMsysSocketFile(1234, SECRET);
    expect(parseMsysSocketFile(text)).toEqual({ port: 1234, secret: SECRET });
    expect(parseMsysSocketFile(`${text.toLowerCase().replace("!<SOCKET", "!<socket")}\0`)).toEqual({
      port: 1234,
      secret: SECRET,
    });
  });

  it("rejects anything else", () => {
    expect(parseMsysSocketFile("")).toBeNull();
    expect(parseMsysSocketFile("!<socket >99999 s 00000000-00000000-00000000-00000000")).toBeNull();
    expect(parseMsysSocketFile("!<socket >0 s 00000000-00000000-00000000-00000000")).toBeNull();
    expect(parseMsysSocketFile("!<socket >22 d 00000000-00000000-00000000-00000000")).toBeNull();
    expect(parseMsysSocketFile("!<symlink>whatever")).toBeNull();
  });

  it("checks the path against MSYS's sun_path, in bytes", () => {
    expect(fitsMsysSunPath("x".repeat(MSYS_SOCKET_MAX_PATH_BYTES))).toBe(true);
    expect(fitsMsysSunPath("x".repeat(MSYS_SOCKET_MAX_PATH_BYTES + 1))).toBe(false);
    expect(fitsMsysSunPath("é".repeat(60))).toBe(false);
  });
});

describe("writeMsysSocketFile", () => {
  it("passes the path and cookie through the environment to a fixed script, minus PSModulePath", async () => {
    const run = vi.fn((_file, _args, _opts, cb) => cb(null, "", "")) as unknown as typeof execFile;
    await writeMsysSocketFile("D:\\s\\ssh-agent.sock", "!<socket >1 s x", {
      execFile: run,
      env: { PSModulePath: "C:\\pwsh7\\Modules", KEEP: "1" },
    });
    const [file, args, opts] = (run as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file).toBe("powershell.exe");
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command", MSYS_SOCKET_FILE_SCRIPT]);
    expect(opts.windowsHide).toBe(true);
    expect(opts.env[MSYS_SOCKET_PATH_ENV]).toBe("D:\\s\\ssh-agent.sock");
    expect(opts.env[MSYS_SOCKET_COOKIE_ENV]).toBe("!<socket >1 s x");
    expect(opts.env.KEEP).toBe("1");
    expect(opts.env.PSModulePath).toBeUndefined();
    expect(MSYS_SOCKET_FILE_SCRIPT).not.toContain("D:\\s");
  });

  it("rejects with PowerShell's stderr when the file could not be created", async () => {
    const run = vi.fn((_file, _args, _opts, cb) =>
      cb(new Error("exit 1"), "", "Access is denied."),
    ) as unknown as typeof execFile;
    await expect(writeMsysSocketFile("D:\\s\\a.sock", "c", { execFile: run })).rejects.toThrow(
      /could not create the MSYS socket file D:\\s\\a\.sock: Access is denied\./,
    );
  });
});

describe("writeMsysSocketFile collisions", () => {
  it("reports a file that is already there as SocketAlreadyListeningError — another instance's, never taken over", async () => {
    const run = vi.fn((_file, _args, _opts, cb) =>
      cb(Object.assign(new Error("exit"), { code: MSYS_SOCKET_FILE_EXISTS_EXIT }), "", "exists"),
    ) as unknown as typeof execFile;
    await expect(writeMsysSocketFile("D:/s/a.sock", "c", { execFile: run })).rejects.toBeInstanceOf(
      SocketAlreadyListeningError,
    );
    expect(MSYS_SOCKET_FILE_SCRIPT).toContain("CreateNew");
    expect(MSYS_SOCKET_FILE_SCRIPT).not.toMatch(/File\]::Create\(/);
  });
});

describe("listenMsysSocket", () => {
  let dir: string;
  const servers: MsysSocketServer[] = [];
  const sockets: net.Socket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    for (const s of servers.splice(0)) await s.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const tmpSocket = () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "msys-"));
    return path.join(dir, "a.sock");
  };

  it("serves the stream after a good handshake, with bytes sent past the handshake intact", async () => {
    const socketPath = tmpSocket();
    const received: Buffer[] = [];
    const server = await listenMsysSocket({
      socketPath,
      writeSocketFile: plainWriter,
      onConnection: (s) => {
        sockets.push(s);
        s.on("data", (d: Buffer) => {
          received.push(d);
          s.write(Buffer.from("pong"));
        });
      },
    });
    servers.push(server);
    expect(parseMsysSocketFile(readFileSync(socketPath, "latin1"))?.port).toBe(server.port);

    const client = await connectMsys(socketPath);
    sockets.push(client);
    const reply = new Promise<string>((resolve) => client.once("data", (d) => resolve(String(d))));
    client.write("ping");
    expect(await reply).toBe("pong");
    expect(Buffer.concat(received).toString()).toBe("ping");
  });

  it("keeps bytes that arrive with the handshake until a consumer attaches, however late", async () => {
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    const written: Buffer[] = [];
    // The server's replies go nowhere — a PassThrough would loop them back.
    stream.write = ((b: Buffer) => written.push(b) > 0) as typeof stream.write;
    const socket = stream as unknown as net.Socket;
    const ready = new Promise<net.Socket>((resolve) =>
      acceptMsysHandshake(socket, SECRET, resolve),
    );
    stream.push(Buffer.concat([SECRET, Buffer.alloc(12), Buffer.from("early")]));
    const handedOver = await ready;
    expect(written[0].equals(SECRET)).toBe(true);
    // The consumer attaches only after an async hop, as handleConnection does.
    await new Promise((r) => setTimeout(r, 20));
    const received: Buffer[] = [];
    handedOver.on("data", (d: Buffer) => received.push(d));
    await new Promise((r) => setImmediate(r));
    expect(Buffer.concat(received).toString()).toBe("early");
  });

  it("drops a client with the wrong secret before it reaches the caller", async () => {
    const socketPath = tmpSocket();
    const onConnection = vi.fn();
    servers.push(
      await listenMsysSocket({ socketPath, writeSocketFile: plainWriter, onConnection }),
    );
    const port = parseMsysSocketFile(readFileSync(socketPath, "latin1"))!.port;
    const client = net.createConnection({ host: "127.0.0.1", port });
    sockets.push(client);
    const echoed: Buffer[] = [];
    client.on("data", (d: Buffer) => echoed.push(d));
    client.on("error", () => undefined);
    client.write(Buffer.alloc(16, 0xab));
    await waitForClose(client);
    expect(echoed).toEqual([]);
    expect(onConnection).not.toHaveBeenCalled();
  });

  it("drops a client that does not finish the handshake in time", async () => {
    const socketPath = tmpSocket();
    const onConnection = vi.fn();
    servers.push(
      await listenMsysSocket({
        socketPath,
        writeSocketFile: plainWriter,
        onConnection,
        handshakeTimeoutMs: 50,
      }),
    );
    const port = parseMsysSocketFile(readFileSync(socketPath, "latin1"))!.port;
    const client = net.createConnection({ host: "127.0.0.1", port });
    sockets.push(client);
    client.on("error", () => undefined);
    client.write(SECRET.subarray(0, 8));
    await waitForClose(client);
    expect(onConnection).not.toHaveBeenCalled();
  });

  it("caps connections still in the handshake — any local user can reach the port", async () => {
    const socketPath = tmpSocket();
    const server = await listenMsysSocket({
      socketPath,
      writeSocketFile: plainWriter,
      onConnection: () => undefined,
      maxPendingHandshakes: 1,
    });
    servers.push(server);
    const first = net.createConnection({ host: "127.0.0.1", port: server.port });
    sockets.push(first);
    first.on("error", () => undefined);
    await new Promise((r) => first.once("connect", r));
    await new Promise((r) => setTimeout(r, 50));
    const second = net.createConnection({ host: "127.0.0.1", port: server.port });
    sockets.push(second);
    second.on("error", () => undefined);
    await waitForClose(second);
    expect(first.destroyed).toBe(false);
  });

  it("removes the socket file on close, and ends connections still in the handshake", async () => {
    const socketPath = tmpSocket();
    const server = await listenMsysSocket({
      socketPath,
      writeSocketFile: plainWriter,
      onConnection: () => undefined,
    });
    const client = net.createConnection({ host: "127.0.0.1", port: server.port });
    sockets.push(client);
    client.on("error", () => undefined);
    await new Promise((r) => client.once("connect", r));
    await server.close();
    await waitForClose(client);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("stops listening when the socket file cannot be created", async () => {
    const socketPath = tmpSocket();
    let port = 0;
    await expect(
      listenMsysSocket({
        socketPath,
        onConnection: () => undefined,
        writeSocketFile: (_p, contents) => {
          port = parseMsysSocketFile(contents)!.port;
          return Promise.reject(new Error("denied"));
        },
      }),
    ).rejects.toThrow("denied");
    const refused = await new Promise<string | undefined>((resolve) => {
      const c = net.createConnection({ host: "127.0.0.1", port });
      c.once("connect", () => {
        c.destroy();
        resolve(undefined);
      });
      c.once("error", (e: NodeJS.ErrnoException) => resolve(e.code));
    });
    expect(refused).toBe("ECONNREFUSED");
  });

  it("removes a socket file a failed write left behind — reclaim could never tell it is stale", async () => {
    const socketPath = tmpSocket();
    await expect(
      listenMsysSocket({
        socketPath,
        onConnection: () => undefined,
        writeSocketFile: (p) => {
          writeFileSync(p, "");
          return Promise.reject(new Error("disk full"));
        },
      }),
    ).rejects.toThrow("disk full");
    expect(existsSync(socketPath)).toBe(false);
  });

  it("leaves the file alone after a collision — it is another instance's", async () => {
    const socketPath = tmpSocket();
    writeFileSync(socketPath, "theirs");
    await expect(
      listenMsysSocket({
        socketPath,
        onConnection: () => undefined,
        writeSocketFile: (p) => Promise.reject(new SocketAlreadyListeningError(p, "unknown")),
      }),
    ).rejects.toBeInstanceOf(SocketAlreadyListeningError);
    expect(readFileSync(socketPath, "utf8")).toBe("theirs");
  });

  it("refuses a path too long for MSYS", async () => {
    await expect(
      listenMsysSocket({
        socketPath: "x".repeat(MSYS_SOCKET_MAX_PATH_BYTES + 1),
        writeSocketFile: plainWriter,
        onConnection: () => undefined,
      }),
    ).rejects.toThrow(/too long for an MSYS socket path/);
  });
});

describe("probeMsysSocket / reclaimMsysSocket", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const tmpSocket = () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "msys-"));
    return path.join(dir, "a.sock");
  };
  /** A port nothing listens on: bind one, then close it. */
  async function deadPort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const { port } = s.address() as net.AddressInfo;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  }

  it("reads a missing file as dead", async () => {
    expect(await probeMsysSocket(tmpSocket())).toBe("dead");
  });

  it("reads a file that is not a socket as unknown, and refuses to reclaim it", async () => {
    const p = tmpSocket();
    writeFileSync(p, "hello");
    expect(await probeMsysSocket(p)).toBe("unknown");
    await expect(reclaimMsysSocket(p)).rejects.toBeInstanceOf(SocketAlreadyListeningError);
    expect(existsSync(p)).toBe(true);
  });

  it("reads a file whose port refuses connections as dead, and reclaims it", async () => {
    const p = tmpSocket();
    writeFileSync(p, formatMsysSocketFile(await deadPort(), SECRET));
    expect(await probeMsysSocket(p)).toBe("dead");
    await reclaimMsysSocket(p);
    expect(existsSync(p)).toBe(false);
  });

  it("reads a stale file whose port another program took as dead, and reclaims it", async () => {
    const p = tmpSocket();
    // A foreign server on the reused port: answers something else, then hangs up.
    const foreign = net.createServer((c) => {
      c.once("data", () => c.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    });
    await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", () => r()));
    try {
      writeFileSync(p, formatMsysSocketFile((foreign.address() as net.AddressInfo).port, SECRET));
      expect(await probeMsysSocket(p)).toBe("dead");
      await reclaimMsysSocket(p);
      expect(existsSync(p)).toBe(false);
    } finally {
      await new Promise<void>((r) => foreign.close(() => r()));
    }
  });

  it("reads a silent listener as unknown — nothing proves it is safe to remove", async () => {
    const p = tmpSocket();
    const held: net.Socket[] = [];
    const silent = net.createServer((c) => held.push(c));
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    try {
      writeFileSync(p, formatMsysSocketFile((silent.address() as net.AddressInfo).port, SECRET));
      expect(await probeMsysSocket(p, 100)).toBe("unknown");
    } finally {
      for (const c of held) c.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });

  it("reads a live server as live, and never reclaims it", async () => {
    const p = tmpSocket();
    const server = await listenMsysSocket({
      socketPath: p,
      writeSocketFile: plainWriter,
      onConnection: () => undefined,
    });
    try {
      expect(await probeMsysSocket(p)).toBe("live");
      await expect(reclaimMsysSocket(p)).rejects.toBeInstanceOf(SocketAlreadyListeningError);
      expect(existsSync(p)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("reclaims a missing file without complaint", async () => {
    await expect(reclaimMsysSocket(tmpSocket())).resolves.toBeUndefined();
  });
});
