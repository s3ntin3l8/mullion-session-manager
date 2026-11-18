// PtyManager terminal I/O — startup terminal queries, writes and backpressure, agent-driven input, resize clamping and the redraw nudge.
//
// Split out of the former test/services/pty-manager.test.ts (issue #3277) —
// that file sat at the file-size ratchet's ceiling, so a change here could no
// longer land next to the tests it belongs with. The shared mock preamble and
// helpers live in test/helpers/pty-manager-harness.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  bundleSyncMock,
  cgroupInventoryMock,
  childProcessMock,
  createPtyManagerFixture,
  destroyPtyManagerFixture,
  fakePtyChildren,
  nodePtyMock,
  resetPtyManagerMocks,
  waitForSpawn,
} from "../helpers/pty-manager-harness.js";
import {
  resetTerminalPalette,
  setTerminalPalette,
} from "../../src/services/terminal-query-reply.js";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager, MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS } =
  await import("../../src/services/pty-manager.js");

describe("PtyManager", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    // Every test starts from a clean slate: no fake PTYs, no `systemctl`
    // fixtures and no cgroup-inventory call log left over from a sibling.
    resetPtyManagerMocks();
    ({ sessionsDir, manager } = createPtyManagerFixture(PtyManager));
  });

  afterEach(async () => {
    await destroyPtyManagerFixture({ sessionsDir, manager });
  });

  describe("startup terminal queries", () => {
    const LIGHT = { foreground: "#1d1d1d", background: "#f2f2f2", cursor: "#1d1d1d" };
    const QUERY = "\x1b]11;?\x07\x1b[c";
    const REPLY = "\x1b]11;rgb:f2f2/f2f2/f2f2\x07\x1b[?1;2c";

    afterEach(() => resetTerminalPalette());

    async function startSession() {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      return session;
    }

    it("answers an OSC 11 + DA1 query from the cached palette", async () => {
      setTerminalPalette(LIGHT);
      await startSession();

      fakePtyChildren[0].emitData(QUERY);

      expect(fakePtyChildren[0].writeSpy).toHaveBeenCalledWith(REPLY);
    });

    it("strips answered queries but still counts them as activity", async () => {
      setTerminalPalette(LIGHT);
      const session = await startSession();
      const seen: string[] = [];
      session.onData((d) => seen.push(d.toString()));

      fakePtyChildren[0].emitData(QUERY);
      const kept = [session.getScrollback().includes("]11;?"), session.toInfo().lastActivityAt];
      expect(kept).toEqual([false, expect.any(Number)]);

      fakePtyChildren[0].emitData(QUERY + "hello");
      expect(seen).toEqual(["hello"]);
    });

    it("only answers during the session's startup window", async () => {
      setTerminalPalette(LIGHT);
      await startSession();
      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow + 31_000);

      fakePtyChildren[0].emitData(QUERY);
      nowSpy.mockRestore();

      expect(fakePtyChildren[0].writeSpy).not.toHaveBeenCalledWith(REPLY);
    });

    it("answers nothing until a palette has been reported", async () => {
      await startSession();

      fakePtyChildren[0].emitData(QUERY);

      expect(fakePtyChildren[0].writeSpy).not.toHaveBeenCalled();
    });
  });

  it("writes input to the underlying pty", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.write("echo hi\n");
    expect(fakePtyChildren[0].writeSpy).toHaveBeenCalledWith("echo hi\n");
  });

  // B9 — WS->PTY backpressure: a large paste (or a burst of rapid messages)
  // into a session whose program isn't reading its stdin must not grow the
  // write queue without bound.
  describe("write() backpressure (B9)", () => {
    it("drops writes once WRITE_BACKPRESSURE_MAX_BYTES is exceeded within the current window", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(0);
        // A single "paste" comfortably under the 4 MiB cap goes through in
        // full.
        const underCap = "a".repeat(3 * 1024 * 1024);
        session.write(underCap);
        expect(fakePtyChildren[0].writeSpy).toHaveBeenCalledWith(underCap);

        // A second chunk that pushes the running total over the cap, still
        // within the same window, is dropped entirely rather than partially
        // written or queued.
        fakePtyChildren[0].writeSpy.mockClear();
        const overCap = "b".repeat(2 * 1024 * 1024);
        session.write(overCap);
        expect(fakePtyChildren[0].writeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("many rapid small messages within the window are capped the same way a single large paste is", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(0);
        const chunk = "x".repeat(512 * 1024); // 0.5 MiB per message
        for (let i = 0; i < 16; i++) session.write(chunk); // 8 MiB total, well over the 4 MiB cap

        const writtenBytes = fakePtyChildren[0].writeSpy.mock.calls.reduce(
          (sum: number, [data]: [string]) => sum + Buffer.byteLength(data, "utf8"),
          0,
        );
        expect(writtenBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(writtenBytes).toBeGreaterThan(0); // not everything was dropped
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the cap once the window elapses, so a session recovers rather than staying capped forever", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(0);
        session.write("a".repeat(4 * 1024 * 1024)); // fills the window's cap exactly
        fakePtyChildren[0].writeSpy.mockClear();
        session.write("b"); // dropped — still within the same window
        expect(fakePtyChildren[0].writeSpy).not.toHaveBeenCalled();

        // Past WRITE_BACKPRESSURE_WINDOW_MS (1000ms), the window resets.
        vi.setSystemTime(1_001);
        session.write("c");
        expect(fakePtyChildren[0].writeSpy).toHaveBeenCalledWith("c");
      } finally {
        vi.useRealTimers();
      }
    });

    it("still clears a confirmed attention flag on a dropped write — the user genuinely acted", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      // Same OUTPUT_IMMUNE_KINDS-confirmed attention flag the "focus-report
      // / mouse-report / OSC color-reply" test above exercises — only a
      // genuine keystroke (write()'s own isGenuineUserInput check) clears
      // it, not mere output.
      session.emitHookEvent({ kind: "notification", title: "Permission needed", body: "" });
      expect(session.toInfo().attention).toBe(true);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(0);
        session.write("a".repeat(4 * 1024 * 1024)); // fills the cap
        fakePtyChildren[0].writeSpy.mockClear();

        // Dropped by the cap, but it's still a genuine keystroke — the
        // attention flag above must still clear. Only the actual
        // ptyProcess.write() call is skipped on a drop; everything else in
        // write() (lastUserInputAt, the genuine-user-input transition) runs
        // unconditionally.
        session.write("y");
        expect(fakePtyChildren[0].writeSpy).not.toHaveBeenCalled();
        expect(session.toInfo().attention).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("agent-driven input (sessions.prompt)", () => {
    it("writeAgentInput delivers bytes but, unlike write(), leaves a confirmed attention flag alone", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "notification", title: "Permission needed", body: "" });
      expect(session.toInfo().attention).toBe(true);

      expect(session.writeAgentInput("y")).toBe(true);
      expect(fakePtyChildren[0].writeSpy).toHaveBeenCalledWith("y");
      // A parent prompting a child is not the human acknowledging the badge.
      expect(session.toInfo().attention).toBe(true);

      session.write("y");
      expect(session.toInfo().attention).toBe(false);
    });

    it("writeAgentInput reports a backpressure drop (and delivery when the window resets)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(0);
        expect(session.writeAgentInput("a".repeat(4 * 1024 * 1024))).toBe(true);
        fakePtyChildren[0].writeSpy.mockClear();
        expect(session.writeAgentInput("b")).toBe(false);
        expect(fakePtyChildren[0].writeSpy).not.toHaveBeenCalled();
        vi.setSystemTime(1_001);
        expect(session.writeAgentInput("c")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("beginAgentTurn clears the previous turn's finished latch and stale error, emitting agent_prompt only on a real change", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const reasons = () =>
        session
          .getEvents()
          .filter((e) => e.kind === "status_change")
          .map((e) => (e.payload as { reason?: string }).reason);

      // Nothing latched: no change, no event.
      const before = session.eventSeqHead;
      session.beginAgentTurn();
      expect(session.eventSeqHead).toBe(before);

      session.emitHookEvent({ kind: "progress", phase: "done" });
      expect(session.toInfo().lastTurnEndedAt).not.toBeNull();
      session.beginAgentTurn();
      expect(session.toInfo().lastTurnEndedAt).toBeNull();
      expect(reasons()).toContain("agent_prompt");
    });

    // Issue #1735 — a machine-woken turn is not a turn END.
    //
    // Before this, EVERY `progress: done` latched the turn end, so a
    // session that loops internally tripped the reconciler's
    // `in_progress -> reviewing` gate MID-LOOP: the task advanced to
    // "reviewing" while the worker was still writing, and the review agent
    // judged an incomplete diff in the same worktree.
    describe("the turn source decides whether the WORK finished (issue #1735)", () => {
      async function sessionWith(): Promise<ReturnType<typeof manager.getOrCreate>> {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        return session;
      }

      it("latches the turn end UNCONDITIONALLY, even for a machine-woken turn", async () => {
        // The latch also drives the derived `finished` status,
        // `agentTurnInFlight` (and through it the control socket's 409 for a
        // busy agent) and the "Finished" ping. A machine-woken turn ends
        // just as really as a human's, so holding the latch back would
        // break all three.
        const session = await sessionWith();
        session.emitHookEvent({ kind: "turn_start", promptSource: "loop_wakeup" });
        session.emitHookEvent({ kind: "progress", phase: "done" });
        expect(session.toInfo().lastTurnEndedAt).not.toBeNull();
      });

      it("does NOT mark the work finished for a machine-woken turn with a wakeup pending", async () => {
        // The mid-loop case: the agent armed one more wakeup, so the
        // session is about to be woken again to keep working. The
        // reconciler's worker->review gate reads THIS signal, so the task
        // does not advance mid-loop.
        const session = await sessionWith();
        session.emitHookEvent({ kind: "turn_start", promptSource: "loop_wakeup" });
        session.emitHookEvent({ kind: "progress", phase: "done", wakeupsPending: true });
        expect(session.toInfo().lastTurnEndedAt).not.toBeNull();
        expect(session.toInfo().workFinishedAt).toBeNull();
      });

      it("DOES mark the work finished for a machine-woken turn with NOTHING pending", async () => {
        // The `/loop`'s FINAL iteration: the agent armed one more wakeup
        // every iteration but the last, so the final turn ends with an
        // empty `session_crons` — and the task must be able to advance.
        const session = await sessionWith();
        session.emitHookEvent({ kind: "turn_start", promptSource: "loop_wakeup" });
        session.emitHookEvent({ kind: "progress", phase: "done", wakeupsPending: false });
        expect(session.toInfo().workFinishedAt).not.toBeNull();
      });

      it("DOES mark the work finished for a human's turn", async () => {
        const session = await sessionWith();
        session.emitHookEvent({ kind: "turn_start", promptSource: "user" });
        session.emitHookEvent({ kind: "progress", phase: "done" });
        expect(session.toInfo().workFinishedAt).not.toBeNull();
      });

      it("DOES mark the work finished for the non-interactive entrypoint", async () => {
        // Task Master's own workers run through it: if it did not count,
        // Task Master would never reach "reviewing" at all.
        const session = await sessionWith();
        session.emitHookEvent({ kind: "turn_start", promptSource: "sdk" });
        session.emitHookEvent({ kind: "progress", phase: "done" });
        expect(session.toInfo().workFinishedAt).not.toBeNull();
      });

      it("DOES mark the work finished when the source is absent — today's behaviour", async () => {
        // The field is still rolling out upstream, and no other CLI sends
        // one: on those, nothing changes.
        const session = await sessionWith();
        session.emitHookEvent({ kind: "turn_start" });
        session.emitHookEvent({ kind: "progress", phase: "done" });
        expect(session.toInfo().workFinishedAt).not.toBeNull();
      });

      it("clears the work-finished signal on the next turn", async () => {
        const session = await sessionWith();
        session.emitHookEvent({ kind: "turn_start", promptSource: "user" });
        session.emitHookEvent({ kind: "progress", phase: "done" });
        expect(session.toInfo().workFinishedAt).not.toBeNull();
        session.emitHookEvent({ kind: "turn_start", promptSource: "user" });
        expect(session.toInfo().workFinishedAt).toBeNull();
      });

      it("still releases the permission/plan latches for a machine-woken turn", async () => {
        // The agent DID move on, so the observational latches are released
        // exactly as before.
        const session = await sessionWith();
        session.emitHookEvent({
          kind: "permission_request",
          tool: "Bash",
          summary: "run the tests",
        });
        expect(session.toInfo().permissionState).not.toBe("idle");

        session.emitHookEvent({ kind: "turn_start", promptSource: "loop_wakeup" });
        expect(session.toInfo().permissionState).toBe("idle");
      });

      it("carries the source on the turn_start event, for the timeline", async () => {
        const session = await sessionWith();
        session.emitHookEvent({ kind: "turn_start", promptSource: "loop_wakeup" });
        const event = session.getEvents().find((e) => e.kind === "status_change");
        expect(event?.payload).toMatchObject({ phase: "generating", promptSource: "loop_wakeup" });
      });
    });

    it("beginAgentTurn does not run the attention 'userInput' clear", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "notification", title: "Permission needed", body: "" });
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.beginAgentTurn();
      expect(session.toInfo().attention).toBe(true);
    });

    it("agentTurnInFlight: set by beginAgentTurn, cleared by a later turn end, by the staleness cap, or by a respawn", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.agentTurnInFlight).toBe(false);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(1_000_000);
        session.beginAgentTurn();
        expect(session.agentTurnInFlight).toBe(true);

        // A turn end AFTER the prompt ends it…
        vi.setSystemTime(1_005_000);
        session.emitHookEvent({ kind: "progress", phase: "done" });
        expect(session.agentTurnInFlight).toBe(false);

        // …a new prompt starts a fresh one, which the staleness cap bounds.
        vi.setSystemTime(1_010_000);
        session.beginAgentTurn();
        expect(session.agentTurnInFlight).toBe(true);
        vi.setSystemTime(1_010_000 + 15 * 60_000 + 1);
        expect(session.agentTurnInFlight).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("tracks the app's bracketed-paste mode", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.bracketedPaste).toBe(false);
      fakePtyChildren[0].emitData("\u001b[?2004h");
      expect(session.bracketedPaste).toBe(true);
      fakePtyChildren[0].emitData("\u001b[?2004l");
      expect(session.bracketedPaste).toBe(false);
    });
  });

  it("resize updates the tracked size and calls through to the pty", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.resize(120, 40);
    expect(fakePtyChildren[0].resizeSpy).toHaveBeenCalledWith(120, 40);
  });

  // Issue #676 — a promoted session's brand-new dockview panel can attach
  // with a garbage-tiny size (production incident: a real WS attach with
  // cols=10&rows=13), which reaches here as a real resize and silently
  // killed a freshly-booted opencode session (its own "terminal too small"
  // exit path, reproduced in isolation with no dtach/nudge/worktree
  // involved). Session must never construct or resize below the floor.
  it("clamps an initial spawn size below the floor", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 10,
      rows: 5,
    });
    await waitForSpawn(session);

    expect(session.toInfo().cols).toBe(40);
    expect(session.toInfo().rows).toBe(10);
    // attachClient() spawns the pty at the (already-clamped) tracked size.
    expect(fakePtyChildren[0].cols).toBe(40);
    expect(fakePtyChildren[0].rows).toBe(10);
  });

  it("does not clamp an initial spawn size that's already at or above the floor", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    expect(session.toInfo().cols).toBe(80);
    expect(session.toInfo().rows).toBe(24);
    expect(fakePtyChildren[0].cols).toBe(80);
    expect(fakePtyChildren[0].rows).toBe(24);
  });

  it("clamps a resize() call below the floor, and calls through to the pty with the clamped size", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.resize(10, 5);
    expect(fakePtyChildren[0].resizeSpy).toHaveBeenCalledWith(40, 10);
    expect(session.toInfo().cols).toBe(40);
    expect(session.toInfo().rows).toBe(10);
  });

  it("does not clamp a resize() call that's already at or above the floor", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.resize(120, 40);
    expect(fakePtyChildren[0].resizeSpy).toHaveBeenCalledWith(120, 40);
    expect(session.toInfo().cols).toBe(120);
    expect(session.toInfo().rows).toBe(40);
  });

  // Dock monitor resize-runaway — a client-driven resize feedback loop (or
  // any other misbehaving caller) sent an unbounded cols/rows to the pty
  // with no ceiling to catch it. MIN_TERMINAL_COLS/ROWS's own doc comment
  // covers the floor; this pins the analogous ceiling.
  it("clamps an initial spawn size above the ceiling", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 35_140,
      rows: 9_000,
    });
    await waitForSpawn(session);

    expect(session.toInfo().cols).toBe(MAX_TERMINAL_COLS);
    expect(session.toInfo().rows).toBe(MAX_TERMINAL_ROWS);
    expect(fakePtyChildren[0].cols).toBe(MAX_TERMINAL_COLS);
    expect(fakePtyChildren[0].rows).toBe(MAX_TERMINAL_ROWS);
  });

  it("clamps a resize() call above the ceiling, and calls through to the pty with the clamped size", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.resize(35_140, 9_000);
    expect(fakePtyChildren[0].resizeSpy).toHaveBeenCalledWith(MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS);
    expect(session.toInfo().cols).toBe(MAX_TERMINAL_COLS);
    expect(session.toInfo().rows).toBe(MAX_TERMINAL_ROWS);
  });

  it("requestRedraw dips then restores rows to force a repaint", async () => {
    // Fake only setTimeout/clearTimeout — RedrawNudge.trigger()'s the sole
    // user of real timers on this path, and leaving setImmediate real keeps
    // waitForSpawn's polling loop and the mocked child_process bootstrap
    // (both setImmediate-based) working exactly as in every other test here.
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
      const pty = fakePtyChildren[0];

      // Flush the spawn-time nudge (attachClient() -> RedrawNudge.trigger())
      // so it doesn't interfere with the assertions below.
      await vi.advanceTimersByTimeAsync(700);
      pty.resizeSpy.mockClear();

      session.requestRedraw();
      expect(pty.resizeSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 12); // max(4, floor(24 / 2))

      await vi.advanceTimersByTimeAsync(400);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requestRedraw called again before the first dip fires coalesces into one cycle", async () => {
    // Regression test for the overlapping-nudge-cycles bug (issue #107): two
    // unserialized RedrawNudge.trigger() calls used to schedule fully
    // independent dip/restore/grace-reset timers, so a second reattach
    // landing while a first cycle was still in flight produced FOUR resize
    // calls (two dips, two restores) instead of one clean pair, and could
    // let the first cycle's grace-reset clear suppression mid-repaint (see
    // the next test).
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
      const pty = fakePtyChildren[0];

      await vi.advanceTimersByTimeAsync(700);
      pty.resizeSpy.mockClear();

      session.requestRedraw();
      // Re-nudge BEFORE the first cycle's dip (300ms) fires — RedrawNudge.
      // cancel() clears its still-pending dip timer, so the first cycle
      // never produces any resize call at all; only the second
      // (superseding) cycle's own dip/restore should ever fire.
      await vi.advanceTimersByTimeAsync(100);
      session.requestRedraw();

      // Second cycle's dip fires 300ms after ITS OWN call (at local t=400).
      await vi.advanceTimersByTimeAsync(300);
      expect(pty.resizeSpy).toHaveBeenCalledTimes(1);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 12);

      // Second cycle's restore fires 400ms after its dip (at local t=800).
      await vi.advanceTimersByTimeAsync(400);
      expect(pty.resizeSpy).toHaveBeenCalledTimes(2);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a same-size resize() mid-nudge does not cancel the pending dip/restore", async () => {
    // Regression test: it's tempting to have resize() cancel any in-flight
    // nudge (a real dimension change already forces its own repaint, so the
    // synthetic one seems redundant) — but the frontend's on-open resize
    // (sendResizeIfOpen) has no delta guard and resends the CURRENT size on
    // every attach. A same-size resize() is a kernel-level no-op (no
    // SIGWINCH), so if it cancelled the pending nudge, the nudge — the only
    // thing that would force a repaint — would never run, reintroducing the
    // Milestone-1 blank-screen-on-reconnect bug. This asserts the nudge
    // survives a same-size resize() landing mid-cycle.
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
      const pty = fakePtyChildren[0];

      await vi.advanceTimersByTimeAsync(700);
      pty.resizeSpy.mockClear();

      session.requestRedraw();
      await vi.advanceTimersByTimeAsync(300);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 12); // dip fired

      // A resize to the SAME size the session already has (80, 24) — exactly
      // what sendResizeIfOpen's no-delta-guard resend looks like.
      session.resize(80, 24);
      // Clear right after the manual call: asserting the restore's args
      // alone wouldn't discriminate here, since the manual resize() already
      // set this.cols/this.rows to (80, 24) — a naive "last called with
      // (80, 24)" check would pass whether or not the restore actually
      // fires, because the manual call alone satisfies it. Clearing first
      // and asserting a call COUNT after is what actually proves the
      // restore ran rather than got silently cancelled.
      pty.resizeSpy.mockClear();

      await vi.advanceTimersByTimeAsync(400);
      expect(pty.resizeSpy).toHaveBeenCalledTimes(1);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an earlier nudge cycle's cancelled grace-reset can't clear suppression for a still-in-flight later cycle", async () => {
    // Regression test for the core cross-cycle race (issue #107): the OLD
    // code's three bare setTimeouts per cycle meant a first cycle's
    // grace-reset (suppressed = false) could fire while a SECOND, later
    // cycle's own dip/restore repaint was still genuinely in flight —
    // letting that second cycle's own reduced-height dip frame leak into
    // scrollback and get replayed to a future attach. RedrawNudge.cancel()
    // fixes this by cancelling whichever single stage is pending (including
    // an already-scheduled grace-reset) the instant a new cycle starts.
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
      const pty = fakePtyChildren[0];

      await vi.advanceTimersByTimeAsync(700 + 500);
      const before = session.getScrollback().toString();

      // Cycle 1 (local t=0): dip@300, restore@700, grace-reset@1200.
      session.requestRedraw();
      // Advance past cycle 1's restore (700) so its grace-reset is now the
      // single pending timer, scheduled to fire at t=1200.
      await vi.advanceTimersByTimeAsync(800);

      // Cycle 2 starts at t=800 — RedrawNudge.cancel() cancels cycle 1's
      // still-pending grace-reset (would have fired at t=1200) before it can
      // run, then schedules its own: dip@1100, restore@1500, grace@2000.
      session.requestRedraw();

      // Advance to cycle 1's ORIGINAL (now-cancelled) grace-reset time,
      // t=1200. Cycle 2's dip (t=1100) has already fired but its restore
      // (t=1500) hasn't — cycle 2's own repaint is legitimately still in
      // flight. Without the fix, cycle 1's grace-reset would have fired here
      // and wrongly cleared suppression.
      await vi.advanceTimersByTimeAsync(1200 - 800);
      pty.emitData("mid-cycle-2 repaint frame");
      expect(session.getScrollback().toString()).toBe(before);

      // Advance past cycle 2's OWN grace-reset (t=2000) — suppression should
      // now be genuinely lifted.
      await vi.advanceTimersByTimeAsync(2000 - 1200);
      pty.emitData("post-nudge output");
      expect(session.getScrollback().toString()).toBe(`${before}post-nudge output`);
    } finally {
      vi.useRealTimers();
    }
  });
});
