import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { MullionHookEmitter } from "../../src/hooks/opencode-plugin.js";
import { openCodeAdapter } from "../../src/services/hook-adapters/opencode.js";

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
const { mapOpenCodeEvent, promoteRequest, mapToolExecuteAfter } = MullionHookEmitter;

describe("opencode-plugin.js module shape (regression: opencode startup crash)", () => {
  it("exports exactly one top-level binding (MullionHookEmitter)", async () => {
    const mod = await import("../../src/hooks/opencode-plugin.js");
    expect(Object.keys(mod)).toEqual(["MullionHookEmitter"]);
  });
});

describe("mapOpenCodeEvent (issue #175)", () => {
  // Issue #271 follow-up — session.idle's own payload carries opencode's
  // internal session id for free; mapOpenCodeEvent now also reports it as a
  // second "agent_session" message alongside the existing progress one, so a
  // later promote can transfer this session's real conversation history.
  it("maps session.idle to a done progress message plus the live agent_session id", () => {
    expect(mapOpenCodeEvent({ type: "session.idle", properties: { sessionID: "1" } })).toEqual([
      { kind: "progress", phase: "done" },
      { kind: "agent_session", sessionId: "1" },
    ]);
  });

  it("omits the agent_session message when session.idle carries no sessionID", () => {
    expect(mapOpenCodeEvent({ type: "session.idle", properties: {} })).toEqual([
      { kind: "progress", phase: "done" },
    ]);
  });

  it("maps file.edited to a file_change message", () => {
    expect(mapOpenCodeEvent({ type: "file.edited", properties: { file: "/repo/a.ts" } })).toEqual([
      { kind: "file_change", path: "/repo/a.ts", action: "modify" },
    ]);
  });

  it("returns null when file.edited has no usable file path", () => {
    expect(mapOpenCodeEvent({ type: "file.edited", properties: {} })).toBeNull();
  });

  it("returns null for an event type not forwarded", () => {
    expect(mapOpenCodeEvent({ type: "unknown.event", properties: {} })).toBeNull();
  });

  it("returns null for a nullish event", () => {
    expect(mapOpenCodeEvent(undefined)).toBeNull();
    expect(mapOpenCodeEvent(null)).toBeNull();
  });

  describe("permission.asked / permission.replied (v2 fix)", () => {
    it("maps permission.asked to a permission_request using permission+patterns as summary", () => {
      expect(
        mapOpenCodeEvent({
          type: "permission.asked",
          properties: { id: "p1", permission: "bash", patterns: ["rm -rf build/"], sessionID: "1" },
        }),
      ).toEqual([{ kind: "permission_request", tool: "opencode", summary: "bash rm -rf build/" }]);
    });

    it("maps permission.asked with no patterns to a permission_request with just the permission type as summary", () => {
      expect(
        mapOpenCodeEvent({ type: "permission.asked", properties: { permission: "edit" } }),
      ).toEqual([{ kind: "permission_request", tool: "opencode", summary: "edit" }]);
    });

    // Fix: status-clearing-semantics — was "notification_resolved", which
    // permission.asked's own confirmedKind (permissionRequest, not
    // hookNotification) meant this never actually cleared. See the plugin's
    // own comment on this event.
    it("maps permission.replied to permission_resolved, matching what permission.asked raises", () => {
      expect(
        mapOpenCodeEvent({
          type: "permission.replied",
          properties: { sessionID: "1", permissionID: "p1", response: "always" },
        }),
      ).toEqual([{ kind: "permission_resolved" }]);
    });
  });

  describe("session.error", () => {
    it("maps a ProviderAuthError to a tool_failure using its data.message as summary", () => {
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
      ).toEqual([
        {
          kind: "tool_failure",
          tool: "opencode",
          error: "ProviderAuthError",
          summary: "bad key",
        },
      ]);
    });

    it("falls back to the error's own name as summary when data.message is missing (e.g. MessageOutputLengthError)", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.error",
          properties: { error: { name: "MessageOutputLengthError", data: {} } },
        }),
      ).toEqual([
        {
          kind: "tool_failure",
          tool: "opencode",
          error: "MessageOutputLengthError",
          summary: "MessageOutputLengthError",
        },
      ]);
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
        ).toEqual([{ kind: "notification", title: "Heads up", body: "Something needs attention" }]);
      },
    );

    it("falls back to a generic title when the toast has none", () => {
      expect(
        mapOpenCodeEvent({
          type: "tui.toast.show",
          properties: { variant: "error", message: "Failed" },
        }),
      ).toEqual([{ kind: "notification", title: "opencode", body: "Failed" }]);
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
    it("maps a retry status to a generating progress message — session is still working (issue #275)", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.status",
          properties: {
            sessionID: "1",
            status: { type: "retry", attempt: 2, message: "rate limited", next: 5000 },
          },
        }),
      ).toEqual([
        { kind: "progress", phase: "generating", detail: "retry attempt 2: rate limited" },
      ]);
    });

    it("maps a busy status to turn_start + generating progress (clears finished latch before working)", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.status",
          properties: { sessionID: "1", status: { type: "busy" } },
        }),
      ).toEqual([{ kind: "turn_start" }, { kind: "progress", phase: "generating" }]);
    });

    it("maps an idle status to a done progress message, same as the session.idle event", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.status",
          properties: { sessionID: "1", status: { type: "idle" } },
        }),
      ).toEqual([{ kind: "progress", phase: "done" }]);
    });

    it("returns null when properties.status itself is missing", () => {
      expect(mapOpenCodeEvent({ type: "session.status", properties: {} })).toBeNull();
    });
  });

  describe("session.compacting (issue #321)", () => {
    it("maps session.compacting started to a compact message with state started", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.compacting",
          properties: { state: "started" },
        }),
      ).toEqual([{ kind: "compact", state: "started" }]);
    });

    it("maps session.compacting finished to a compact message with state finished", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.compacting",
          properties: { state: "finished" },
        }),
      ).toEqual([{ kind: "compact", state: "finished" }]);
    });

    it("returns null when session.compacting state is missing", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.compacting",
          properties: {},
        }),
      ).toBeNull();
    });
  });

  describe("session.subagent (issue #321)", () => {
    it("maps session.subagent started to a subagent message with state started", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.subagent",
          properties: { state: "started" },
        }),
      ).toEqual([{ kind: "subagent", state: "started" }]);
    });

    it("maps session.subagent stopped to a subagent message with state finished", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.subagent",
          properties: { state: "stopped" },
        }),
      ).toEqual([{ kind: "subagent", state: "finished" }]);
    });

    it("returns null when session.subagent state is missing", () => {
      expect(
        mapOpenCodeEvent({
          type: "session.subagent",
          properties: {},
        }),
      ).toBeNull();
    });
  });
});

