// Issue #1728 — the pty-host master (src/pty-host/), run for real under
// node-pty. The endpoint is a unix socket here and a named pipe on Windows
// (via ipcPath) — the master is platform-neutral, which is what lets it be
// tested on Linux CI.
//
// Most cases drive master.mjs in-process (so its lines are covered); one
// runs the actual `pty-host.mjs -n` command line end to end, launcher and
// detached master included.
//
// No systemd, no dtach: nothing here goes near a scope.

import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachPtyHost, type AttachClient } from "../../src/services/pty-host-client.js";
import { probeSocket } from "../../src/services/unix-socket.js";
import { ipcPath } from "../../src/cli/ipc-path.mjs";
import { createSession, isServing, probeEndpoint, serve } from "../../src/pty-host/master.mjs";
import { TOKEN_ENV, encodeFrame, encodeHello, FRAME_DATA } from "../../src/pty-host/protocol.mjs";

const PTY_HOST = path.resolve(import.meta.dirname, "..", "..", "src", "pty-host", "pty-host.mjs");

/** The session token every master in this file is started with. */
const TOKEN = "test-session-token";

/** A program that echoes each line back with a prefix, and exits 3 on "quit". */
const ECHO_PROGRAM = [
  "-e",
  [
    "process.stdin.setEncoding('utf8');",
    "process.stdout.write('ready\\n');",
    "process.stdin.on('data', (d) => {",
    "  if (d.includes('quit')) process.exit(3);",
    // getWindowSize() asks the terminal now; .columns is only refreshed by a
    // resize event, which Windows delivers late.
    "  if (d.includes('size')) process.stdout.write('size:' + process.stdout.getWindowSize().join('x') + '\\n');",
    "  else if (d.includes('env')) process.stdout.write('token:' + (process.env.MULLION_PTY_HOST_TOKEN || 'none') + '\\n');",
    "  else process.stdout.write('got:' + d.trim() + '\\n');",
    "});",
  ].join(""),
];

const cleanups: Array<() => void | Promise<void>> = [];
// Last registered, first run — so a session is ended before the temp dir
// holding its endpoint is removed.
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-host-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const tmpEndpoint = () => ipcPath(path.join(tmpDir(), "1.sock"));

const until = async (cond: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until something accepts connections on `endpoint`. */
async function waitServing(endpoint: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await isServing(endpoint))) {
    if (Date.now() > deadline) throw new Error(`${endpoint} never served`);
    await sleep(20);
  }
}

/** Attaches once the master serves and collects output; waits for the program's "ready". */
async function attachReady(endpoint: string) {
  await waitServing(endpoint);
  const client: AttachClient = attachPtyHost(endpoint, { cols: 80, rows: 24 }, TOKEN);
  const seen = { output: "", exits: [] as Array<{ exitCode: number }> };
  client.onData((d) => (seen.output += d));
  client.onExit((e) => seen.exits.push(e));
  cleanups.push(() => client.kill());
  await until(() => seen.output.includes("ready"));
  return { client, seen };
}

