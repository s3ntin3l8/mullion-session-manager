import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { vi } from "vitest";

// Real integration test against the actual listening Unix socket — same
// "app.inject() can't drive this, so build a real app and connect a real
// client" reasoning as test/routes/terminal.test.ts / test/routes/events.test.ts,
// just over net.createConnection() instead of a WebSocket. node-pty and the
// systemd-run/dtach bootstrap child_process are faked the same way
// test/services/pty-manager.test.ts fakes them, so this exercises the real
// hooksPlugin listener (handshake, token validation, line framing) without
// depending on a real systemd --user session.
class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  exitListeners: Array<() => void> = [];
  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }
  onExit(cb: () => void) {
    this.exitListeners.push(cb);
    return { dispose: () => {} };
  }
  write() {}
  resize() {}
  kill() {}
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => new FakePty()),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { GATE_TIMEOUT_MS, PROMOTE_TIMEOUT_MS } = await import("../../src/plugins/hooks.js");

/** Connects a raw net socket to `path`, resolving once actually connected. */
function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Resolves once `socket` closes (server-initiated destroy, in every test
 * below) — the thing every "was this connection rejected" assertion here
 * actually waits on. */
function waitForClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });
}

/** Resolves with the first complete newline-terminated line the server
 * writes back (issue #173's error-reply path) — used by the "malformed
 * message gets an error reply but stays open" tests below. */
function waitForLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) resolve(buffer.slice(0, newlineIndex));
    });
  });
}