describe("question.asked / question.replied / question.rejected (v2)", () => {
  it("maps question.asked to a question:started hook message with header and summary", () => {
    expect(
      mapOpenCodeEvent({
        type: "question.asked",
        properties: {
          id: "q1",
          sessionID: "1",
          questions: [
            {
              question: "Which mode?",
              header: "Mode",
              options: [{ label: "A", description: "Option A" }],
              multiple: false,
            },
          ],
          tool: { messageID: "m1", callID: "c1" },
        },
      }),
    ).toEqual([
      {
        kind: "question",
        state: "started",
        header: "Mode",
        summary: "Which mode?",
        tool: { messageID: "m1", callID: "c1" },
      },
    ]);
  });

  it("maps question.asked with no questions to question:started without header/summary/tool", () => {
    expect(
      mapOpenCodeEvent({
        type: "question.asked",
        properties: { id: "q1", sessionID: "1", questions: [] },
      }),
    ).toEqual([{ kind: "question", state: "started", header: undefined, summary: undefined }]);
  });

  it("maps question.replied to question:finished", () => {
    expect(
      mapOpenCodeEvent({
        type: "question.replied",
        properties: { sessionID: "1", requestID: "q1", answers: [["A"]] },
      }),
    ).toEqual([{ kind: "question", state: "finished" }]);
  });

  it("maps question.rejected to question:finished", () => {
    expect(
      mapOpenCodeEvent({
        type: "question.rejected",
        properties: { sessionID: "1", requestID: "q1" },
      }),
    ).toEqual([{ kind: "question", state: "finished" }]);
  });
});

