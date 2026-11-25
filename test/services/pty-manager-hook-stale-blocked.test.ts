// emitHookEvent (issue #176) — clearStaleBlockedIfOlderThan (issue #320), the stale permission/plan/question latches.
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

  afterEach(async () => {
    await destroyPtyManagerFixture({ sessionsDir, manager });
  });

  describe("emitHookEvent (issue #176)", () => {
    describe("clearStaleBlockedIfOlderThan (issue #320)", () => {
      it("a1: clears a stale permissionState past the TTL and emits status_change", async () => {
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

          session.emitHookEvent({
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          });
          expect(session.toInfo().permissionState).toBe("pending");

          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now)).toBe(false);

          vi.setSystemTime(now + 600_001);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(true);
          expect(session.toInfo().permissionState).toBe("idle");

          const events = session.getEvents();
          const statusEvent = events[events.length - 1];
          expect(statusEvent.kind).toBe("status_change");
          expect(statusEvent.payload).toMatchObject({
            reason: "stale_blocked_cleared",
            state: "permissionState",
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it("fix: sticky needs_input (D4) — a stale permissionState sweep also drops the attention machine's permissionRequest-owned flag it confirmed", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        // `now` pinned here (rather than emitHookEvent's own default
        // Date.now()) so the settle window's dueAt and this tick() below
        // race against the identical synthetic clock, not two independent
        // real-time reads a few CI-scheduling milliseconds apart — see
        // emitAttentionSignalDeferred's own doc comment.
        session.emitHookEvent(
          {
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          },
          now,
        );
        // Confirm it (settle window) — the sweep this test exercises only
        // makes sense against an already-CONFIRMED flag, per the test's own
        // name ("...it confirmed").
        session.tick(now + 2_000);
        expect(session.toInfo()).toMatchObject({ permissionState: "pending", attention: true });

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);

        expect(session.toInfo().attention).toBe(false);
      });

      // The handlers used to stamp `permissionAt` with a fresh Date.now()
      // instead of emitHookEvent's `now`, so the sweep above flaked whenever
      // CI's clock moved >1ms between the two reads. Pinning `now` well in
      // the past makes that drift deterministic.
      it("stamps latches with emitHookEvent's pinned now, not a fresh Date.now()", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now() - 5_000;

        session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "ls" }, now);

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().permissionState).toBe("idle");
      });

      // Hermes review, PR #3528 — the busy tier's backgroundTasksAt is stamped
      // by the tracker's setBackgroundTasks, reached through the facade.
      it("stamps backgroundTasksAt with emitHookEvent's pinned now, too", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now() - 5_000;

        session.emitHookEvent(
          {
            kind: "progress",
            phase: "done",
            backgroundTasks: [
              { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
            ],
          },
          now,
        );

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().outstandingBackgroundTasks).toHaveLength(0);
      });

      it("fix: sticky needs_input (D4) — the stale sweep does NOT drop a hookNotification-confirmed flag with no dedicated latch behind it (deliberately left to keystroke/notification_resolved only)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        // A bare generic notification, nothing else pending — `hookNotification`
        // has no owning per-state latch for this sweep to key its clear off,
        // unlike the six blocked/busy latches above.
        session.emitHookEvent({ kind: "notification", title: "heads up", body: "" });
        expect(session.toInfo().attention).toBe(true);

        // Nothing is stale from this sweep's perspective (every one of the
        // six latches it checks is already idle) — correctly a no-op.
        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(false);

        expect(session.toInfo().attention).toBe(true);
      });

      it("a2: clears a stale planState past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix bug" });
        const now = Date.now();
        expect(session.toInfo().planState).toBe("pending");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().planState).toBe("idle");

        const events = session.getEvents();
        const statusEvent = events[events.length - 1];
        expect(statusEvent.payload).toMatchObject({
          reason: "stale_blocked_cleared",
          state: "planState",
        });
      });

      it("a3: clears a stale gateState (waiting) past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
        const now = Date.now();
        expect(session.toInfo().gateState).toBe("waiting");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().gateState).toBe("idle");
        expect(session.toInfo().gatePrompt).toBeNull();

        const payload = session.getEvents().findLast((e) => e.kind === "status_change")?.payload;
        expect(payload).toMatchObject({ reason: "stale_blocked_cleared", state: "gateState" });
      });

      it("a4: clears a stale promoteState (pending) past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "promote_request", summary: "Refactor widget" });
        const now = Date.now();
        expect(session.toInfo().promoteState).toBe("pending");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().promoteState).toBe("idle");
        expect(session.toInfo().promoteSummary).toBeNull();

        const payload = session.getEvents().findLast((e) => e.kind === "status_change")?.payload;
        expect(payload).toMatchObject({ reason: "stale_blocked_cleared", state: "promoteState" });
      });

      it("a5: clears a stale elicitationState past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });
        const now = Date.now();
        expect(session.toInfo().elicitationState).toBe("pending");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().elicitationState).toBe("idle");
        expect(session.toInfo().elicitationServer).toBeNull();

        const payload = session.getEvents().findLast((e) => e.kind === "status_change")?.payload;
        expect(payload).toMatchObject({
          reason: "stale_blocked_cleared",
          state: "elicitationState",
        });
      });

      it("a6: clears a stale compactState (compacting) past the TTL and emits status_change", async () => {
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

          session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });
          expect(session.toInfo().compactState).toBe("compacting");

          vi.setSystemTime(now + 600_001);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(true);
          expect(session.toInfo().compactState).toBe("idle");

          const payload = session.getEvents().findLast((e) => e.kind === "status_change")?.payload;
          expect(payload).toMatchObject({ reason: "stale_blocked_cleared", state: "compactState" });
        } finally {
          vi.useRealTimers();
        }
      });

      it("a7: resets stale subagentCount > 0 past the TTL and emits status_change", async () => {
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

          session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
          expect(session.toInfo().subagentCount).toBe(1);

          vi.setSystemTime(now + 600_001);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(true);
          expect(session.toInfo().subagentCount).toBe(0);

          const payload = session.getEvents().findLast((e) => e.kind === "status_change")?.payload;
          expect(payload).toMatchObject({
            reason: "stale_blocked_cleared",
            state: "subagentCount",
          });
        } finally {
          vi.useRealTimers();
        }
      });

      // Hermes review, PR #453 — the sweep deliberately does NOT fire the
      // deferred agentIdle ping: clearing a stale outstanding entry is a
      // "give up tracking it" backstop (isStale's silence test can't tell a
      // stuck report apart from a genuinely-running, PTY-silent background
      // task), not a confirmed drain, so it must not assert "the work is
      // done" via a possibly-false "Finished" notification.
      it("issue #428: resets stale outstanding backgroundTasks past the TTL and emits status_change, without firing a possibly-false agentIdle ping", async () => {
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

          session.emitHookEvent({
            kind: "progress",
            phase: "done",
            backgroundTasks: [
              { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
            ],
          });
          expect(session.toInfo().outstandingBackgroundTasks).toHaveLength(1);
          // The deferred-turn-end gate held: no attention event fired yet.
          expect(session.getEvents().map((e) => e.kind)).not.toContain("attention");

          vi.setSystemTime(now + 600_001);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(true);
          expect(session.toInfo().outstandingBackgroundTasks).toHaveLength(0);

          const events = session.getEvents();
          const payload = events.findLast((e) => e.kind === "status_change")?.payload;
          expect(payload).toMatchObject({
            reason: "stale_blocked_cleared",
            state: "backgroundTasks",
          });
          // No attention/agentIdle ping — the sweep isn't a confirmed drain.
          expect(events.map((e) => e.kind)).not.toContain("attention");
        } finally {
          vi.useRealTimers();
        }
      });

      it("a8: busy latches (compactState) use busyMaxAgeMs, not blockedMaxAgeMs — past the short blocked TTL but within the longer busy TTL stays untouched", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });
        expect(session.toInfo().compactState).toBe("compacting");

        // Well past a 10-minute blocked TTL, but still within a 2-hour busy TTL.
        expect(session.clearStaleBlockedIfOlderThan(600_000, 7_200_000, now + 600_001)).toBe(false);
        expect(session.toInfo().compactState).toBe("compacting");
      });

      it("a9: busy latches (subagentCount) use busyMaxAgeMs, not blockedMaxAgeMs — past the short blocked TTL but within the longer busy TTL stays untouched", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
        expect(session.toInfo().subagentCount).toBe(1);

        expect(session.clearStaleBlockedIfOlderThan(600_000, 7_200_000, now + 600_001)).toBe(false);
        expect(session.toInfo().subagentCount).toBe(1);
      });

      it("a10: busy latches ARE cleared once past their own (longer) busyMaxAgeMs, even while a shorter blockedMaxAgeMs applies to blocked latches", async () => {
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

          session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });
          session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });

          vi.setSystemTime(now + 7_200_001);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 7_200_000, Date.now())).toBe(true);
          expect(session.toInfo().compactState).toBe("idle");
          expect(session.toInfo().subagentCount).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("a11: a blocked latch past blockedMaxAgeMs is cleared even while a busy latch set at the same time is still within its own (longer) busyMaxAgeMs", async () => {
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

          session.emitHookEvent({
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          });
          session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });

          vi.setSystemTime(now + 600_001);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 7_200_000, Date.now())).toBe(true);
          expect(session.toInfo().permissionState).toBe("idle");
          expect(session.toInfo().compactState).toBe("compacting");
        } finally {
          vi.useRealTimers();
        }
      });

      it("b: recent blocked states are untouched by the sweep", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({
          kind: "permission_request",
          tool: "Bash",
          summary: "rm -rf /tmp/x",
        });
        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });
        session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
        session.emitHookEvent({ kind: "promote_request", summary: "Refactor" });
        session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });
        session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });
        session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Plan" });

        // Everything set at roughly `now` — well within the TTL
        const eventsBefore = session.getEvents().length;
        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 10_000)).toBe(false);
        expect(session.getEvents().length).toBe(eventsBefore);

        expect(session.toInfo()).toMatchObject({
          permissionState: "pending",
          planState: "pending",
          gateState: "waiting",
          promoteState: "pending",
          elicitationState: "pending",
          compactState: "compacting",
          subagentCount: 1,
        });
      });

      it("c: stale state with recent PTY output (lastActivityAt > latch time) is NOT cleared", async () => {
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
          const start = Date.now();
          vi.setSystemTime(start);

          session.emitHookEvent({
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          });
          expect(session.toInfo().permissionState).toBe("pending");

          // PTY output arrives AFTER the permission was set — the agent is clearly still alive
          vi.setSystemTime(start + 100_000);
          fakePtyChildren[0].emitData("agent is still working...");

          // Now check well past the TTL
          vi.setSystemTime(start + 700_000);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(false);
          expect(session.toInfo().permissionState).toBe("pending");
        } finally {
          vi.useRealTimers();
        }
      });

      it("c2: PTY output within BLOCKED_STALE_GRACE_MS of the latch is NOT considered new activity — stale latch still cleared", async () => {
        /* Grace window: activity arriving very close to the latch timestamp
         * (e.g. the dialog render that follows the hook firing) is treated
         * as part of the same triggering event, not as evidence the agent
         * is still progressing. Without this, the dialog's own PTY render
         * would permanently block the sweep. */
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
          const latchTime = 100_000;
          vi.setSystemTime(latchTime);

          session.emitHookEvent({
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          });
          expect(session.toInfo().permissionState).toBe("pending");

          // PTY output arrives just 100ms after the latch — well within the
          // 2000ms grace window. This simulates the dialog rendering to PTY
          // at the same moment the hook fires (the real-world scenario this
          // PR fixes).
          vi.setSystemTime(latchTime + 100);
          fakePtyChildren[0].emitData("rendered prompt dialog...");

          // Advance past the TTL (600s)
          vi.setSystemTime(latchTime + 700_000);

          // With the grace window fix, the sweep should detect the latch as
          // stale — the 100ms-later PTY output is just the dialog render,
          // not genuine new agent activity.
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(true);
          expect(session.toInfo().permissionState).toBe("idle");
        } finally {
          vi.useRealTimers();
        }
      });

      it("d: only stale latches are cleared, recent ones remain — permission stale, plan recent", async () => {
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
          const start = Date.now();
          vi.setSystemTime(start);

          // Old permission request
          session.emitHookEvent({
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          });

          // Recent plan_ready — just before the sweep (10s ago, well within TTL)
          vi.setSystemTime(start + 690_000);
          session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });

          // Sweep with 600s TTL: permission (set at 0) is old, plan (set at 690s) is recent
          vi.setSystemTime(start + 700_000);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(true);
          expect(session.toInfo().permissionState).toBe("idle");
          expect(session.toInfo().planState).toBe("pending");
        } finally {
          vi.useRealTimers();
        }
      });

      it("e: stale subagentCount > 0 resets to 0 and clears subagentCountAt", async () => {
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
          const start = Date.now();
          vi.setSystemTime(start);

          session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
          expect(session.toInfo().subagentCount).toBe(1);

          vi.setSystemTime(start + 700_000);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(true);
          expect(session.toInfo().subagentCount).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("f: clearStaleBlockedIfOlderThan returns false when nothing is stale", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        // Nothing set at all
        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now)).toBe(false);
        // Already cleared states
        session.emitHookEvent({ kind: "progress", phase: "done" });
        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now)).toBe(false);
      });
    });
  });
});
