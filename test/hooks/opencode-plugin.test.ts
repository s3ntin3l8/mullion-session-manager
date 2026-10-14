import { describe, it, expect, afterEach, beforeEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import MullionHookEmitter from "../../src/hooks/opencode-plugin.js";
import { openCodeAdapter, OPENCODE_EMITS } from "../../src/services/hook-adapters/opencode.js";
import { createFakeCtx, flush } from "./helpers/opencode-ctx.js";

// opencode v2 plugin (minimum 2.0.29). Unlike forwarder.mjs (a subprocess
// entry point with a top-level `main()` that runs on load), this plugin file
// has no top-level side effects — only calling `setup(ctx)` does any I/O. That
// makes it safe to import and exercise directly in-process, with a fake
// plugin `Context` (see helpers/opencode-ctx.ts) standing in for opencode.
//
// mapOpenCodeEvent/promoteRequest/etc. are read off the default export as
// properties, not imported as their own named exports — the module must have
// exactly one top-level `export` (see opencode-plugin.js's own comment).
const {
  mapOpenCodeEvent,
  promoteRequest,
  mapToolExecuteAfter,
  createAssistantTextTracker,
  createMapState,
  readInstructionTexts,
} = MullionHookEmitter;

// v2 event envelope: the payload is under `data` (1.x: `properties`).
const ev = (type: string, data: Record<string, unknown>, directory?: string) => ({
  type,
  data,
  ...(directory ? { location: { directory } } : {}),
});

describe("opencode-plugin.js module shape (opencode v2 loader contract)", () => {
  it("has exactly one top-level export: `default` (a second export crashed the 1.x loader)", async () => {
    const mod = await import("../../src/hooks/opencode-plugin.js");
    expect(Object.keys(mod)).toEqual(["default"]);
  });

  it("is a { id, setup } definition — what v2's loader requires", () => {
    expect(MullionHookEmitter.id).toBe("mullion-hook-emitter");
    expect(typeof MullionHookEmitter.setup).toBe("function");
  });

  it("does not use the 1.x named factory shape", async () => {
    const mod = (await import("../../src/hooks/opencode-plugin.js")) as Record<string, unknown>;
    expect(mod.MullionHookEmitter).toBeUndefined();
  });
});

describe("mapOpenCodeEvent (opencode v2 events)", () => {
  describe("turn lifecycle", () => {
    // Issue #271 follow-up — the finished-turn event carries the session id
    // for free; it's reported as an "agent_session" alongside the progress
    // message so a later promote can transfer the real conversation history.
    it("maps session.execution.succeeded to a done progress message plus the live agent_session id", () => {
      expect(mapOpenCodeEvent(ev("session.execution.succeeded", { sessionID: "ses_1" }))).toEqual([
        { kind: "progress", phase: "done" },
        { kind: "agent_session", sessionId: "ses_1" },
      ]);
    });

    it("omits the agent_session message when no sessionID is present", () => {
      expect(mapOpenCodeEvent(ev("session.execution.succeeded", {}))).toEqual([
        { kind: "progress", phase: "done" },
      ]);
    });

    // Issue #1230 — opencode has no Stop-analogue field carrying this, so it's
    // passed in by the caller (createAssistantTextTracker, tested below).
    it("attaches a non-null lastAssistantMessage to the done message", () => {
      expect(
        mapOpenCodeEvent(ev("session.execution.succeeded", {}), undefined, "All done."),
      ).toEqual([{ kind: "progress", phase: "done", lastAssistantMessage: "All done." }]);
    });

    it("omits lastAssistantMessage when null (the default)", () => {
      const [progress] = mapOpenCodeEvent(ev("session.execution.succeeded", {}))!;
      expect(progress).not.toHaveProperty("lastAssistantMessage");
    });

    it("maps session.execution.started to turn_start + generating progress", () => {
      expect(mapOpenCodeEvent(ev("session.execution.started", { sessionID: "ses_1" }))).toEqual([
        { kind: "turn_start" },
        { kind: "progress", phase: "generating" },
      ]);
    });

    it("maps session.execution.failed to tool_failure with the structured error's type and message", () => {
      expect(
        mapOpenCodeEvent(
          ev("session.execution.failed", {
            sessionID: "ses_1",
            error: { type: "ProviderAuthError", message: "bad key" },
          }),
        ),
      ).toEqual([
        {
          kind: "tool_failure",
          tool: "opencode",
          error: "ProviderAuthError",
          summary: "bad key",
        },
      ]);
    });

    it("falls back to the error type as summary when the message is empty, and to 'error' without a type", () => {
      expect(
        mapOpenCodeEvent(ev("session.execution.failed", { error: { type: "Boom", message: "" } })),
      ).toEqual([{ kind: "tool_failure", tool: "opencode", error: "Boom", summary: "Boom" }]);
      expect(mapOpenCodeEvent(ev("session.execution.failed", { error: {} }))).toEqual([
        { kind: "tool_failure", tool: "opencode", error: "error", summary: "error" },
      ]);
    });

    it("returns null for session.execution.failed without an error object", () => {
      expect(mapOpenCodeEvent(ev("session.execution.failed", { sessionID: "s" }))).toBeNull();
    });

    it("clears a pending question when the turn fails or is interrupted (no form.replied will ever arrive)", () => {
      const form = { sessionID: "s", title: "Q", metadata: { kind: "question" }, fields: [] };
      for (const type of ["session.execution.failed", "session.execution.interrupted"]) {
        const state = createMapState();
        mapOpenCodeEvent(ev("form.created", { form }), undefined, null, state);
        const out = mapOpenCodeEvent(
          ev(type, { sessionID: "s", reason: "user", error: { type: "E", message: "m" } }),
          undefined,
          null,
          state,
        )!;
        expect(out).toContainEqual({ kind: "question", state: "finished" });
        // and only once
        expect(
          mapOpenCodeEvent(ev("form.replied", { sessionID: "s" }), undefined, null, state),
        ).toBeNull();
      }
    });

    // 1.x skipped MessageAbortedError; in v2 a user abort is its own event
    // and is deliberately not attention-worthy.
    it("does not map session.execution.interrupted (a user abort isn't attention-worthy)", () => {
      expect(
        mapOpenCodeEvent(ev("session.execution.interrupted", { sessionID: "s", reason: "user" })),
      ).toBeNull();
    });

    it("maps session.retry.scheduled to a generating progress message with the attempt and error", () => {
      expect(
        mapOpenCodeEvent(
          ev("session.retry.scheduled", {
            sessionID: "s",
            attempt: 2,
            error: { type: "RateLimit", message: "rate limited" },
          }),
        ),
      ).toEqual([
        { kind: "progress", phase: "generating", detail: "retry attempt 2: rate limited" },
      ]);
    });

    it("omits the error text from a retry detail when there is none", () => {
      expect(
        mapOpenCodeEvent(ev("session.retry.scheduled", { sessionID: "s", attempt: 1 })),
      ).toEqual([{ kind: "progress", phase: "generating", detail: "retry attempt 1" }]);
    });
  });

  describe("session.step.ended files (file_change)", () => {
    it("emits a file_change per changed file, absolutised against the event's own location", () => {
      expect(
        mapOpenCodeEvent(
          ev("session.step.ended", { sessionID: "s", files: ["src/a.ts", "/abs/b.ts"] }, "/repo"),
          "/fallback",
        ),
      ).toEqual([
        { kind: "file_change", path: "/repo/src/a.ts", action: "modify" },
        { kind: "file_change", path: "/abs/b.ts", action: "modify" },
      ]);
    });

    it("falls back to the plugin's directory when the event has no location", () => {
      expect(
        mapOpenCodeEvent(
          ev("session.step.ended", { sessionID: "s", files: ["a.ts"] }),
          "/fallback",
        ),
      ).toEqual([{ kind: "file_change", path: "/fallback/a.ts", action: "modify" }]);
    });

    it("returns null when there are no files", () => {
      expect(mapOpenCodeEvent(ev("session.step.ended", { sessionID: "s" }))).toBeNull();
      expect(mapOpenCodeEvent(ev("session.step.ended", { sessionID: "s", files: [] }))).toBeNull();
      expect(mapOpenCodeEvent(ev("session.step.ended", { files: ["", 3] }))).toBeNull();
    });
  });

  describe("permission.asked / permission.replied", () => {
    // v2's request carries `action` (e.g. "shell") and `resources`.
    it("maps permission.asked to permission_request with the action and first resource", () => {
      expect(
        mapOpenCodeEvent(
          ev("permission.asked", { sessionID: "s", action: "shell", resources: ["rm -rf /tmp/x"] }),
        ),
      ).toEqual([{ kind: "permission_request", tool: "opencode", summary: "shell rm -rf /tmp/x" }]);
    });

    it("tolerates a missing action or resources", () => {
      expect(mapOpenCodeEvent(ev("permission.asked", { action: "edit" }))).toEqual([
        { kind: "permission_request", tool: "opencode", summary: "edit" },
      ]);
      expect(mapOpenCodeEvent(ev("permission.asked", {}))).toEqual([
        { kind: "permission_request", tool: "opencode", summary: "" },
      ]);
    });

    it("maps permission.replied to permission_resolved (clears permissionRequest, not a generic notification)", () => {
      expect(mapOpenCodeEvent(ev("permission.replied", { reply: "once" }))).toEqual([
        { kind: "permission_resolved" },
      ]);
    });
  });

  // v2 has no dedicated subagent/compaction-state events beyond these: a
  // subagent is a CHILD SESSION, so its execution events must not be mistaken
  // for the main session's turn boundaries.
  describe("subagents (child sessions, issue #321)", () => {
    it("maps a session.created with a parentID to subagent started", () => {
      const state = createMapState();
      expect(
        mapOpenCodeEvent(
          ev("session.created", { sessionID: "child", parentID: "main" }),
          undefined,
          null,
          state,
        ),
      ).toEqual([{ kind: "subagent", state: "started" }]);
    });

    it("does not map a top-level session.created", () => {
      expect(mapOpenCodeEvent(ev("session.created", { sessionID: "main" }))).toBeNull();
    });

    it("maps the child's execution end to subagent finished — NOT a done progress for the main session", () => {
      const state = createMapState();
      mapOpenCodeEvent(
        ev("session.created", { sessionID: "child", parentID: "main" }),
        undefined,
        null,
        state,
      );
      expect(
        mapOpenCodeEvent(
          ev("session.execution.succeeded", { sessionID: "child" }),
          undefined,
          null,
          state,
        ),
      ).toEqual([{ kind: "subagent", state: "finished" }]);
    });

    it.each(["session.execution.failed", "session.execution.interrupted"])(
      "maps a child's %s to subagent finished too",
      (type) => {
        const state = createMapState();
        mapOpenCodeEvent(
          ev("session.created", { sessionID: "c", parentID: "m" }),
          undefined,
          null,
          state,
        );
        expect(
          mapOpenCodeEvent(
            ev(type, { sessionID: "c", error: { type: "x", message: "y" } }),
            undefined,
            null,
            state,
          ),
        ).toEqual([{ kind: "subagent", state: "finished" }]);
      },
    );

    it("ignores a child's turn start, retry and compaction (those belong to the main session only)", () => {
      const state = createMapState();
      mapOpenCodeEvent(
        ev("session.created", { sessionID: "c", parentID: "m" }),
        undefined,
        null,
        state,
      );
      for (const type of [
        "session.execution.started",
        "session.retry.scheduled",
        "session.compaction.started",
        "session.compaction.ended",
        "session.step.ended",
      ]) {
        expect(
          mapOpenCodeEvent(ev(type, { sessionID: "c", files: ["a.ts"] }), undefined, null, state),
        ).toBeNull();
      }
    });

    it("still maps the MAIN session's turn end while a child exists", () => {
      const state = createMapState();
      mapOpenCodeEvent(
        ev("session.created", { sessionID: "c", parentID: "m" }),
        undefined,
        null,
        state,
      );
      expect(
        mapOpenCodeEvent(
          ev("session.execution.succeeded", { sessionID: "m" }),
          undefined,
          null,
          state,
        ),
      ).toEqual([
        { kind: "progress", phase: "done" },
        { kind: "agent_session", sessionId: "m" },
      ]);
    });
  });

  describe("session.compaction.* (issue #321)", () => {
    it("maps started to compact started", () => {
      expect(mapOpenCodeEvent(ev("session.compaction.started", { sessionID: "s" }))).toEqual([
        { kind: "compact", state: "started" },
      ]);
    });

    it.each(["session.compaction.ended", "session.compaction.failed"])(
      "maps %s to compact finished",
      (type) => {
        expect(mapOpenCodeEvent(ev(type, { sessionID: "s" }))).toEqual([
          { kind: "compact", state: "finished" },
        ]);
      },
    );
  });

  // opencode's `question` tool is a v2 form whose metadata.kind is "question".
  describe("question forms", () => {
    const questionForm = {
      id: "form_1",
      sessionID: "s",
      title: "Which mode?",
      metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
      fields: [
        { title: "A very long header that exceeds thirty characters", description: "Pick one" },
      ],
    };

    it("maps a question form to question started, truncating the header to 30 chars", () => {
      expect(mapOpenCodeEvent(ev("form.created", { form: questionForm }))).toEqual([
        {
          kind: "question",
          state: "started",
          header: "A very long header that exceed",
          summary: "Pick one",
          tool: { messageID: "msg_1", callID: "call_1" },
        },
      ]);
    });

    it("falls back to the form title for the summary, and omits tool when absent", () => {
      const [msg] = mapOpenCodeEvent(
        ev("form.created", {
          form: { ...questionForm, metadata: { kind: "question" }, fields: [{ title: "Mode" }] },
        }),
      )!;
      expect(msg).toEqual({
        kind: "question",
        state: "started",
        header: "Mode",
        summary: "Which mode?",
      });
    });

    it("handles fields given as a record rather than an array", () => {
      const [msg] = mapOpenCodeEvent(
        ev("form.created", {
          form: { ...questionForm, fields: { mode: { title: "Mode", description: "d" } } },
        }),
      )!;
      expect(msg).toMatchObject({ header: "Mode", summary: "d" });
    });

    it("ignores forms that aren't questions", () => {
      expect(
        mapOpenCodeEvent(
          ev("form.created", { form: { ...questionForm, metadata: { kind: "login" } } }),
        ),
      ).toBeNull();
      expect(mapOpenCodeEvent(ev("form.created", {}))).toBeNull();
    });

    it.each(["form.replied", "form.cancelled"])(
      "maps %s to question finished, but only for a session with a pending question",
      (type) => {
        const state = createMapState();
        expect(mapOpenCodeEvent(ev(type, { sessionID: "s" }), undefined, null, state)).toBeNull();
        mapOpenCodeEvent(ev("form.created", { form: questionForm }), undefined, null, state);
        expect(mapOpenCodeEvent(ev(type, { sessionID: "s" }), undefined, null, state)).toEqual([
          { kind: "question", state: "finished" },
        ]);
        // resolved once — a second reply is no longer a pending question
        expect(mapOpenCodeEvent(ev(type, { sessionID: "s" }), undefined, null, state)).toBeNull();
      },
    );
  });

  describe("vcs.branch.updated", () => {
    it("maps to cwd_changed (from the event's location) + git_branch", () => {
      expect(
        mapOpenCodeEvent(ev("vcs.branch.updated", { branch: "feat/foo" }, "/repo/wt"), "/other"),
      ).toEqual([
        { kind: "cwd_changed", cwd: "/repo/wt" },
        { kind: "git_branch", branch: "feat/foo" },
      ]);
    });

    it("falls back to the plugin's own directory when the event has no location", () => {
      expect(mapOpenCodeEvent(ev("vcs.branch.updated", { branch: "main" }), "/fallback")).toEqual([
        { kind: "cwd_changed", cwd: "/fallback" },
        { kind: "git_branch", branch: "main" },
      ]);
    });

    it("emits only git_branch when no directory is known at all", () => {
      expect(mapOpenCodeEvent(ev("vcs.branch.updated", { branch: "main" }))).toEqual([
        { kind: "git_branch", branch: "main" },
      ]);
    });

    it("returns null for a missing or empty branch", () => {
      expect(mapOpenCodeEvent(ev("vcs.branch.updated", {}))).toBeNull();
      expect(mapOpenCodeEvent(ev("vcs.branch.updated", { branch: "" }))).toBeNull();
    });
  });

  describe("unhandled and 1.x-shaped events", () => {
    it("returns null for an unhandled event type", () => {
      expect(mapOpenCodeEvent(ev("model.updated", {}))).toBeNull();
    });

    it("returns null for malformed input", () => {
      expect(mapOpenCodeEvent(null)).toBeNull();
      expect(mapOpenCodeEvent(undefined)).toBeNull();
      expect(mapOpenCodeEvent({ type: 3, data: {} })).toBeNull();
      expect(mapOpenCodeEvent({ type: "session.execution.succeeded" })).toBeNull();
    });

    // The 1.x payload lived under `properties` — it must NOT be read any more.
    it("does not read 1.x `properties` payloads", () => {
      expect(mapOpenCodeEvent({ type: "session.idle", properties: { sessionID: "1" } })).toBeNull();
      expect(
        mapOpenCodeEvent({ type: "permission.asked", properties: { permission: "bash" } }),
      ).toBeNull();
    });

    // v2 has no server-side publisher for these 1.x events (see opencode.ts).
    it.each([
      "todo.updated",
      "session.diff",
      "tui.toast.show",
      "worktree.failed",
      "mcp.browser.open.failed",
    ])("does not map %s", (type) => {
      expect(
        mapOpenCodeEvent(
          ev(type, { content: "x", status: "pending", variant: "error", diff: [{ file: "a" }] }),
        ),
      ).toBeNull();
    });
  });
});

// Issue #1230 — createAssistantTextTracker in isolation, over v2's
// `session.text.ended` events (`data.text`, keyed by assistantMessageID + ordinal).
describe("createAssistantTextTracker (issue #1230)", () => {
  const text = (assistantMessageID: string, ordinal: number, body: string, sessionID = "s") =>
    ev("session.text.ended", { sessionID, assistantMessageID, ordinal, text: body });

  it("returns null before any text has been seen", () => {
    expect(createAssistantTextTracker().current()).toBeNull();
  });

  it("returns the text of the current assistant message", () => {
    const tracker = createAssistantTextTracker();
    tracker.observe(text("msg_1", 0, "Hello."));
    expect(tracker.current()).toBe("Hello.");
  });

  it("joins several text blocks of one message in ordinal order, however they arrive", () => {
    const tracker = createAssistantTextTracker();
    tracker.observe(text("msg_1", 1, "Second."));
    tracker.observe(text("msg_1", 0, "First."));
    expect(tracker.current()).toBe("First.\n\nSecond.");
  });

  it("replaces a block that is re-ended with the same ordinal", () => {
    const tracker = createAssistantTextTracker();
    tracker.observe(text("msg_1", 0, "draft"));
    tracker.observe(text("msg_1", 0, "final"));
    expect(tracker.current()).toBe("final");
  });

  it("resets when the assistant message id changes", () => {
    const tracker = createAssistantTextTracker();
    tracker.observe(text("msg_1", 0, "old turn"));
    tracker.observe(text("msg_2", 0, "new turn"));
    expect(tracker.current()).toBe("new turn");
  });

  it("resets when a new execution starts, so a tool-only turn never reports the previous turn's text", () => {
    const tracker = createAssistantTextTracker();
    tracker.observe(text("msg_1", 0, "previous turn"));
    tracker.observe(ev("session.execution.started", { sessionID: "s" }));
    expect(tracker.current()).toBeNull();
  });

  it("ignores a child (subagent) session's text so it never lands on the main session's done", () => {
    const state = createMapState();
    state.childSessions.add("child");
    const tracker = createAssistantTextTracker();
    tracker.observe(text("msg_1", 0, "main"), state);
    tracker.observe(text("msg_9", 0, "subagent chatter", "child"), state);
    expect(tracker.current()).toBe("main");
    // and a child's execution.started must not wipe the main turn's text
    tracker.observe(ev("session.execution.started", { sessionID: "child" }), state);
    expect(tracker.current()).toBe("main");
  });

  it("ignores malformed events", () => {
    const tracker = createAssistantTextTracker();
    tracker.observe(null);
    tracker.observe({ type: "session.text.ended" });
    tracker.observe(ev("session.text.ended", { text: 3, assistantMessageID: "m" }));
    tracker.observe(ev("session.text.ended", { text: "x" }));
    expect(tracker.current()).toBeNull();
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

describe("mapToolExecuteAfter (issue: sidebar worktree detection; v2 `shell` tool)", () => {
  const shell = (command: string, extra: Record<string, unknown> = {}) => ({
    tool: "shell",
    status: "completed",
    input: { command, ...extra },
  });

  it("returns cwd_changed + git_branch for git worktree add", () => {
    expect(
      mapToolExecuteAfter(shell("git worktree add -b feat/x /path/wt main"), "/home/user/project"),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/path/wt" },
      { kind: "git_branch", branch: "feat/x", worktree: "/path/wt" },
    ]);
  });

  it("resolves a relative worktree path against the fallback directory", () => {
    expect(
      mapToolExecuteAfter(
        shell("git worktree add -b feat/x .worktrees/feat main"),
        "/home/user/project",
      ),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/home/user/project/.worktrees/feat" },
      { kind: "git_branch", branch: "feat/x", worktree: "/home/user/project/.worktrees/feat" },
    ]);
  });

  // The tool call's own `workdir` outranks the plugin's directory: the agent
  // may run a command from a different directory than the session's.
  it("resolves a relative worktree path against the call's own workdir when given", () => {
    expect(
      mapToolExecuteAfter(
        shell("git worktree add -b feat/x wt main", { workdir: "/elsewhere" }),
        "/home/user/project",
      ),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/elsewhere/wt" },
      { kind: "git_branch", branch: "feat/x", worktree: "/elsewhere/wt" },
    ]);
  });

  it("returns git_branch for git checkout and git switch", () => {
    expect(mapToolExecuteAfter(shell("git checkout feat/x"), "/p")).toEqual([
      { kind: "git_branch", branch: "feat/x" },
    ]);
    expect(mapToolExecuteAfter(shell("git switch feat/x"), "/p")).toEqual([
      { kind: "git_branch", branch: "feat/x" },
    ]);
  });

  it("returns null for non-shell tools, including 1.x's `bash` name", () => {
    expect(
      mapToolExecuteAfter({ tool: "read", input: { filePath: "/repo/a.ts" } }, "/p"),
    ).toBeNull();
    expect(
      mapToolExecuteAfter({ tool: "bash", input: { command: "git checkout x" } }, "/p"),
    ).toBeNull();
  });

  it("returns null when the shell call itself errored (the branch didn't change)", () => {
    expect(
      mapToolExecuteAfter(
        { tool: "shell", status: "error", input: { command: "git checkout x" } },
        "/p",
      ),
    ).toBeNull();
  });

  it("resolves a RELATIVE workdir against the session directory, not the plugin process's cwd", () => {
    expect(
      mapToolExecuteAfter(
        shell("git worktree add -b feat/x wt main", { workdir: "sub" }),
        "/home/user/project",
      ),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/home/user/project/sub/wt" },
      { kind: "git_branch", branch: "feat/x", worktree: "/home/user/project/sub/wt" },
    ]);
  });

  it("returns null for a missing/malformed event or command", () => {
    expect(mapToolExecuteAfter(null, "/p")).toBeNull();
    expect(mapToolExecuteAfter(undefined, "/p")).toBeNull();
    expect(mapToolExecuteAfter({ tool: "shell", input: {} }, "/p")).toBeNull();
    expect(mapToolExecuteAfter({ tool: "shell", input: { command: "" } }, "/p")).toBeNull();
    expect(mapToolExecuteAfter(shell("echo hi"), "/p")).toBeNull();
  });

  it("picks the last worktree add in a chained command", () => {
    expect(
      mapToolExecuteAfter(
        shell(
          "git worktree add -b old-feat /path/old-wt main && git worktree add -b feat/x /path/wt main",
        ),
        "/home/user/project",
      ),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/path/wt" },
      { kind: "git_branch", branch: "feat/x", worktree: "/path/wt" },
    ]);
  });

  it("ignores -C flags from non-git segments in chained command", () => {
    expect(
      mapToolExecuteAfter(
        shell("my-tool -C some_arg && git worktree add -b feat/x .worktrees/feat"),
        "/home/user/project",
      ),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/home/user/project/.worktrees/feat" },
      { kind: "git_branch", branch: "feat/x", worktree: "/home/user/project/.worktrees/feat" },
    ]);
  });

  it("uses git -C from matching worktree add segment even in chained command", () => {
    expect(
      mapToolExecuteAfter(
        shell("echo hello && git -C /repo worktree add -b feat/x .worktrees/feat"),
        "/home/user/project",
      ),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/repo/.worktrees/feat" },
      { kind: "git_branch", branch: "feat/x", worktree: "/repo/.worktrees/feat" },
    ]);
  });
});

