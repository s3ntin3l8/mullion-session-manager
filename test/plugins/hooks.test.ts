import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { vi } from "vitest";
import { projects, sessions } from "../../src/db/schema.js";
import type { ManagedBrowser } from "../../src/services/browser-manager.js";
import { readAgentGuideExcerpt, sessionAgentGuidePath } from "../../src/services/agent-guide.js";
import { sessionBriefingPath } from "../../src/services/project-briefing.js";

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
const { GATE_TIMEOUT_MS, PROMOTE_TIMEOUT_MS, buildAgentGuideBlock } =
  await import("../../src/plugins/hooks.js");

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
    // A8 fix (pty-manager.ts) — Session.kill() now flushes its state file
    // synchronously (instead of relying on a 5s debounce timer that a fast
    // test never gave time to fire), so app.close() -> killAll() -> kill()
    // above now genuinely writes `<id>.state.json` to disk for every
    // tracked session, every time. This file's tests all reuse session id
    // "1" (see openPendingPromote and friends) against the ONE SESSIONS_DIR
    // shared by the whole file (test/setup.ts sets it once per file, not
    // per test) — before the A8 fix, that state file was never actually
    // written within a fast test's lifetime, so each fresh buildApp()'s
    // brand-new Session("1") constructor found nothing to restore. Now that
    // writes genuinely land on disk, a later test's "fresh" session 1
    // restores the PREVIOUS test's promoteState/promoteSummary/etc. instead
    // of starting clean — sweeping the directory here restores the
    // isolation these tests always assumed, correctly, they had.
    if (process.env.SESSIONS_DIR && fs.existsSync(process.env.SESSIONS_DIR)) {
      for (const entry of fs.readdirSync(process.env.SESSIONS_DIR)) {
        if (entry.endsWith(".state.json")) {
          fs.rmSync(path.join(process.env.SESSIONS_DIR, entry), { force: true });
        }
      }
    }
  });

  it("listens on app.pty.hookSocketPath once ready", async () => {
    app = await buildApp();
    await app.ready();

    const socket = await connect(app.pty.hookSocketPath);
    socket.destroy();
  });

  // The actual production incident this guards against: this socket path is
  // injected into every spawned session, so a dev backend started from
  // inside an already-running Mullion-hosted session inherits the same
  // SESSIONS_DIR (and so the same hooks.sock path) unless something
  // overrides it. Before the fix, buildApp() would unconditionally unlink
  // and rebind over an already-live listener there — silently hijacking it.
  // Now it must refuse to start, and the pre-existing listener must be left
  // untouched. hooksPlugin registers before any other socket-binding plugin
  // in app.ts's sequence, so this failure happens before anything else has
  // bound — no partial-registration cleanup needed, unlike the equivalent
  // test in control-socket.test.ts.
  it("refuses to start when hookSocketPath already has a live listener", async () => {
    const originalSessionsDir = process.env.SESSIONS_DIR;
    const scratchSessionsDir = path.join(os.tmpdir(), `hooks-collision-sessions-${process.pid}`);
    fs.mkdirSync(scratchSessionsDir, { recursive: true });
    const collisionPath = path.join(scratchSessionsDir, "hooks.sock");
    const preExisting = net.createServer(() => {});
    await new Promise<void>((resolve) => preExisting.listen(collisionPath, resolve));
    process.env.SESSIONS_DIR = scratchSessionsDir;

    try {
      await expect(buildApp()).rejects.toThrow(/already listening/i);

      // The pre-existing listener must survive completely untouched — not
      // unlinked, still reachable.
      const socket = await connect(collisionPath);
      socket.destroy();
    } finally {
      process.env.SESSIONS_DIR = originalSessionsDir;
      preExisting.close();
      fs.rmSync(scratchSessionsDir, { recursive: true, force: true });
    }
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

    const warnSpy = vi.spyOn(app.log, "warn");

    const socket = await connect(app.pty.hookSocketPath);
    // No trailing newline — deliberately never completes a line, so this
    // only ever hits the byte-cap guard, not JSON parsing.
    socket.write("a".repeat(70_000));

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);

    // Issue #907 — the warn log must include diagnostic context so a
    // recurrence is diagnosable without timestamp correlation.
    const oversizedWarn = warnSpy.mock.calls.find(
      (call) =>
        typeof call[1] === "string" && call[1].includes("oversized line without a terminator"),
    );
    expect(oversizedWarn).toBeDefined();
    // pino-style: warn({…}, "msg") — first arg is structured fields, second
    // is the message string.
    const fields = oversizedWarn![0];
    expect(fields).toMatchObject({
      bytesReceived: expect.any(Number),
    });
    expect(fields.bytesReceived).toBeGreaterThan(64 * 1024);
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
      // Issue: correlate concurrent permission gates — the forwarder (or,
      // here, the raw socket write above) generates its own gateId; read it
      // back off the live gate list rather than assuming one, so callers
      // that need it (to resolve THIS specific gate once more than one can
      // be pending) have it.
      const gateId = session.toInfo().gates[0]?.gateId;
      expect(gateId).toBeDefined();
      return { session, socket, gateId: gateId as string };
    }

    it("app.resolveHookGate writes an approve decision back to the pending connection and flips gateState", async () => {
      app = await buildApp();
      await app.ready();
      const { session, socket } = await openPendingGate(app, "1", "rm -rf /tmp/scratch");

      const replyPromise = waitForLine(socket);
      expect(app.resolveHookGate("1", undefined, "approved")).toBe(true);

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
      expect(app.resolveHookGate("1", undefined, "denied", "looks unsafe")).toBe(true);

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

      expect(app.resolveHookGate("1", undefined, "approved")).toBe(false);
    });

    it("holds two concurrent waiting gates for the same session independently — each has its own connection, its own reply, and resolving one doesn't touch the other (issue: correlate concurrent permission gates, supersedes PR #839's fall-through)", async () => {
      // Deterministic proof at the socket layer (not dependent on any
      // agent actually batching two escalated tool calls in one turn,
      // which is model behavior no test can command): open TWO concurrent
      // hook connections for the SAME session, each sending its own
      // `review_gate {state: "waiting"}`. Before this issue, the second
      // connection's gate resolved immediately to "no_response" (PR #839)
      // and the first was left as the session's only trace. This is the
      // exact scenario that wedged a real Codex turn (branchDAM, session
      // 566): the user answered whichever ONE prompt fell through to the
      // agent's own native TUI, with no indication a second tool call was
      // still parked, unanswerable except from the Mullion UI.
      app = await buildApp();
      await app.ready();
      const {
        session,
        socket: first,
        gateId: firstId,
      } = await openPendingGate(app, "1", "first command");

      const second = await connect(app.pty.hookSocketPath);
      second.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      const secondReplyPromise = waitForLine(second);
      second.write(
        `${JSON.stringify({ kind: "review_gate", state: "waiting", prompt: "second command" })}\n`,
      );
      for (let i = 0; i < 50 && session.toInfo().gates.length < 2; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Both gates are live, independently — no "already pending" fall
      // through, no dropped bookkeeping for either.
      expect(session.toInfo().gateState).toBe("waiting");
      expect(session.toInfo().gates).toHaveLength(2);
      const [g1, g2] = session.toInfo().gates;
      expect(g1).toMatchObject({ gateId: firstId, prompt: "first command" });
      expect(g2.prompt).toBe("second command");
      expect(g2.gateId).not.toBe(firstId);

      // Resolving the SECOND gate specifically (by its own id) does not
      // touch the first — the write-side half of the "resolving A must
      // not disturb B" invariant.
      const replyForSecond = secondReplyPromise;
      expect(app.resolveHookGate("1", g2.gateId, "denied", "not this one")).toBe(true);
      expect(JSON.parse(await replyForSecond)).toEqual({
        decision: "denied",
        reason: "not this one",
      });
      expect(session.toInfo().gateState).toBe("waiting");
      expect(session.toInfo().gates).toEqual([
        { gateId: firstId, prompt: "first command", at: g1.at },
      ]);

      // The first gate is STILL independently resolvable, on its own
      // connection, with its own reply.
      const replyForFirst = waitForLine(first);
      expect(app.resolveHookGate("1", firstId, "approved")).toBe(true);
      expect(JSON.parse(await replyForFirst)).toEqual({ decision: "approved" });
      expect(session.toInfo().gateState).toBe("approved");
      expect(session.toInfo().gates).toEqual([]);

      first.destroy();
      second.destroy();
    });

    it("resolves to lapsed, not denied, when the gate connection closes before a decision arrives (concurrent-gates investigation)", async () => {
      app = await buildApp();
      await app.ready();
      const { session, socket } = await openPendingGate(app, "1", "some command");

      socket.destroy();

      for (let i = 0; i < 50 && session.toInfo().gateState === "waiting"; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      // "lapsed", NOT "denied": nobody actually decided anything here —
      // same as the GATE_TIMEOUT_MS path below, which already resolves to
      // "lapsed". A live stuck session (branchDAM, session 566) showed this
      // previously latching a human-looking "denied" onto the persisted
      // session state for a connection drop nobody caused.
      expect(session.toInfo().gateState).toBe("lapsed");
    });

    it("resolves to no_response on the server-side gate timeout — falls through, not a denial (issue #264)", async () => {
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
          decision: "no_response",
          reason: "timed out waiting for a decision",
        });
        // "no_response" (nobody ever decided) now has its own gateState
        // ("lapsed", issue #840/#844) distinct from a human "denied" — the
        // WIRE reply the agent receives falls through, and this end's
        // record of the outcome matches that instead of misreporting it as
        // an explicit denial.
        expect(session.toInfo().gateState).toBe("lapsed");
        socket.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves a still-pending gate to lapsed (not denied) at graceful shutdown, before its socket is destroyed (issue #844)", async () => {
      app = await buildApp();
      await app.ready();
      const { session, socket } = await openPendingGate(app, "1", "some command");

      const replyPromise = waitForLine(socket);
      await app.close();
      app = null;

      // The forwarder's own runGate() treats this reply exactly like a live
      // timeout — falls through to the agent's own native prompt, not a
      // denial — so the agent-visible outcome is identical whether Mullion
      // is shutting down or just timed out.
      expect(JSON.parse(await replyPromise)).toEqual({
        decision: "no_response",
        reason: "Mullion is shutting down",
      });
      // The session's own persisted record of the outcome — what a restored
      // session boots back up showing — must say "lapsed", not "denied":
      // this was Mullion closing the socket on purpose, not a forwarder
      // failure, and denying here would misrepresent a graceful restart as
      // a real human decision.
      expect(session.toInfo().gateState).toBe("lapsed");
      socket.destroy();
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
    it("replies with just the agent guide pointer when nothing was stashed (default settings)", async () => {
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

      // Issue #405 — `sessions.injectAgentGuide` defaults to true, and this
      // repo checkout ships docs/agent-guide.md, so with no seed stashed and
      // no project briefing for cwd "/tmp" (no marked AGENTS.md/CLAUDE.md
      // there) the reply is the guide block alone (excerpt + pointer — see
      // buildAgentGuideBlock's own doc comment for why this replaced the
      // pointer-only reply).
      const guidePath = sessionAgentGuidePath(path.dirname(app.pty.hookSocketPath), "1");
      expect(JSON.parse(await replyPromise)).toEqual({
        additionalContext: buildAgentGuideBlock(readAgentGuideExcerpt(), guidePath, false),
      });
      socket.destroy();
    });

    it("replies with the stashed seed and clears it (single-use), composed with the guide pointer", async () => {
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

      const guidePath = sessionAgentGuidePath(path.dirname(app.pty.hookSocketPath), "1");
      const guideBlock = buildAgentGuideBlock(readAgentGuideExcerpt(), guidePath, false);
      expect(JSON.parse(await replyPromise)).toEqual({
        additionalContext: `picks up where the last session left off\n\n${guideBlock}`,
      });

      // Single-use: a second session_start for the same id gets no seed —
      // but the guide block is generated FRESH on every call (never
      // stashed/consumed itself), so it's still present.
      const secondReplyPromise = waitForLine(socket);
      socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);
      expect(JSON.parse(await secondReplyPromise)).toEqual({ additionalContext: guideBlock });
      socket.destroy();
    });

    it("sends the full-scope wording when auth is enabled (not the session-scope claims, which would be false)", async () => {
      process.env.MULLION_AUTH_TOKEN = "test-auth-token-0123456789"; // pragma: allowlist secret
      process.env.MULLION_SESSION_SECRET = "test-session-secret-0123456789"; // pragma: allowlist secret
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
        socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

        const guidePath = sessionAgentGuidePath(path.dirname(app.pty.hookSocketPath), "1");
        const reply = JSON.parse(await replyPromise);
        expect(reply).toEqual({
          additionalContext: buildAgentGuideBlock(readAgentGuideExcerpt(), guidePath, true),
        });
        // Dedicated assertion, not just structural equality against a
        // rebuilt expected value: the actual reply text must carry the
        // session-scope claim, not the full-disabled wording — this is a
        // correctness claim about what the agent is told, not a formatting
        // detail, and must survive the excerpt/block refactor.
        expect(reply.additionalContext).toContain("MULLION_HOOK_TOKEN; MULLION_AUTH_TOKEN");
        socket.destroy();
      } finally {
        delete process.env.MULLION_AUTH_TOKEN;
        delete process.env.MULLION_SESSION_SECRET;
      }
    });

    it("omits the guide pointer entirely when sessions.injectAgentGuide is disabled", async () => {
      app = await buildApp();
      await app.ready();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { sessions: { injectAgentGuide: false } },
      });
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

      // Only the seed, no guide block — same reply shape as before issue #405.
      expect(JSON.parse(await replyPromise)).toEqual({
        additionalContext: "picks up where the last session left off",
      });
      socket.destroy();
    });

    // Issue #884 — a per-project override (simulated here the same way
    // session-lifecycle.ts's createSessionRecord actually resolves and
    // threads it: as an explicit getOrCreate() opt) must win over the LIVE
    // global setting, proving this gate now reads the session's own
    // spawn-time-resolved value (pty-manager.ts) rather than independently
    // re-deriving the global setting via getStoredSettings as it used to.
    // The global setting is left ON here specifically so a false positive
    // (the gate coincidentally reading the global default) can't slip by.
    it("a per-project override (threaded as an explicit getOrCreate opt) wins over the live global setting", async () => {
      app = await buildApp();
      await app.ready();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { sessions: { injectAgentGuide: true, injectProjectBriefing: true } },
      });
      const session = app.pty.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        injectAgentGuide: false,
      });
      app.pty.stashSeed("1", "picks up where the last session left off");

      const socket = await connect(app.pty.hookSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      const replyPromise = waitForLine(socket);
      socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

      // Only the seed, no guide block — the per-project override, not the
      // (still-on) global setting, decided this.
      expect(JSON.parse(await replyPromise)).toEqual({
        additionalContext: "picks up where the last session left off",
      });
      socket.destroy();
    });

    it("keeps injecting the guide for a session already spawned when the global setting is later flipped off (issue #884 spawn-time snapshot)", async () => {
      app = await buildApp();
      await app.ready();
      // Global default is injectAgentGuide: true, so this session's own
      // Session.injectAgentGuide snapshots `true` at getOrCreate() time —
      // before the PATCH below ever runs.
      const session = app.pty.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { sessions: { injectAgentGuide: false } },
      });

      const socket = await connect(app.pty.hookSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      const replyPromise = waitForLine(socket);
      socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

      // The guide block is still present: hooks.ts reads the SESSION's own
      // already-resolved injectAgentGuide, never a live re-read of the
      // global setting, so a toggle flipped after spawn only affects the
      // session's NEXT spawn, not this already-running one.
      const guidePath = sessionAgentGuidePath(path.dirname(app.pty.hookSocketPath), "1");
      expect(JSON.parse(await replyPromise)).toEqual({
        additionalContext: buildAgentGuideBlock(readAgentGuideExcerpt(), guidePath, false),
      });
      socket.destroy();
    });

    describe("pinned note (agent-briefing follow-up to #405, redesigned by #942)", () => {
      it("composes seed, guide block, and pinned note in that order when all three are present", async () => {
        app = await buildApp();
        await app.ready();
        // Explicit, not relied-on-default: this test file shares one DB
        // across every `it()` (test/setup.ts isolates per FILE, not per
        // test — see CLAUDE.md), so an earlier test's PATCH (e.g. "omits
        // the guide pointer when disabled") would otherwise leak into this
        // one depending on execution order.
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { sessions: { injectAgentGuide: true, injectProjectBriefing: true } },
        });
        const session = app.pty.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
          briefingOverride: "branch off origin/main",
        });
        app.pty.stashSeed("1", "picks up where the last session left off");
        await session.spawnOutcome();

        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
        const replyPromise = waitForLine(socket);
        socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

        const guidePath = sessionAgentGuidePath(path.dirname(app.pty.hookSocketPath), "1");
        const guideBlock = buildAgentGuideBlock(readAgentGuideExcerpt(), guidePath, false);
        const briefingPath = sessionBriefingPath(path.dirname(app.pty.hookSocketPath), "1");
        const briefing = fs.readFileSync(briefingPath, "utf8");
        expect(JSON.parse(await replyPromise)).toEqual({
          additionalContext: `picks up where the last session left off\n\n${guideBlock}\n\n${briefing}`,
        });
        expect(briefing).toContain("branch off origin/main");
        socket.destroy();
      });

      it("omits the pinned note but keeps the guide block when sessions.injectProjectBriefing is disabled", async () => {
        app = await buildApp();
        await app.ready();
        // Explicit about BOTH keys, not just the one under test — see the
        // "composes all three" test's comment above for why.
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { sessions: { injectAgentGuide: true, injectProjectBriefing: false } },
        });
        const session = app.pty.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
          briefingOverride: "branch off origin/main",
        });
        await session.spawnOutcome();

        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
        const replyPromise = waitForLine(socket);
        socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

        const guidePath = sessionAgentGuidePath(path.dirname(app.pty.hookSocketPath), "1");
        const guideBlock = buildAgentGuideBlock(readAgentGuideExcerpt(), guidePath, false);
        expect(JSON.parse(await replyPromise)).toEqual({ additionalContext: guideBlock });
        socket.destroy();
      });

      it("omits the guide block but keeps the pinned note when sessions.injectAgentGuide is disabled", async () => {
        app = await buildApp();
        await app.ready();
        // Explicit about BOTH keys — see the "composes all three" test's
        // comment above for why.
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { sessions: { injectAgentGuide: false, injectProjectBriefing: true } },
        });
        const session = app.pty.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
          briefingOverride: "branch off origin/main",
        });
        await session.spawnOutcome();

        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
        const replyPromise = waitForLine(socket);
        socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

        const briefingPath = sessionBriefingPath(path.dirname(app.pty.hookSocketPath), "1");
        const briefing = fs.readFileSync(briefingPath, "utf8");
        expect(JSON.parse(await replyPromise)).toEqual({ additionalContext: briefing });
        socket.destroy();
      });

      it("reply is byte-identical to the no-note case when the project has no pinned note set", async () => {
        app = await buildApp();
        await app.ready();
        // Explicit — see the "composes all three" test's comment above.
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { sessions: { injectAgentGuide: true, injectProjectBriefing: true } },
        });
        const session = app.pty.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await session.spawnOutcome();

        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
        const replyPromise = waitForLine(socket);
        socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

        const guidePath = sessionAgentGuidePath(path.dirname(app.pty.hookSocketPath), "1");
        const guideBlock = buildAgentGuideBlock(readAgentGuideExcerpt(), guidePath, false);
        expect(JSON.parse(await replyPromise)).toEqual({ additionalContext: guideBlock });
        socket.destroy();
      });

      // Issue #942 — an empty-string note is a real, reachable state
      // (select-all-delete in the UI, then Save), distinct from no note at
      // all: it still gets written and injected, header-only. Pinning this
      // end to end, not just at the writeSessionBriefing unit level, since
      // this is what an agent's context actually looks like for it.
      it("still injects a header-only block for an empty-string pinned note — not the same as no note at all", async () => {
        app = await buildApp();
        await app.ready();
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { sessions: { injectAgentGuide: false, injectProjectBriefing: true } },
        });
        const session = app.pty.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
          briefingOverride: "",
        });
        await session.spawnOutcome();

        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
        const replyPromise = waitForLine(socket);
        socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

        const briefingPath = sessionBriefingPath(path.dirname(app.pty.hookSocketPath), "1");
        const briefing = fs.readFileSync(briefingPath, "utf8");
        expect(briefing).toContain("pinned note");
        expect(JSON.parse(await replyPromise)).toEqual({ additionalContext: briefing });
        socket.destroy();
      });
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

  describe("browser_action (Feature 3.7)", () => {
    it("handles browser_action hook message and executes browser actions locally", async () => {
      process.env.BROWSER_ENABLED = "true";
      try {
        app = await buildApp();
        await app.ready();

        const [projectRow] = app.db
          .insert(projects)
          .values({ name: "test-p", cwd: "/tmp", hostId: "local" })
          .returning()
          .all();

        const session = app.pty.getOrCreate({
          id: "123",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
          projectId: projectRow.id,
        });

        app.db
          .insert(sessions)
          .values({ id: 123, projectId: projectRow.id, command: "bash", status: "active" })
          .run();

        class FakePage extends EventEmitter {
          currentUrl = "about:blank";
          gotoSpy = vi.fn(async (url: string) => {
            this.currentUrl = url;
          });
          url() {
            return this.currentUrl;
          }
          async title() {
            return "Hook Test Page";
          }
          async goto(url: string, opts?: unknown) {
            return this.gotoSpy(url, opts);
          }
          async evaluate() {
            return null;
          }
          locator() {
            return {
              ariaSnapshot: async () => "- heading: Hook Test Page",
              all: async () => [],
            };
          }
        }

        const fakePage = new FakePage();
        const fakeManaged = {
          projectId: projectRow.id,
          page: fakePage,
          consoleLogs: [{ type: "log", text: "hook console test", timestamp: Date.now() }],
          pageErrors: [],
        };
        vi.spyOn(app.browser, "getOrLaunch").mockResolvedValue(
          fakeManaged as unknown as ManagedBrowser,
        );

        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);

        const replyPromise = waitForLine(socket);
        socket.write(
          `${JSON.stringify({
            kind: "browser_action",
            action: "navigate",
            url: "http://google.com",
          })}\n`,
        );

        const reply = JSON.parse(await replyPromise);
        expect(reply.ok).toBe(true);
        expect(reply.url).toBe("http://google.com");
        expect(reply.console[0].text).toBe("hook console test");

        socket.destroy();
      } finally {
        delete process.env.BROWSER_ENABLED;
      }
    });

    // Regression coverage for a gap where KNOWN_BROWSER_ACTIONS (hook-protocol.ts)
    // only allowed 15 of the 19 actions the MCP use_browser/browser_action tools,
    // the REST route, and the CLI all advertise — "fill", "snapshot", "eval", and
    // "screenshot" were reachable everywhere except this hook-socket path, where
    // they were rejected with "unknown browser_action: <action>".
    //
    // Note on assertion strength: the "fill", "eval", and "screenshot" tests
    // below assert real spy calls/return values (fillSpy, evaluateSpy,
    // the base64 screenshot payload) — they exercise logic unique to that
    // action. The "snapshot" test below only proves the action clears the
    // allowlist gate; per browser-automation.ts's own "snapshot is folded
    // into every response below" comment, snapshotPage runs on every action
    // regardless, so that test doesn't exercise anything unique to
    // "snapshot" itself.
    it("handles a browser_action fill message and fills the resolved element", async () => {
      process.env.BROWSER_ENABLED = "true";
      try {
        app = await buildApp();
        await app.ready();

        const [projectRow] = app.db
          .insert(projects)
          .values({ name: "test-p", cwd: "/tmp", hostId: "local" })
          .returning()
          .all();

        const session = app.pty.getOrCreate({
          id: "124",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
          projectId: projectRow.id,
        });

        app.db
          .insert(sessions)
          .values({ id: 124, projectId: projectRow.id, command: "bash", status: "active" })
          .run();

        class FakePage extends EventEmitter {
          currentUrl = "about:blank";
          fillSpy = vi.fn(async (_value: string) => {});
          gotoSpy = vi.fn(async (url: string) => {
            this.currentUrl = url;
          });
          url() {
            return this.currentUrl;
          }
          async title() {
            return "Hook Test Page";
          }
          async goto(url: string, opts?: unknown) {
            return this.gotoSpy(url, opts);
          }
          async evaluate() {
            return null;
          }
          locator() {
            return {
              ariaSnapshot: async () => "- heading: Hook Test Page",
              all: async () => [],
              fill: (value: string) => this.fillSpy(value),
            };
          }
        }

        const fakePage = new FakePage();
        const fakeManaged = {
          projectId: projectRow.id,
          page: fakePage,
          consoleLogs: [],
          pageErrors: [],
        };
        vi.spyOn(app.browser, "getOrLaunch").mockResolvedValue(
          fakeManaged as unknown as ManagedBrowser,
        );

        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);

        const replyPromise = waitForLine(socket);
        socket.write(
          `${JSON.stringify({
            kind: "browser_action",
            action: "fill",
            ref: "e1",
            value: "hello world",
          })}\n`,
        );

        const reply = JSON.parse(await replyPromise);
        expect(reply.ok).toBe(true);
        expect(fakePage.fillSpy).toHaveBeenCalledWith("hello world");

        socket.destroy();
      } finally {
        delete process.env.BROWSER_ENABLED;
      }
    });

    it("handles a browser_action snapshot message and returns the page snapshot", async () => {
      process.env.BROWSER_ENABLED = "true";
      try {
        app = await buildApp();
        await app.ready();

        const [projectRow] = app.db
          .insert(projects)
          .values({ name: "test-p", cwd: "/tmp", hostId: "local" })
          .returning()
          .all();

        const session = app.pty.getOrCreate({
          id: "125",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
          projectId: projectRow.id,
        });

        app.db
          .insert(sessions)
          .values({ id: 125, projectId: projectRow.id, command: "bash", status: "active" })
          .run();

        class FakePage extends EventEmitter {
          currentUrl = "http://example.com";
          url() {
            return this.currentUrl;
          }
          async title() {
            return "Hook Test Page";
          }
          async goto() {}
          async evaluate() {
            return [];
          }
          locator() {
            return {
              ariaSnapshot: async () => "- heading: Hook Test Page",
              all: async () => [],
            };
          }
        }

        const fakePage = new FakePage();
        const fakeManaged = {
          projectId: projectRow.id,
          page: fakePage,
          consoleLogs: [],
          pageErrors: [],
        };
        vi.spyOn(app.browser, "getOrLaunch").mockResolvedValue(
          fakeManaged as unknown as ManagedBrowser,
        );

        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);

        const replyPromise = waitForLine(socket);
        socket.write(`${JSON.stringify({ kind: "browser_action", action: "snapshot" })}\n`);

        const reply = JSON.parse(await replyPromise);
        expect(reply.ok).toBe(true);
        expect(reply.snapshot.tree).toBe("- heading: Hook Test Page");

        socket.destroy();
      } finally {
        delete process.env.BROWSER_ENABLED;
      }
    });

    it("handles a browser_action eval message and returns the script's result", async () => {
      process.env.BROWSER_ENABLED = "true";
      try {
        app = await buildApp();
        await app.ready();

        const [projectRow] = app.db
          .insert(projects)
          .values({ name: "test-p", cwd: "/tmp", hostId: "local" })
          .returning()
          .all();

        const session = app.pty.getOrCreate({
          id: "126",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
          projectId: projectRow.id,
        });

        app.db
          .insert(sessions)
          .values({ id: 126, projectId: projectRow.id, command: "bash", status: "active" })
          .run();

        class FakePage extends EventEmitter {
          currentUrl = "about:blank";
          evaluateSpy = vi.fn((script: string) => {
            if (script.includes("data-mullion-ref")) return [];
            return 42;
          });
          url() {
            return this.currentUrl;
          }
          async title() {
            return "Hook Test Page";
          }
          async goto() {}
          async evaluate(script: string) {
            return this.evaluateSpy(script);
          }
          locator() {
            return {
              ariaSnapshot: async () => "- heading: Hook Test Page",
              all: async () => [],
            };
          }
        }

        const fakePage = new FakePage();
        const fakeManaged = {
          projectId: projectRow.id,
          page: fakePage,
          consoleLogs: [],
          pageErrors: [],
        };
        vi.spyOn(app.browser, "getOrLaunch").mockResolvedValue(
          fakeManaged as unknown as ManagedBrowser,
        );

        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);

        const replyPromise = waitForLine(socket);
        socket.write(
          `${JSON.stringify({ kind: "browser_action", action: "eval", script: "1 + 41" })}\n`,
        );

        const reply = JSON.parse(await replyPromise);
        expect(reply.ok).toBe(true);
        expect(reply.result).toBe(42);
        expect(fakePage.evaluateSpy).toHaveBeenCalledWith("1 + 41");

        socket.destroy();
      } finally {
        delete process.env.BROWSER_ENABLED;
      }
    });

    it("handles a browser_action screenshot message and returns a base64 PNG", async () => {
      process.env.BROWSER_ENABLED = "true";
      try {
        app = await buildApp();
        await app.ready();

        const [projectRow] = app.db
          .insert(projects)
          .values({ name: "test-p", cwd: "/tmp", hostId: "local" })
          .returning()
          .all();

        const session = app.pty.getOrCreate({
          id: "127",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
          projectId: projectRow.id,
        });

        app.db
          .insert(sessions)
          .values({ id: 127, projectId: projectRow.id, command: "bash", status: "active" })
          .run();

        class FakePage extends EventEmitter {
          currentUrl = "about:blank";
          screenshotBuffer = Buffer.from("PNGDATA");
          url() {
            return this.currentUrl;
          }
          async title() {
            return "Hook Test Page";
          }
          async goto() {}
          async evaluate() {
            return [];
          }
          async screenshot() {
            return this.screenshotBuffer;
          }
          locator() {
            return {
              ariaSnapshot: async () => "- heading: Hook Test Page",
              all: async () => [],
            };
          }
        }

        const fakePage = new FakePage();
        const fakeManaged = {
          projectId: projectRow.id,
          page: fakePage,
          consoleLogs: [],
          pageErrors: [],
        };
        vi.spyOn(app.browser, "getOrLaunch").mockResolvedValue(
          fakeManaged as unknown as ManagedBrowser,
        );

        const socket = await connect(app.pty.hookSocketPath);
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);

        const replyPromise = waitForLine(socket);
        socket.write(`${JSON.stringify({ kind: "browser_action", action: "screenshot" })}\n`);

        const reply = JSON.parse(await replyPromise);
        expect(reply.ok).toBe(true);
        expect(reply.screenshot).toBe(Buffer.from("PNGDATA").toString("base64"));

        socket.destroy();
      } finally {
        delete process.env.BROWSER_ENABLED;
      }
    });
  });
});