describe("hooksPlugin (issue #172)", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it("listens on app.pty.hookSocketPath once ready", async () => {
    app = await buildApp();
    await app.ready();

    const socket = await connect(app.pty.hookSocketPath);
    socket.destroy();
  });

  it("keeps a connection open once a valid session token handshakes", async () => {
    app = await buildApp();
    await app.ready();
    const session = app.pty.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);

    // No close event fires for a valid handshake — assert the connection is
    // still alive after giving the (mocked, synchronous-ish) server loop a
    // moment to have destroyed it if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });

  it("closes the connection on an unknown/forged token", async () => {
    app = await buildApp();
    await app.ready();

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: "forged-token" })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("closes the connection on a malformed (non-JSON) handshake line", async () => {
    app = await buildApp();
    await app.ready();

    const socket = await connect(app.pty.hookSocketPath);
    socket.write("not json at all\n");

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("closes the connection on a handshake object with no string token field", async () => {
    app = await buildApp();
    await app.ready();

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ notToken: 123 })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("closes the connection on an oversized line with no terminator", async () => {
    app = await buildApp();
    await app.ready();

    const socket = await connect(app.pty.hookSocketPath);
    // No trailing newline — deliberately never completes a line, so this
    // only ever hits the byte-cap guard, not JSON parsing.
    socket.write("a".repeat(70_000));

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("a token stops resolving (and a fresh connection using it is closed) once its session is killed", async () => {
    app = await buildApp();
    await app.ready();
    const session = app.pty.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    const token = session.hookToken;
    app.pty.kill("1");

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("unlinks the socket file on close (onClose cleanup)", async () => {
    app = await buildApp();
    await app.ready();
    const socketPath = app.pty.hookSocketPath;

    await app.close();
    app = null;

    // A fresh app can bind the same path again — proof the file was
    // actually removed, not just that the server stopped accepting.
    const second = await buildApp();
    try {
      await second.ready();
      expect(second.pty.hookSocketPath).toBe(socketPath);
      const socket = await connect(socketPath);
      socket.destroy();
    } finally {
      await second.close();
    }
  });

  describe("hook message protocol (issue #173)", () => {
    async function handshakedSocket(app_: Awaited<ReturnType<typeof buildApp>>) {
      const session = app_.pty.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      const socket = await connect(app_.pty.hookSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      return socket;
    }

    it("accepts a well-formed message with no error reply and keeps the connection open", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await handshakedSocket(app);

      const replies: string[] = [];
      socket.on("data", (chunk: Buffer) => replies.push(chunk.toString("utf8")));
      socket.write(`${JSON.stringify({ kind: "notification", title: "hi", body: "there" })}\n`);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(replies).toEqual([]);
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    });

    it("replies with a JSON error for a malformed message but keeps the connection open", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await handshakedSocket(app);

      socket.write(`${JSON.stringify({ kind: "notification", title: "missing body" })}\n`);
      const replyLine = await waitForLine(socket);

      const reply = JSON.parse(replyLine);
      expect(reply).toHaveProperty("error");
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    });

    it("survives a malformed message and still accepts a well-formed one afterward", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await handshakedSocket(app);

      socket.write("not json\n");
      await waitForLine(socket);

      // The connection is still alive — a second, well-formed message after
      // the error reply produces no further error line.
      const repliesAfter: string[] = [];
      socket.on("data", (chunk: Buffer) => repliesAfter.push(chunk.toString("utf8")));
      socket.write(`${JSON.stringify({ kind: "progress", phase: "thinking" })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(repliesAfter).toEqual([]);
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    });

    it("accepts an unrecognized kind (extensibility) with no error reply", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await handshakedSocket(app);

      const replies: string[] = [];
      socket.on("data", (chunk: Buffer) => replies.push(chunk.toString("utf8")));
      socket.write(`${JSON.stringify({ kind: "some_future_kind", extra: "field" })}\n`);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(replies).toEqual([]);
      socket.destroy();
    });
  });

  describe("routing into the notification event model (issue #176)", () => {
    it("a real notification message flips SessionInfo.attention and appears in app.pty.listEvents()", async () => {
      app = await buildApp();
      await app.ready();
      const session = app.pty.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      expect(session.toInfo().attention).toBe(false);

      const socket = await connect(app.pty.hookSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(
        `${JSON.stringify({ kind: "notification", title: "Build done", body: "0 errors" })}\n`,
      );

      // Poll rather than a fixed sleep: the socket data event and this
      // process's own event emission are both async relative to write().
      for (let i = 0; i < 50 && !session.toInfo().attention; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(session.toInfo().attention).toBe(true);
      const events = app.pty.listEvents();
      expect(
        events.some((e) => e.kind === "attention" && e.payload.signal === "hookNotification"),
      ).toBe(true);
      socket.destroy();
    });

    it("a real review_gate waiting message appears as its own event kind", async () => {
      app = await buildApp();
      await app.ready();
      const session = app.pty.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });

      const socket = await connect(app.pty.hookSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(
        `${JSON.stringify({ kind: "review_gate", state: "waiting", prompt: "Deploy?" })}\n`,
      );

      for (let i = 0; i < 50 && session.getEvents().length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const events = session.getEvents();
      expect(events.some((e) => e.kind === "review_gate" && e.payload.state === "waiting")).toBe(
        true,
      );
      socket.destroy();
    });
  });

  describe("review gate (issue #178)", () => {
    async function openPendingGate(
      app_: Awaited<ReturnType<typeof buildApp>>,
      id: string,
      prompt: string,
    ) {
      const session = app_.pty.getOrCreate({
        id,
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      const socket = await connect(app_.pty.hookSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(`${JSON.stringify({ kind: "review_gate", state: "waiting", prompt })}\n`);
      for (let i = 0; i < 50 && session.toInfo().gateState !== "waiting"; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(session.toInfo().gateState).toBe("waiting");
      expect(session.toInfo().gatePrompt).toBe(prompt);
      return { session, socket };
    }

    it("app.resolveHookGate writes an approve decision back to the pending connection and flips gateState", async () => {
      app = await buildApp();
      await app.ready();
      const { session, socket } = await openPendingGate(app, "1", "rm -rf /tmp/scratch");

      const replyPromise = waitForLine(socket);
      expect(app.resolveHookGate("1", "approved")).toBe(true);

      expect(JSON.parse(await replyPromise)).toEqual({ decision: "approved" });
      expect(session.toInfo().gateState).toBe("approved");
      expect(session.toInfo().gatePrompt).toBe(null);
      const events = session.getEvents();
      expect(events.some((e) => e.kind === "review_gate" && e.payload.state === "approved")).toBe(
        true,
      );
      socket.destroy();
    });

    it("app.resolveHookGate writes a deny decision with a reason", async () => {
      app = await buildApp();
      await app.ready();
      const { socket } = await openPendingGate(app, "1", "curl http://evil.example");

      const replyPromise = waitForLine(socket);
      expect(app.resolveHookGate("1", "denied", "looks unsafe")).toBe(true);

      expect(JSON.parse(await replyPromise)).toEqual({
        decision: "denied",
        reason: "looks unsafe",
      });
      socket.destroy();
    });

    it("app.resolveHookGate returns false when nothing is pending for this session", async () => {
      app = await buildApp();
      await app.ready();
      app.pty.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });

      expect(app.resolveHookGate("1", "approved")).toBe(false);
    });

    it("denies a second concurrent waiting gate for the same session immediately, without disturbing the first", async () => {
      app = await buildApp();
      await app.ready();
      const { session, socket: first } = await openPendingGate(app, "1", "first command");

      const second = await connect(app.pty.hookSocketPath);
      second.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      const secondReplyPromise = waitForLine(second);
      second.write(
        `${JSON.stringify({ kind: "review_gate", state: "waiting", prompt: "second command" })}\n`,
      );

      expect(JSON.parse(await secondReplyPromise)).toEqual({
        decision: "denied",
        reason: "another review is already pending for this session",
      });
      // The first gate is completely undisturbed.
      expect(session.toInfo().gateState).toBe("waiting");
      expect(session.toInfo().gatePrompt).toBe("first command");

      expect(app.resolveHookGate("1", "approved")).toBe(true);
      expect(session.toInfo().gateState).toBe("approved");

      first.destroy();
      second.destroy();
    });

    it("resolves to denied when the gate connection closes before a decision arrives (fail closed)", async () => {
      app = await buildApp();
      await app.ready();
      const { session, socket } = await openPendingGate(app, "1", "some command");

      socket.destroy();

      for (let i = 0; i < 50 && session.toInfo().gateState === "waiting"; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(session.toInfo().gateState).toBe("denied");
    });

    it("resolves to denied on the server-side gate timeout (fail closed)", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        app = await buildApp();
        await app.ready();
        const session = app.pty.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
        const replyPromise = waitForLine(socket);
        socket.write(`${JSON.stringify({ kind: "review_gate", state: "waiting", prompt: "x" })}\n`);
        for (let i = 0; i < 50 && session.toInfo().gateState !== "waiting"; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(session.toInfo().gateState).toBe("waiting");

        await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS);

        expect(JSON.parse(await replyPromise)).toEqual({
          decision: "denied",
          reason: "timed out waiting for a decision",
        });
        expect(session.toInfo().gateState).toBe("denied");
        socket.destroy();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("promote request (issue #271)", () => {
    async function openPendingPromote(
      app_: Awaited<ReturnType<typeof buildApp>>,
      id: string,
      summary: string,
      suggestedBaseRef?: string,
    ) {
      const session = app_.pty.getOrCreate({
        id,
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      const socket = await connect(app_.pty.hookSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(`${JSON.stringify({ kind: "promote_request", summary, suggestedBaseRef })}\n`);
      for (let i = 0; i < 50 && session.toInfo().promoteState !== "pending"; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(session.toInfo().promoteState).toBe("pending");
      expect(session.toInfo().promoteSummary).toBe(summary);
      return { session, socket };
    }

    it("sets promoteState to pending and emits a promote_request event", async () => {
      app = await buildApp();
      await app.ready();
      const { session } = await openPendingPromote(app, "1", "start work on the bug fix", "main");

      expect(session.toInfo().promoteSuggestedBaseRef).toBe("main");
      const events = session.getEvents();
      expect(
        events.some(
          (e) => e.kind === "promote_request" && e.payload.summary === "start work on the bug fix",
        ),
      ).toBe(true);
    });

    it("app.resolvePendingPromote writes an accepted decision back with worktree info and flips promoteState", async () => {
      app = await buildApp();
      await app.ready();
      const { session, socket } = await openPendingPromote(app, "1", "seed");

      const replyPromise = waitForLine(socket);
      expect(
        app.resolvePendingPromote("1", {
          decision: "accepted",
          worktreePath: "/tmp/.mullion-worktrees/foo",
          newSessionId: 42,
        }),
      ).toBe(true);

      expect(JSON.parse(await replyPromise)).toEqual({
        decision: "accepted",
        worktreePath: "/tmp/.mullion-worktrees/foo",
        newSessionId: 42,
      });
      expect(session.toInfo().promoteState).toBe("accepted");
      expect(session.toInfo().promoteSummary).toBe(null);
      socket.destroy();
    });

    it("app.resolvePendingPromote writes a declined decision with a reason", async () => {
      app = await buildApp();
      await app.ready();
      const { socket } = await openPendingPromote(app, "1", "seed");

      const replyPromise = waitForLine(socket);
      expect(app.resolvePendingPromote("1", { decision: "declined", reason: "not now" })).toBe(
        true,
      );

      expect(JSON.parse(await replyPromise)).toEqual({ decision: "declined", reason: "not now" });
      socket.destroy();
    });

    it("app.resolvePendingPromote returns false when nothing is pending for this session", async () => {
      app = await buildApp();
      await app.ready();
      app.pty.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });

      expect(app.resolvePendingPromote("1", { decision: "declined" })).toBe(false);
    });

    it("denies a second concurrent promote request for the same session immediately, without disturbing the first", async () => {
      app = await buildApp();
      await app.ready();
      const { session, socket: first } = await openPendingPromote(app, "1", "first summary");

      const second = await connect(app.pty.hookSocketPath);
      second.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      const secondReplyPromise = waitForLine(second);
      second.write(`${JSON.stringify({ kind: "promote_request", summary: "second summary" })}\n`);

      expect(JSON.parse(await secondReplyPromise)).toEqual({
        decision: "declined",
        reason: "another promote request is already pending for this session",
      });
      expect(session.toInfo().promoteState).toBe("pending");
      expect(session.toInfo().promoteSummary).toBe("first summary");

      expect(app.resolvePendingPromote("1", { decision: "declined" })).toBe(true);
      first.destroy();
      second.destroy();
    });

    it("resolves to declined when the promote connection closes before a decision arrives (fail closed)", async () => {
      app = await buildApp();
      await app.ready();
      const { session, socket } = await openPendingPromote(app, "1", "seed");

      socket.destroy();

      for (let i = 0; i < 50 && session.toInfo().promoteState === "pending"; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(session.toInfo().promoteState).toBe("declined");
    });

    it("resolves to declined on the server-side promote timeout (fail closed)", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        app = await buildApp();
        await app.ready();
        const session = app.pty.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
        const replyPromise = waitForLine(socket);
        socket.write(`${JSON.stringify({ kind: "promote_request", summary: "x" })}\n`);
        for (let i = 0; i < 50 && session.toInfo().promoteState !== "pending"; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(session.toInfo().promoteState).toBe("pending");

        await vi.advanceTimersByTimeAsync(PROMOTE_TIMEOUT_MS);

        expect(JSON.parse(await replyPromise)).toEqual({
          decision: "declined",
          reason: "timed out waiting for a decision",
        });
        expect(session.toInfo().promoteState).toBe("declined");
        socket.destroy();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("session_start (issue #271)", () => {
    it("replies immediately with an empty additionalContext when nothing was stashed", async () => {
      app = await buildApp();
      await app.ready();
      const session = app.pty.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });

      const socket = await connect(app.pty.hookSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      const replyPromise = waitForLine(socket);
      socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

      expect(JSON.parse(await replyPromise)).toEqual({ additionalContext: "" });
      socket.destroy();
    });

    it("replies with the stashed seed and clears it (single-use)", async () => {
      app = await buildApp();
      await app.ready();
      const session = app.pty.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      app.pty.stashSeed("1", "picks up where the last session left off");

      const socket = await connect(app.pty.hookSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      const replyPromise = waitForLine(socket);
      socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

      expect(JSON.parse(await replyPromise)).toEqual({
        additionalContext: "picks up where the last session left off",
      });

      // Single-use: a second session_start for the same id gets nothing.
      const secondReplyPromise = waitForLine(socket);
      socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);
      expect(JSON.parse(await secondReplyPromise)).toEqual({ additionalContext: "" });
      socket.destroy();
    });

    it("latches hooksProven via markHooksProven — follow-up to #275 (gap #1) — since session_start bypasses emitHookEvent entirely", async () => {
      app = await buildApp();
      await app.ready();
      const session = app.pty.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      const markHooksProvenSpy = vi.spyOn(app.pty, "markHooksProven");

      const socket = await connect(app.pty.hookSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      const replyPromise = waitForLine(socket);
      socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);
      await replyPromise;

      // Confirms hooks.ts's session_start branch itself calls this — see
      // Session.markHooksProven's doc comment for why session_start can't
      // latch through emitHookEvent (this method's normal caller, per the
      // "PtyManager.emitHookEvent() routes to the right session by id" test
      // in pty-manager.test.ts) the way every other hook kind does.
      expect(markHooksProvenSpy).toHaveBeenCalledWith("1");
      socket.destroy();
    });
  });
});
