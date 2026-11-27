import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import {
  type FakePty,
  createControlSocketPtyMock,
  mockControlSocketChildProcess,
  NOT_MINE,
  waitForReply,
  waitUntil,
  collectFrames,
  cleanupControlSocketEnv,
  enableControlSocketAuthEnv,
  createRealSession,
  fullScopeSocket,
  sessionScopeSocket,
  spawnChildOf,
  ask,
} from "../helpers/control-socket.js";
import { seedHostResponse } from "../helpers/hosts.js";

const ptyMock = createControlSocketPtyMock();
vi.mock("../../src/services/hook-adapters/codex-trust.js", () => ({
  getCodexHookTrust: () => "pending" as const,
}));
vi.mock("../../src/services/bundle-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBundleSyncedFor: () => false,
}));
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) =>
  mockControlSocketChildProcess(await importOriginal<typeof ChildProcess>()),
);

const { buildApp } = await import("../../src/app.js");
const { sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const sessionBackendModule = await import("../../src/services/session-backend.js");

describe("parent→child ops: sessions.prompt", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  beforeEach(() => {
    enableControlSocketAuthEnv();
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    ptyMock.spawnedPtys.length = 0;
    cleanupControlSocketEnv();
  });

  describe("sessions.prompt", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });
    /** The FakePty of the most recently spawned session (the child just created). */
    const lastPty = () => ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
    const writes = (pty: FakePty) => pty.writeSpy.mock.calls.map(([d]) => d as string);
    const PASTE = "\u001b[200~";
    const PASTE_END = "\u001b[201~";

    async function agentChild(command = "claude") {
      const parent = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, parent.hookToken, command);
      const pty = lastPty();
      const socket = await sessionScopeSocket(app!, parent.hookToken);
      return { ...parent, childId, pty, socket };
    }

    // Issue #1951 — a child on ANOTHER host: its PTY is there, so the
    // delivery is proxied to that host through SessionBackend.prompt.
    async function remoteChild(
      prompt: ReturnType<typeof vi.fn>,
      // What the child's host reports on its Nth live-status read (#1962).
      // Reads past the end of the script repeat the last entry.
      // An `Error` entry is a host that does not answer that read.
      liveScript: Array<Record<string, unknown> | Error> = [{ alive: true }],
    ) {
      const { childId, socket, pty } = await agentChild();
      const hostRes = await seedHostResponse(app!, {
        name: "mac",
        baseUrl: "http://127.0.0.1:1",
        token: "t",
      });
      const hostId = hostRes.json().id as string;
      if (!hostId) throw new Error(`host create: ${hostRes.statusCode} ${hostRes.body}`);
      app!.db.update(sessions).set({ hostId }).where(eq(sessions.id, childId)).run();
      let liveReads = 0;
      const backend = {
        prompt,
        waitOutput: vi.fn(),
        liveStatus: vi.fn(async (..._args: unknown[]) => {
          const info = liveScript[Math.min(liveReads, liveScript.length - 1)];
          liveReads += 1;
          if (info instanceof Error) throw info;
          return { [String(childId)]: info };
        }),
      };
      const realResolveBackend = sessionBackendModule.resolveBackend;
      vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation(((
        appArg: Parameters<typeof realResolveBackend>[0],
        host: string,
      ) =>
        host === hostId
          ? backend
          : realResolveBackend(
              appArg,
              host,
            )) as unknown as typeof sessionBackendModule.resolveBackend);
      return { childId, socket, pty, backend, hostId };
    }

    it("proxies the prompt to the child's own host instead of 409ing (#1951)", async () => {
      app = await buildApp();
      await app.ready();
      const prompt = vi.fn().mockResolvedValue({ ok: true, outputOffset: 123 });
      const { childId, socket, pty, hostId } = await remoteChild(prompt);
      pty.writeSpy.mockClear();
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({
        ok: true,
        status: 200,
        result: { delivered: true, submitted: true, outputOffset: 123 },
      });
      expect(prompt).toHaveBeenCalledWith(String(childId), { text: "go", submit: true });
      // Nothing was typed into the PRIMARY's own (stale) PTY for that id.
      expect(writes(pty)).toEqual([]);
      void hostId;
      socket.destroy();
    });

    it("relays a remote refusal's status and message (#1951)", async () => {
      app = await buildApp();
      await app.ready();
      const prompt = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 501, error: "no framing for that agent" });
      const { childId, socket } = await remoteChild(prompt);
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({
        ok: false,
        status: 501,
        error: "no framing for that agent",
      });
      socket.destroy();
    });

    it("waits on a remote child's NEXT turn, not the previous turn's `finished` (#1962)", async () => {
      app = await buildApp();
      await app.ready();
      const prompt = vi.fn().mockResolvedValue({ ok: true, outputOffset: 5, afterSeq: 7 });
      const previousTurn = { alive: true, lastTurnEndedAt: 1, eventSeqHead: 7 };
      const { childId, socket, backend } = await remoteChild(prompt, [
        previousTurn, // the pre-prompt gate
        previousTurn, // first wait read: still the old turn's `finished` -> guard holds
        { alive: true, activity: "working", eventSeqHead: 9, agentTurnInFlight: true },
        { alive: true, lastTurnEndedAt: 2, eventSeqHead: 10 },
      ]);
      const reply = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "go",
        wait: { until: ["done"], timeoutMs: 20_000 },
      });
      expect(reply).toMatchObject({
        ok: true,
        result: {
          delivered: true,
          outputOffset: 5,
          wait: { timedOut: false, status: "finished", severity: "done", eventSeq: 10 },
        },
      });
      // The guard was armed and held, so nothing is flagged.
      expect(reply.result).not.toHaveProperty("wait.guardDisabled");
      // Every read the prompt/wait made went around the 1.5 s cache.
      expect(backend.liveStatus).toHaveBeenCalledTimes(4);
      for (const call of backend.liveStatus.mock.calls) {
        expect(call[3]).toEqual({ fresh: true });
      }
      socket.destroy();
    }, 30_000);

    it("refuses a remote `wait` with agent_busy while the child's prompted turn is in flight (#1962)", async () => {
      app = await buildApp();
      await app.ready();
      const prompt = vi.fn();
      const { childId, socket } = await remoteChild(prompt, [
        { alive: true, agentTurnInFlight: true, eventSeqHead: 3 },
      ]);
      const reply = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "go",
        wait: true,
      });
      expect(reply).toMatchObject({ ok: false, status: 409 });
      expect(String(reply.error)).toMatch(/agent_busy/);
      expect(prompt).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("runs a remote wait without the new-turn guard when the agent reports no event head (#1962)", async () => {
      app = await buildApp();
      await app.ready();
      // An agent build that predates the field: `afterSeq` is absent from
      // the prompt reply AND `eventSeqHead` from its live info. The guard
      // must be OFF, not stuck closed — this wait would otherwise hang.
      const prompt = vi.fn().mockResolvedValue({ ok: true, outputOffset: 1 });
      const { childId, socket } = await remoteChild(prompt, [{ alive: true, lastTurnEndedAt: 1 }]);
      const reply = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "go",
        wait: { until: ["done"], timeoutMs: 5_000 },
      });
      // ...and the reply says so, so the caller can cross-check.
      expect(reply).toMatchObject({
        ok: true,
        result: {
          delivered: true,
          wait: { timedOut: false, status: "finished", guardDisabled: true },
        },
      });
      socket.destroy();
    });

    it("reports a wait on a host that stops answering as suspended, not as a failure (#1962)", async () => {
      app = await buildApp();
      await app.ready();
      const prompt = vi.fn().mockResolvedValue({ ok: true, outputOffset: 1, afterSeq: 7 });
      // Answers the pre-prompt gate, then goes dark.
      const { childId, socket } = await remoteChild(prompt, [
        { alive: true, lastTurnEndedAt: 1, eventSeqHead: 7 },
        new Error("ECONNREFUSED"),
      ]);
      const reply = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "go",
        wait: { until: ["done"], timeoutMs: 1_500 },
      });
      // The prompt WAS delivered; the wait times out reporting the status
      // the REST path would (host unreachable — may still be running).
      expect(reply).toMatchObject({
        ok: true,
        result: { delivered: true, wait: { timedOut: true, status: "suspended" } },
      });
      socket.destroy();
    }, 15_000);

    it("answers 500 with the host's own error when it ANSWERS the pre-check with a refusal (#1962)", async () => {
      app = await buildApp();
      await app.ready();
      const { HostRequestError } = await import("../../src/services/remote-host-client.js");
      const prompt = vi.fn();
      // A 429 from the agent's rate limit: reachable, and saying no.
      const { childId, socket } = await remoteChild(prompt, [
        new HostRequestError("mac", 429, "Too Many Requests"),
      ]);
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({ ok: false, status: 500 });
      expect(String(reply.error)).toMatch(/429/);
      expect(prompt).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("ends a remote wait with the host's refusal rather than reporting it suspended until the timeout (#1962)", async () => {
      app = await buildApp();
      await app.ready();
      const { HostRequestError } = await import("../../src/services/remote-host-client.js");
      const prompt = vi.fn().mockResolvedValue({ ok: true, outputOffset: 1, afterSeq: 7 });
      const refusal = new HostRequestError("mac", 429, "Too Many Requests");
      const { childId, socket } = await remoteChild(prompt, [
        { alive: true, lastTurnEndedAt: 1, eventSeqHead: 7 },
        refusal,
      ]);
      const reply = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "go",
        wait: { until: ["done"], timeoutMs: 60_000 },
      });
      // The prompt was delivered; the wait gave up on the third failed read
      // with the real reason, in seconds - not after its 60 s timeout.
      expect(reply).toMatchObject({
        ok: true,
        result: { delivered: true, wait: { status: 500 } },
      });
      expect(String((reply.result as { wait: { error: string } }).wait.error)).toMatch(/429/);
      socket.destroy();
    }, 20_000);

    it("treats an event head that moved BACKWARDS (the agent restarted) as a new turn (#1962)", async () => {
      app = await buildApp();
      await app.ready();
      const prompt = vi.fn().mockResolvedValue({ ok: true, outputOffset: 1, afterSeq: 40 });
      const { childId, socket } = await remoteChild(prompt, [
        { alive: true, lastTurnEndedAt: 1, eventSeqHead: 40 },
        { alive: true, lastTurnEndedAt: 1, eventSeqHead: 40 },
        // The counter is not persisted: a restarted agent starts over.
        { alive: true, lastTurnEndedAt: 2, eventSeqHead: 3 },
      ]);
      const reply = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "go",
        wait: { until: ["done"], timeoutMs: 20_000 },
      });
      expect(reply).toMatchObject({
        ok: true,
        result: { wait: { timedOut: false, status: "finished", eventSeq: 3 } },
      });
      socket.destroy();
    }, 30_000);

    it("reports eventSeq 0, not a stand-in, when the host never reports a head (#1962)", async () => {
      app = await buildApp();
      await app.ready();
      const prompt = vi.fn().mockResolvedValue({ ok: true, outputOffset: 1, afterSeq: 4 });
      const { childId, socket } = await remoteChild(prompt, [{ alive: true, lastTurnEndedAt: 1 }]);
      const reply = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "go",
        wait: { until: ["done"], timeoutMs: 5_000 },
      });
      expect(reply).toMatchObject({ ok: true, result: { wait: { eventSeq: 0 } } });
      socket.destroy();
    });

    it("keeps the guard off when the prompt reply carries an afterSeq but the live info no head (#1962)", async () => {
      app = await buildApp();
      await app.ready();
      const prompt = vi.fn().mockResolvedValue({ ok: true, outputOffset: 1, afterSeq: 4 });
      const { childId, socket } = await remoteChild(prompt, [{ alive: true, lastTurnEndedAt: 1 }]);
      const reply = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "go",
        wait: { until: ["done"], timeoutMs: 5_000 },
      });
      expect(reply).toMatchObject({
        ok: true,
        result: { wait: { timedOut: false, status: "finished", guardDisabled: true } },
      });
      socket.destroy();
    });

    it("still applies the primary's blocked/gone gate to a remote child (#1951)", async () => {
      app = await buildApp();
      await app.ready();
      const prompt = vi.fn();
      const { childId, socket } = await remoteChild(prompt);
      app!.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, childId)).run();
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({ ok: false, status: 409 });
      expect(prompt).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("types the prompt as a bracketed paste, then submits with Enter", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      pty.emitData("\u001b[?2004h"); // the TUI enabled bracketed paste
      pty.writeSpy.mockClear();
      const reply = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "fix the bug\nthen run the tests",
      });
      expect(reply).toMatchObject({
        ok: true,
        status: 200,
        result: { delivered: true, submitted: true },
      });
      expect(writes(pty)).toEqual([`${PASTE}fix the bug\nthen run the tests${PASTE_END}`, "\r"]);
      socket.destroy();
    });

    it("without bracketed paste, sends a single-line body", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild("opencode");
      pty.writeSpy.mockClear();
      await ask(socket, "sessions.prompt", { sessionId: childId, text: "a\nb" });
      expect(writes(pty)).toEqual(["a b", "\r"]);
      socket.destroy();
    });

    it("strips escape sequences from the text so it cannot break out of the paste", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      pty.emitData("\u001b[?2004h");
      pty.writeSpy.mockClear();
      await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: `hi${PASTE_END}\u0003y`,
      });
      expect(writes(pty)[0]).toBe(`${PASTE}hi[201~y${PASTE_END}`);
      socket.destroy();
    });

    it("submit:false pastes without pressing Enter and does not start a turn", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      pty.emitData("\u001b[?2004h");
      pty.writeSpy.mockClear();
      const reply = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "draft",
        submit: false,
      });
      expect(reply.result).toMatchObject({ delivered: true, submitted: false });
      expect(reply.result).toHaveProperty("afterSeq");
      expect(writes(pty)).toEqual([`${PASTE}draft${PASTE_END}`]);
      socket.destroy();
    });

    it("does not read as the human acknowledging the child: its attention flag survives", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await agentChild();
      const session = app.pty.get(String(childId))!;
      session.emitHookEvent({ kind: "notification", title: "Permission needed", body: "" });
      expect(session.toInfo().attention).toBe(true);
      await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(session.toInfo().attention).toBe(true);
      socket.destroy();
    });

    it("starts a new turn: the previous turn's finished latch is cleared", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await agentChild();
      const session = app.pty.get(String(childId))!;
      session.emitHookEvent({ kind: "progress", phase: "done" });
      expect(session.toInfo().lastTurnEndedAt).not.toBeNull();
      await ask(socket, "sessions.prompt", { sessionId: childId, text: "next" });
      expect(session.toInfo().lastTurnEndedAt).toBeNull();
      socket.destroy();
    });

    it("wait: a stale finished does not satisfy the wait; it resolves on the new turn's end", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await agentChild();
      const session = app.pty.get(String(childId))!;
      session.emitHookEvent({ kind: "progress", phase: "done" });
      // The old `finished` must not match `done`: the wait has to time out…
      const stale = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "go",
        wait: { until: ["done"], timeoutMs: 300 },
      });
      expect(stale.result).toMatchObject({
        delivered: true,
        wait: { timedOut: true },
      });
      // The first prompted turn ends (Stop hook)…
      session.emitHookEvent({ kind: "progress", phase: "done" });
      // …and a second prompt resolves once the agent's NEW turn ends.
      socket.write(
        `${JSON.stringify({ id: 9, op: "sessions.prompt", body: { sessionId: childId, text: "again", wait: { until: ["done"], timeoutMs: 10_000 } } })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      session.emitHookEvent({ kind: "progress", phase: "done" });
      const done = await waitForReply(socket);
      expect(done.result).toMatchObject({
        delivered: true,
        wait: { timedOut: false, status: "finished", severity: "done" },
      });
      socket.destroy();
    });

    it("wait:true uses the wait defaults", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await agentChild();
      const session = app.pty.get(String(childId))!;
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.prompt", body: { sessionId: childId, text: "go", wait: true } })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      session.emitHookEvent({ kind: "progress", phase: "done" });
      const reply = await waitForReply(socket);
      expect(reply.result).toMatchObject({ delivered: true, wait: { timedOut: false } });
      socket.destroy();
    });

    it("409 agent_blocked while the child is waiting on a permission dialog — and nothing is typed", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      const session = app.pty.get(String(childId))!;
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "Run ls" });
      pty.writeSpy.mockClear();
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({ ok: false, status: 409 });
      expect(reply.error).toMatch(/^agent_blocked: /);
      expect(pty.writeSpy).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("a dialog that appears between the paste and the Enter is NOT answered", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      const session = app.pty.get(String(childId))!;
      pty.emitData("\u001b[?2004h");
      pty.writeSpy.mockClear();
      // The agent raises a permission dialog right after the paste lands.
      pty.writeSpy.mockImplementationOnce(() => {
        session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "Run ls" });
      });
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({ ok: false, status: 409 });
      expect(reply.error).toMatch(/^agent_blocked: .*NOT submitted/);
      expect(writes(pty)).toEqual([`${PASTE}go${PASTE_END}`]); // no "\r"
      socket.destroy();
    });

    it("serializes concurrent prompts to one child (no interleaved bodies and Enters)", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      const other = await fullScopeSocket(app!);
      pty.emitData("\u001b[?2004h");
      pty.writeSpy.mockClear();
      const frames = collectFrames(socket);
      const otherFrames = collectFrames(other);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.prompt", body: { sessionId: childId, text: "AAA" } })}\n`,
      );
      other.write(
        `${JSON.stringify({ id: 2, op: "sessions.prompt", body: { sessionId: childId, text: "BBB" } })}\n`,
      );
      await vi.waitFor(() => expect([frames.length, otherFrames.length]).toEqual([1, 1]), {
        timeout: 3_000,
      });
      const seq = writes(pty);
      expect(seq).toHaveLength(4);
      // Each body is immediately followed by its own Enter.
      expect(seq[1]).toBe("\r");
      expect(seq[3]).toBe("\r");
      expect(new Set([seq[0], seq[2]])).toEqual(
        new Set([`${PASTE}AAA${PASTE_END}`, `${PASTE}BBB${PASTE_END}`]),
      );
      socket.destroy();
      other.destroy();
    });

    it("text that sanitizes to nothing is rejected, not turned into a bare Enter", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      pty.writeSpy.mockClear();
      for (const text of ["\u001b", "\u0003\u009b", " \u202e "]) {
        expect(await ask(socket, "sessions.prompt", { sessionId: childId, text })).toMatchObject({
          ok: false,
          status: 400,
        });
      }
      expect(pty.writeSpy).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("409 agent_busy for prompt+wait while the child is mid-turn; a plain prompt (queued) is still allowed", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      const session = app.pty.get(String(childId))!;
      // A running subagent == status "subagent" (severity busy).
      session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
      pty.writeSpy.mockClear();
      const refused = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "go",
        wait: true,
      });
      expect(refused).toMatchObject({ ok: false, status: 409 });
      expect(refused.error).toMatch(/^agent_busy: /);
      // Busy because of a running subagent, not a prompted turn: the message must not claim one.
      expect(refused.error).not.toMatch(/in flight/);
      expect(pty.writeSpy).not.toHaveBeenCalled();
      const queued = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(queued).toMatchObject({ ok: true, result: { delivered: true, submitted: true } });
      socket.destroy();
    });

    it("a second prompt+wait is refused (agent_busy) while the first prompted turn is still in flight, then allowed once it ends", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      const session = app.pty.get(String(childId))!;
      // Turn A: a plain prompt (no wait). The child still reads idle — it
      // has produced no sustained output yet — but a turn is in flight.
      expect(
        await ask(socket, "sessions.prompt", { sessionId: childId, text: "turn A" }),
      ).toMatchObject({ ok: true });
      expect(session.agentTurnInFlight).toBe(true);
      pty.writeSpy.mockClear();
      const refused = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "turn B",
        wait: true,
      });
      expect(refused).toMatchObject({ ok: false, status: 409 });
      expect(refused.error).toMatch(/^agent_busy: .*prompted turn still in flight/);
      expect(pty.writeSpy).not.toHaveBeenCalled();
      // Turn A ends (Stop hook): the child is free again.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      expect(session.agentTurnInFlight).toBe(false);
      const allowed = await ask(socket, "sessions.prompt", {
        sessionId: childId,
        text: "turn B",
        wait: { until: ["awaiting_elicitation"], timeoutMs: 100 },
      });
      expect(allowed.result).toMatchObject({ delivered: true, wait: { timedOut: true } });
      socket.destroy();
    });

    it("409 agent_gone for an exited child", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, childId)).run();
      pty.writeSpy.mockClear();
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({ ok: false, status: 409 });
      expect(reply.error).toMatch(/^agent_gone: /);
      expect(pty.writeSpy).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("409 when the child's process is no longer running", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      for (const cb of pty.exitListeners) cb({ exitCode: 0 });
      pty.writeSpy.mockClear();
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({ ok: false, status: 409 });
      expect(pty.writeSpy).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("501 for a plain shell child, and nothing is typed", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild("bash");
      pty.writeSpy.mockClear();
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({ ok: false, status: 501 });
      expect(pty.writeSpy).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("503 when the write is dropped by backpressure", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await agentChild();
      const session = app.pty.get(String(childId))!;
      session.writeAgentInput("a".repeat(4 * 1024 * 1024)); // fills this window's cap
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({ ok: false, status: 503 });
      socket.destroy();
    });

    it("validates arguments before touching the child", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      pty.writeSpy.mockClear();
      const big = "x".repeat(32 * 1024 + 1);
      const cases: Array<[Record<string, unknown>, number]> = [
        [{}, 400],
        [{ text: "" }, 400],
        [{ text: "   " }, 400],
        [{ text: 5 }, 400],
        [{ text: big }, 413],
        [{ text: "go", submit: "yes" }, 400],
        [{ text: "go", submit: false, wait: true }, 400],
        [{ text: "go", wait: null }, 400],
        [{ text: "go", wait: 0 }, 400],
        [{ text: "go", wait: [] }, 400],
        [{ text: "go", wait: "yes" }, 400],
        [{ text: "go", wait: { until: ["bogus"] } }, 400],
        [{ text: "go", wait: { timeoutMs: -1 } }, 400],
      ];
      for (const [extra, status] of cases) {
        expect(
          await ask(socket, "sessions.prompt", { sessionId: childId, ...extra }),
        ).toMatchObject({ ok: false, status });
      }
      expect(pty.writeSpy).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("session scope may only prompt its own children — not itself, a stranger, or nothing", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, socket } = await agentChild();
      const stranger = await createRealSession(app!, ptyMock);
      expect(await ask(socket, "sessions.prompt", { sessionId, text: "go" })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(await ask(socket, "sessions.prompt", { text: "go" })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(
        await ask(socket, "sessions.prompt", { sessionId: stranger.sessionId, text: "go" }),
      ).toEqual({ id: 1, ...NOT_MINE });
      socket.destroy();
    });

    it("full scope can prompt any live agent session by id", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      socket.destroy();
      const full = await fullScopeSocket(app!);
      pty.writeSpy.mockClear();
      const reply = await ask(full, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply.ok).toBe(true);
      expect(writes(pty).at(-1)).toBe("\r");
      full.destroy();
    });

    it("the cap on pending waits applies to prompt+wait (429, nothing typed)", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await agentChild();
      const frames = collectFrames(socket);
      for (let id = 1; id <= 4; id++) {
        socket.write(
          `${JSON.stringify({ id, op: "sessions.wait", body: { sessionId: childId, until: ["awaiting_elicitation"], timeoutMs: 60_000 } })}\n`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      pty.writeSpy.mockClear();
      socket.write(
        `${JSON.stringify({ id: 5, op: "sessions.prompt", body: { sessionId: childId, text: "go", wait: true } })}\n`,
      );
      await waitUntil(() => frames.some((f) => f.id === 5));
      expect(frames.find((f) => f.id === 5)).toMatchObject({ ok: false, status: 429 });
      expect(pty.writeSpy).not.toHaveBeenCalled();
      socket.destroy();
    });
  });
});
