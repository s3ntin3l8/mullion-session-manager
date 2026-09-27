import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment for
// the empirically confirmed hoisting/ordering failure mode.
import { buildTestApp } from "../helpers/app.js";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";

// Real integration test: a genuine WebSocket client against a real listening
// server, not app.inject() (which can't drive a full-duplex upgrade) — same
// reasoning and harness shape as test/routes/terminal.test.ts. Faked
// node-pty/child_process the same way, so this exercises the actual
// /ws/events route logic (replay, live streaming, "seen" cursor messages)
// without depending on a real systemd --user session.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { closeDb } = await import("../../src/db/client.js");
const { shouldDropForBackpressure, EVENTS_BACKPRESSURE_MAX_BUFFERED_BYTES } =
  await import("../../src/routes/events.js");

describe("shouldDropForBackpressure", () => {
  // Pulled out as a pure predicate specifically so this drop condition is
  // directly testable — a full backpressure integration test (actually
  // stalling a real socket's bufferedAmount past the 4MiB threshold) isn't
  // practical to drive deterministically from a test WS client; this at
  // least makes the exact drop boundary code-reachable and asserted.
  it("does not drop at or below the threshold", () => {
    expect(shouldDropForBackpressure(0)).toBe(false);
    expect(shouldDropForBackpressure(EVENTS_BACKPRESSURE_MAX_BUFFERED_BYTES)).toBe(false);
  });

  it("drops once strictly over the threshold", () => {
    expect(shouldDropForBackpressure(EVENTS_BACKPRESSURE_MAX_BUFFERED_BYTES + 1)).toBe(true);
  });
});

const tmpDb = path.join(os.tmpdir(), `events-test-${process.pid}.db`);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

function waitForOpenOrClose(ws: WebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.addEventListener("open", () => resolve("open"), { once: true });
    ws.addEventListener("close", () => resolve("close"), { once: true });
  });
}

interface WireEvent {
  seq: number;
  sessionId: number;
  kind: string;
  ts: number;
  payload: Record<string, unknown>;
}

function collectJsonMessages(ws: WebSocket): WireEvent[] {
  const messages: WireEvent[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string) as WireEvent);
  });
  return messages;
}