describe("serve (the master)", () => {
  it("serves the program to a client — input, output, resize — and ends with it", async () => {
    const endpoint = tmpEndpoint();
    const exitCodes: number[] = [];
    serve(endpoint, process.execPath, ECHO_PROGRAM, {
      token: TOKEN,
      onExit: (code) => exitCodes.push(code),
      log: () => {},
    });
    const { client, seen } = await attachReady(endpoint);

    client.write("hello\r");
    await until(() => seen.output.includes("got:hello"));

    client.write("quit\r");
    await until(() => seen.exits.length > 0);
    expect(seen.exits).toEqual([{ exitCode: 3 }]);
    await until(() => exitCodes.length > 0);
    expect(exitCodes).toEqual([0]);
    expect(await isServing(endpoint)).toBe(false);
  }, 30_000);

  // Skipped on Windows only because of the PROBE: a Node program there keeps
  // reporting its starting size — libuv caches the console size and refreshes
  // it from resize events it only reads in raw-input mode. The resize itself
  // reaches ConPTY (it repaints, and `stty size` in bash reports the new
  // size — verified by hand on Windows 11 for issue #1728).
  it.skipIf(process.platform === "win32")(
    "applies a client's resize to the terminal",
    async () => {
      const endpoint = tmpEndpoint();
      const master = serve(endpoint, process.execPath, ECHO_PROGRAM, {
        token: TOKEN,
        onExit: () => {},
        log: () => {},
      });
      cleanups.push(() => master.stop());
      const { client, seen } = await attachReady(endpoint);
      client.resize(100, 30);
      await sleep(100);
      client.write("size\r");
      await until(() => seen.output.includes("size:100x30"));
    },
    30_000,
  );

  it("fans output out to every attached client", async () => {
    const endpoint = tmpEndpoint();
    const master = serve(endpoint, process.execPath, ECHO_PROGRAM, {
      token: TOKEN,
      onExit: () => {},
      log: () => {},
    });
    cleanups.push(() => master.stop());
    const a = await attachReady(endpoint);
    const b = attachPtyHost(endpoint, { cols: 80, rows: 24 }, TOKEN);
    let bOutput = "";
    b.onData((d) => (bOutput += d));
    cleanups.push(() => b.kill());
    // No sleep-and-hope: the master keeps no scrollback, so `b` only sees
    // output produced after it connected. Keep typing until it does.
    for (let attempt = 0; !bOutput.includes("got:both"); attempt++) {
      if (attempt > 60) throw new Error("the second client never saw the output");
      a.client.write("both\r");
      await sleep(150);
    }
  }, 30_000);

  it("stop() kills the program, which ends the master", async () => {
    const endpoint = tmpEndpoint();
    const exitCodes: number[] = [];
    const master = serve(endpoint, process.execPath, ECHO_PROGRAM, {
      token: TOKEN,
      onExit: (code) => exitCodes.push(code),
      log: () => {},
    });
    await attachReady(endpoint);
    master.stop();
    await until(() => exitCodes.length > 0);
    expect(exitCodes).toEqual([0]);
  }, 30_000);

  it("refuses an endpoint that is already served, without starting the program", async () => {
    const endpoint = tmpEndpoint();
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(endpoint, r));
    cleanups.push(() => void holder.close());
    const exitCodes: number[] = [];
    const logs: string[] = [];
    serve(endpoint, process.execPath, ECHO_PROGRAM, {
      token: TOKEN,
      onExit: (code) => exitCodes.push(code),
      log: (line) => logs.push(line),
    });
    await until(() => exitCodes.length > 0);
    expect(exitCodes).toEqual([1]);
    expect(logs.join("\n")).toMatch(/cannot serve/);
  });

  it("drops a client that sends a malformed frame, and keeps serving the rest", async () => {
    const endpoint = tmpEndpoint();
    const master = serve(endpoint, process.execPath, ECHO_PROGRAM, {
      token: TOKEN,
      onExit: () => {},
      log: () => {},
    });
    cleanups.push(() => master.stop());
    const good = await attachReady(endpoint);
    const bad = net.connect(endpoint);
    const closed = new Promise<void>((r) => bad.on("close", () => r()));
    bad.on("error", () => {});
    const huge = Buffer.alloc(5);
    huge.writeUInt32BE(0xffffffff, 1);
    bad.write(huge);
    await closed;
    good.client.write("still\r");
    await until(() => good.seen.output.includes("got:still"));
  }, 30_000);
});