describe("readInstructionTexts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-instr-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MULLION_OPENCODE_INSTRUCTIONS;
  });

  it("reads the files listed in MULLION_OPENCODE_INSTRUCTIONS, in order, trimmed", () => {
    const a = path.join(dir, "a.md");
    const b = path.join(dir, "b.md");
    writeFileSync(a, "  first \n");
    writeFileSync(b, "second");
    process.env.MULLION_OPENCODE_INSTRUCTIONS = JSON.stringify([a, b]);
    expect(readInstructionTexts()).toEqual(["first", "second"]);
  });

  it("skips relative paths, unreadable files and empty files", () => {
    const empty = path.join(dir, "empty.md");
    const ok = path.join(dir, "ok.md");
    writeFileSync(empty, "   \n");
    writeFileSync(ok, "kept");
    process.env.MULLION_OPENCODE_INSTRUCTIONS = JSON.stringify([
      "relative/path.md",
      path.join(dir, "missing.md"),
      empty,
      42,
      ok,
    ]);
    expect(readInstructionTexts()).toEqual(["kept"]);
  });

  it("returns [] when the env var is unset, not JSON, or not an array", () => {
    expect(readInstructionTexts()).toEqual([]);
    process.env.MULLION_OPENCODE_INSTRUCTIONS = "not json";
    expect(readInstructionTexts()).toEqual([]);
    process.env.MULLION_OPENCODE_INSTRUCTIONS = JSON.stringify({ a: 1 });
    expect(readInstructionTexts()).toEqual([]);
  });
});

