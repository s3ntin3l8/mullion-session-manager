import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { MullionHookEmitter } from "../../src/hooks/opencode-plugin.js";

// Unlike forwarder.mjs (a subprocess entry point with a top-level `main()`
// that runs on load), this plugin file has no top-level side effects — only
// calling the exported MullionHookEmitter() factory, or its returned
// `event` hook, does any I/O. That makes it safe to import and exercise
// directly in-process here, no subprocess spawning needed (see the plan's
// "Testability of the forwarder" note, which this plugin doesn't need the
// same split for).
//
// mapOpenCodeEvent is read off MullionHookEmitter as a property, not
// imported as its own named export — the module must have exactly one
// top-level `export`, or OpenCode's real plugin loader crashes the whole
// server on startup (see opencode-plugin.js's own comment on this).
const { mapOpenCodeEvent } = MullionHookEmitter;

describe("opencode-plugin.js module shape (regression: opencode startup crash)", () => {
  it("exports exactly one top-level binding (MullionHookEmitter)", async () => {
    const mod = await import("../../src/hooks/opencode-plugin.js");
    expect(Object.keys(mod)).toEqual(["MullionHookEmitter"]);
  });
});

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

  // Follow-up to #275 (gap #2, issue #259) — notification parity for opencode.
  describe("permission.updated / permission.replied", () => {
    it("maps permission.updated to a notification carrying the permission's own title", () => {
      expect(
        mapOpenCodeEvent({
          type: "permission.updated",
          properties: { id: "p1", title: "Run `rm -rf build/`?", sessionID: "1" },
        }),
      ).toEqual({ kind: "notification", title: "opencode", body: "Run `rm -rf build/`?" });
    });

    it("maps permission.updated with a missing/non-string title to an empty body, still a valid notification", () => {
      expect(mapOpenCodeEvent({ type: "permission.updated", properties: {} })).toEqual({
        kind: "notification",
        title: "opencode",
        body: "",
      });
    });

    it("maps permission.replied to the resolution message", () => {
      expect(
        mapOpenCodeEvent({
          type: "permission.replied",
          properties: { sessionID: "1", permissionID: "p1", response: "always" },
        }),
      ).toEqual({ kind: "notification_resolved" });
    });
  });

  describe("session.error", () => {
    it("maps a ProviderAuthError to a notification using its data.message", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.error",
          properties: {
            error: {
              name: "ProviderAuthError",
              data: { providerID: "anthropic", message: "bad key" },
            },
          },
        }),
      ).toEqual({ kind: "notification", title: "opencode error", body: "bad key" });
    });

    it("falls back to the error's own name when data.message is missing (e.g. MessageOutputLengthError)", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.error",
          properties: { error: { name: "MessageOutputLengthError", data: {} } },
        }),
      ).toEqual({
        kind: "notification",
        title: "opencode error",
        body: "MessageOutputLengthError",
      });
    });

    it("skips MessageAbortedError entirely (user-initiated Ctrl-C, not attention-worthy)", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.error",
          properties: { error: { name: "MessageAbortedError", data: { message: "aborted" } } },
        }),
      ).toBeNull();
    });

    it("returns null when no error is present on the event at all", () => {
      expect(mapOpenCodeEvent({ type: "session.error", properties: {} })).toBeNull();
    });
  });

  describe("tui.toast.show", () => {
    it.each(["warning", "error"] as const)(
      "maps a %s-variant toast to a notification",
      (variant) => {
        expect(
          mapOpenCodeEvent({
            type: "tui.toast.show",
            properties: { variant, title: "Heads up", message: "Something needs attention" },
          }),
        ).toEqual({ kind: "notification", title: "Heads up", body: "Something needs attention" });
      },
    );

    it("falls back to a generic title when the toast has none", () => {
      expect(
        mapOpenCodeEvent({
          type: "tui.toast.show",
          properties: { variant: "error", message: "Failed" },
        }),
      ).toEqual({ kind: "notification", title: "opencode", body: "Failed" });
    });

    it.each(["info", "success"] as const)(
      "filters out %s-variant toasts as routine noise",
      (variant) => {
        expect(
          mapOpenCodeEvent({
            type: "tui.toast.show",
            properties: { variant, title: "Copied", message: "Copied to clipboard" },
          }),
        ).toBeNull();
      },
    );
  });

  describe("session.status", () => {
    it("maps a retry status to a notification carrying the attempt/message", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.status",
          properties: {
            sessionID: "1",
            status: { type: "retry", attempt: 2, message: "rate limited", next: 5000 },
          },
        }),
      ).toEqual({
        kind: "notification",
        title: "opencode retrying",
        body: "attempt 2: rate limited",
      });
    });

    it("maps a busy status to a generating progress message (not a done/agentIdle signal)", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.status",
          properties: { sessionID: "1", status: { type: "busy" } },
        }),
      ).toEqual({ kind: "progress", phase: "generating" });
    });

    it("maps an idle status to a done progress message, same as the session.idle event", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.status",
          properties: { sessionID: "1", status: { type: "idle" } },
        }),
      ).toEqual({ kind: "progress", phase: "done" });
    });

    it("returns null when properties.status itself is missing", () => {
      expect(mapOpenCodeEvent({ type: "session.status", properties: {} })).toBeNull();
    });
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