describe("events route (/ws/events)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function buildAndListen() {
    const app = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    return { app, port: address.port };
  }

  async function createProjectAndSession(app: Awaited<ReturnType<typeof buildTestApp>>) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;

    const before = ptyMock.spawnedPtys.length;
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = session.json().id as number;

    await waitUntil(() => ptyMock.spawnedPtys.length > before);
    return { sessionId, pty: ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1] };
  }

  // A1: title_change events are now debounced at the source
  // (pty-manager.ts's TITLE_CHANGE_EVENT_DEBOUNCE_MS, 3s) — a raw OSC title
  // no longer lands in a session's event buffer (or over this route's WS)
  // synchronously. This is a real integration test against a real listening
  // server and real WS client (see this file's header comment), so — unlike
  // pty-manager.test.ts's fake-timer coverage of the debounce mechanism
  // itself — the tests below wait out the real debounce window rather than
  // faking it, to also exercise the real setTimeout scheduling end to end.
  const TITLE_CHANGE_EVENT_DEBOUNCE_MS = 3_000;

  it("replays a session's already-buffered events on connect", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId, pty } = await createProjectAndSession(app);

    // Emitted before the WS even connects — must still show up in the
    // replay batch, same "reconstructs what happened while unwatched"
    // guarantee /ws/terminal's scrollback replay already gives. Wait out
    // the debounce first so the event has actually settled into the
    // session's buffer before the client connects — otherwise this would
    // be testing live streaming, not replay.
    pty.emitData("\x1b]2;working\x07");
    await new Promise((resolve) => setTimeout(resolve, TITLE_CHANGE_EVENT_DEBOUNCE_MS + 200));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const messages = collectJsonMessages(ws);
    await waitForOpenOrClose(ws);

    // Issue #1427: the very first frame on any connection is now the
    // `cursors` frame (see the dedicated test below), sent before the
    // replay batch — filter by `kind` (absent on a `cursors` frame) rather
    // than asserting on messages[0] directly, the same forward-compatible
    // pattern the other tests in this file already use.
    await waitUntil(() => messages.some((m) => m.kind === "title_change"));
    const replayed = messages.find((m) => m.kind === "title_change");
    expect(replayed).toMatchObject({
      sessionId,
      kind: "title_change",
      payload: { title: "working" },
    });

    ws.close();
  }, 10_000);

  it("streams a live event to an already-connected client", async () => {
    const { app, port } = await buildAndListen();
    const { pty } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const messages = collectJsonMessages(ws);
    await waitForOpenOrClose(ws);

    // A working->idle title transition (#98) is a zero-threshold attention
    // signal (see ATTENTION_CONFIRM_MS in attention-detect.ts) — confirms
    // synchronously off the RAW title change, unlike a bare bell (debounced
    // against attention-detect.ts's PENDING_ATTENTION state machine — see
    // issue #171), which needs either a real ~2s wait or a direct
    // Session.tick() call this route-level test has no access to. Firing
    // both title changes back-to-back (no wait in between) still exercises
    // this correctly: idle-detection is deliberately decoupled from the
    // title_change EVENT's own debounce (A1) — see pty-manager.ts's
    // scheduleTitleChangeEvent() doc comment.
    pty.emitData("\x1b]2;working\x07");
    pty.emitData("\x1b]2;idle\x07");
    await waitUntil(() => messages.some((m) => m.kind === "attention"));
    const attentionEvent = messages.find((m) => m.kind === "attention");
    expect(attentionEvent?.payload).toEqual({ attention: true, signal: "titleIdle" });

    // The title_change EVENT itself is still coalesced (A1) — back-to-back
    // "working" then "idle" settle as ONE debounced event carrying the
    // LATEST title, not two.
    await new Promise((resolve) => setTimeout(resolve, TITLE_CHANGE_EVENT_DEBOUNCE_MS + 200));
    const titleEvents = messages.filter((m) => m.kind === "title_change");
    expect(titleEvents).toHaveLength(1);
    expect(titleEvents[0].payload).toEqual({ title: "idle" });

    ws.close();
  }, 10_000);

  it("delivers events from multiple sessions, each with its own per-session seq", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId: sessionA, pty: ptyA } = await createProjectAndSession(app);
    const { sessionId: sessionB, pty: ptyB } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const messages = collectJsonMessages(ws);
    await waitForOpenOrClose(ws);

    ptyA.emitData("\x1b]2;a1\x07");
    ptyB.emitData("\x1b]2;b1\x07");
    // A1: both title_change events are debounced (3s) before they're
    // emitted/broadcast — wait that out rather than short-polling.
    await new Promise((resolve) => setTimeout(resolve, TITLE_CHANGE_EVENT_DEBOUNCE_MS + 200));
    await waitUntil(() => messages.length >= 2);

    const fromA = messages.find((m) => m.sessionId === sessionA);
    const fromB = messages.find((m) => m.sessionId === sessionB);
    expect(fromA).toMatchObject({ seq: 1, sessionId: sessionA });
    expect(fromB).toMatchObject({ seq: 1, sessionId: sessionB });

    ws.close();
  }, 10_000);

  it("accepts a 'seen' control message without erroring, and ignores malformed frames", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    await waitForOpenOrClose(ws);

    ws.send(JSON.stringify({ type: "seen", sessionId, seq: 1 }));
    ws.send("not json");
    ws.send(JSON.stringify({ type: "not-seen" }));

    // No response is expected for any of these — the assertion is simply
    // that the socket is still open and well-behaved afterward.
    await new Promise((resolve) => setImmediate(resolve));
    expect(ws.readyState).toBe(ws.OPEN);

    ws.close();
  });

  // Issue #1427 — the server-owned read cursor. Uses raw parsed frames
  // (not collectJsonMessages/WireEvent, which assumes every frame is a bare
  // NotificationEvent) since a `cursors`/`seen` control frame doesn't match
  // that shape.
  function collectRawMessages(ws: WebSocket): unknown[] {
    const messages: unknown[] = [];
    ws.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string)));
    return messages;
  }

  it("sends a cursors frame before any replayed event, reflecting this session's head/seen", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId, pty } = await createProjectAndSession(app);

    // Give the session a non-trivial head to assert on.
    pty.emitData("\x1b]2;working\x07");
    await new Promise((resolve) => setTimeout(resolve, TITLE_CHANGE_EVENT_DEBOUNCE_MS + 200));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const raw = collectRawMessages(ws);
    await waitForOpenOrClose(ws);

    await waitUntil(() => raw.length > 0);
    const first = raw[0] as {
      type?: string;
      bootId?: string;
      cursors?: Record<string, { seen: number; head: number }>;
    };
    expect(first.type).toBe("cursors");
    expect(typeof first.bootId).toBe("string");
    expect(first.bootId).not.toBe("");
    expect(first.cursors?.[String(sessionId)]).toEqual({ seen: 0, head: 1 });

    ws.close();
  }, 10_000);

  it("sends the same bootId to every connection on this process (issue #1427's restart-detection signal)", async () => {
    const { app, port } = await buildAndListen();
    await createProjectAndSession(app);

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const raw1 = collectRawMessages(ws1);
    const raw2 = collectRawMessages(ws2);
    await Promise.all([waitForOpenOrClose(ws1), waitForOpenOrClose(ws2)]);
    await waitUntil(() => raw1.length > 0 && raw2.length > 0);

    const bootId1 = (raw1[0] as { bootId?: string }).bootId;
    const bootId2 = (raw2[0] as { bootId?: string }).bootId;
    expect(bootId1).toBe(bootId2);

    ws1.close();
    ws2.close();
  });

  it("broadcasts a 'seen' advance to another open connection, but not back to the sender", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const raw1 = collectRawMessages(ws1);
    const raw2 = collectRawMessages(ws2);
    await Promise.all([waitForOpenOrClose(ws1), waitForOpenOrClose(ws2)]);

    // Each connection gets its own cursors frame on connect — drain those
    // first so they aren't mistaken for the broadcast below.
    await waitUntil(() => raw1.length > 0 && raw2.length > 0);
    raw1.length = 0;
    raw2.length = 0;

    ws1.send(JSON.stringify({ type: "seen", sessionId, seq: 1 }));

    await waitUntil(() => raw2.some((m) => (m as { type?: string }).type === "seen"));
    expect(raw2).toContainEqual({ type: "seen", sessionId, seq: 1 });
    expect(raw1.some((m) => (m as { type?: string }).type === "seen")).toBe(false);

    ws1.close();
    ws2.close();
  });

  it("does not re-broadcast a 'seen' that doesn't actually advance the cursor", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    const raw2 = collectRawMessages(ws2);
    await Promise.all([waitForOpenOrClose(ws1), waitForOpenOrClose(ws2)]);

    ws1.send(JSON.stringify({ type: "seen", sessionId, seq: 5 }));
    await waitUntil(() => raw2.some((m) => (m as { type?: string }).type === "seen"));
    raw2.length = 0;

    // A lower/equal seq is a no-op on Session.markEventsSeen (monotonic
    // only) — must not re-broadcast either. Waiting on a bare timer tick
    // here can't distinguish "correctly didn't broadcast" from "broadcast
    // still in flight over the real WS round trip" — instead, send a
    // second, definitely-advancing seq right behind it and wait for THAT
    // one to arrive, then assert it was the ONLY frame raw2 ever received
    // (i.e. the no-op seq truly produced nothing, not just something
    // slow).
    ws1.send(JSON.stringify({ type: "seen", sessionId, seq: 3 }));
    ws1.send(JSON.stringify({ type: "seen", sessionId, seq: 8 }));
    await waitUntil(() => raw2.some((m) => (m as { type?: string; seq?: number }).seq === 8));
    expect(raw2).toEqual([{ type: "seen", sessionId, seq: 8 }]);

    ws1.close();
    ws2.close();
  });

  it("closes cleanly without leaving the session tracked incorrectly", async () => {
    const { app, port } = await buildAndListen();
    await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
    await waitForOpenOrClose(ws);
    ws.close();
    await new Promise((resolve) => setImmediate(resolve));

    // The session list endpoint (unrelated to /ws/events) must still work
    // normally — confirms this route's close handling didn't leak into
    // unrelated app state.
    const list = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(list.statusCode).toBe(200);
  });
});
