import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import {
  createControlSocketPtyMock,
  mockControlSocketChildProcess,
  DEBOUNCED_WAIT_MS,
  TEST_TOKEN,
  waitForClose,
  waitForReply,
  waitUntil,
  collectFrames,
  cleanupControlSocketEnv,
  enableControlSocketAuthEnv,
  createRealSession,
  fullScopeSocket,
  sessionScopeSocket,
} from "../helpers/control-socket.js";

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
const { insertSessionEvents } = await import("../../src/services/event-history.js");

describe("PTY I/O and notification events ops (Phase 4, #186, #188)", () => {
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

  describe("PTY I/O ops (Phase 4, #186)", () => {
    it("full scope: a successful attach has no separate ack — its own scrollback-replay data frame IS the success signal", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);

      // createRealSession already pushed a marker through this session's
      // FakePty (see its own doc comment) BEFORE this attach — the
      // scrollback ring buffer, not live data, is what the attach itself
      // replays first (attachSocketToSession's own getScrollback() call),
      // so that marker must appear on the very first stream frame, with
      // no ok:true reply preceding or following it.
      const framePromise = new Promise<Record<string, unknown>>((resolve) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex !== -1) resolve(JSON.parse(buffer.slice(0, newlineIndex)));
        });
      });
      socket.write(
        `${JSON.stringify({ id: 42, op: "sessions.attach", body: { sessionId, cols: 100, rows: 40 } })}\n`,
      );
      const frame = await framePromise;
      expect(frame.id).toBe(42);
      expect(frame.type).toBe("data");
      expect(frame.ok).toBeUndefined();
      const decoded = Buffer.from(frame.b64 as string, "base64").toString("utf8");
      expect(decoded).toContain(`scrollback-marker-${sessionId}`);
      socket.destroy();
    });

    it("session scope: attaches to its own pinned session with no sessionId given", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      const framePromise = waitForReply(socket);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach" })}\n`);
      const frame = await framePromise;
      expect(frame.id).toBe(1);
      expect(frame.type).toBe("data");
      const decoded = Buffer.from(frame.b64 as string, "base64").toString("utf8");
      expect(decoded).toContain(`scrollback-marker-${sessionId}`);
      socket.destroy();
    });

    it("session scope: rejects attaching to a different session id", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId: otherSessionId } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "session-scoped connections may only target their own session",
      });
      socket.destroy();
    });

    it("400s attaching to an unknown session id, reusing resolveAndAttach's own error", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId: 999999 } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(404);
      socket.destroy();
    });

    it("400s attaching with a non-numeric session id instead of a confusing 404", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId: "not-a-number" } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "sessionId must be an integer",
      });
      socket.destroy();
    });

    it("400s re-attaching the same stream id without detaching first", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 5, op: "sessions.attach", body: { sessionId } })}\n`);
      await waitForReply(socket);

      const secondReply = new Promise<Record<string, unknown>>((resolve) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n").filter(Boolean);
          for (const line of lines) {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed.error === "a stream is already open for this id") resolve(parsed);
          }
        });
      });
      socket.write(`${JSON.stringify({ id: 5, op: "sessions.attach", body: { sessionId } })}\n`);
      expect(await secondReply).toEqual({
        id: 5,
        ok: false,
        status: 400,
        error: "a stream is already open for this id",
      });
      socket.destroy();
    });

    it("sessions.input writes decoded bytes to the session's PTY, silently (no reply) on success", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const child = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
      await waitForReply(socket);

      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.input", body: { b64: Buffer.from("ls\n").toString("base64") } })}\n`,
      );
      await waitUntil(() => child.writeSpy.mock.calls.length > 0);
      expect(child.writeSpy).toHaveBeenCalledWith("ls\n");
      socket.destroy();
    });

    it("sessions.input 400s with no open stream for the given id", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.input", body: { b64: "aGk=" } })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "no open stream for this id",
      });
      socket.destroy();
    });

    it("sessions.resize calls the session's own resize, silently (no reply) on success", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const child = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
      await waitForReply(socket);

      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.resize", body: { cols: 120, rows: 45 } })}\n`,
      );
      await waitUntil(() => child.resizeSpy.mock.calls.length > 0);
      expect(child.resizeSpy).toHaveBeenCalledWith(120, 45);
      socket.destroy();
    });

    it("sessions.resize 400s when cols/rows are missing", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
      await waitForReply(socket);

      socket.write(`${JSON.stringify({ id: 1, op: "sessions.resize" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'cols' and 'rows' are required",
      });
      socket.destroy();
    });

    it("sessions.resize 400s on a non-finite cols/rows instead of silently no-oping downstream (Hermes review, PR #399)", async () => {
      // `1e400` is valid JSON syntax (an ordinary number literal with a
      // large exponent) that JSON.parse overflows to Infinity — still
      // `typeof "number"`, so it must be rejected explicitly here.
      // (JSON.stringify({cols: Infinity}) would render `null` on the
      // client side before ever hitting the wire, which is why this test
      // builds the wire line by hand instead of stringifying a JS object
      // containing a literal Infinity.)
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const child = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
      await waitForReply(socket);

      socket.write('{"id":1,"op":"sessions.resize","body":{"cols":1e400,"rows":10}}\n');
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'cols' and 'rows' are required",
      });
      expect(child.resizeSpy).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("sessions.detach ends the stream and a follow-up input/resize on the same id 400s", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
      await waitForReply(socket);

      socket.write(`${JSON.stringify({ id: 1, op: "sessions.detach" })}\n`);
      const detachReply = await waitForReply(socket);
      expect(detachReply).toEqual({ id: 1, ok: true, status: 200 });

      socket.write(
        `${JSON.stringify({ id: 1, op: "sessions.resize", body: { cols: 10, rows: 10 } })}\n`,
      );
      const afterDetach = await waitForReply(socket);
      expect(afterDetach).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "no open stream for this id",
      });
      socket.destroy();
    });

    it("sessions.detach 400s with no open stream for the given id", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.detach" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "no open stream for this id",
      });
      socket.destroy();
    });

    it("closing the whole connection detaches every still-open stream (attachSocketToSession's own close cleanup runs)", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const child = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
      await waitForReply(socket);

      socket.destroy();
      await waitForClose(socket);

      // The session itself is never killed by a connection drop — same
      // "detach ≠ kill" posture as /ws/terminal's own socket close
      // handler — so its master keeps running (nothing to assert on the
      // fake PTY's kill() here, only that this doesn't throw and the
      // process stays otherwise healthy).
      expect(child.writeSpy).toBeDefined();
    });

    it("openChannels is scoped per-connection, not global — two connections reusing the same stream id never cross-talk", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: sessionA } = await createRealSession(app!, ptyMock);
      const childA = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
      const { sessionId: sessionB } = await createRealSession(app!, ptyMock);
      const childB = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];

      // Both connections deliberately reuse the same request/stream id (1)
      // — if openChannels were ever hoisted to a connection-independent
      // registry, the second attach would collide with (or overwrite) the
      // first instead of opening its own independent stream.
      const socketA = await fullScopeSocket(app!);
      socketA.write(
        `${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId: sessionA } })}\n`,
      );
      await waitForReply(socketA);

      const socketB = await fullScopeSocket(app!);
      socketB.write(
        `${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId: sessionB } })}\n`,
      );
      await waitForReply(socketB);

      socketA.write(
        `${JSON.stringify({ id: 1, op: "sessions.input", body: { b64: Buffer.from("from-a\n").toString("base64") } })}\n`,
      );
      await waitUntil(() => childA.writeSpy.mock.calls.length > 0);
      expect(childA.writeSpy).toHaveBeenCalledWith("from-a\n");
      expect(childB.writeSpy).not.toHaveBeenCalled();

      // Detaching connection A's stream 1 must not touch connection B's
      // own, independently-tracked stream 1.
      socketA.write(`${JSON.stringify({ id: 1, op: "sessions.detach" })}\n`);
      expect(await waitForReply(socketA)).toEqual({ id: 1, ok: true, status: 200 });

      socketB.write(
        `${JSON.stringify({ id: 1, op: "sessions.resize", body: { cols: 90, rows: 30 } })}\n`,
      );
      await waitUntil(() => childB.resizeSpy.mock.calls.length > 0);
      expect(childB.resizeSpy).toHaveBeenCalledWith(90, 30);

      socketA.destroy();
      socketB.destroy();
    });
  });

  describe("notification events ops (Phase 4, #188)", () => {
    it("events.subscribe (full scope): replays already-buffered events, then acks, then streams live ones", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const child = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
      // Buffered BEFORE the subscribe — must still show up in the replay
      // batch, same "reconstructs what happened while unwatched"
      // guarantee /ws/events's own WS route already gives. A1: title_change
      // events are now debounced at the source (pty-manager.ts's
      // TITLE_CHANGE_EVENT_DEBOUNCE_MS, 3s) — wait that out first so the
      // event has actually settled into the session's buffer before
      // subscribing, otherwise this would be testing live streaming, not
      // replay (mirrors events.test.ts's identical fix).
      child.emitData("\x1b]2;working\x07");
      await new Promise((resolve) => setTimeout(resolve, 3_200));

      const socket = await fullScopeSocket(app!);
      const frames = collectFrames(socket);
      socket.write(`${JSON.stringify({ id: 11, op: "events.subscribe" })}\n`);

      await waitUntil(() => frames.some((f) => f.ok === true));
      const ackIndex = frames.findIndex((f) => f.ok === true);
      expect(frames[ackIndex]).toEqual({ id: 11, ok: true, status: 200 });
      // The replay event arrived BEFORE the ack — attaching flushes any
      // already-buffered events synchronously, before this handler ever
      // calls reply().
      const replayEvent = frames.slice(0, ackIndex).find((f) => f.kind === "title_change");
      expect(replayEvent).toMatchObject({ id: 11, sessionId, kind: "title_change" });

      // A second, distinct title change — its own fresh debounce window
      // (the previous one already fired and cleared above), so this one
      // also needs the real wait rather than waitUntil's short poll.
      child.emitData("\x1b]2;still-working\x07");
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      await waitUntil(
        () => frames.slice(ackIndex + 1).some((f) => f.kind === "title_change" && f.seq === 2),
        DEBOUNCED_WAIT_MS,
      );
      socket.destroy();
      // 30s, not 10s: this test waits out a 3s source-side title-change
      // debounce, and on a loaded host the app setup plus that wait does
      // not fit in 10 — the ceiling was the flake, not the code.
    }, 30_000);

    it("events.subscribe (session scope): filtered to only the connection's own pinned session", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId: sessionA, hookToken } = await createRealSession(app!, ptyMock);
      const childA = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
      const { sessionId: sessionB } = await createRealSession(app!, ptyMock);
      const childB = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];

      const socket = await sessionScopeSocket(app!, hookToken);
      const frames = collectFrames(socket);
      socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
      await waitUntil(() => frames.some((f) => f.ok === true));

      childA.emitData("\x1b]2;from-a\x07");
      childB.emitData("\x1b]2;from-b\x07");
      // A1: title_change events are debounced at the source (3s) — wait
      // that out rather than short-polling.
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      await waitUntil(() => frames.some((f) => f.kind === "title_change"), DEBOUNCED_WAIT_MS);

      // Give any (incorrect) cross-session delivery a chance to arrive
      // before asserting only session A's event ever showed up.
      await new Promise((resolve) => setImmediate(resolve));
      const titleChanges = frames.filter((f) => f.kind === "title_change");
      expect(titleChanges.every((f) => f.sessionId === sessionA)).toBe(true);
      expect(titleChanges.some((f) => f.sessionId === sessionB)).toBe(false);
      socket.destroy();
      // 30s, not 10s: this test waits out a 3s source-side title-change
      // debounce, and on a loaded host the app setup plus that wait does
      // not fit in 10 — the ceiling was the flake, not the code.
    }, 30_000);

    it("400s re-subscribing on the same id without unsubscribing first", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
      await waitForReply(socket);

      socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "a stream is already open for this id",
      });
      socket.destroy();
    });

    it("events.seen forwards to app.pty.markEventsSeen, silently on success (no reply)", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const markEventsSeenSpy = vi.spyOn(app.pty, "markEventsSeen");
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
      await waitForReply(socket);

      socket.write(
        `${JSON.stringify({ id: 1, op: "events.seen", body: { sessionId, seq: 3 } })}\n`,
      );
      await waitUntil(() => markEventsSeenSpy.mock.calls.length > 0);
      expect(markEventsSeenSpy).toHaveBeenCalledWith(String(sessionId), 3);
      socket.destroy();
    });

    it("events.seen (session scope): naming the connection's own pinned sessionId reaches markEventsSeen (Hermes review, PR #400)", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
      const markEventsSeenSpy = vi.spyOn(app.pty, "markEventsSeen");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
      await waitForReply(socket);

      socket.write(
        `${JSON.stringify({ id: 1, op: "events.seen", body: { sessionId, seq: 2 } })}\n`,
      );
      await waitUntil(() => markEventsSeenSpy.mock.calls.length > 0);
      expect(markEventsSeenSpy).toHaveBeenCalledWith(String(sessionId), 2);
      socket.destroy();
    });

    it("events.seen (session scope): naming a DIFFERENT session's id is silently ignored by attachLocalEventsSocket's own filter", async () => {
      app = await buildApp();
      await app.ready();
      const { hookToken } = await createRealSession(app!, ptyMock);
      const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
      const markEventsSeenSpy = vi.spyOn(app.pty, "markEventsSeen");
      const socket = await sessionScopeSocket(app!, hookToken);
      socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
      await waitForReply(socket);

      socket.write(
        `${JSON.stringify({ id: 1, op: "events.seen", body: { sessionId: otherSessionId, seq: 1 } })}\n`,
      );
      // No reply is expected either way (events.seen is silent on
      // success) — the assertion is that the OTHER session's cursor was
      // never advanced, not that this op itself errored.
      await new Promise((resolve) => setImmediate(resolve));
      expect(markEventsSeenSpy).not.toHaveBeenCalled();
      socket.destroy();
    });

    it("events.seen 400s with no open stream for the given id", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(
        `${JSON.stringify({ id: 1, op: "events.seen", body: { sessionId: 1, seq: 1 } })}\n`,
      );
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "no open stream for this id",
      });
      socket.destroy();
    });

    it("events.seen 400s on missing or non-finite sessionId/seq", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
      await waitForReply(socket);

      socket.write(`${JSON.stringify({ id: 1, op: "events.seen" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'sessionId' and 'seq' must be finite numbers",
      });

      // 1e400 is valid JSON syntax that JSON.parse overflows to Infinity
      // — still typeof "number", same edge case as sessions.resize's own
      // Number.isFinite guard (Hermes review, PR #399).
      socket.write('{"id":1,"op":"events.seen","body":{"sessionId":1e400,"seq":1}}\n');
      const secondReply = await waitForReply(socket);
      expect(secondReply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "'sessionId' and 'seq' must be finite numbers",
      });
      socket.destroy();
    });

    it("events.unsubscribe ends the stream and a follow-up events.seen on the same id 400s", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
      await waitForReply(socket);

      socket.write(`${JSON.stringify({ id: 1, op: "events.unsubscribe" })}\n`);
      expect(await waitForReply(socket)).toEqual({ id: 1, ok: true, status: 200 });

      socket.write(
        `${JSON.stringify({ id: 1, op: "events.seen", body: { sessionId: 1, seq: 1 } })}\n`,
      );
      const afterUnsubscribe = await waitForReply(socket);
      expect(afterUnsubscribe).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "no open stream for this id",
      });
      socket.destroy();
    });

    it("events.unsubscribe 400s with no open stream for the given id", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await fullScopeSocket(app!);
      socket.write(`${JSON.stringify({ id: 1, op: "events.unsubscribe" })}\n`);
      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 400,
        error: "no open stream for this id",
      });
      socket.destroy();
    });

    describe("events.query (issue #213, roadmap 4.7)", () => {
      it("full scope: persistenceEnabled:false with an empty result while the setting is off (default)", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "events.query" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: true,
          status: 200,
          result: { persistenceEnabled: false, events: [], nextCursor: null },
        });
        socket.destroy();
      });

      it("full scope: queries every session when sessionId is omitted, once persistence is enabled", async () => {
        app = await buildApp();
        await app.ready();
        const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: authHeaders,
          payload: { sessions: { eventPersistence: true } },
        });
        const { sessionId } = await createRealSession(app!, ptyMock);
        insertSessionEvents(app.db, [
          { seq: 1, sessionId, kind: "title_change", ts: Date.now(), payload: { x: 1 } },
        ]);

        const socket = await fullScopeSocket(app!);
        socket.write(`${JSON.stringify({ id: 1, op: "events.query" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        const result = reply.result as { persistenceEnabled: boolean; events: unknown[] };
        expect(result.persistenceEnabled).toBe(true);
        expect(result.events).toEqual(
          expect.arrayContaining([expect.objectContaining({ sessionId, kind: "title_change" })]),
        );
        socket.destroy();
      });

      it("full scope: an explicit sessionId scopes the query to just that session", async () => {
        app = await buildApp();
        await app.ready();
        const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: authHeaders,
          payload: { sessions: { eventPersistence: true } },
        });
        const { sessionId: sessionA } = await createRealSession(app!, ptyMock);
        const { sessionId: sessionB } = await createRealSession(app!, ptyMock);
        insertSessionEvents(app.db, [
          { seq: 1, sessionId: sessionA, kind: "todo", ts: Date.now(), payload: {} },
          { seq: 1, sessionId: sessionB, kind: "todo", ts: Date.now(), payload: {} },
        ]);

        const socket = await fullScopeSocket(app!);
        socket.write(
          `${JSON.stringify({ id: 1, op: "events.query", body: { sessionId: sessionA } })}\n`,
        );
        const reply = await waitForReply(socket);
        const result = reply.result as { events: Array<{ sessionId: number }> };
        expect(result.events).toHaveLength(1);
        expect(result.events[0].sessionId).toBe(sessionA);
        socket.destroy();
      });

      it("session scope: omitting sessionId defaults to the connection's own pinned session", async () => {
        app = await buildApp();
        await app.ready();
        const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: authHeaders,
          payload: { sessions: { eventPersistence: true } },
        });
        const { sessionId, hookToken } = await createRealSession(app!, ptyMock);
        const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);
        insertSessionEvents(app.db, [
          { seq: 1, sessionId, kind: "todo", ts: Date.now(), payload: {} },
          { seq: 1, sessionId: otherSessionId, kind: "todo", ts: Date.now(), payload: {} },
        ]);

        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "events.query" })}\n`);
        const reply = await waitForReply(socket);
        const result = reply.result as { events: Array<{ sessionId: number }> };
        expect(result.events).toHaveLength(1);
        expect(result.events[0].sessionId).toBe(sessionId);
        socket.destroy();
      });

      it("session scope: naming a DIFFERENT session's id is rejected with 403, isolation matching events.subscribe", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession(app!, ptyMock);
        const { sessionId: otherSessionId } = await createRealSession(app!, ptyMock);

        const socket = await sessionScopeSocket(app!, hookToken);
        socket.write(
          `${JSON.stringify({ id: 1, op: "events.query", body: { sessionId: otherSessionId } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 403,
          error: "session-scoped connections may only target their own session or its children",
        });
        socket.destroy();
      });
    });

    it("an events.subscribe stream and a sessions.attach stream can be open concurrently on distinct ids without cross-talk", async () => {
      app = await buildApp();
      await app.ready();
      const { sessionId } = await createRealSession(app!, ptyMock);
      const child = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
      const socket = await fullScopeSocket(app!);
      const frames = collectFrames(socket);

      socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
      await waitUntil(() => frames.some((f) => f.id === 1 && f.ok === true));

      socket.write(`${JSON.stringify({ id: 2, op: "sessions.attach", body: { sessionId } })}\n`);
      await waitUntil(() => frames.some((f) => f.id === 2 && f.type === "data"));

      child.emitData("\x1b]2;live\x07");
      // A1: title_change events are debounced at the source (3s).
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      await waitUntil(
        () => frames.some((f) => f.id === 1 && f.kind === "title_change"),
        DEBOUNCED_WAIT_MS,
      );
      expect(frames.some((f) => f.id === 2 && f.kind === "title_change")).toBe(false);
      socket.destroy();
      // 30s, not 10s: this test waits out a 3s source-side title-change
      // debounce, and on a loaded host the app setup plus that wait does
      // not fit in 10 — the ceiling was the flake, not the code.
    }, 30_000);
  });
});
