import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { mapOpenCodeEvent, MullionHookEmitter } from "../../src/hooks/opencode-plugin.js";

// Unlike forwarder.mjs (a subprocess entry point with a top-level `main()`
// that runs on load), this plugin file has no top-level side effects — only
// calling the exported MullionHookEmitter() factory, or its returned
// `event` hook, does any I/O. That makes it safe to import and exercise
// directly in-process here, no subprocess spawning needed (see the plan's
// "Testability of the forwarder" note, which this plugin doesn't need the
// same split for).

describe("mapOpenCodeEvent (issue #175)", () => {
  it("maps session.idle to a done progress message", () => {
    expect(mapOpenCodeEvent({ type: "session.idle", properties: { sessionID: "1" } })).toEqual({
      kind: "progress",
      phase: "done",
    });
  });

  it("maps file.edited to a file_change message", () => {
    expect(mapOpenCodeEvent({ type: "file.edited", properties: { file: "/repo/a.ts" } })).toEqual({
      kind: "file_change",
      path: "/repo/a.ts",
      action: "modify",
    });
  });

  it("returns null when file.edited has no usable file path", () => {
    expect(mapOpenCodeEvent({ type: "file.edited", properties: {} })).toBeNull();
  });

  it("returns null for an event type not forwarded (e.g. permission.asked, deferred to issue #178)", () => {
    expect(mapOpenCodeEvent({ type: "permission.asked", properties: {} })).toBeNull();
  });

  it("returns null for a nullish event", () => {
    expect(mapOpenCodeEvent(undefined)).toBeNull();
    expect(mapOpenCodeEvent(null)).toBeNull();
  });
});

describe("MullionHookEmitter (issue #175)", () => {
  let dir: string;
  let server: net.Server | null = null;
  // The plugin deliberately keeps its connection open for reuse (see
  // opencode-plugin.js's header comment) — server.close() alone waits
  // forever for a connection nothing here ever ends, so every accepted
  // socket is tracked and force-destroyed in afterEach instead.
  let openSockets: net.Socket[] = [];

  afterEach(async () => {
    for (const socket of openSockets) socket.destroy();
    openSockets = [];
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.MULLION_HOOK_SOCKET;
    delete process.env.MULLION_HOOK_TOKEN;
  });

  function collectLines(count: number): Promise<string[]> {
    return new Promise((resolve) => {
      server?.once("connection", (socket) => {
        openSockets.push(socket);
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

  it("handshakes and forwards a mapped session.idle event", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = net.createServer();
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-456";

    const linesPromise = collectLines(2);
    const hooks = await MullionHookEmitter();
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "1" } } });

    const [handshakeLine, messageLine] = await linesPromise;
    expect(JSON.parse(handshakeLine)).toEqual({ token: "tok-456" });
    expect(JSON.parse(messageLine)).toEqual({ kind: "progress", phase: "done" });
  });

  it("sends multiple events over the same reused connection", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = net.createServer();
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-456";

    const linesPromise = collectLines(3);
    const hooks = await MullionHookEmitter();
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "1" } } });
    await hooks.event?.({ event: { type: "file.edited", properties: { file: "/repo/a.ts" } } });

    const [, second, third] = await linesPromise;
    expect(JSON.parse(second)).toEqual({ kind: "progress", phase: "done" });
    expect(JSON.parse(third)).toEqual({
      kind: "file_change",
      path: "/repo/a.ts",
      action: "modify",
    });
  });

  it("never throws with no socket configured at all", async () => {
    const hooks = await MullionHookEmitter();
    await expect(
      hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "1" } } }),
    ).resolves.toBeUndefined();
  });

  it("does not open a connection for an event with no mapping", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = net.createServer();
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-456";
    let sawConnection = false;
    server.on("connection", () => {
      sawConnection = true;
    });

    const hooks = await MullionHookEmitter();
    await hooks.event?.({ event: { type: "permission.asked", properties: {} } });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sawConnection).toBe(false);
  });
});