describe("serve — the session token", () => {
  /** A master on a fresh endpoint, with one authenticated client ready. */
  async function servedWithClient() {
    const endpoint = tmpEndpoint();
    const master = serve(endpoint, process.execPath, ECHO_PROGRAM, {
      token: TOKEN,
      onExit: () => {},
      log: () => {},
    });
    cleanups.push(() => master.stop());
    return { endpoint, good: await attachReady(endpoint) };
  }

  /** A raw connection that sends `frames` and reports what it got back. */
  async function rawClient(endpoint: string, frames: Buffer[]) {
    const socket = net.connect(endpoint);
    let received = 0;
    socket.on("data", (chunk) => (received += chunk.length));
    socket.on("error", () => {});
    const closed = new Promise<void>((r) => socket.on("close", () => r()));
    for (const frame of frames) socket.write(frame);
    return { closed, received: () => received };
  }

  it("refuses to serve without a token, without starting the program", async () => {
    const exitCodes: number[] = [];
    const logs: string[] = [];
    const master = serve(tmpEndpoint(), process.execPath, ECHO_PROGRAM, {
      token: "",
      onExit: (code) => exitCodes.push(code),
      log: (line) => logs.push(line),
    });
    master.stop();
    expect(exitCodes).toEqual([1]);
    expect(logs.join("\n")).toMatch(/without a session token/);
  });

  it("a refused attach reports a failed exit (1), never a clean one", async () => {
    const { endpoint } = await servedWithClient();
    const refused = attachPtyHost(endpoint, { cols: 80, rows: 24 }, "stale-token");
    const exits: Array<{ exitCode: number }> = [];
    let bytes = 0;
    refused.onData((d) => (bytes += d.length));
    refused.onExit((e) => exits.push(e));
    await until(() => exits.length > 0);
    expect(exits).toEqual([{ exitCode: 1 }]);
    expect(bytes).toBe(0);
  }, 30_000);

  it("drops a client with the wrong token, which never sees output", async () => {
    const { endpoint, good } = await servedWithClient();
    const intruder = await rawClient(endpoint, [encodeHello("wrong")]);
    await intruder.closed;
    good.client.write("hello\r");
    await until(() => good.seen.output.includes("got:hello"));
    expect(intruder.received()).toBe(0);
  }, 30_000);

  it("drops a client whose first frame is not the token, and ignores what it sent", async () => {
    const { endpoint, good } = await servedWithClient();
    const intruder = await rawClient(endpoint, [
      encodeFrame(FRAME_DATA, Buffer.from("intruder\r")),
    ]);
    await intruder.closed;
    good.client.write("after\r");
    await until(() => good.seen.output.includes("got:after"));
    expect(good.seen.output).not.toContain("got:intruder");
  }, 30_000);

  it("keeps the token out of the program's environment", async () => {
    const { good } = await servedWithClient();
    good.client.write("env\r");
    await until(() => good.seen.output.includes("token:"));
    expect(good.seen.output).toContain("token:none");
  }, 30_000);
});