describe("todo.updated (v2)", () => {
  it("maps todo.updated to a todo hook message", () => {
    expect(
      mapOpenCodeEvent({
        type: "todo.updated",
        properties: {
          sessionID: "1",
          content: "Implement auth",
          status: "in_progress",
          priority: "high",
        },
      }),
    ).toEqual([
      { kind: "todo", content: "Implement auth", status: "in_progress", priority: "high" },
    ]);
  });

  it("maps todo.updated without priority to default medium", () => {
    expect(
      mapOpenCodeEvent({
        type: "todo.updated",
        properties: { sessionID: "1", content: "Fix bug", status: "pending" },
      }),
    ).toEqual([{ kind: "todo", content: "Fix bug", status: "pending", priority: "medium" }]);
  });

  it("returns null when todo.updated has no content", () => {
    expect(mapOpenCodeEvent({ type: "todo.updated", properties: { status: "done" } })).toBeNull();
  });

  it("clamps unknown priority to medium", () => {
    expect(
      mapOpenCodeEvent({
        type: "todo.updated",
        properties: { content: "Task", status: "pending", priority: "critical" },
      }),
    ).toEqual([{ kind: "todo", content: "Task", status: "pending", priority: "medium" }]);
  });
});

describe("session.diff (v2)", () => {
  it("maps session.diff to a session_diff hook message", () => {
    expect(
      mapOpenCodeEvent({
        type: "session.diff",
        properties: {
          sessionID: "1",
          diff: [{ file: "/repo/a.ts", additions: 10, deletions: 2, patch: "diff a.ts" }],
        },
      }),
    ).toEqual([
      {
        kind: "session_diff",
        files: [{ file: "/repo/a.ts", additions: 10, deletions: 2, patch: "diff a.ts" }],
      },
    ]);
  });

  it("maps session.diff without patches to file entries without patch", () => {
    expect(
      mapOpenCodeEvent({
        type: "session.diff",
        properties: {
          sessionID: "1",
          diff: [{ file: "/repo/b.ts", additions: 5, deletions: 1 }],
        },
      }),
    ).toEqual([
      {
        kind: "session_diff",
        files: [{ file: "/repo/b.ts", additions: 5, deletions: 1, patch: undefined }],
      },
    ]);
  });

  it("returns null when session.diff has an empty diff array", () => {
    expect(
      mapOpenCodeEvent({ type: "session.diff", properties: { sessionID: "1", diff: [] } }),
    ).toBeNull();
  });

  it("returns null when session.diff has no diff field", () => {
    expect(mapOpenCodeEvent({ type: "session.diff", properties: {} })).toBeNull();
  });
});

describe("worktree.failed (v2)", () => {
  it("maps worktree.failed to a notification with the error message", () => {
    expect(
      mapOpenCodeEvent({
        type: "worktree.failed",
        properties: { error: "branch already exists" },
      }),
    ).toEqual([
      {
        kind: "notification",
        title: "OpenCode",
        body: "Worktree creation failed: branch already exists",
      },
    ]);
  });

  it("maps worktree.failed without error to a generic notification", () => {
    expect(mapOpenCodeEvent({ type: "worktree.failed", properties: {} })).toEqual([
      { kind: "notification", title: "OpenCode", body: "Worktree creation failed" },
    ]);
  });
});

