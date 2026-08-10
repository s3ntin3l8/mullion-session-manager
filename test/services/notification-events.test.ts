import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type { NotificationEvent } from "../../src/services/pty-manager.js";

// Phase 1's notification event model (issue #166) — the ring buffer +
// emit-on-transition logic added to Session/PtyManager in pty-manager.ts.
// Faked the same way test/services/pty-manager.test.ts fakes node-pty and
// the systemd-run/dtach bootstrap child_process, kept in its own file
// (rather than folded into pty-manager.test.ts) per the PR's own test plan.
const fakePtyChildren: FakePty[] = [];

class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  exitListeners: Array<(e: { exitCode: number }) => void> = [];

  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }

  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitListeners.push(cb);
    return { dispose: () => {} };
  }

  write() {}
  resize() {}

  kill() {
    for (const cb of this.exitListeners) cb({ exitCode: 0 });
  }

  emitData(chunk: string) {
    for (const cb of this.dataListeners) cb(chunk);
  }
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const child = new FakePty();
    fakePtyChildren.push(child);
    return child;
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      ee.stdout = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const { PtyManager } = await import("../../src/services/pty-manager.js");

describe("notification events (issue #166)", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    fakePtyChildren.length = 0;
    sessionsDir = path.join(
      os.tmpdir(),
      `notification-events-test-${crypto.randomBytes(4).toString("hex")}`,
    );
    manager = new PtyManager({ sessionsDir });
  });

  afterEach(() => {
    // Stops PtyManager's own attention-evaluator interval (issue #171/#98) —
    // see pty-manager.test.ts's identical afterEach for why.
    manager.killAll();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  async function waitForSpawn(session: { isAlive: boolean }) {
    for (let i = 0; i < 50; i++) {
      if (session.isAlive) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("session never became alive");
  }

  // Issue #171/#98: attention confirmation is now debounced through
  // attention-detect.ts's state machine — see pty-manager.test.ts's own
  // "activity/attention signals (WS-6)" describe block for the full
  // transition-by-transition coverage. These two just confirm the
  // event-emission side (issue #166's model) still fires correctly once a
  // signal actually confirms/clears.
  it("emits an attention event exactly once on confirm, not again on a later refresh while still confirmed", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("first\x07");
    session.tick(Date.now() + 2_000); // confirms -> the one attention event

    // A second bell arriving once already confirmed is transition-guarded —
    // still needs attention, but not a NEW transition, so no second emit.
    fakePtyChildren[0].emitData("second\x07");

    const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
    expect(attentionEvents).toHaveLength(1);
    expect(attentionEvents[0]).toMatchObject({
      sessionId: 1,
      kind: "attention",
      payload: { attention: true, signal: "bell" },
    });
  });

  it("emits attention set then clear as two distinct events", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("progress\x07");
    session.tick(Date.now() + 2_000); // confirms -> emits attention:true
    fakePtyChildren[0].emitData("more progress"); // clears -> emits attention:false

    const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
    expect(attentionEvents.map((e) => e.payload)).toEqual([
      { attention: true, signal: "bell" },
      { attention: false },
    ]);
  });

  // #98's three new detection signals, each verified end-to-end through to
  // a real emitEvent("attention", ...) / onEvent() delivery — not just an
  // internal flag flip. Separate sessions per signal: once one signal
  // confirms attention, the very next plain-output chunk is itself evidence
  // of resumed work and clears it (see attention-detect.ts's clearAttention)
  // — exactly the real behavior a genuine follow-up chunk (e.g. the next
  // signal's own setup bytes) would otherwise trigger, so isolating each
  // signal in its own session keeps this test's cause and effect obvious.
  it("emits an attention event for a working->idle title transition (#98)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "claude",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b]2;Thinking…\x07"); // working title, no attention event
    fakePtyChildren[0].emitData("\x1b]2;Ready\x07"); // working->idle transition

    const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
    expect(attentionEvents.map((e) => e.payload)).toEqual([
      { attention: true, signal: "titleIdle" },
    ]);
  });

  it("emits an attention event for an alt-screen exit (#98)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1049h"); // enter alt-screen, no attention event
    fakePtyChildren[0].emitData("\x1b[?1049l"); // exit -> attention

    const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
    expect(attentionEvents.map((e) => e.payload)).toEqual([
      { attention: true, signal: "altScreenExit" },
    ]);
  });

  it("emits an attention event for sustained silence after a real work streak (#98), delivered via PtyManager.onEvent too", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    const received: NotificationEvent[] = [];
    manager.onEvent((event) => received.push(event));

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      vi.setSystemTime(start);
      fakePtyChildren[0].emitData("agent output 1");
      vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
      fakePtyChildren[0].emitData("agent output 2");
      session.tick(start + 1_200 + 10_000); // sustained silence -> attention
    } finally {
      vi.useRealTimers();
    }

    const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
    expect(attentionEvents.map((e) => e.payload)).toEqual([{ attention: true, signal: "silence" }]);
    // The manager-level fan-out (issue #166) picked it up too — not just
    // the session's own ring buffer.
    expect(received.map((e) => e.payload)).toContainEqual({ attention: true, signal: "silence" });
  });

  it("emits a title_change event only when the title actually changes", async () => {
    // A1: the title_change EVENT (as opposed to raw title-change detection,
    // which stays synchronous — see pty-manager.test.ts's own "title_change
    // event coalescing (A1)" describe block) is now debounced at the
    // source, so this test advances a fake clock past
    // TITLE_CHANGE_EVENT_DEBOUNCE_MS (3s) between distinct titles to
    // observe each as its own settled event, same as it would in
    // production once an agent's TUI actually stops churning for a few
    // seconds.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("\x1b]2;working\x07");
      fakePtyChildren[0].emitData("\x1b]2;working\x07"); // same title again — no new event
      await vi.advanceTimersByTimeAsync(3_000); // let "working" settle
      fakePtyChildren[0].emitData("\x1b]2;idle\x07");
      await vi.advanceTimersByTimeAsync(3_000); // let "idle" settle

      const titleEvents = session.getEvents().filter((e) => e.kind === "title_change");
      expect(titleEvents.map((e) => e.payload.title)).toEqual(["working", "idle"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a status_change event on alt-screen transitions, not on a repeated same-state switch", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1049h"); // enter alt
    fakePtyChildren[0].emitData("\x1b[?1049h\x1b[?1049l\x1b[?1049h"); // net: still alt (last switch in chunk)
    fakePtyChildren[0].emitData("\x1b[?1049l"); // exit alt

    const statusEvents = session.getEvents().filter((e) => e.kind === "status_change");
    expect(statusEvents.map((e) => e.payload)).toEqual([{ screen: "alt" }, { screen: "primary" }]);
  });

  it("emits a status_change event on program exit", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].kill();

    const statusEvents = session.getEvents().filter((e) => e.kind === "status_change");
    expect(statusEvents.map((e) => e.payload)).toContainEqual({ reason: "exited" });
  });

  it("does not emit any event for a plain working<->idle title transition change tracked separately from attention", async () => {
    // Regression guard for the deliberate scope cut (issue #166): idle is
    // time-based, not byte-driven, so toInfo()'s activity classification
    // must never itself become an event source here — only title_change (a
    // literal OSC 0/2 payload change) and attention (bell/OSC 9/777) do.
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("plain output, no escape sequences at all");
    expect(session.getEvents()).toHaveLength(0);
  });

  it("assigns a monotonic per-session seq starting at 1", async () => {
    // A1: title_change events are now debounced (see the "emits a
    // title_change event only when the title actually changes" test just
    // above for why) — advance past the debounce window between each
    // distinct title so all three settle as their own events.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // Title changes only (no bell/notification involved) so this test
      // doesn't also need to reason about the attention-clear-window
      // interaction the two tests above already cover in isolation.
      fakePtyChildren[0].emitData("\x1b]2;t0\x07");
      await vi.advanceTimersByTimeAsync(3_000);
      fakePtyChildren[0].emitData("\x1b]2;t1\x07");
      await vi.advanceTimersByTimeAsync(3_000);
      fakePtyChildren[0].emitData("\x1b]2;t2\x07");
      await vi.advanceTimersByTimeAsync(3_000);

      const seqs = session.getEvents().map((e) => e.seq);
      expect(seqs).toEqual([1, 2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps each session's own event ring buffer at 100 (FIFO)", async () => {
    // A1: each title now needs its own settled debounce window (3s) to
    // become its own event — advance the fake clock between every emit so
    // this still exercises 150 DISTINCT events hitting the 100-slot ring
    // buffer, same as the pre-debounce version of this test did.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      for (let i = 0; i < 150; i++) {
        fakePtyChildren[0].emitData(`\x1b]2;title-${i}\x07`);
        await vi.advanceTimersByTimeAsync(3_000);
      }

      const events = session.getEvents();
      expect(events).toHaveLength(100);
      // FIFO eviction: the oldest 50 titles are gone, the newest 100 remain.
      expect(events[0].payload.title).toBe("title-50");
      expect(events[events.length - 1].payload.title).toBe("title-149");
    } finally {
      vi.useRealTimers();
    }
  });

  it("markEventsSeen advances the read cursor but ignores a seq behind it", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    // No public getter for lastSeenSeq (it's WS-facing only, not part of
    // SessionInfo/toInfo — see pty-manager.ts's own comment) — exercise it
    // indirectly through PtyManager.markEventsSeen and confirm it doesn't
    // throw for an unknown id either.
    expect(() => manager.markEventsSeen("1", 5)).not.toThrow();
    expect(() => manager.markEventsSeen("1", 2)).not.toThrow();
    expect(() => manager.markEventsSeen("does-not-exist", 1)).not.toThrow();
  });

  it("PtyManager.onEvent fans out events from every tracked session", async () => {
    const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(a);
    await waitForSpawn(b);

    const received: NotificationEvent[] = [];
    const unsubscribe = manager.onEvent((event) => received.push(event));

    fakePtyChildren[0].emitData("\x07");
    fakePtyChildren[1].emitData("\x07");
    a.tick(Date.now() + 2_000);
    b.tick(Date.now() + 2_000);

    expect(received.map((e) => e.sessionId).sort()).toEqual([1, 2]);

    unsubscribe();
    fakePtyChildren[0].emitData("more\x07");
    a.tick(Date.now() + 10_000);
    expect(received).toHaveLength(2); // unsubscribed — no further delivery
  });

  it("PtyManager.listEvents aggregates every tracked session's buffered events", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      await waitForSpawn(a);
      await waitForSpawn(b);

      fakePtyChildren[0].emitData("\x07");
      a.tick(Date.now() + 2_000); // confirms -> attention event
      fakePtyChildren[1].emitData("\x1b]2;hi\x07"); // title_change fires regardless of the attention machine
      // A1: the title_change event above is debounced at the source — let
      // it settle before asserting on the aggregated event list.
      await vi.advanceTimersByTimeAsync(3_000);

      const all = manager.listEvents();
      expect(all).toHaveLength(2);
      expect(all.map((e) => e.sessionId).sort()).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });
});
