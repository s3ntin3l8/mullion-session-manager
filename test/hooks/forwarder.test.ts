import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Integration-style test for the actual forwarder.mjs subprocess entry
// point (issue #174) — the thin stdin/socket shim that forwarder-core.test.ts
// can't reach (that file only exercises the pure mapping functions in-
// process). Mirrors test/plugins/hooks.test.ts's "real socket, real client"
// posture: a real net.createServer Unix socket stands in for hooksPlugin's
// listener, and a real `node forwarder.mjs` child process stands in for
// what an agent's hook runner actually invokes — see the plan's
// "Testability of the forwarder" note for why this split (pure core +
// thin, separately-covered shim) is how forwarder.mjs stays inside CI's
// coverage floor without an exclude.

const FORWARDER_PATH = fileURLToPath(new URL("../../src/hooks/forwarder.mjs", import.meta.url));

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

// Attaches the 'data' listener the INSTANT a connection arrives (inside the
// synchronous 'connection' handler), not after — a net.Socket stays paused
// (not flowing, not consuming its underlying fd) until something puts it in
// flowing mode, and the forwarder's `socket.end()` half-close only completes
// (triggering 'close' on the forwarder's own end, which is what lets the
// child process actually exit) once the server side has drained and echoed
// the close back. Awaiting the forwarder's exit code BEFORE calling this
// would deadlock: the child never exits because nothing here has started
// reading yet, but nothing here starts reading until the (never-arriving)
// exit resolves.
function collectLines(server: net.Server, count: number): Promise<string[]> {
  return new Promise((resolve) => {
    server.once("connection", (socket) => {
      let buffer = "";
      const lines: string[] = [];
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          lines.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
          if (lines.length === count) {
            resolve(lines);
            return;
          }
        }
      });
    });
  });
}

/** Runs the real forwarder.mjs as a child process with the given argv/env,
 * writing `stdin` and waiting for it to exit. */
function runForwarder(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FORWARDER_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("forwarder.mjs (issue #174)", () => {
  let dir: string;
  let server: net.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("handshakes and forwards a mapped Notification message", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = await listen(socketPath);

    const linesPromise = collectLines(server, 2);
    const exitCode = await runForwarder(
      ["claude-code", "Notification"],
      { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
      JSON.stringify({ message: "Waiting for review" }),
    );
    expect(exitCode).toBe(0);

    const [handshakeLine, messageLine] = await linesPromise;
    expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-123" });
    expect(JSON.parse(messageLine)).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "Waiting for review",
    });
  });

  it("connects nothing when the mapped event has no message (unmatched PostToolUse tool)", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = await listen(socketPath);
    let sawConnection = false;
    server.on("connection", () => {
      sawConnection = true;
    });

    const exitCode = await runForwarder(
      ["claude-code", "PostToolUse"],
      { MULLION_HOOK_SOCKET: socketPath, MULLION_HOOK_TOKEN: "tok-123" },
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
    );
    expect(exitCode).toBe(0);
    expect(sawConnection).toBe(false);
  });

  it("exits cleanly with no socket configured at all", async () => {
    const exitCode = await runForwarder(
      ["claude-code", "Stop"],
      { MULLION_HOOK_SOCKET: "", MULLION_HOOK_TOKEN: "" },
      "{}",
    );
    expect(exitCode).toBe(0);
  });

  it("exits cleanly (never throws) when the socket path doesn't exist", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-forwarder-"));
    const exitCode = await runForwarder(
      ["claude-code", "Stop"],
      { MULLION_HOOK_SOCKET: path.join(dir, "no-such.sock"), MULLION_HOOK_TOKEN: "tok" },
      "{}",
    );
    expect(exitCode).toBe(0);
  });
});