describe("mcp.browser.open.failed (v2)", () => {
  it("maps mcp.browser.open.failed to a notification with the MCP server name", () => {
    expect(
      mapOpenCodeEvent({
        type: "mcp.browser.open.failed",
        properties: { mcpName: "github-mcp", url: "https://github.com/login/oauth" },
      }),
    ).toEqual([
      {
        kind: "notification",
        title: "MCP auth failed",
        body: "github-mcp failed to open browser for authentication",
      },
    ]);
  });

  it("maps mcp.browser.open.failed without mcpName to a generic notification", () => {
    expect(mapOpenCodeEvent({ type: "mcp.browser.open.failed", properties: {} })).toEqual([
      { kind: "notification", title: "MCP auth failed", body: "MCP browser auth failed" },
    ]);
  });
});

describe("vcs.branch.updated", () => {
  it("maps a branch update to a git_branch message", () => {
    expect(
      mapOpenCodeEvent({
        type: "vcs.branch.updated",
        properties: { sessionID: "1", branch: "feat/opencode-signals" },
      }),
    ).toEqual([{ kind: "git_branch", branch: "feat/opencode-signals" }]);
  });

  it("maps a branch update with cwd to cwd_changed + git_branch", () => {
    expect(
      mapOpenCodeEvent(
        {
          type: "vcs.branch.updated",
          properties: { sessionID: "1", branch: "feat/opencode-signals" },
        },
        "/home/user/project",
      ),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/home/user/project" },
      { kind: "git_branch", branch: "feat/opencode-signals" },
    ]);
  });

  it("returns null when branch is missing", () => {
    expect(mapOpenCodeEvent({ type: "vcs.branch.updated", properties: {} })).toBeNull();
  });

  it("returns null when branch is an empty string", () => {
    expect(
      mapOpenCodeEvent({
        type: "vcs.branch.updated",
        properties: { sessionID: "1", branch: "" },
      }),
    ).toBeNull();
  });
});

