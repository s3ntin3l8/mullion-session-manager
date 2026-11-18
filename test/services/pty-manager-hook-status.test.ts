// emitHookEvent (issue #176) — tool_failure, session_end, plan_ready, the ExitPlanMode dedup, the output watermark and the tool_done release semantics.
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

  afterEach(() => {
    destroyPtyManagerFixture({ sessionsDir, manager });
  });

  describe("emitHookEvent (issue #176)", () => {
    it("tool_failure: sets errorState to tool_failure and emits a tool_failure event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().errorState).toBe("idle");

      session.emitHookEvent({
        kind: "tool_failure",
        tool: "Bash",
        error: "Command failed",
        summary: "ls: no such file",
      });

      // Same shape as stop_failure above — the tool_failure NotificationEvent
      // is immediate, only the trailing `attention` (toolFailure) ping is
      // deferred.
      expect(session.toInfo().errorState).toBe("tool_failure");
      session.tick(Date.now() + 2_000);
      const events = session.getEvents();
      const event = events[events.length - 2];
      expect(event.kind).toBe("tool_failure");
      expect(event.payload).toEqual({
        tool: "Bash",
        error: "Command failed",
        summary: "ls: no such file",
        agentId: null,
      });
      expect(events[events.length - 1].kind).toBe("attention");
    });

    it("session_end: sets endedReason and emits a session_end event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().endedReason).toBeNull();
      expect(session.toInfo().exitCode).toBeNull();

      session.emitHookEvent({ kind: "session_end", reason: "finished" });

      expect(session.toInfo().endedReason).toBe("finished");
      expect(session.toInfo().exitCode).toBeNull();
      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("session_end");
      expect(event.payload).toEqual({ reason: "finished", exitCode: null });
    });

    it("session_end: carries exitCode through to SessionInfo and the event payload when the adapter reports one", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "session_end", reason: "crashed", exitCode: 1 });

      expect(session.toInfo().exitCode).toBe(1);
      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.payload).toEqual({ reason: "crashed", exitCode: 1 });
    });

    it("plan_ready: sets planState to pending and emits a plan_ready event + flips attention", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().planState).toBe("idle");
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({
        kind: "plan_ready",
        plan: "1. Fix bug\n2. Test",
        summary: "Fix the issue",
      });

      expect(session.toInfo().planState).toBe("pending");
      const events = session.getEvents();
      const planEvent = events[events.length - 2];
      expect(planEvent.kind).toBe("plan_ready");
      expect(planEvent.payload).toEqual({
        plan: "1. Fix bug\n2. Test",
        filePath: null,
        summary: "Fix the issue",
      });
      const attentionEvent = events[events.length - 1];
      expect(attentionEvent.kind).toBe("attention");
      expect(attentionEvent.payload).toMatchObject({ attention: true, signal: "planReady" });
      expect(session.toInfo().attention).toBe(true);
    });

    describe("ExitPlanMode dedup (Hermes review, PR #675)", () => {
      it("the common-order case: plan_ready arrives first (as it reliably does — PreToolUse before PermissionRequest), so the later permission_request{ExitPlanMode} is a no-op and 'Plan ready' wins", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix bug" });
        expect(session.toInfo()).toMatchObject({
          planState: "pending",
          permissionState: "idle",
          attentionKind: "planReady",
        });
        const eventsBefore = session.getEvents().length;

        session.emitHookEvent({
          kind: "permission_request",
          tool: "ExitPlanMode",
          summary: "ExitPlanMode",
        });

        // A genuine no-op: no new event at all, not even a suppressed one.
        expect(session.getEvents().length).toBe(eventsBefore);
        expect(session.toInfo()).toMatchObject({
          planState: "pending",
          permissionState: "idle",
          attentionKind: "planReady",
        });
      });

      it("the fallback case: plan_ready never arrives at all (PreToolUse hook missing/not registered) — permission_request{ExitPlanMode} still shows SOMETHING rather than nothing", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "permission_request",
          tool: "ExitPlanMode",
          summary: "ExitPlanMode",
        });
        // permissionState updates synchronously; attentionKind only reaches
        // "permissionRequest" once the settle window confirms it.
        session.tick(Date.now() + 2_000);

        expect(session.toInfo()).toMatchObject({
          permissionState: "pending",
          planState: "idle",
          attentionKind: "permissionRequest",
        });
      });

      it("the reordered case: permission_request{ExitPlanMode} arrives BEFORE plan_ready — the fallback permissionState is superseded once the real plan_ready lands, so 'Plan ready' still wins", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "permission_request",
          tool: "ExitPlanMode",
          summary: "ExitPlanMode",
        });
        expect(session.toInfo()).toMatchObject({ permissionState: "pending" });

        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix bug" });

        expect(session.toInfo()).toMatchObject({
          permissionState: "idle",
          planState: "pending",
          attentionKind: "planReady",
        });
      });

      it("permission_request for a DIFFERENT tool while planState is pending is NOT deduped — the dedup is scoped to ExitPlanMode specifically", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix bug" });
        session.emitHookEvent({
          kind: "permission_request",
          tool: "Bash",
          summary: "rm -rf /tmp/x",
        });

        expect(session.toInfo()).toMatchObject({
          planState: "pending",
          permissionState: "pending",
        });
      });
    });

    it("outputOffset / getOutputSince (issue #1625): returns exactly the output produced after a watermark", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const before = session.outputOffset;
      expect(session.getOutputSince(before).length).toBe(0);
      fakePtyChildren[fakePtyChildren.length - 1].emitData("hello world");
      expect(session.getOutputSince(before).toString("utf8")).toBe("hello world");
      // A watermark from the future (e.g. a pre-restart cursor) is simply empty.
      expect(session.getOutputSince(session.outputOffset + 1000).length).toBe(0);
    });

    it("self-reported status (issue #1623): needs_input after done clears the finished latch and raises attention", async () => {
      const { statusHookMessages } = await import("../../src/cli/client.mjs");
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      for (const m of statusHookMessages("done", "finished the task") ?? []) {
        session.emitHookEvent(m);
      }
      expect(session.toInfo().lastTurnEndedAt).not.toBeNull();

      for (const m of statusHookMessages("needs_input", "approve the deploy") ?? []) {
        session.emitHookEvent(m);
      }
      const info = session.toInfo();
      expect(info.lastTurnEndedAt).toBeNull();
      expect(info.attention).toBe(true);

      // `working` after that clears attention again and leaves no finished latch.
      for (const m of statusHookMessages("working") ?? []) session.emitHookEvent(m);
      expect(session.toInfo().lastTurnEndedAt).toBeNull();
    });

    it("turn_start: releases permissionState/planState/elicitationState/errorState and the finished latch", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // "progress: done" already resets permissionState/planState/errorState
      // to idle and latches lastTurnEndedAt (pre-existing behavior) — emit it
      // FIRST, then re-raise permissionState/planState/errorState afterward,
      // so this test exercises turn_start's OWN clearing of every one of
      // these fields simultaneously, not a leftover partial state from
      // progress:done's own clearing.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });
      session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });
      session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });
      expect(session.toInfo()).toMatchObject({
        permissionState: "pending",
        planState: "pending",
        elicitationState: "pending",
        errorState: "tool_failure",
        lastTurnEndedAt: expect.any(Number),
      });

      session.emitHookEvent({ kind: "turn_start" });

      expect(session.toInfo()).toMatchObject({
        permissionState: "idle",
        planState: "idle",
        elicitationState: "idle",
        elicitationServer: null,
        errorState: "idle",
        errorDetail: null,
        lastTurnEndedAt: null,
      });
    });

    it("fix: status-clearing-semantics — tool_done releases a pending permissionState when the tool NAME matches, and clears errorState as forward-progress evidence", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });
      expect(session.toInfo()).toMatchObject({
        permissionState: "pending",
        errorState: "tool_failure",
      });
      const eventsBefore = session.getEvents().length;

      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });

      const info = session.toInfo();
      expect(info.permissionState).toBe("idle");
      expect(info.errorState).toBe("idle");
      expect(info.errorDetail).toBeNull();
      const newEvents = session.getEvents().slice(eventsBefore);
      expect(newEvents.filter((e) => e.kind === "status_change")).toHaveLength(1);
    });

    it("fix: status-clearing-semantics — REGRESSION GUARD: a tool_done for a DIFFERENT tool name does NOT release a pending permissionState (the parallel-tool-call case the rejected 'any progress releases' design would have broken)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // Bash is awaiting permission; a concurrent, already-permitted Write
      // call completes first — Claude Code runs tools in parallel, so this
      // ordering is realistic, not contrived.
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "tool_done", tool: "Write" });

      expect(session.toInfo().permissionState).toBe("pending");

      // The matching tool_done, once it finally arrives, still releases it.
      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });
      expect(session.toInfo().permissionState).toBe("idle");
    });

    it("fix: status-clearing-semantics — tool_done releases a pending planState only for ExitPlanMode", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });
      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });
      expect(session.toInfo().planState).toBe("pending");

      session.emitHookEvent({ kind: "tool_done", tool: "ExitPlanMode" });
      expect(session.toInfo().planState).toBe("idle");
    });

    it("fix: AskUserQuestion mislabelled (D3) — tool_done releases a pending questionState only for AskUserQuestion, and clears the attention machine's confirmed 'question' kind with it", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "question", state: "started", header: "Approach?" });
      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });
      expect(session.toInfo()).toMatchObject({ questionState: "pending", attention: true });

      session.emitHookEvent({ kind: "tool_done", tool: "AskUserQuestion" });
      expect(session.toInfo()).toMatchObject({
        questionState: "idle",
        questionHeader: null,
        attention: false,
      });
    });

    it("fix: status-clearing-semantics — a matched release clears pendingPermissionTool, so a LATER tool_done with the same name is a clean no-op rather than matching a stale pending tool", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });
      expect(session.toInfo().permissionState).toBe("idle");
      const eventsBefore = session.getEvents().length;

      // Nothing pending anymore — this must be a genuine no-op, not a match
      // against a leftover pendingPermissionTool.
      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });
      expect(session.getEvents().length).toBe(eventsBefore);
    });

    it("fix: status-clearing-semantics — tool_done never touches gateState/promoteState (Mullion's own REST-resolved dialogs)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "rm -rf /tmp/x" });
      session.emitHookEvent({
        kind: "promote_request",
        summary: "start a worktree session",
      });
      expect(session.toInfo()).toMatchObject({ gateState: "waiting", promoteState: "pending" });

      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });

      expect(session.toInfo()).toMatchObject({ gateState: "waiting", promoteState: "pending" });
    });

    it("fix: status-clearing-semantics — a tool_done that changes nothing emits no status_change", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const eventsBefore = session.getEvents().length;

      session.emitHookEvent({ kind: "tool_done", tool: "Read" });

      expect(session.getEvents().length).toBe(eventsBefore);
    });

    it("fix: status-clearing-semantics — REGRESSION GUARD: 'progress: generating' alone releases nothing (the rejected design this replaces)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });

      session.emitHookEvent({ kind: "progress", phase: "generating" });

      expect(session.toInfo()).toMatchObject({ permissionState: "pending", planState: "pending" });
    });

    it("fix: status-clearing-semantics — a tool_done for a DIFFERENT tool still clears errorState (forward-progress evidence) even when it doesn't release permissionState", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });

      session.emitHookEvent({ kind: "tool_done", tool: "Write" });

      const info = session.toInfo();
      expect(info.errorState).toBe("idle");
      expect(info.permissionState).toBe("pending");
    });

    it("fix: status-clearing-semantics — a genuine keystroke does NOT release permissionState even when its tool matches (arrow keys navigating an open dialog must not blank it)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.write("\x1b[A"); // arrow-key navigation inside the still-open dialog

      expect(session.toInfo().permissionState).toBe("pending");
    });

    it("fix: status-clearing-semantics — a stale errorState and the finished latch survive a reattach-style repaint and later plain output; only a genuine keystroke (or a resolving hook) clears them now that markViewed() is gone. Fix: sticky needs_input — unlike those two, tool_failure's OWN attention flag is no longer output-immune, so it clears on the very next real output chunk instead of waiting for that keystroke", async () => {
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
        await vi.advanceTimersByTimeAsync(700 + 500); // flush the spawn-time nudge

        session.emitHookEvent({ kind: "progress", phase: "done" });
        session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });
        // Both the deferred agentIdle (progress:done) and the deferred
        // toolFailure (tool_failure) ping are still settling — advance past
        // both windows (session.tick() is explicit-clock, unaffected by the
        // faked setTimeout/clearTimeout above). toolFailure drains after
        // agentIdle (insertion order) and neither is immune, so it becomes
        // the final confirmedKind — output-clearable, which is exactly what
        // this test goes on to exercise.
        session.tick(Date.now() + 3_000);
        expect(session.toInfo()).toMatchObject({
          errorState: "tool_failure",
          lastTurnEndedAt: expect.any(Number),
          attention: true,
        });

        // A reattach (opening the workspace tab) forces a repaint — the
        // exact byte pattern markViewed() used to piggyback its "user is
        // looking" clear on. Must no longer clear anything (repaints are
        // suppressed from the attention machine entirely — see
        // redrawNudge.suppressingOutput — regardless of which kind is
        // confirmed).
        session.requestRedraw();
        pty.emitData("repainted frame");
        expect(session.toInfo()).toMatchObject({
          errorState: "tool_failure",
          lastTurnEndedAt: expect.any(Number),
          attention: true,
        });

        // Fix: sticky needs_input (D1) — once the repaint suppression
        // window has fully elapsed, arbitrary later output IS evidence the
        // agent is working again: `toolFailure` is deliberately NOT in
        // OUTPUT_IMMUNE_KINDS (attention-detect.ts), so it clears here —
        // unlike errorState/lastTurnEndedAt, which have no such auto-clear
        // and stay sticky until a keystroke or a resolving hook.
        await vi.advanceTimersByTimeAsync(300 + 400 + 500);
        pty.emitData("just more program output, not a decision");
        expect(session.toInfo()).toMatchObject({
          errorState: "tool_failure",
          lastTurnEndedAt: expect.any(Number),
          attention: false,
        });

        // A genuine keystroke is the replacement unblocking signal for the
        // two latches output alone can't touch.
        const eventsBefore = session.getEvents().length;
        session.write("y");
        const info = session.toInfo();
        expect(info.errorState).toBe("idle");
        expect(info.errorDetail).toBeNull();
        expect(info.lastTurnEndedAt).toBeNull();
        expect(info.attention).toBe(false);
        const newEvents = session.getEvents().slice(eventsBefore);
        expect(newEvents.filter((e) => e.kind === "status_change")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    // Fresh-review finding on PR #453 — this clear path (write()'s
    // genuine-keystroke branch) wasn't exercised by any existing test with
    // backgroundTasks actually set beforehand.
    it("issue #428: a genuine keystroke clears a latched outstanding backgroundTasks set", async () => {
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

      const eventsBefore = session.getEvents().length;
      session.write("y");

      const info = session.toInfo();
      expect(info.outstandingBackgroundTasks).toEqual([]);
      expect(info.lastTurnEndedAt).toBeNull();
      const newEvents = session.getEvents().slice(eventsBefore);
      expect(newEvents.filter((e) => e.kind === "status_change")).toHaveLength(1);

      // The one-shot guard resets too — a later, unrelated Stop for a NEW
      // turn (no outstanding work) fires its own ping rather than being
      // silently suppressed by stale one-shot state from before the
      // keystroke.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      // This turn-end resolves cleanly (no outstanding work) and SCHEDULES
      // its own fresh deferred agentIdle ping — advance past the window.
      session.tick(Date.now() + 3_000);
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);
    });

    it("fix: status-clearing-semantics — a genuine keystroke does NOT release permissionState/planState/elicitationState; those still need an explicit decision", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });
      session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });

      session.write("y");

      const info = session.toInfo();
      expect(info.permissionState).toBe("pending");
      expect(info.planState).toBe("pending");
      expect(info.elicitationState).toBe("pending");
    });

    it("fix: status-clearing-semantics — synthetic (non-genuine) input clears none of errorState/finished/attention", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });
      // Confirm both deferred pings (see the repaint test above for why
      // toolFailure ends up the final confirmedKind) before eventsBefore is
      // captured, so the synthetic write below is checked against a
      // steady, already-confirmed state.
      session.tick(Date.now() + 3_000);
      const eventsBefore = session.getEvents().length;

      // A focus-report is filtered by isGenuineUserInput — not a real
      // keystroke, so it must not count as the unblocking action.
      session.write("\x1b[I");

      const info = session.toInfo();
      expect(info.errorState).toBe("tool_failure");
      expect(info.lastTurnEndedAt).not.toBeNull();
      expect(info.attention).toBe(true);
      expect(session.getEvents().length).toBe(eventsBefore);
    });

    it("clearStaleErrorIfOlderThan: clears errorState past the TTL and logs a real transition", async () => {
      // Hermes review, PR #1262 round 2 — emitHookEvent's own `now` param
      // does NOT thread into errorAt (hook-handlers.ts's tool_failure case
      // writes `ctx.errorAt = Date.now()` unconditionally); only
      // vi.useFakeTimers({ toFake: ["Date"] }) actually pins every
      // Date.now() call inside the handler to a synthetic clock, closing
      // the real-clock race by construction rather than by a margin — same
      // pattern as tests "c"/"c2"/"d"/"e" further down this describe block.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();
        session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });

        // Not yet stale.
        expect(session.clearStaleErrorIfOlderThan(600_000, now)).toBe(false);
        expect(session.toInfo().errorState).toBe("tool_failure");

        // Past the TTL.
        vi.setSystemTime(now + 600_001);
        expect(session.clearStaleErrorIfOlderThan(600_000, Date.now())).toBe(true);
        expect(session.toInfo().errorState).toBe("idle");
        expect(session.toInfo().errorDetail).toBeNull();

        // A second check with nothing left to clear is a no-op, not a
        // re-trigger.
        vi.setSystemTime(now + 700_000);
        expect(session.clearStaleErrorIfOlderThan(600_000, Date.now())).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
