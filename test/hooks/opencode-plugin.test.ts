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
// mapOpenCodeEvent/promoteRequest are read off MullionHookEmitter as
// properties, not imported as their own named exports — the module must
// have exactly one top-level `export`, or OpenCode's real plugin loader
// crashes the whole server on startup (see opencode-plugin.js's own
// comment on this).
const { mapOpenCodeEvent, promoteRequest } = MullionHookEmitter;

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

describe("promoteRequest (issue #271)", () => {
  let dir: string;
  let server: net.Server | null = null;
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

  /** Creates a server that collects both incoming lines and then answers
   * with `reply`. Returns a promise for the incoming lines so the test can
   * verify the handshake and promote_request were sent correctly. */
  function acceptingServer(reply: object): Promise<string[]> {
    return new Promise((resolve) => {
      server = net.createServer((socket) => {
        openSockets.push(socket);
        let buffer = "";
        const lines: string[] = [];
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let idx = buffer.indexOf("\n");
          while (idx !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            idx = buffer.indexOf("\n");
            lines.push(line);
            // Once both handshake + promote_request are received, reply
            if (lines.length === 2) {
              socket.write(`${JSON.stringify(reply)}\n`);
              resolve(lines);
            }
          }
        });
      });
    });
  }

  it("returns declined when MULLION_HOOK_SOCKET is not set", async () => {
    delete process.env.MULLION_HOOK_SOCKET;
    process.env.MULLION_HOOK_TOKEN = "tok";
    const result = await promoteRequest("test summary", "main");
    expect(result).toContain("Declined");
    expect(result).toContain("MULLION_HOOK_SOCKET");
    expect(result).not.toContain("MULLION_HOOK_TOKEN");
  });

  it("returns declined when MULLION_HOOK_TOKEN is not set", async () => {
    process.env.MULLION_HOOK_SOCKET = "/tmp/nonexistent.sock";
    delete process.env.MULLION_HOOK_TOKEN;
    const result = await promoteRequest("test summary", "main");
    expect(result).toContain("Declined");
    expect(result).toContain("MULLION_HOOK_TOKEN");
    expect(result).not.toContain("MULLION_HOOK_SOCKET");
  });

  it("returns an approval message on accepted decision", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    const incomingPromise = acceptingServer({
      decision: "accepted",
      worktreePath: "/tmp/mullion-wt",
      newSessionId: 42,
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-promote";

    const [result, incoming] = await Promise.all([
      promoteRequest("test summary", "main"),
      incomingPromise,
    ]);

    expect(JSON.parse(incoming[0])).toEqual({ token: "tok-promote" });
    expect(JSON.parse(incoming[1])).toEqual({
      kind: "promote_request",
      summary: "test summary",
      suggestedBaseRef: "main",
    });
    expect(result).toContain("Approved");
    expect(result).toContain("/tmp/mullion-wt");
    expect(result).toContain("session 42");
    expect(result).toContain("This session is ending");
  });

  it("returns an approval message when newSessionId is null", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    const incomingPromise = acceptingServer({
      decision: "accepted",
      worktreePath: "/tmp/wt",
      newSessionId: null,
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-promote";

    const [result] = await Promise.all([promoteRequest("test summary", "main"), incomingPromise]);

    expect(result).toContain("Approved");
    expect(result).not.toContain("session null");
  });

  it("returns declined message on declined decision", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    const incomingPromise = acceptingServer({
      decision: "declined",
      reason: "not ready yet",
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-promote";

    const [result] = await Promise.all([promoteRequest("test summary", "main"), incomingPromise]);

    expect(result).toContain("Declined");
    expect(result).toContain("not ready yet");
  });

  it("returns declined message on declined decision without reason", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    const incomingPromise = acceptingServer({ decision: "declined" });
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-promote";

    const [result] = await Promise.all([
      promoteRequest("test summary", undefined),
      incomingPromise,
    ]);

    expect(result).toBe("Declined. Continue on the current checkout.");
  });

  it("returns declined on connection error", async () => {
    // Point at a socket that nothing is listening on
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "no-server.sock");
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-promote";

    const result = await promoteRequest("test summary", "main");
    expect(result).toContain("Declined");
    expect(result).toContain("connection error");
  });

  it("returns declined on malformed response", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = net.createServer((socket) => {
      openSockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        // Both handshake + promote_request lines received
        if ((buffer.match(/\n/g) || []).length >= 2) {
          socket.write("not-json\n");
        }
      });
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-promote";

    const result = await promoteRequest("test summary", "main");
    expect(result).toContain("Declined");
    expect(result).toContain("malformed response");
  });

  it("returns declined when server closes without sending data", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = net.createServer((socket) => {
      openSockets.push(socket);
      // Accept the connection, read both lines, then close without replying
      socket.on("data", () => {
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-promote";

    const result = await promoteRequest("test summary", "main");
    expect(result).toContain("Declined");
    expect(result).toContain("connection closed");
  });

  it("sends promote_request without suggestedBaseRef when undefined", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    const incomingPromise = acceptingServer({ decision: "declined" });
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-promote";

    const [, incoming] = await Promise.all([promoteRequest("only summary"), incomingPromise]);

    const msg = JSON.parse(incoming[1]);
    expect(msg.kind).toBe("promote_request");
    expect(msg.summary).toBe("only summary");
    expect(msg.suggestedBaseRef).toBeUndefined();
  });
});

describe("MullionHookEmitter tool registration (issue #271)", () => {
  let dir: string;
  let server: net.Server | null = null;
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

  it("registers promote_to_worktree tool when zod is available", async () => {
    const hooks = await MullionHookEmitter();
    expect(hooks.tool).toBeDefined();
    expect(hooks.tool?.promote_to_worktree).toBeDefined();
  });

  it("tool has description, args, and execute", async () => {
    const hooks = await MullionHookEmitter();
    const tool = hooks.tool?.promote_to_worktree;
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description.length).toBeGreaterThan(0);
    expect(tool!.args).toBeDefined();
    expect(typeof tool!.args.summary).toBe("object");
    expect(typeof tool!.execute).toBe("function");
  });

  it("tool.args has required summary and optional suggestedBaseRef", async () => {
    const hooks = await MullionHookEmitter();
    const tool = hooks.tool?.promote_to_worktree;
    expect(tool).toBeDefined();
    expect(tool!.args.summary.isOptional?.()).toBe(false);
    expect(tool!.args.suggestedBaseRef?.isOptional?.()).toBe(true);
  });

  it("tool.execute invokes promoteRequest", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-tool-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = net.createServer((socket) => {
      openSockets.push(socket);
      let lines = 0;
      socket.on("data", (chunk) => {
        lines += (chunk.toString().match(/\n/g) || []).length;
        if (lines >= 2) {
          socket.write(
            JSON.stringify({ decision: "accepted", worktreePath: "/wt", newSessionId: 1 }) + "\n",
          );
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-tool";

    const hooks = await MullionHookEmitter();
    const result = await hooks.tool!.promote_to_worktree.execute(
      { summary: "do work", suggestedBaseRef: "main" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(result).toContain("Approved");
    expect(result).toContain("/wt");
    expect(result).toContain("session 1");
  });

  it("still registers event hook alongside tool", async () => {
    const hooks = await MullionHookEmitter();
    expect(typeof hooks.event).toBe("function");
    expect(hooks.tool?.promote_to_worktree).toBeDefined();
  });
});
