import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  createInternalAgentEnv,
  INTERNAL_TEST_TOKEN,
  waitUntil,
  buildAndListen,
} from "../helpers/internal-routes.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";

const ptyHarness = createInternalPtyHarness();
const childProcessHarness = createInternalChildProcessHarness();
const bundleSyncHarness = createBundleSyncHarness();

vi.mock("node-pty", () => ptyHarness.mockModule());
vi.mock("node:child_process", async (importOriginal) =>
  childProcessHarness.mockModule(await importOriginal()),
);
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncHarness.mockModule());
const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");

const TOKEN = INTERNAL_TEST_TOKEN;
const { fakePtyChildren } = ptyHarness;
const listenApp = () => buildAndListen(buildApp);

describe("internal routes: session transcript, scrollback, prompt, and wait-output", () => {
  const env = createInternalAgentEnv();
  beforeAll(() => {
    env.setup();
  });
  afterAll(() => {
    env.teardown();
  });
  beforeEach(() => {
    ptyHarness.reset();
    childProcessHarness.reset();
    bundleSyncHarness.reset();
    clearAgentsCacheForTests();
  });

  describe("GET /internal/sessions/:id/transcript (issue #2268)", () => {
    const auth = { authorization: `Bearer ${TOKEN}` };

    it("answers a refusal as a value for an untracked session and for a shell", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;
      const missing = await app.inject({
        method: "GET",
        url: "/internal/sessions/never-spawned/transcript",
        headers: auth,
      });
      expect(missing.statusCode).toBe(200);
      expect(missing.json()).toMatchObject({ ok: false, status: 404 });

      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: auth,
        payload: { id: "611", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);
      const shell = await app.inject({
        method: "GET",
        url: "/internal/sessions/611/transcript",
        headers: auth,
      });
      expect(shell.json()).toMatchObject({ ok: false, status: 501 });
      await app.close();
    });

    it("reads the Claude transcript a hook reported, inside the config dir only", async () => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-claude-cfg-"));
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = configDir;
      try {
        const projects = path.join(configDir, "projects", "-tmp");
        fs.mkdirSync(projects, { recursive: true });
        const file = path.join(projects, "s.jsonl");
        fs.writeFileSync(
          file,
          `${JSON.stringify({ type: "user", message: { content: "hello agent" } })}\n`,
        );
        const app = await buildApp();
        const before = fakePtyChildren.length;
        await app.inject({
          method: "POST",
          url: "/internal/sessions",
          headers: auth,
          payload: { id: "612", cwd: "/tmp", command: "claude", cols: 80, rows: 24 },
        });
        await waitUntil(() => fakePtyChildren.length > before);

        const notYet = await app.inject({
          method: "GET",
          url: "/internal/sessions/612/transcript",
          headers: auth,
        });
        expect(notYet.json()).toMatchObject({ ok: false, status: 409 });

        app.pty.emitHookEvent("612", { kind: "cwd_changed", cwd: "/tmp", transcriptPath: file });
        const res = await app.inject({
          method: "GET",
          url: "/internal/sessions/612/transcript?limit=5&tools=0",
          headers: auth,
        });
        expect(res.json()).toMatchObject({
          ok: true,
          entries: [{ role: "user", text: "hello agent" }],
          more: false,
        });

        // Another project's transcript, inside the same config dir, is refused too:
        // a session reads only the project directory it was launched in.
        const otherProject = path.join(configDir, "projects", "-somewhere-else");
        fs.mkdirSync(otherProject, { recursive: true });
        const otherFile = path.join(otherProject, "other.jsonl");
        fs.writeFileSync(
          otherFile,
          `${JSON.stringify({ type: "user", message: { content: "someone else's conversation" } })}\n`,
        );
        app.pty.emitHookEvent("612", {
          kind: "cwd_changed",
          cwd: "/tmp",
          transcriptPath: otherFile,
        });
        const crossProject = await app.inject({
          method: "GET",
          url: "/internal/sessions/612/transcript",
          headers: auth,
        });
        expect(crossProject.json()).toMatchObject({ ok: false, status: 404 });

        // A forged path outside the config dir is refused, not read.
        const outside = path.join(configDir, "secret.jsonl");
        fs.writeFileSync(outside, "{}\n");
        app.pty.emitHookEvent("612", { kind: "cwd_changed", cwd: "/tmp", transcriptPath: outside });
        const forged = await app.inject({
          method: "GET",
          url: "/internal/sessions/612/transcript",
          headers: auth,
        });
        expect(forged.json()).toMatchObject({ ok: false, status: 404 });
        await app.close();
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    });

    it("rejects an out-of-range limit", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/sessions/611/transcript?limit=501",
        headers: auth,
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("GET /internal/sessions/:id/scrollback (Phase 4, #187)", () => {
    it("returns the base64-encoded scrollback for a tracked session", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;

      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "601", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);

      const res = await app.inject({
        method: "GET",
        url: "/internal/sessions/601/scrollback",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const { b64 } = res.json();
      expect(typeof b64).toBe("string");
      // Always non-empty: getScrollback()'s synthesized alt-screen preamble
      // is unconditional, even with nothing else in the ring buffer yet —
      // see pty-manager.ts's getScrollback doc comment.
      expect(Buffer.from(b64, "base64").length).toBeGreaterThan(0);

      await app.close();
    });

    it("?mode=rendered answers plain text rendered on this agent, empty for an untracked id (issue #2112)", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "602", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);

      const tracked = await app.inject({
        method: "GET",
        url: "/internal/sessions/602/scrollback?mode=rendered",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(tracked.statusCode).toBe(200);
      expect(typeof tracked.json().text).toBe("string");
      expect(tracked.json()).not.toHaveProperty("b64");

      const untracked = await app.inject({
        method: "GET",
        url: "/internal/sessions/never-spawned/scrollback?mode=rendered",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(untracked.json()).toEqual({ text: "" });
      await app.close();
    });

    it("returns an empty b64 for a session id this agent has never tracked", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/sessions/never-spawned/scrollback",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ b64: "" });
      await app.close();
    });

    it("401s without a valid bearer token", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/internal/sessions/601/scrollback" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("POST /internal/sessions/:id/review-gate (issue #178)", () => {
    it("delivers a decision to a real pending gate and reports {ok: true}", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "9001", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);
      const session = app.pty.get("9001");
      if (!session) throw new Error("session not tracked");

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(
        `${JSON.stringify({ kind: "review_gate", state: "waiting", prompt: "rm -rf /tmp/x" })}\n`,
      );
      await waitUntil(() => session.toInfo().gateState === "waiting");

      const replyPromise = new Promise<string>((resolve) => {
        socket.on("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
      });

      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9001/review-gate",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(JSON.parse(await replyPromise)).toEqual({ decision: "approved" });
      expect(session.toInfo().gateState).toBe("approved");

      socket.destroy();
      await app.close();
    });

    it("reports {ok: false} when nothing is pending for this session", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "9002", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);

      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9002/review-gate",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { decision: "denied", reason: "nothing pending" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false });

      await app.close();
    });

    it("rejects a request with the wrong token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9003/review-gate",
        headers: { authorization: "Bearer wrong" },
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("400s an unrecognized decision value", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9004/review-gate",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { decision: "maybe" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("POST /internal/sessions/:id/attention/ack (issue #1472)", () => {
    it("reports {ok: true} for a session with nothing to acknowledge, and clears this agent's own attention state", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "9101", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);

      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9101/attention/ack",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      // AttentionTracker.acknowledgeAttention emits its own "attention"
      // NotificationEvent unconditionally on success — this is what the
      // primary's /internal/ws/events relay (relayRemoteEventsHost)
      // forwards byte-for-byte to a connected browser, clearing its badge,
      // with no further plumbing needed (issue #1472).
      const events = app.pty.listEvents();
      expect(events.some((e) => e.sessionId === 9101 && e.kind === "attention")).toBe(true);

      await app.close();
    });

    it("reports {ok: false} while a blocking kind (a pending review gate) is confirmed", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "9102", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);
      const session = app.pty.get("9102");
      if (!session) throw new Error("session not tracked");

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(
        `${JSON.stringify({ kind: "review_gate", state: "waiting", prompt: "rm -rf /tmp/x" })}\n`,
      );
      await waitUntil(() => session.toInfo().gateState === "waiting");

      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9102/attention/ack",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false });
      expect(session.toInfo().gateState).toBe("waiting");

      socket.destroy();
      await app.close();
    });

    it("rejects a request with the wrong token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9103/attention/ack",
        headers: { authorization: "Bearer wrong" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  // Issue #1951 follow-up — the primary editing THIS agent's project roots.
  // The saved override lives under os.homedir(), so HOME points at a throwaway
  // directory for the whole block: nothing here may touch the real ~/.mullion.

  describe("POST /internal/sessions/:id/prompt (issue #1951)", () => {
    async function spawn(app: Awaited<ReturnType<typeof buildApp>>, id: string, command: string) {
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id, cwd: "/tmp", command, cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);
      return fakePtyChildren[fakePtyChildren.length - 1];
    }

    it("types the prompt, submits it, and reports the output offset", async () => {
      const app = await buildApp();
      const pty = await spawn(app, "9201", "claude");
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9201/prompt",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { text: "run the build", submit: true },
      });
      expect(res.statusCode).toBe(200);
      // `afterSeq` (#1962): the event head right after the turn began — what
      // arms the primary's "a new turn started" guard for `prompt` + `wait`.
      expect(res.json()).toEqual({
        outputOffset: expect.any(Number),
        afterSeq: expect.any(Number),
      });
      const typed = pty.writeSpy.mock.calls.map((c) => String(c[0]));
      expect(typed.some((s) => s.includes("run the build"))).toBe(true);
      expect(typed[typed.length - 1]).toBe("\r");
      await app.close();
    });

    it("types without submitting when submit is false", async () => {
      const app = await buildApp();
      const pty = await spawn(app, "9202", "claude");
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9202/prompt",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { text: "draft only", submit: false },
      });
      expect(res.statusCode).toBe(200);
      expect(pty.writeSpy.mock.calls.map((c) => String(c[0])).includes("\r")).toBe(false);
      await app.close();
    });

    it("answers 422 {status: 501} for an agent with no prompt framing", async () => {
      const app = await buildApp();
      await spawn(app, "9203", "bash");
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9203/prompt",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { text: "hi", submit: true },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ status: 501, error: expect.stringMatching(/not supported/) });
      await app.close();
    });

    it("answers 422 {status: 409} for a session this agent is not running", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9204/prompt",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { text: "hi", submit: true },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().status).toBe(409);
      await app.close();
    });

    it("rejects a request with the wrong token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9205/prompt",
        headers: { authorization: "Bearer wrong" },
        payload: { text: "hi", submit: true },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("POST /internal/sessions/:id/wait-output (issue #1951)", () => {
    async function spawn(app: Awaited<ReturnType<typeof buildApp>>, id: string) {
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id, cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);
      return fakePtyChildren[fakePtyChildren.length - 1];
    }
    const post = (app: Awaited<ReturnType<typeof buildApp>>, id: string, payload: object) =>
      app.inject({
        method: "POST",
        url: `/internal/sessions/${id}/wait-output`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload,
      });

    it("resolves a match as it is printed, with the PTY's output offset", async () => {
      const app = await buildApp();
      const pty = await spawn(app, "9211");
      const pending = post(app, "9211", { match: "BUILD OK", regex: false, timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 50));
      pty.emitData("compiling...\r\nBUILD OK\r\n");
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        matched: true,
        text: "BUILD OK",
        outputOffset: expect.any(Number),
      });
      await app.close();
    });

    it("counts output printed since afterOffset (no prompt -> wait race)", async () => {
      const app = await buildApp();
      const pty = await spawn(app, "9212");
      const session = app.pty.get("9212")!;
      const offset = session.outputOffset;
      pty.emitData("DONE already\r\n");
      const res = await post(app, "9212", {
        match: "DONE",
        regex: false,
        timeoutMs: 5000,
        afterOffset: offset,
      });
      expect(res.json()).toMatchObject({ matched: true });
      await app.close();
    });

    it("reports {timedOut} with the offset to resume from when the chunk elapses", async () => {
      const app = await buildApp();
      await spawn(app, "9213");
      const res = await post(app, "9213", { match: "never", regex: false, timeoutMs: 100 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        matched: false,
        timedOut: true,
        outputOffset: expect.any(Number),
      });
      await app.close();
    });

    it("reports {notRunning} for a session this agent does not run", async () => {
      const app = await buildApp();
      const res = await post(app, "9214", { match: "x", regex: false, timeoutMs: 100 });
      expect(res.json()).toEqual({ notRunning: true });
      await app.close();
    });

    it("answers 422 {status: 400} for an unsafe regex", async () => {
      const app = await buildApp();
      await spawn(app, "9215");
      const res = await post(app, "9215", { match: "(a+)+$", regex: true, timeoutMs: 100 });
      expect(res.statusCode).toBe(422);
      expect(res.json().status).toBe(400);
      await app.close();
    });

    it("holds the wait open over a real socket until output arrives (the request's own close is not a hang-up)", async () => {
      const { app, port } = await listenApp();
      const pty = await spawn(app, "9219");
      const pending = fetch(`http://127.0.0.1:${port}/internal/sessions/9219/wait-output`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ match: "READY", regex: false, timeoutMs: 5000 }),
      });
      await new Promise((r) => setTimeout(r, 150));
      pty.emitData("READY\r\n");
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ matched: true, text: "READY" });
      await app.close();
    });

    it("aborts the agent-side wait when the requester hangs up", async () => {
      const { app, port } = await listenApp();
      await spawn(app, "9220");
      const outputWait = await import("../../src/services/output-wait.js");
      let seen: AbortSignal | undefined;
      const waitSpy = vi.spyOn(outputWait, "waitForOutput").mockImplementation((_m, _t, deps) => {
        seen = deps.signal;
        return new Promise(() => {});
      });
      try {
        const controller = new AbortController();
        const pending = fetch(`http://127.0.0.1:${port}/internal/sessions/9220/wait-output`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ match: "NEVER", regex: false, timeoutMs: 5000 }),
          signal: controller.signal,
        }).catch(() => null);
        await waitUntil(() => seen !== undefined);
        expect(seen!.aborted).toBe(false);
        controller.abort();
        await pending;
        await waitUntil(() => seen!.aborted);
      } finally {
        waitSpy.mockRestore();
      }
      await app.close();
    });

    it("rejects a wait longer than one remote chunk, rather than holding a subscription that long", async () => {
      const app = await buildApp();
      await spawn(app, "9216");
      const res = await post(app, "9216", { match: "never", regex: false, timeoutMs: 60_001 });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ status: 400, error: expect.stringMatching(/timeoutMs/) });
      await app.close();
    });

    it("accepts a wait of exactly one remote chunk", async () => {
      const app = await buildApp();
      await spawn(app, "9218");
      const outputWait = await import("../../src/services/output-wait.js");
      const waitSpy = vi
        .spyOn(outputWait, "waitForOutput")
        .mockResolvedValue({ matched: false, timedOut: true });
      try {
        const res = await post(app, "9218", { match: "never", regex: false, timeoutMs: 60_000 });
        expect(res.statusCode).toBe(200);
        expect(waitSpy.mock.calls[0][1]).toBe(60_000);
      } finally {
        waitSpy.mockRestore();
      }
      await app.close();
    });

    it("rejects a request with the wrong token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9217/wait-output",
        headers: { authorization: "Bearer wrong" },
        payload: { match: "x", regex: false, timeoutMs: 100 },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });
});