// `setup(ctx)` end to end: a fake opencode Context drives the plugin, and a
// real unix-socket server stands in for Mullion's hook socket.
describe("MullionHookEmitter.setup (opencode v2 plugin)", () => {
  let dir: string;
  let server: net.Server | null = null;
  // The plugin keeps its connection open for reuse — server.close() alone
  // waits forever for a connection nothing here ends, so every accepted
  // socket is tracked and force-destroyed in afterEach.
  let openSockets: net.Socket[] = [];
  let cleanup: (() => Promise<void> | void) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    for (const socket of openSockets) socket.destroy();
    openSockets = [];
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.MULLION_HOOK_SOCKET;
    delete process.env.MULLION_HOOK_TOKEN;
    delete process.env.MULLION_OPENCODE_INSTRUCTIONS;
  });

  async function listen(token = "tok-456"): Promise<void> {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = net.createServer();
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = token;
  }

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

  const start = async (fake: ReturnType<typeof createFakeCtx>) => {
    cleanup = (await MullionHookEmitter.setup(fake.ctx)) as typeof cleanup;
    return cleanup;
  };

  it("does nothing — and never throws — outside a Mullion session (no hook socket/token env)", async () => {
    const fake = createFakeCtx();
    await expect(MullionHookEmitter.setup(fake.ctx)).resolves.toBeUndefined();
    expect(fake.subscribed).toBe(false);
    expect(fake.tools).toHaveLength(0);
    expect(fake.toolHooks.size).toBe(0);
    expect(fake.sessionHooks.size).toBe(0);
  });

  it("handshakes and forwards a mapped turn end read from ctx.event.subscribe", async () => {
    await listen();
    const linesPromise = collectLines(3);
    const fake = createFakeCtx();
    await start(fake);

    fake.push(ev("session.execution.succeeded", { sessionID: "ses_1" }));

    const [handshake, progress, agentSession] = await linesPromise;
    expect(JSON.parse(handshake)).toEqual({ token: "tok-456" });
    expect(JSON.parse(progress)).toEqual({ kind: "progress", phase: "done" });
    expect(JSON.parse(agentSession)).toEqual({ kind: "agent_session", sessionId: "ses_1" });
  });

  it("sends multiple events over the same reused connection", async () => {
    await listen();
    const linesPromise = collectLines(4);
    const fake = createFakeCtx();
    await start(fake);

    fake.push(ev("session.execution.started", { sessionID: "s" }));
    fake.push(ev("session.step.ended", { sessionID: "s", files: ["a.ts"] }, "/repo"));

    const [, a, b, c] = await linesPromise;
    expect(JSON.parse(a)).toEqual({ kind: "turn_start" });
    expect(JSON.parse(b)).toEqual({ kind: "progress", phase: "generating" });
    expect(JSON.parse(c)).toEqual({ kind: "file_change", path: "/repo/a.ts", action: "modify" });
  });

  // Issue #1230 — end to end through the real subscription loop: the turn's
  // text is reconstructed from session.text.ended and attached to "done".
  it("attaches the reconstructed assistant text to the turn's done message", async () => {
    await listen();
    const linesPromise = collectLines(3);
    const fake = createFakeCtx();
    await start(fake);

    fake.push(
      ev("session.text.ended", {
        sessionID: "s1",
        assistantMessageID: "msg_a",
        ordinal: 0,
        text: "All done.",
      }),
    );
    fake.push(ev("session.execution.succeeded", { sessionID: "s1" }));

    const [, progress, agentSession] = await linesPromise;
    expect(JSON.parse(progress)).toEqual({
      kind: "progress",
      phase: "done",
      lastAssistantMessage: "All done.",
    });
    expect(JSON.parse(agentSession)).toEqual({ kind: "agent_session", sessionId: "s1" });
  });

  it("uses ctx.location.directory (not process.cwd()) as the cwd fallback", async () => {
    await listen();
    const linesPromise = collectLines(3);
    const fake = createFakeCtx("/session/dir");
    await start(fake);

    fake.push(ev("vcs.branch.updated", { branch: "feat/x" }));

    const [, cwdMsg, branchMsg] = await linesPromise;
    expect(JSON.parse(cwdMsg)).toEqual({ kind: "cwd_changed", cwd: "/session/dir" });
    expect(JSON.parse(branchMsg)).toEqual({ kind: "git_branch", branch: "feat/x" });
  });

  it("keeps consuming events after a malformed one", async () => {
    await listen();
    const linesPromise = collectLines(2);
    const fake = createFakeCtx();
    await start(fake);

    fake.push(null);
    fake.push({ type: "session.execution.started" });
    fake.push(ev("session.execution.started", { sessionID: "s" }));

    const [, first] = await linesPromise;
    expect(JSON.parse(first)).toEqual({ kind: "turn_start" });
  });

  it("registers promote_to_worktree with a plain JSON Schema input (v2 provides no zod)", async () => {
    await listen();
    const fake = createFakeCtx();
    await start(fake);

    expect(fake.tools).toHaveLength(1);
    const [tool] = fake.tools;
    expect(tool.name).toBe("promote_to_worktree");
    expect(tool.description).toMatch(/isolated git worktree/);
    expect(tool.input).toMatchObject({
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" }, suggestedBaseRef: { type: "string" } },
    });
  });

  it("promote_to_worktree returns { content } and declines when the call's signal is already aborted", async () => {
    await listen();
    const fake = createFakeCtx();
    await start(fake);

    const result = await fake.tools[0].execute({ summary: "s" }, { signal: AbortSignal.abort() });
    expect(result).toEqual({ content: "Declined: aborted" });
  });

  it("forwards git branch changes from the shell tool's execute.after hook", async () => {
    await listen("tok-wt");
    const linesPromise = collectLines(3);
    const fake = createFakeCtx("/home/user/project");
    await start(fake);

    fake.toolHooks.get("execute.after")!({
      tool: "shell",
      status: "completed",
      input: { command: "git worktree add -b feat/x /path/wt main" },
    });

    const [handshake, cwdMsg, branchMsg] = await linesPromise;
    expect(JSON.parse(handshake)).toEqual({ token: "tok-wt" });
    expect(JSON.parse(cwdMsg)).toEqual({ kind: "cwd_changed", cwd: "/path/wt" });
    expect(JSON.parse(branchMsg)).toEqual({
      kind: "git_branch",
      branch: "feat/x",
      worktree: "/path/wt",
    });
  });

  describe("instruction files via the session `context` hook", () => {
    it("does not register a context hook when MULLION_OPENCODE_INSTRUCTIONS is unset", async () => {
      await listen();
      const fake = createFakeCtx();
      await start(fake);
      expect(fake.sessionHooks.has("context")).toBe(false);
    });

    it("appends each instruction file as a text system part, once", async () => {
      await listen();
      const a = path.join(dir, "tier0.md");
      const b = path.join(dir, "briefing.md");
      writeFileSync(a, "tier zero");
      writeFileSync(b, "the briefing");
      process.env.MULLION_OPENCODE_INSTRUCTIONS = JSON.stringify([a, b]);
      const fake = createFakeCtx();
      await start(fake);

      const context = { system: [{ type: "text", text: "existing" }] };
      fake.sessionHooks.get("context")!(context);
      expect(context.system).toEqual([
        { type: "text", text: "existing" },
        { type: "text", text: "tier zero" },
        { type: "text", text: "the briefing" },
      ]);
      // idempotent — setup may run per Location, and a request may re-run the hook
      fake.sessionHooks.get("context")!(context);
      expect(context.system).toHaveLength(3);
    });

    it("reads the instruction files once, not on every model request", async () => {
      await listen();
      const a = path.join(dir, "once.md");
      writeFileSync(a, "first read");
      process.env.MULLION_OPENCODE_INSTRUCTIONS = JSON.stringify([a]);
      const fake = createFakeCtx();
      await start(fake);

      fake.sessionHooks.get("context")!({ system: [] });
      writeFileSync(a, "changed on disk");
      const second = { system: [] as Array<{ type: string; text: string }> };
      fake.sessionHooks.get("context")!(second);
      expect(second.system).toEqual([{ type: "text", text: "first read" }]);
    });
  });

  it("returns a cleanup that aborts the subscription and disposes every registration", async () => {
    await listen();
    process.env.MULLION_OPENCODE_INSTRUCTIONS = JSON.stringify([]);
    const fake = createFakeCtx();
    const stop = await start(fake);
    expect(fake.aborted).toBe(false);
    expect(fake.registrations.length).toBeGreaterThanOrEqual(3);

    await stop!();
    expect(fake.aborted).toBe(true);
    expect(fake.registrations.every((r) => r.disposed)).toBe(true);

    // events after cleanup are no longer consumed
    await flush();
  });

  it("still finishes cleanup when a registration's dispose throws", async () => {
    await listen();
    const fake = createFakeCtx();
    const stop = await start(fake);
    fake.registrations[0].dispose = async () => {
      throw new Error("boom");
    };
    await expect(stop!()).resolves.toBeUndefined();
    expect(fake.aborted).toBe(true);
  });
});

