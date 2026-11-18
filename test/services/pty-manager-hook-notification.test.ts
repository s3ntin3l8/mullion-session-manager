// emitHookEvent (issue #176) — notifications, progress/turn ends, the deferred agentIdle ping, and the sticky needs_input clears.
//
// Split out of the former test/services/pty-manager.test.ts (issue #3277) —
// that file sat at the file-size ratchet's ceiling, so a change here could no
// longer land next to the tests it belongs with. The shared mock preamble and
// helpers live in test/helpers/pty-manager-harness.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  bundleSyncMock,
  cgroupInventoryMock,
  childProcessMock,
  createPtyManagerFixture,
  destroyPtyManagerFixture,
  nodePtyMock,
  resetPtyManagerMocks,
  waitForSpawn,
} from "../helpers/pty-manager-harness.js";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager } = await import("../../src/services/pty-manager.js");

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

  describe("emitHookEvent (issue #176)", () => {
    it("notification: emits an attention event carrying title/body and flips SessionInfo.attention", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({ kind: "notification", title: "Build done", body: "0 errors" });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("attention");
      expect(event.payload).toEqual({
        attention: true,
        signal: "hookNotification",
        title: "Build done",
        body: "0 errors",
      });
      expect(session.toInfo().attention).toBe(true);
    });

    it("notification: still emits a fresh event with new title/body even when attention is already confirmed", async () => {
      // Regression test: confirmAttention()'s `alreadyConfirmed` guard
      // suppresses re-emitting for a repeat GENERIC signal (correct for a
      // second bell while already confirmed) — but a hook notification's
      // title/body is never "nothing new", and emitAttentionSignalWithExtras()
      // must not silently drop it just because attention was already true.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "notification", title: "First", body: "one" });
      expect(session.toInfo().attention).toBe(true);

      session.emitHookEvent({ kind: "notification", title: "Second", body: "two" });

      const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
      expect(attentionEvents).toHaveLength(2);
      expect(attentionEvents[1].payload).toEqual({
        attention: true,
        signal: "hookNotification",
        title: "Second",
        body: "two",
      });
    });

    it("notification: suppressed when a structured ask (question) is already pending and recent (issue #903)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "question", state: "started", header: "Stack menu" });
      const beforeCount = session.getEvents().filter((e) => e.kind === "attention").length;

      session.emitHookEvent({
        kind: "notification",
        title: "Claude Code",
        body: "Claude needs your permission",
      });

      const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
      expect(attentionEvents).toHaveLength(beforeCount);
    });

    it("notification: still emits when a structured ask is pending but stale (issue #903 — must not silently swallow notifications forever)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "question", state: "started", header: "Stack menu" });
      // Simulate the D4-style stuck-latch case directly: questionState
      // stays "pending" but questionAt is old — a sticky latch that never
      // got its own release, per the D4 incident this suppression's own
      // doc comment cites. A recency-unbounded check would drop every
      // notification for this session forever; the bound must not.
      const hourAgo = Date.now() - 60 * 60 * 1000;
      (session as unknown as { questionAt: number }).questionAt = hourAgo;

      session.emitHookEvent({
        kind: "notification",
        title: "Claude Code",
        body: "Claude needs your permission",
      });

      const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
      expect(attentionEvents.at(-1)).toMatchObject({
        payload: expect.objectContaining({ signal: "hookNotification" }),
      });
    });

    it("notification: does NOT suppress when it arrives BEFORE the structured ask's own latch is set (known ordering limitation, code review)", async () => {
      // hasRecentStructuredAsk only catches ONE race ordering — the latch
      // going pending BEFORE the generic notification is processed (the
      // other two tests above). Two independent forwarder subprocesses have
      // no ordering guarantee, so the reverse — notification processed
      // first, question's own latch set only afterward — is a real, accepted
      // gap: nothing here retroactively suppresses an already-emitted row.
      // Documented as a known limitation on RECENT_STRUCTURED_ASK_MS's own
      // doc comment rather than silently untested.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "notification",
        title: "Claude Code",
        body: "Claude needs your permission",
      });
      session.emitHookEvent({ kind: "question", state: "started", header: "Stack menu" });

      const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
      const notificationEmits = attentionEvents.filter(
        (e) => (e.payload as { signal?: string }).signal === "hookNotification",
      );
      expect(notificationEmits).toHaveLength(1);
    });

    it("notification: still emits when no structured ask is pending (fallback role preserved)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "notification", title: "opencode", body: "Build finished" });

      const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
      expect(attentionEvents.at(-1)).toMatchObject({
        payload: expect.objectContaining({ signal: "hookNotification" }),
      });
    });

    it("progress: emits a status_change event with the phase, no attention change", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "progress", phase: "thinking" });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("status_change");
      expect(event.payload).toEqual({ phase: "thinking" });
      expect(session.toInfo().attention).toBe(false);
    });

    it("progress: forwards 'detail' into the status_change payload when present (issue #321)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "generating",
        detail: "retry attempt 2: rate limited",
      });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("status_change");
      expect(event.payload).toEqual({
        phase: "generating",
        detail: "retry attempt 2: rate limited",
      });
    });

    it("progress (done): also flips attention via the authoritative agentIdle signal", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({ kind: "progress", phase: "done" });
      // agentIdle now settles for 3s (ATTENTION_SETTLE_MS) before it
      // confirms — advance past that window (see cancelDeferred's own
      // comment for why a plain tick, with no intervening
      // progress:generating, lets it confirm rather than cancel).
      session.tick(Date.now() + 3_000);

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual(["status_change", "attention"]);
      expect(events[1].payload).toEqual({ attention: true, signal: "agentIdle" });
      expect(session.toInfo().attention).toBe(true);
    });

    // Issue #428 — the core bug: a Stop hook (progress:done) firing while
    // Claude Code reports outstanding backgroundTasks (a background Agent/
    // Task call from the same turn) must NOT fire the premature "your move"
    // agentIdle ping, even though it still latches lastTurnEndedAt.
    it("progress (done) with outstanding backgroundTasks: latches lastTurnEndedAt but gates agentIdle", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual(["status_change"]);
      expect(session.toInfo().attention).toBe(false);
      expect(session.toInfo().lastTurnEndedAt).not.toBeNull();
      expect(session.toInfo().outstandingBackgroundTasks).toEqual([
        { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
      ]);
    });

    it("a later progress message whose backgroundTasks have all drained fires the deferred agentIdle", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
        ],
      });
      // The drain resolves resolveDeferredTurnEnd()'s guards and SCHEDULES
      // the ping (ATTENTION_SETTLE_MS's 3s agentIdle window) rather than
      // firing it immediately — advance past it.
      session.tick(Date.now() + 3_000);

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual(["status_change", "status_change", "attention"]);
      expect(events[2].payload).toEqual({ attention: true, signal: "agentIdle" });
      expect(session.toInfo().attention).toBe(true);
      expect(session.toInfo().outstandingBackgroundTasks).toEqual([]);
    });

    // Issue #428 — the drain signal in practice: a background subagent's own
    // SubagentStop (not a further "progress" message — the parent's turn has
    // already ended) reports the outstanding list emptied.
    it("SubagentStop carrying a drained backgroundTasks list fires the deferred agentIdle with no intervening progress message", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({
        kind: "subagent",
        state: "finished",
        agentType: "Explore",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
        ],
      });
      // Same as the previous test — the drain SCHEDULES the deferred ping;
      // advance past its 3s settle window.
      session.tick(Date.now() + 3_000);

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual([
        "status_change",
        "status_change",
        "status_change",
        "attention",
      ]);
      expect(events[3].payload).toEqual({ attention: true, signal: "agentIdle" });
      expect(session.toInfo().attention).toBe(true);
      expect(session.toInfo().outstandingBackgroundTasks).toEqual([]);
    });

    // Hermes review, PR #453 — resolveDeferredTurnEnd() must only run for a
    // "subagent" hook message that actually carries backgroundTasks. Calling
    // it unconditionally for every subagent message (including a plain
    // "started"/"finished" with no backgroundTasks field) would re-fire
    // agentIdle for an already-resolved turn end the moment ANY unrelated
    // subagent activity arrives afterward, since lastTurnEndedAt stays
    // latched until the next turn_start/keystroke.
    it("a plain subagent message with no backgroundTasks field does not re-fire agentIdle for an already-resolved turn end", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // An ordinary Stop with no backgroundTasks at all — resolves and
      // schedules the deferred agentIdle ping, same as any plain "done".
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.tick(Date.now() + 3_000); // past ATTENTION_SETTLE_MS.agentIdle
      expect(session.toInfo().attention).toBe(true);
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);

      // A later, wholly unrelated subagent event (no backgroundTasks field)
      // arrives before the user has typed anything or a new turn started.
      session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });

      // Must NOT have fired a second agentIdle.
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);
    });

    // Hermes review, PR #453 — a late/reordered SubagentStop re-reporting
    // the SAME already-drained backgroundTasks state (Claude Code re-sends
    // the full list on every Stop/SubagentStop) must not re-fire agentIdle
    // for a turn end that already got its ping — the one-shot guard
    // (turnEndPingSent) exists specifically for this.
    it("a SubagentStop re-reporting an already-drained backgroundTasks state does not re-fire agentIdle", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      expect(session.toInfo().attention).toBe(false);

      const drainedTasks = [
        { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
      ];
      session.emitHookEvent({
        kind: "subagent",
        state: "finished",
        agentType: "Explore",
        backgroundTasks: drainedTasks,
      });
      // The drain SCHEDULES the deferred ping; confirm it before asserting.
      session.tick(Date.now() + 3_000);
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);

      // A late/reordered duplicate SubagentStop reports the same drained
      // state again, before the user has typed anything or a new turn
      // started.
      session.emitHookEvent({
        kind: "subagent",
        state: "finished",
        agentType: "Explore",
        backgroundTasks: drainedTasks,
      });

      // Must still be exactly one agentIdle, not two.
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);
    });

    it("a fresh progress:done latch gets its own ping even if a prior latch's ping already fired and the user hasn't typed since", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // First plain "done" — schedules the deferred ping; confirm it.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.tick(Date.now() + 3_000);
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);

      // A second, independent "done" (e.g. a distinct later Stop) — this is
      // a genuinely NEW turn-end occurrence and gets its own single ping
      // (its own fresh settle window), not suppressed by the prior latch's
      // one-shot guard.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.tick(Date.now() + 3_000);
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(2);
    });

    it("a progress:done with no backgroundTasks field (e.g. idle_prompt) does not wipe a previously-latched outstanding set", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      // A second "done" with no backgroundTasks field at all (the
      // idle_prompt-mapped notification path never carries one).
      session.emitHookEvent({ kind: "progress", phase: "done" });

      expect(session.toInfo().outstandingBackgroundTasks).toEqual([
        { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
      ]);
      expect(session.toInfo().attention).toBe(false);
    });

    it("turn_start clears a latched outstanding backgroundTasks set", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      expect(session.toInfo().outstandingBackgroundTasks).toHaveLength(1);

      session.emitHookEvent({ kind: "turn_start" });

      expect(session.toInfo().outstandingBackgroundTasks).toEqual([]);
      expect(session.toInfo().lastTurnEndedAt).toBeNull();
    });

    it("fix: sticky needs_input (D4) — progress:done pairs its planState/permissionState/questionState resets with clearIfConfirmedKind, so a confirmed planReady no longer survives its own latch going idle", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "plan_ready", plan: "do the thing" });
      expect(session.toInfo()).toMatchObject({
        attention: true,
        attentionKind: "planReady",
        planState: "pending",
      });

      // progress:done resets planState to idle directly (see hook-handlers.ts's
      // "progress" case), then its own resolveDeferredTurnEnd() unconditionally
      // fires an `agentIdle` signal (nothing outstanding) — a legitimate,
      // separate "the turn just ended" reason for attention to stay true
      // (deriveSessionStatus reads this as `finished`, which outranks
      // `needs_input` anyway). Before this fix, planState's own reset ran
      // WITHOUT calling clearIfConfirmedKind first: the confirmed planReady
      // (output-immune) survived that unrelated agentIdle signal too —
      // moreAuthoritativeKind refuses to let a non-immune incoming kind
      // downgrade an already-confirmed immune one — so confirmedKind stayed
      // "planReady" forever, an orphan the sweep in
      // clearStaleBlockedIfOlderThan can't reach either (it only clears a
      // latch that's still stale-AND-set, and this path nulls it in the same
      // statement). Fixed by pairing each latch reset with its own
      // clearIfConfirmedKind call BEFORE resolveDeferredTurnEnd() runs: the
      // orphaned planReady is cleared first, so agentIdle then confirms
      // fresh as the CURRENT, honest confirmedKind instead — once its own
      // settle window (ATTENTION_SETTLE_MS) elapses; the clearing of
      // planReady itself is still synchronous, only agentIdle's own
      // confirmation is deferred.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.tick(Date.now() + 3_000);

      expect(session.toInfo()).toMatchObject({
        planState: "idle",
        attention: true,
        attentionKind: "agentIdle",
      });
    });

    it("fix: sticky needs_input (D4) — turn_start unconditionally clears the attention machine, closing the one orphan class progress:done's own paired clears can't reach: a bare, generic hookNotification with no owning per-state latch to pair a clear against", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // No specific dialog behind this — a plain Notification hook message,
      // exactly the "hookNotification has no owning latch" case the stale
      // sweep also deliberately leaves alone (see that describe block's own
      // negative test).
      session.emitHookEvent({ kind: "notification", title: "heads up", body: "" });
      expect(session.toInfo().attention).toBe(true);

      // progress:done's own resolveDeferredTurnEnd() fires `agentIdle` here,
      // but moreAuthoritativeKind refuses to let that non-immune signal
      // downgrade the already-confirmed immune hookNotification — it
      // survives, same as any other repaint/non-immune signal would.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      expect(session.toInfo().attention).toBe(true);

      session.emitHookEvent({ kind: "turn_start" });

      expect(session.toInfo().attention).toBe(false);
    });
  });
});