describe("worktree.ready", () => {
  it("maps worktree.ready to a git_branch message", () => {
    expect(
      mapOpenCodeEvent({
        type: "worktree.ready",
        properties: { sessionID: "1", branch: "fix/sidebar-branch" },
      }),
    ).toEqual([{ kind: "git_branch", branch: "fix/sidebar-branch" }]);
  });

  it("maps worktree.ready with cwd to cwd_changed + git_branch", () => {
    expect(
      mapOpenCodeEvent(
        {
          type: "worktree.ready",
          properties: { sessionID: "1", branch: "fix/sidebar-branch" },
        },
        "/home/user/wt",
      ),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/home/user/wt" },
      { kind: "git_branch", branch: "fix/sidebar-branch" },
    ]);
  });

  it("returns null when branch is missing", () => {
    expect(mapOpenCodeEvent({ type: "worktree.ready", properties: {} })).toBeNull();
  });

  it("returns null when branch is an empty string", () => {
    expect(
      mapOpenCodeEvent({
        type: "worktree.ready",
        properties: { sessionID: "1", branch: "" },
      }),
    ).toBeNull();
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

    // 4 lines, not 3: session.idle now sends TWO messages (progress, then
    // the issue #271 follow-up's agent_session — see mapOpenCodeEvent's own
    // test above), still over the same reused connection as file.edited's
    // single file_change message.
    const linesPromise = collectLines(4);
    const hooks = await MullionHookEmitter();
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "1" } } });
    await hooks.event?.({ event: { type: "file.edited", properties: { file: "/repo/a.ts" } } });

    const [, second, third, fourth] = await linesPromise;
    expect(JSON.parse(second)).toEqual({ kind: "progress", phase: "done" });
    expect(JSON.parse(third)).toEqual({ kind: "agent_session", sessionId: "1" });
    expect(JSON.parse(fourth)).toEqual({
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
    await hooks.event?.({ event: { type: "unknown.event", properties: {} } });
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

describe("parseGitWorktreeAdd (issue: sidebar worktree detection)", () => {
  it("extracts branch and worktree path from git worktree add -b", () => {
    expect(
      MullionHookEmitter.parseGitWorktreeAdd("git worktree add -b feat/x /path/wt main"),
    ).toEqual({ branch: "feat/x", worktree: "/path/wt" });
  });

  it("handles -B flag", () => {
    expect(
      MullionHookEmitter.parseGitWorktreeAdd("git worktree add -B feat/x /path/wt main"),
    ).toEqual({ branch: "feat/x", worktree: "/path/wt" });
  });

  it("infers branch from worktree basename when no -b/-B flag", () => {
    expect(MullionHookEmitter.parseGitWorktreeAdd("git worktree add /path/wt")).toEqual({
      branch: "wt",
      worktree: "/path/wt",
    });
  });

  it("infers branch from second positional when no -b/-B flag", () => {
    expect(MullionHookEmitter.parseGitWorktreeAdd("git worktree add /path/wt main")).toEqual({
      branch: "main",
      worktree: "/path/wt",
    });
  });

  it("returns null for non-worktree-add commands", () => {
    expect(MullionHookEmitter.parseGitWorktreeAdd("git status")).toBeNull();
    expect(MullionHookEmitter.parseGitWorktreeAdd("ls -la")).toBeNull();
    expect(MullionHookEmitter.parseGitWorktreeAdd("npm test")).toBeNull();
  });

  it("handles git -C prefix before worktree add", () => {
    expect(
      MullionHookEmitter.parseGitWorktreeAdd("git -C /repo worktree add -b feat/x .worktrees/feat"),
    ).toEqual({ branch: "feat/x", worktree: ".worktrees/feat" });
  });
});

describe("parseGitCheckout (issue: sidebar worktree detection)", () => {
  it("extracts branch from git checkout <name>", () => {
    expect(MullionHookEmitter.parseGitCheckout("git checkout feat/x")).toEqual({
      branch: "feat/x",
    });
  });

  it("extracts branch from git checkout -b <name>", () => {
    expect(MullionHookEmitter.parseGitCheckout("git checkout -b feat/x")).toEqual({
      branch: "feat/x",
    });
  });

  it("extracts branch from git switch <name>", () => {
    expect(MullionHookEmitter.parseGitCheckout("git switch feat/x")).toEqual({
      branch: "feat/x",
    });
  });

  it("extracts branch from git switch -c <name>", () => {
    expect(MullionHookEmitter.parseGitCheckout("git switch -c feat/x")).toEqual({
      branch: "feat/x",
    });
  });

  it("extracts branch from git checkout main", () => {
    expect(MullionHookEmitter.parseGitCheckout("git checkout main")).toEqual({
      branch: "main",
    });
  });

  it("returns null for git checkout . (file restore)", () => {
    expect(MullionHookEmitter.parseGitCheckout("git checkout .")).toBeNull();
  });

  it("returns null for git checkout - (previous branch)", () => {
    expect(MullionHookEmitter.parseGitCheckout("git checkout -")).toBeNull();
  });

  it("returns null for git switch - (previous branch)", () => {
    expect(MullionHookEmitter.parseGitCheckout("git switch -")).toBeNull();
  });

  it("returns null for non-git commands", () => {
    expect(MullionHookEmitter.parseGitCheckout("ls")).toBeNull();
  });
});

describe("splitShellSegments (issue: sidebar worktree detection)", () => {
  it("splits on &&", () => {
    expect(
      MullionHookEmitter.splitShellSegments("mkdir -p wt && git worktree add -b feat/x wt main"),
    ).toEqual(["mkdir -p wt", "git worktree add -b feat/x wt main"]);
  });

  it("splits on ;", () => {
    expect(
      MullionHookEmitter.splitShellSegments("git worktree add -b feat/x wt main; npm test"),
    ).toEqual(["git worktree add -b feat/x wt main", "npm test"]);
  });
});

describe("mapToolExecuteAfter (issue: sidebar worktree detection)", () => {
  it("returns cwd_changed + git_branch for git worktree add", () => {
    const result = MullionHookEmitter.mapToolExecuteAfter(
      { tool: "bash", args: { command: "git worktree add -b feat/x /path/wt main" } },
      "/home/user/project",
    );
    expect(result).toEqual([
      { kind: "cwd_changed", cwd: "/path/wt" },
      { kind: "git_branch", branch: "feat/x", worktree: "/path/wt" },
    ]);
  });

  it("resolves relative worktree path with cwd", () => {
    const result = MullionHookEmitter.mapToolExecuteAfter(
      { tool: "bash", args: { command: "git worktree add -b feat/x .worktrees/feat main" } },
      "/home/user/project",
    );
    expect(result).toEqual([
      { kind: "cwd_changed", cwd: "/home/user/project/.worktrees/feat" },
      { kind: "git_branch", branch: "feat/x", worktree: "/home/user/project/.worktrees/feat" },
    ]);
  });

  it("returns git_branch for git checkout", () => {
    const result = MullionHookEmitter.mapToolExecuteAfter(
      { tool: "bash", args: { command: "git checkout feat/x" } },
      "/home/user/project",
    );
    expect(result).toEqual([{ kind: "git_branch", branch: "feat/x" }]);
  });

  it("returns git_branch for git switch", () => {
    const result = MullionHookEmitter.mapToolExecuteAfter(
      { tool: "bash", args: { command: "git switch feat/x" } },
      "/home/user/project",
    );
    expect(result).toEqual([{ kind: "git_branch", branch: "feat/x" }]);
  });

  it("returns null for non-bash tools", () => {
    expect(
      MullionHookEmitter.mapToolExecuteAfter(
        { tool: "read", args: { filePath: "/repo/a.ts" } },
        "/home/user/project",
      ),
    ).toBeNull();
  });

  it("returns null for missing/null input", () => {
    expect(MullionHookEmitter.mapToolExecuteAfter(null)).toBeNull();
    expect(MullionHookEmitter.mapToolExecuteAfter(undefined)).toBeNull();
  });

  it("picks the last worktree add in a chained command", () => {
    const result = MullionHookEmitter.mapToolExecuteAfter(
      {
        tool: "bash",
        args: {
          command:
            "git worktree add -b old-feat /path/old-wt main && git worktree add -b feat/x /path/wt main",
        },
      },
      "/home/user/project",
    );
    expect(result).toEqual([
      { kind: "cwd_changed", cwd: "/path/wt" },
      { kind: "git_branch", branch: "feat/x", worktree: "/path/wt" },
    ]);
  });

  it("ignores -C flags from non-git segments in chained command", () => {
    const result = MullionHookEmitter.mapToolExecuteAfter(
      {
        tool: "bash",
        args: {
          command: "my-tool -C some_arg && git worktree add -b feat/x .worktrees/feat",
        },
      },
      "/home/user/project",
    );
    expect(result).toEqual([
      { kind: "cwd_changed", cwd: "/home/user/project/.worktrees/feat" },
      { kind: "git_branch", branch: "feat/x", worktree: "/home/user/project/.worktrees/feat" },
    ]);
  });

  it("uses git -C from matching worktree add segment even in chained command", () => {
    const result = MullionHookEmitter.mapToolExecuteAfter(
      {
        tool: "bash",
        args: {
          command: "echo hello && git -C /repo worktree add -b feat/x .worktrees/feat",
        },
      },
      "/home/user/project",
    );
    expect(result).toEqual([
      { kind: "cwd_changed", cwd: "/repo/.worktrees/feat" },
      { kind: "git_branch", branch: "feat/x", worktree: "/repo/.worktrees/feat" },
    ]);
  });
});

describe("MullionHookEmitter tool.execute.after hook (issue: sidebar worktree detection)", () => {
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

  it("forwards cwd_changed + git_branch for git worktree add", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-wt-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = net.createServer();
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok-wt";

    const linesPromise = collectLines(3);
    const hooks = await MullionHookEmitter();
    await hooks["tool.execute.after"]?.(
      {
        tool: "bash",
        args: { command: "git worktree add -b feat/x /path/wt main" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {},
    );

    const [handshake, cwdMsg, branchMsg] = await linesPromise;
    expect(JSON.parse(handshake)).toEqual({ token: "tok-wt" });
    expect(JSON.parse(cwdMsg)).toEqual({ kind: "cwd_changed", cwd: "/path/wt" });
    expect(JSON.parse(branchMsg)).toEqual({
      kind: "git_branch",
      branch: "feat/x",
      worktree: "/path/wt",
    });
  });
});

// Issue: extend surfaced session statuses — opencode's own capability-parity
// test, mirroring forwarder-core.test.ts's "hook adapter emits capability
// parity" block for the three shell-hook adapters. opencode has no
// equivalent registered-hooks list to enumerate (its adapter, opencode.ts,
// never touches hooks.json — see that adapter's own header comment): the
// event-bus type strings mapOpenCodeEvent itself switches on ARE the
// "registered events" here, so this drives every one of them through the
// mapper directly instead. `promote_request` (the plugin's own tool, not an
// `event` type) is asserted separately below — it has no mapper output to
// drive through this table at all.
describe("mapOpenCodeEvent emits capability parity (issue: extend surfaced session statuses)", () => {
  it("every handled event type's mapped kind(s) are declared in openCodeAdapter.emits", () => {
    const events = [
      { type: "session.idle", properties: { sessionID: "1" } },
      { type: "file.edited", properties: { file: "/repo/a.ts" } },
      { type: "permission.asked", properties: { permission: "bash" } },
      { type: "permission.replied", properties: {} },
      {
        type: "session.error",
        properties: { error: { name: "ProviderAuthError", data: { message: "bad key" } } },
      },
      { type: "tui.toast.show", properties: { variant: "error", title: "Oops", message: "boom" } },
      { type: "session.status", properties: { status: { type: "busy" } } },
      { type: "session.status", properties: { status: { type: "idle" } } },
      {
        type: "session.status",
        properties: { status: { type: "retry", attempt: 1, message: "rate limited" } },
      },
      { type: "vcs.branch.updated", properties: { branch: "feat/foo" } },
      { type: "worktree.ready", properties: { branch: "fix/bar" } },
      { type: "session.compacting", properties: { state: "started" } },
      { type: "session.compacting", properties: { state: "finished" } },
      { type: "session.subagent", properties: { state: "started" } },
      { type: "session.subagent", properties: { state: "stopped" } },
      {
        type: "question.asked",
        properties: { questions: [{ question: "Which mode?", header: "Mode" }] },
      },
      { type: "question.replied", properties: {} },
      { type: "question.rejected", properties: {} },
      { type: "todo.updated", properties: { content: "Fix bug", status: "pending" } },
      {
        type: "session.diff",
        properties: { diff: [{ file: "/repo/a.ts", additions: 1, deletions: 0 }] },
      },
      { type: "worktree.failed", properties: { error: "exists" } },
      { type: "mcp.browser.open.failed", properties: { mcpName: "mcp-github" } },
    ];

    for (const event of events) {
      const mapped = mapOpenCodeEvent(event);
      if (mapped === null) continue;
      for (const msg of mapped) {
        expect(openCodeAdapter.emits).toContain(msg.kind);
      }
    }
  });

  it("cwd_changed (emitted by vcs.branch.updated and worktree.ready when cwd is provided) is declared in emits", () => {
    expect(openCodeAdapter.emits).toContain("cwd_changed");
  });

  it("promote_request (the plugin's own tool, not an event type) is declared in emits", () => {
    expect(openCodeAdapter.emits).toContain("promote_request");
  });

  it("tool.execute.after's message kinds (git_branch, cwd_changed) are declared in emits", () => {
    const cases = [
      { tool: "bash", args: { command: "git worktree add -b feat/x /path/wt main" } },
      { tool: "bash", args: { command: "git checkout feat/x" } },
    ];
    for (const input of cases) {
      const messages = mapToolExecuteAfter(input, "/tmp");
      if (messages === null) continue;
      for (const msg of messages) {
        expect(openCodeAdapter.emits).toContain(msg.kind);
      }
    }
  });
});