describe("promoteRequest abort signal", () => {
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

  it("resolves as declined when the signal aborts while waiting for a decision", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-"));
    const socketPath = path.join(dir, "hooks.sock");
    server = net.createServer((socket) => openSockets.push(socket));
    await new Promise<void>((resolve) => server?.listen(socketPath, () => resolve()));
    process.env.MULLION_HOOK_SOCKET = socketPath;
    process.env.MULLION_HOOK_TOKEN = "tok";

    const abort = new AbortController();
    const resultPromise = promoteRequest("summary", undefined, abort.signal);
    await new Promise<void>((resolve) => server?.once("connection", () => resolve()));
    abort.abort();
    await expect(resultPromise).resolves.toBe("Declined: aborted");
  });
});

// Issue: extend surfaced session statuses — opencode's own capability-parity
// test, mirroring forwarder-core.test.ts's "hook adapter emits capability
// parity" block for the three shell-hook adapters. opencode has no
// registered-hooks list to enumerate: the v2 event types mapOpenCodeEvent
// itself switches on ARE the "registered events", so this drives every one of
// them through the mapper directly. `promote_request` (the plugin's own tool,
// not an event type) is asserted separately below.
describe("mapOpenCodeEvent emits capability parity (issue: extend surfaced session statuses)", () => {
  function driveAll(): Set<string> {
    const state = createMapState();
    const kinds = new Set<string>();
    const events = [
      ev("session.execution.started", { sessionID: "m" }),
      ev("session.execution.succeeded", { sessionID: "m" }),
      ev("session.execution.failed", { sessionID: "m", error: { type: "E", message: "m" } }),
      ev("session.retry.scheduled", { sessionID: "m", attempt: 1, error: { message: "x" } }),
      ev("session.step.ended", { sessionID: "m", files: ["a.ts"] }, "/repo"),
      ev("permission.asked", { action: "shell", resources: ["ls"] }),
      ev("permission.replied", {}),
      ev("vcs.branch.updated", { branch: "feat/foo" }, "/repo"),
      ev("session.compaction.started", { sessionID: "m" }),
      ev("session.compaction.ended", { sessionID: "m" }),
      ev("session.compaction.failed", { sessionID: "m" }),
      ev("session.created", { sessionID: "c", parentID: "m" }),
      ev("session.execution.succeeded", { sessionID: "c" }),
      ev("form.created", {
        form: { sessionID: "m", title: "Q", metadata: { kind: "question" }, fields: [] },
      }),
      ev("form.replied", { sessionID: "m" }),
    ];
    for (const event of events) {
      for (const msg of mapOpenCodeEvent(event, undefined, null, state) ?? []) {
        kinds.add(msg.kind as string);
      }
    }
    return kinds;
  }

  it("every handled event type's mapped kind(s) are declared in openCodeAdapter.emits", () => {
    for (const kind of driveAll()) {
      expect(openCodeAdapter.emits).toContain(kind);
    }
  });

  // Guards the other direction: nothing is advertised that the plugin can no
  // longer produce (1.x's notification/todo/session_diff, for instance).
  it("every kind in OPENCODE_EMITS (except the tool-sourced promote_request) is actually producible", () => {
    const producible = driveAll();
    // cwd_changed/git_branch also come from the tool hook, agent_session etc. from events above
    for (const kind of OPENCODE_EMITS) {
      if (kind === "promote_request") continue;
      expect(producible).toContain(kind);
    }
  });

  it("promote_request (the plugin's own tool, not an event type) is declared in emits", () => {
    expect(openCodeAdapter.emits).toContain("promote_request");
  });

  it("tool.execute.after's message kinds (git_branch, cwd_changed) are declared in emits", () => {
    const cases = [
      { tool: "shell", input: { command: "git worktree add -b feat/x /path/wt main" } },
      { tool: "shell", input: { command: "git checkout feat/x" } },
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
