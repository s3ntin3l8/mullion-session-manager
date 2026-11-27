import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import {
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

describe("parent→child ops (sessions.children, owned targets)", () => {
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

  it("a parent can get and read the scrollback of its own child", async () => {
    app = await buildApp();
    await app.ready();
    const { hookToken } = await createRealSession(app!, ptyMock);
    const { childId } = await spawnChildOf(app!, hookToken);
    const socket = await sessionScopeSocket(app!, hookToken);
    const got = await ask(socket, "sessions.get", { sessionId: childId });
    expect(got.ok).toBe(true);
    expect((got.result as { id: number }).id).toBe(childId);
    const scrollback = await ask(socket, "sessions.scrollback", { sessionId: childId });
    expect(scrollback.ok).toBe(true);
    expect(typeof (scrollback.result as { b64: unknown }).b64).toBe("string");
    socket.destroy();
  });

  it("events.subscribe includeChildren streams the parent's and its children's events (incl. a child spawned after subscribing), never a sibling's", async () => {
    app = await buildApp();
    await app.ready();
    const { hookToken } = await createRealSession(app!, ptyMock);
    const parentPty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
    const { sessionId: otherId } = await createRealSession(app!, ptyMock);
    const otherPty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];

    const socket = await sessionScopeSocket(app!, hookToken);
    const frames = collectFrames(socket);
    socket.write(
      `${JSON.stringify({ id: 7, op: "events.subscribe", body: { includeChildren: true } })}\n`,
    );
    await waitUntil(() => frames.some((f) => f.ok === true));

    // Spawned AFTER the subscribe — only classifiable on its first event.
    const { childId } = await spawnChildOf(app!, hookToken);
    const childPty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];

    parentPty.emitData("\x1b]2;from-parent\x07");
    childPty.emitData("\x1b]2;from-child\x07");
    otherPty.emitData("\x1b]2;from-other\x07");
    // title_change is debounced at the source (3s).
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    await waitUntil(
      () =>
        frames.some((f) => f.kind === "title_change" && f.sessionId === childId) &&
        frames.some((f) => f.kind === "title_change" && f.sessionId !== childId),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const ids = new Set(frames.filter((f) => f.kind === "title_change").map((f) => f.sessionId));
    expect(ids.has(childId)).toBe(true);
    expect(ids.has(otherId)).toBe(false);
    socket.destroy();
  }, 15_000);

  it("events.subscribe includeChildren does not let the parent advance a child's read cursor (events.seen stays pinned to its own id)", async () => {
    app = await buildApp();
    await app.ready();
    const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
    const { childId } = await spawnChildOf(app!, hookToken);
    const markEventsSeenSpy = vi.spyOn(app.pty, "markEventsSeen");
    const socket = await sessionScopeSocket(app!, hookToken);
    const frames = collectFrames(socket);
    socket.write(
      `${JSON.stringify({ id: 7, op: "events.subscribe", body: { includeChildren: true } })}\n`,
    );
    await waitUntil(() => frames.some((f) => f.ok === true));
    socket.write(
      `${JSON.stringify({ id: 7, op: "events.seen", body: { sessionId: childId, seq: 5 } })}\n`,
    );
    socket.write(
      `${JSON.stringify({ id: 7, op: "events.seen", body: { sessionId: Number(sessionId), seq: 2 } })}\n`,
    );
    await waitUntil(() => markEventsSeenSpy.mock.calls.length > 0);
    expect(markEventsSeenSpy).toHaveBeenCalledTimes(1);
    expect(markEventsSeenSpy).toHaveBeenCalledWith(String(sessionId), 2);
    socket.destroy();
  });

  it("events.subscribe includeChildren is refused (403) once the caller's own row is no longer active", async () => {
    app = await buildApp();
    await app.ready();
    const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
    const socket = await sessionScopeSocket(app!, hookToken);
    app.db
      .update(sessions)
      .set({ status: "exited" })
      .where(eq(sessions.id, Number(sessionId)))
      .run();
    const reply = await ask(socket, "events.subscribe", { includeChildren: true });
    expect(reply).toMatchObject({ ok: false, status: 403 });
    socket.destroy();
  });

  it("a parent can still inspect a child that has exited", async () => {
    app = await buildApp();
    await app.ready();
    const { hookToken } = await createRealSession(app!, ptyMock);
    const { childId } = await spawnChildOf(app!, hookToken);
    app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, childId)).run();
    const socket = await sessionScopeSocket(app!, hookToken);
    const got = await ask(socket, "sessions.get", { sessionId: childId });
    expect(got.ok).toBe(true);
    socket.destroy();
  });

  it("a session cannot reach an unrelated session, a sibling's child, or a nonexistent id — all the same 403", async () => {
    app = await buildApp();
    await app.ready();
    const { hookToken } = await createRealSession(app!, ptyMock);
    const other = await createRealSession(app!, ptyMock);
    const { childId: otherChild } = await spawnChildOf(app!, other.hookToken);
    const socket = await sessionScopeSocket(app!, hookToken);
    for (const sessionId of [other.sessionId, otherChild, 999999, "not-a-number"]) {
      expect(await ask(socket, "sessions.get", { sessionId })).toEqual({ id: 1, ...NOT_MINE });
    }
    socket.destroy();
  });

  it("a child cannot reach its parent or a sibling", async () => {
    app = await buildApp();
    await app.ready();
    const { sessionId: parentId, hookToken } = await createRealSession(app!, ptyMock);
    const { childToken } = await spawnChildOf(app!, hookToken);
    const { childId: sibling } = await spawnChildOf(app!, hookToken);
    const socket = await sessionScopeSocket(app!, childToken);
    expect(await ask(socket, "sessions.get", { sessionId: parentId })).toEqual({
      id: 1,
      ...NOT_MINE,
    });
    expect(await ask(socket, "sessions.get", { sessionId: sibling })).toEqual({
      id: 1,
      ...NOT_MINE,
    });
    socket.destroy();
  });

  it("a parent whose own row is no longer active cannot reach its children", async () => {
    app = await buildApp();
    await app.ready();
    const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
    const { childId } = await spawnChildOf(app!, hookToken);
    const socket = await sessionScopeSocket(app!, hookToken);
    app.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, sessionId)).run();
    expect(await ask(socket, "sessions.get", { sessionId: childId })).toEqual({
      id: 1,
      ok: false,
      status: 403,
      error: "this session is no longer active",
    });
    socket.destroy();
  });

  it("sessions.kill: a parent kills its child; naming itself, a stranger, or nothing is 403", async () => {
    app = await buildApp();
    await app.ready();
    const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
    const { sessionId: stranger } = await createRealSession(app!, ptyMock);
    const { childId } = await spawnChildOf(app!, hookToken);
    const socket = await sessionScopeSocket(app!, hookToken);
    expect(await ask(socket, "sessions.kill", { sessionId })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await ask(socket, "sessions.kill")).toMatchObject({ ok: false, status: 403 });
    expect(await ask(socket, "sessions.kill", { sessionId: stranger })).toEqual({
      id: 1,
      ...NOT_MINE,
    });
    expect(
      await ask(socket, "sessions.kill", { sessionId: childId, cascade: "bogus" }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await ask(socket, "sessions.kill", { sessionId: childId })).toEqual({
      id: 1,
      ok: true,
      status: 204,
      result: "",
    });
    const row = app.db.select().from(sessions).where(eq(sessions.id, childId)).get();
    expect(row?.status).toBe("killed");
    socket.destroy();
  });

  it("sessions.children: session scope lists only its own children, with derived status", async () => {
    app = await buildApp();
    await app.ready();
    const { hookToken } = await createRealSession(app!, ptyMock);
    const other = await createRealSession(app!, ptyMock);
    const { childId: a } = await spawnChildOf(app!, hookToken);
    const { childId: b } = await spawnChildOf(app!, hookToken);
    await spawnChildOf(app!, other.hookToken);
    const socket = await sessionScopeSocket(app!, hookToken);
    const reply = await ask(socket, "sessions.children");
    expect(reply.ok).toBe(true);
    const rows = reply.result as Array<{ id: number; sessionStatus: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(rows.every((r) => typeof r.sessionStatus === "string")).toBe(true);
    socket.destroy();
  });

  it("sessions.children: a parent whose own row is no longer active gets 403", async () => {
    app = await buildApp();
    await app.ready();
    const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
    await spawnChildOf(app!, hookToken);
    const socket = await sessionScopeSocket(app!, hookToken);
    app.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, sessionId)).run();
    expect(await ask(socket, "sessions.children")).toEqual({
      id: 1,
      ok: false,
      status: 403,
      error: "this session is no longer active",
    });
    socket.destroy();
  });

  it("a non-canonical spelling of a child's id still resolves to that child only", async () => {
    app = await buildApp();
    await app.ready();
    const { hookToken } = await createRealSession(app!, ptyMock);
    const { childId } = await spawnChildOf(app!, hookToken);
    const socket = await sessionScopeSocket(app!, hookToken);
    const got = await ask(socket, "sessions.get", { sessionId: `0${childId}` });
    expect(got.ok).toBe(true);
    expect((got.result as { id: number }).id).toBe(childId);
    socket.destroy();
  });

  it("sessions.children: status filter, own-pin enforcement and full-scope parent naming", async () => {
    app = await buildApp();
    await app.ready();
    const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
    const other = await createRealSession(app!, ptyMock);
    const { childId: live } = await spawnChildOf(app!, hookToken);
    const { childId: dead } = await spawnChildOf(app!, hookToken);
    app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, dead)).run();

    const session = await sessionScopeSocket(app!, hookToken);
    const exited = await ask(session, "sessions.children", { status: "exited" });
    expect((exited.result as Array<{ id: number }>).map((r) => r.id)).toEqual([dead]);
    // Naming a different parent is the pinned-session 403, not a listing.
    expect(await ask(session, "sessions.children", { sessionId: other.sessionId })).toEqual({
      id: 1,
      ok: false,
      status: 403,
      error: "session-scoped connections may only target their own session",
    });
    session.destroy();

    const full = await fullScopeSocket(app!);
    expect(await ask(full, "sessions.children")).toMatchObject({ ok: false, status: 400 });
    const listed = await ask(full, "sessions.children", { sessionId });
    expect((listed.result as Array<{ id: number }>).map((r) => r.id).sort()).toEqual(
      [live, dead].sort(),
    );
    full.destroy();
  });

  it("tells open connections the server is restarting before it drops them (#2271)", async () => {
    app = await buildApp();
    await app.ready();
    const socket = await fullScopeSocket(app!);
    const frames = collectFrames(socket);
    const closing = app.close();
    app = null;
    await waitUntil(() => frames.length > 0);
    expect(frames[0]).toEqual({
      id: null,
      ok: false,
      fatal: true,
      status: 503,
      error: "server-restarting",
    });
    await closing;
    socket.destroy();
  });

  // Issue #2271 — a child's dtach master outlives a Mullion restart, but
  // PtyManager only tracks it again once something attaches. Dropping it
  // from PtyManager (kill() detaches without ending the program) is that
  // state; isMasterAliveState says what its scope is doing.
  describe("a child that survived a restart (#2271)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function survivor(liveness: "alive" | "dead" | "unknown") {
      const parent = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, parent.hookToken, "claude");
      app!.pty.kill(String(childId));
      expect(app!.pty.get(String(childId))).toBeUndefined();
      vi.spyOn(app!.pty, "isMasterAliveState").mockResolvedValue(liveness);
      const socket = await sessionScopeSocket(app!, parent.hookToken);
      return { ...parent, childId, socket };
    }

    it("sessions.prompt adopts a child whose scope is alive instead of answering 409", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await survivor("alive");
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({ ok: true, status: 200, result: { delivered: true } });
      expect(app.pty.get(String(childId))?.isAlive).toBe(true);
      socket.destroy();
    });

    it("sessions.children reports the adopted child as alive, not 'alive: false'", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await survivor("alive");
      const reply = await ask(socket, "sessions.children");
      const rows = reply.result as Array<{
        id: number;
        alive: boolean;
        stateRestored: boolean;
      }>;
      expect(rows.find((r) => r.id === childId)).toMatchObject({
        alive: true,
        stateRestored: true,
      });
      socket.destroy();
    });

    it("sessions.get adopts the child it is asked about", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await survivor("alive");
      const reply = await ask(socket, "sessions.get", { sessionId: childId });
      expect(reply.result).toMatchObject({ id: childId, alive: true });
      socket.destroy();
    });

    it("a child whose scope is gone is still 'not running' and is never respawned", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await survivor("dead");
      const getOrCreate = vi.spyOn(app.pty, "getOrCreate");
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "go" });
      expect(reply).toMatchObject({
        ok: false,
        status: 409,
        error: "the session is not running (it has no live process on its host)",
      });
      expect(getOrCreate).not.toHaveBeenCalled();
      const listed = await ask(socket, "sessions.children");
      expect(
        (listed.result as Array<{ id: number; alive: boolean }>).find((r) => r.id === childId),
      ).toMatchObject({ alive: false });
      socket.destroy();
    });

    it("a scope that cannot be checked answers a retryable 503, not 'not running'", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await survivor("unknown");
      const getOrCreate = vi.spyOn(app.pty, "getOrCreate");
      for (const [op, body] of [
        ["sessions.prompt", { text: "go" }],
        ["sessions.wait_for_output", { match: "x", timeoutMs: 1000 }],
        ["sessions.wait", { timeoutMs: 1000 }],
      ] as const) {
        const reply = await ask(socket, op, { sessionId: childId, ...body });
        expect(reply, op).toMatchObject({ ok: false, status: 503 });
        expect(String(reply.error)).toMatch(/retry/);
      }
      expect(getOrCreate).not.toHaveBeenCalled();
      socket.destroy();
    });
  });

  describe("sessions.wait_for_output", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const lastPty = () => ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];

    async function childWithSocket() {
      const parent = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, parent.hookToken);
      const pty = lastPty();
      const socket = await sessionScopeSocket(app!, parent.hookToken);
      return { ...parent, childId, pty, socket };
    }

    // Issue #1951 — a child on ANOTHER host is waited on through that
    // host (SessionBackend.waitOutput), not refused.
    async function remoteWaitChild(waitOutput: ReturnType<typeof vi.fn>) {
      const { childId, socket } = await childWithSocket();
      const hostRes = await seedHostResponse(app!, {
        name: "mac",
        baseUrl: "http://127.0.0.1:1",
        token: "t",
      });
      const hostId = hostRes.json().id as string;
      if (!hostId) throw new Error(`host create: ${hostRes.statusCode} ${hostRes.body}`);
      app!.db.update(sessions).set({ hostId }).where(eq(sessions.id, childId)).run();
      const realResolveBackend = sessionBackendModule.resolveBackend;
      vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation(((
        appArg: Parameters<typeof realResolveBackend>[0],
        host: string,
      ) =>
        host === hostId
          ? { waitOutput, prompt: vi.fn() }
          : realResolveBackend(
              appArg,
              host,
            )) as unknown as typeof sessionBackendModule.resolveBackend);
      return { childId, socket };
    }

    it("waits on the child's own host when it runs on another one (#1951)", async () => {
      app = await buildApp();
      await app.ready();
      const waitOutput = vi.fn().mockResolvedValue({
        matched: true,
        text: "BUILD OK",
        line: "BUILD OK",
        outputOffset: 55,
      });
      const { childId, socket } = await remoteWaitChild(waitOutput);
      const reply = await ask(socket, "sessions.wait_for_output", {
        sessionId: childId,
        match: "BUILD OK",
        afterOffset: 10,
      });
      expect(reply).toMatchObject({
        ok: true,
        status: 200,
        result: { matched: true, text: "BUILD OK", outputOffset: 55 },
      });
      expect(waitOutput).toHaveBeenCalledWith(
        String(childId),
        expect.objectContaining({ match: "BUILD OK", regex: false, afterOffset: 10 }),
      );
      socket.destroy();
    });

    it("relays a remote wait's failure and not-running outcomes (#1951)", async () => {
      app = await buildApp();
      await app.ready();
      const waitOutput = vi
        .fn()
        .mockResolvedValueOnce({ failed: true, status: 502, error: "host unreachable" })
        .mockResolvedValueOnce({ notRunning: true });
      const { childId, socket } = await remoteWaitChild(waitOutput);
      const failed = await ask(socket, "sessions.wait_for_output", {
        sessionId: childId,
        match: "x",
      });
      expect(failed).toMatchObject({ ok: false, status: 502, error: "host unreachable" });
      const notRunning = await ask(socket, "sessions.wait_for_output", {
        sessionId: childId,
        match: "x",
      });
      expect(notRunning).toMatchObject({ ok: false, status: 409 });
      socket.destroy();
    });

    it("resolves with the matching line when the child prints the text", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await childWithSocket();
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.wait_for_output", body: { sessionId: childId, match: "Tests: 5 passed" } })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      pty.emitData("\u001b[32mTests: 5 passed\u001b[0m (1.2s)\r\n");
      const reply = await waitForReply(socket);
      expect(reply).toMatchObject({
        ok: true,
        status: 200,
        result: { matched: true, text: "Tests: 5 passed", line: "Tests: 5 passed (1.2s)" },
      });
      socket.destroy();
    });

    it("afterOffset covers output printed between the prompt and the wait", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await childWithSocket();
      const offset = app.pty.get(String(childId))!.outputOffset;
      pty.emitData("early DONE marker\r\n"); // before the wait starts
      const reply = await ask(socket, "sessions.wait_for_output", {
        sessionId: childId,
        match: "DONE",
        afterOffset: offset,
      });
      expect(reply).toMatchObject({ ok: true, result: { matched: true, text: "DONE" } });
      // Without afterOffset the same earlier output does NOT count.
      const timedOut = await ask(socket, "sessions.wait_for_output", {
        sessionId: childId,
        match: "DONE",
        timeoutMs: 50,
      });
      expect(timedOut).toMatchObject({ ok: true, result: { matched: false, timedOut: true } });
      socket.destroy();
    });

    it("sessions.prompt returns the outputOffset to chain into the wait", async () => {
      app = await buildApp();
      await app.ready();
      const parent = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, parent.hookToken, "opencode");
      const socket = await sessionScopeSocket(app!, parent.hookToken);
      const reply = await ask(socket, "sessions.prompt", { sessionId: childId, text: "hi" });
      expect(typeof (reply.result as { outputOffset: unknown }).outputOffset).toBe("number");
      socket.destroy();
    });

    it("validates its arguments and rejects unsafe regexes", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, socket } = await childWithSocket();
      const bad = (body: Record<string, unknown>) =>
        ask(socket, "sessions.wait_for_output", { sessionId: childId, ...body });
      expect(await bad({})).toMatchObject({ ok: false, status: 400 });
      expect(await bad({ match: "x".repeat(300) })).toMatchObject({ ok: false, status: 400 });
      expect(await bad({ match: "x", timeoutMs: -1 })).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(await bad({ match: "x", afterOffset: -1 })).toMatchObject({
        ok: false,
        status: 400,
      });
      for (const afterSeq of [-1, "3"]) {
        expect(await bad({ match: "x", afterSeq })).toMatchObject({ ok: false, status: 400 });
      }
      for (const match of ["(a+)+$", "(a)\\1", "(?=a)b", "("]) {
        expect(await bad({ match, regex: true })).toMatchObject({ ok: false, status: 400 });
      }
      socket.destroy();
    });

    it("is children-only: self, a stranger and a missing target are all 403", async () => {
      app = await buildApp();
      await app.ready();
      const mine = await createRealSession(app!, ptyMock);
      const stranger = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, mine.hookToken);
      for (const body of [{}, { sessionId: mine.sessionId }, { sessionId: stranger.sessionId }]) {
        expect(
          await ask(socket, "sessions.wait_for_output", { ...body, match: "x" }),
        ).toMatchObject({ ok: false, status: 403 });
      }
      socket.destroy();
    });

    it("aborts and releases its slot when the socket closes mid-wait", async () => {
      app = await buildApp();
      await app.ready();
      const { childId, pty, socket } = await childWithSocket();
      const listenersBefore = pty.dataListeners.length;
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.wait_for_output", body: { sessionId: childId, match: "never" } })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      socket.destroy();
      // The engine unsubscribed (Session.onData's dispose), so a later chunk is a no-op.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => pty.emitData("never")).not.toThrow();
      expect(listenersBefore).toBeGreaterThan(0);
    });
  });

  describe("sessions.wait", () => {
    const ANY = ["busy", "dormant", "waiting", "done", "blocked", "failed", "gone"];

    it("a parent waits on its child; returns the derived status and the child's eventSeq", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, hookToken);
      const socket = await sessionScopeSocket(app!, hookToken);
      const reply = await ask(socket, "sessions.wait", { sessionId: childId, until: ANY });
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({
        timedOut: false,
        status: expect.any(String),
        severity: expect.any(String),
        eventSeq: expect.any(Number),
      });
      socket.destroy();
    });

    it("times out with timedOut:true when the status never matches", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, hookToken);
      const socket = await sessionScopeSocket(app!, hookToken);
      const reply = await ask(socket, "sessions.wait", {
        sessionId: childId,
        until: ["awaiting_elicitation"],
        timeoutMs: 100,
      });
      expect(reply.ok).toBe(true);
      expect(reply.result).toMatchObject({ timedOut: true });
      socket.destroy();
    });

    it("afterSeq equal to the child's current head holds a match back; a stale (ahead) cursor is ignored", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, hookToken);
      const socket = await sessionScopeSocket(app!, hookToken);
      const first = await ask(socket, "sessions.wait", { sessionId: childId, until: ANY });
      const head = (first.result as { eventSeq: number }).eventSeq;
      const held = await ask(socket, "sessions.wait", {
        sessionId: childId,
        until: ANY,
        afterSeq: head,
        timeoutMs: 100,
      });
      expect(held.result).toMatchObject({ timedOut: true });
      const stale = await ask(socket, "sessions.wait", {
        sessionId: childId,
        until: ANY,
        afterSeq: head + 1_000_000,
        timeoutMs: 5_000,
      });
      expect(stale.result).toMatchObject({ timedOut: false });
      socket.destroy();
    });

    it("caps pending waits per connection with a 429", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, hookToken);
      const socket = await sessionScopeSocket(app!, hookToken);
      const frames = collectFrames(socket);
      for (let id = 1; id <= 5; id++) {
        socket.write(
          `${JSON.stringify({ id, op: "sessions.wait", body: { sessionId: childId, until: ["awaiting_elicitation"], timeoutMs: 60_000 } })}\n`,
        );
      }
      await waitUntil(() => frames.some((f) => f.id === 5));
      expect(frames.find((f) => f.id === 5)).toMatchObject({ ok: false, status: 429 });
      // The first four are still pending (no replies).
      expect(frames.filter((f) => f.id !== 5)).toEqual([]);
      socket.destroy();
    });

    it("ends a pending wait with 403 once the waiting parent is no longer active", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, hookToken);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.wait", body: { sessionId: childId, until: ["awaiting_elicitation"], timeoutMs: 60_000 } })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      app.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, sessionId)).run();
      const reply = await waitForReply(socket);
      expect(reply).toMatchObject({ ok: false, status: 403 });
      socket.destroy();
    });

    it("a wait on an exited child resolves as gone regardless of afterSeq", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, hookToken);
      app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, childId)).run();
      const socket = await sessionScopeSocket(app!, hookToken);
      const reply = await ask(socket, "sessions.wait", {
        sessionId: childId,
        afterSeq: 1_000_000,
        timeoutMs: 5_000,
      });
      expect(reply.result).toMatchObject({ severity: "gone", timedOut: false });
      socket.destroy();
    });

    it("rejects bad arguments with 400", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, hookToken);
      const socket = await sessionScopeSocket(app!, hookToken);
      for (const extra of [
        { until: [] },
        { until: ["bogus"] },
        { timeoutMs: -1 },
        { timeoutMs: "5" },
        { afterSeq: -1 },
        { afterSeq: 1.5 },
      ]) {
        expect(await ask(socket, "sessions.wait", { sessionId: childId, ...extra })).toMatchObject({
          ok: false,
          status: 400,
        });
      }
      socket.destroy();
    });

    it("session scope may not wait on itself, a stranger, or nothing", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: stranger } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      expect(await ask(socket, "sessions.wait", { sessionId })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(await ask(socket, "sessions.wait")).toMatchObject({ ok: false, status: 403 });
      expect(await ask(socket, "sessions.wait", { sessionId: stranger })).toEqual({
        id: 1,
        ...NOT_MINE,
      });
      socket.destroy();
    });

    it("full scope: waits on any session by id; 400 without one", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const full = await fullScopeSocket(app!);
      expect(await ask(full, "sessions.wait")).toMatchObject({ ok: false, status: 400 });
      const reply = await ask(full, "sessions.wait", { sessionId, until: ANY });
      expect(reply.result).toMatchObject({ timedOut: false });
      full.destroy();
    });

    it("full scope: a nonexistent session is a 404", async () => {
      app = await buildApp();
      await app.ready();
      const full = await fullScopeSocket(app!);
      expect(await ask(full, "sessions.wait", { sessionId: 999999 })).toMatchObject({
        ok: false,
        status: 404,
      });
      full.destroy();
    });

    it("a closed connection abandons the wait without error or reply", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { childId } = await spawnChildOf(app!, hookToken);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.wait", body: { sessionId: childId, until: ["awaiting_elicitation"] } })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Server still serves a fresh connection normally.
      const again = await sessionScopeSocket(app!, hookToken);
      expect((await ask(again, "sessions.get")).ok).toBe(true);
      again.destroy();
    });
  });

  it("events.query: a parent may name its child's id, a stranger's is 403", async () => {
    app = await buildApp();
    await app.ready();
    const { hookToken } = await createRealSession(app!, ptyMock);
    const { sessionId: stranger } = await createRealSession(app!, ptyMock);
    const { childId } = await spawnChildOf(app!, hookToken);
    const socket = await sessionScopeSocket(app!, hookToken);
    expect((await ask(socket, "events.query", { sessionId: childId })).ok).toBe(true);
    expect(await ask(socket, "events.query", { sessionId: stranger })).toEqual({
      id: 1,
      ...NOT_MINE,
    });
    socket.destroy();
  });
});