describe("createSession (-n)", () => {
  // A unix-socket-only case: a named pipe leaves no file behind.
  it.skipIf(process.platform === "win32")(
    "clears a stale socket file nothing serves before launching",
    async () => {
      const dir = tmpDir();
      const endpoint = path.join(dir, "1.sock");
      fs.writeFileSync(endpoint, ""); // connecting to it is refused: provably dead
      const dies = path.join(dir, "dies.mjs");
      fs.writeFileSync(dies, "process.exit(1);\n");
      await createSession(endpoint, process.execPath, [], { entry: dies, log: () => {} });
      expect(fs.existsSync(endpoint)).toBe(false);
    },
    30_000,
  );

  it("refuses an endpoint that is already served, like dtach", async () => {
    const endpoint = tmpEndpoint();
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(endpoint, r));
    cleanups.push(() => void holder.close());
    const logs: string[] = [];
    const code = await createSession(endpoint, process.execPath, [], {
      entry: PTY_HOST,
      log: (line) => logs.push(line),
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/already in use/);
  });

  it("reports a master that exits before serving", async () => {
    const dir = tmpDir();
    const dies = path.join(dir, "dies.mjs");
    fs.writeFileSync(dies, "process.exit(1);\n");
    const logs: string[] = [];
    const code = await createSession(ipcPath(path.join(dir, "1.sock")), process.execPath, [], {
      entry: dies,
      log: (line) => logs.push(line),
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/exited \(code 1\) before serving/);
  }, 30_000);

  it("gives up on a master that never serves", async () => {
    const dir = tmpDir();
    const idles = path.join(dir, "idles.mjs");
    fs.writeFileSync(idles, "setTimeout(() => {}, 1500);\n");
    const logs: string[] = [];
    const code = await createSession(ipcPath(path.join(dir, "1.sock")), process.execPath, [], {
      entry: idles,
      log: (line) => logs.push(line),
      readyTimeoutMs: 300,
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/did not serve .* within 300ms/);
  }, 30_000);
});

describe("pty-host.mjs (the command line)", () => {
  it("-n launches a detached master that outlives the launcher", async () => {
    const endpoint = tmpEndpoint();
    const launched = spawnSync(
      process.execPath,
      [PTY_HOST, "-n", endpoint, process.execPath, ...ECHO_PROGRAM],
      { encoding: "utf8", timeout: 20_000, env: { ...process.env, [TOKEN_ENV]: TOKEN } },
    );
    // This master is detached from the test process, so end it even if an
    // assertion below fails: tell its program to quit, over the session.
    cleanups.push(async () => {
      if (!(await isServing(endpoint))) return;
      const stopper = attachPtyHost(endpoint, { cols: 80, rows: 24 }, TOKEN);
      stopper.write("quit\r");
      await sleep(500);
      stopper.kill();
    });
    expect(launched.stderr).toBe("");
    expect(launched.status).toBe(0);
    // The launcher has exited; the master it started is still serving.
    expect(await probeSocket(endpoint)).toBe("live");

    const { client, seen } = await attachReady(endpoint);
    client.write("quit\r");
    await until(() => seen.exits.length > 0);
    expect(seen.exits).toEqual([{ exitCode: 3 }]);
    await sleep(600);
    expect(await isServing(endpoint)).toBe(false);
  }, 30_000);

  it("-n fails when the master has no session token to serve with", () => {
    const env = { ...process.env };
    delete env[TOKEN_ENV];
    const result = spawnSync(
      process.execPath,
      [PTY_HOST, "-n", tmpEndpoint(), process.execPath, ...ECHO_PROGRAM],
      { encoding: "utf8", timeout: 20_000, env },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/exited \(code 1\) before serving/);
  }, 30_000);

  it("prints its usage on bad arguments", () => {
    const result = spawnSync(process.execPath, [PTY_HOST, "--bogus"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: pty-host\.mjs -n <endpoint>/);
  });
});

describe("probeEndpoint", () => {
  it("answers live for a served endpoint and dead for one nothing serves", async () => {
    const endpoint = tmpEndpoint();
    expect(await probeEndpoint(endpoint)).toBe("dead");
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(endpoint, r));
    cleanups.push(() => void server.close());
    expect(await probeEndpoint(endpoint)).toBe("live");
  });

  it("answers unknown, never dead, when the probe cannot finish in time", async () => {
    // A connection that never answers either way.
    const hung = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const spy = vi.spyOn(net, "connect").mockReturnValue(hung as unknown as net.Socket);
    try {
      expect(await probeEndpoint(tmpEndpoint(), 50)).toBe("unknown");
      expect(hung.destroy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("answers unknown for an error that does not prove the endpoint free", async () => {
    const failing = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const spy = vi.spyOn(net, "connect").mockReturnValue(failing as unknown as net.Socket);
    try {
      const answer = probeEndpoint(tmpEndpoint());
      failing.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }));
      expect(await answer).toBe("unknown");
    } finally {
      spy.mockRestore();
    }
  });
});
