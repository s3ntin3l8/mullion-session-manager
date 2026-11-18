// emitHookEvent (issue #176) — the stale sweeps, compaction, the subagent registry, elicitation and the settle-window cancels.
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
import type { Session } from "../../src/services/pty-manager.js";

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
    it("PtyManager.sweepStaleErrors: only local sessions past the TTL, returns cleared ids", async () => {
      const stale = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      const fresh = manager.getOrCreate({
        id: "2",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(stale);
      await waitForSpawn(fresh);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        stale.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });

        vi.setSystemTime(start + 700_000);
        fresh.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });

        const cleared = manager.sweepStaleErrors(600_000);

        expect(cleared).toEqual(["1"]);
        expect(stale.toInfo().errorState).toBe("idle");
        expect(fresh.toInfo().errorState).toBe("tool_failure");
      } finally {
        vi.useRealTimers();
      }
    });

    it("PtyManager.sweepStaleStates: calls clearStaleBlockedIfOlderThan on each session, returns ids of stale sessions", async () => {
      const stale = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      const fresh = manager.getOrCreate({
        id: "2",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(stale);
      await waitForSpawn(fresh);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        stale.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });

        vi.setSystemTime(start + 700_000);
        fresh.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });

        const cleared = manager.sweepStaleStates(600_000, 600_000);

        expect(cleared).toEqual(["1"]);
        expect(stale.toInfo().permissionState).toBe("idle");
        expect(fresh.toInfo().permissionState).toBe("pending");
      } finally {
        vi.useRealTimers();
      }
    });

    it("PtyManager.sweepStaleStates: applies busyMaxAgeMs (not blockedMaxAgeMs) to compact/subagent latches (issue #320 follow-up)", async () => {
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
        const start = Date.now();
        vi.setSystemTime(start);
        session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });

        // Past a 10-minute blockedMaxAgeMs, but still within a 2-hour busyMaxAgeMs.
        vi.setSystemTime(start + 600_001);
        expect(manager.sweepStaleStates(600_000, 7_200_000)).toEqual([]);
        expect(session.toInfo().compactState).toBe("compacting");

        // Now past the busyMaxAgeMs too.
        vi.setSystemTime(start + 7_200_001);
        expect(manager.sweepStaleStates(600_000, 7_200_000)).toEqual(["1"]);
        expect(session.toInfo().compactState).toBe("idle");
      } finally {
        vi.useRealTimers();
      }
    });

    it("compact: tracks compactState across a started/finished pair", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().compactState).toBe("idle");

      session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });
      expect(session.toInfo().compactState).toBe("compacting");

      session.emitHookEvent({ kind: "compact", state: "finished" });
      expect(session.toInfo().compactState).toBe("idle");
    });

    it("subagent: increments/decrements subagentCount, clamped at zero", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().subagentCount).toBe(0);

      session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
      session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Plan" });
      expect(session.toInfo().subagentCount).toBe(2);

      session.emitHookEvent({ kind: "subagent", state: "finished" });
      expect(session.toInfo().subagentCount).toBe(1);

      // An extra "finished" this session never saw a matching "started"
      // for (e.g. one that began just before a restart) must not drive the
      // count negative.
      session.emitHookEvent({ kind: "subagent", state: "finished" });
      session.emitHookEvent({ kind: "subagent", state: "finished" });
      expect(session.toInfo().subagentCount).toBe(0);
    });

    describe("subagent registry (Phase 5, Track A)", () => {
      it("with an agentId: creates, then closes, a named entry additive to subagentCount", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "subagent",
          state: "started",
          agentType: "Explore",
          agentId: "sub-1",
        });
        expect(session.toInfo().subagentCount).toBe(1);
        expect(session.toInfo().subagents).toEqual([
          expect.objectContaining({
            agentId: "sub-1",
            agentType: "Explore",
            endedAt: null,
            summary: null,
            fileChanges: 0,
            toolFailures: 0,
          }),
        ]);

        session.emitHookEvent({
          kind: "subagent",
          state: "finished",
          agentId: "sub-1",
          summary: "Found the config file.",
        });
        expect(session.toInfo().subagentCount).toBe(0);
        const [entry] = session.toInfo().subagents;
        expect(entry.endedAt).not.toBeNull();
        expect(entry.summary).toBe("Found the config file.");
      });

      it("without an agentId: subagentCount still moves, but no entry is created (OpenCode's case)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "opencode",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "subagent", state: "started" });
        expect(session.toInfo().subagentCount).toBe(1);
        expect(session.toInfo().subagents).toEqual([]);
      });

      it("a finish for an agentId never seen (e.g. crossed a restart) is a no-op on the registry", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "subagent", state: "finished", agentId: "never-started" });
        expect(session.toInfo().subagents).toEqual([]);
      });

      it("file_change/tool_failure with a matching agentId attribute to that subagent's counters", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "subagent",
          state: "started",
          agentType: "Explore",
          agentId: "sub-1",
        });
        session.emitHookEvent({
          kind: "file_change",
          path: "src/a.ts",
          action: "modify",
          agentId: "sub-1",
        });
        // The git-ignore check (issue: sidebar worktree display's Part B)
        // is async even for this non-repo cwd's fast path — flush the
        // microtask queue before asserting, same as the plain file_change
        // test above.
        await new Promise((resolve) => setImmediate(resolve));
        session.emitHookEvent({
          kind: "tool_failure",
          tool: "Bash",
          error: "boom",
          agentId: "sub-1",
        });

        const [entry] = session.toInfo().subagents;
        expect(entry.fileChanges).toBe(1);
        expect(entry.toolFailures).toBe(1);
        expect(entry.eventCount).toBe(2);

        // A matching agentId also reaches the event payload, so the
        // timeline can group/filter by subagent.
        const fileChangeEvent = session.getEvents().find((e) => e.kind === "file_change");
        expect(fileChangeEvent?.payload).toMatchObject({ agentId: "sub-1" });
        const toolFailureEvent = session.getEvents().find((e) => e.kind === "tool_failure");
        expect(toolFailureEvent?.payload).toMatchObject({ agentId: "sub-1" });
      });

      it("file_change/tool_failure with an unmatched agentId are a no-op on the registry (no phantom entry)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "file_change",
          path: "src/a.ts",
          action: "modify",
          agentId: "orphan",
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(session.toInfo().subagents).toEqual([]);
      });

      it("stale-clearing subagentCount also marks any still-open registry entries finished, with no summary", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          const now = Date.now();
          session.emitHookEvent({
            kind: "subagent",
            state: "started",
            agentType: "Explore",
            agentId: "sub-1",
          });

          expect(session.clearStaleBlockedIfOlderThan(1000, 1000, now + 5000)).toBe(true);
          const [entry] = session.toInfo().subagents;
          expect(entry.endedAt).toBe(now + 5000);
          expect(entry.summary).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it("evicts exactly the 11 oldest FINISHED entries once the tracked-subagent cap is exceeded, never a still-running one", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        // One still-running entry that must survive the cap.
        session.emitHookEvent({
          kind: "subagent",
          state: "started",
          agentType: "Explore",
          agentId: "still-running",
        });

        // Fill past MAX_TRACKED_SUBAGENTS (50) with finished entries. With 1
        // still-running entry already present, the cap (map size >= 50) is
        // first hit inserting finished-49 (1 + 49 already-inserted = 50),
        // evicting finished-0; each subsequent insert (finished-50..59)
        // evicts the next-oldest finished entry in turn — finished-1
        // through finished-10 — for 11 evictions total. Final size:
        // 1 (still-running) + 60 (inserted) - 11 (evicted) = 50.
        for (let i = 0; i < 60; i++) {
          const agentId = `finished-${i}`;
          session.emitHookEvent({ kind: "subagent", state: "started", agentId });
          session.emitHookEvent({ kind: "subagent", state: "finished", agentId });
        }

        const subagents = session.toInfo().subagents;
        expect(subagents.length).toBe(50);
        expect(subagents.some((s) => s.agentId === "still-running")).toBe(true);
        for (let i = 0; i <= 10; i++) {
          expect(subagents.some((s) => s.agentId === `finished-${i}`)).toBe(false);
        }
        for (let i = 11; i <= 59; i++) {
          expect(subagents.some((s) => s.agentId === `finished-${i}`)).toBe(true);
        }
      });

      it("a duplicate/retried start for an already-tracked agentId is a no-op (doesn't reset counters or startedAt)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "subagent",
          state: "started",
          agentType: "Explore",
          agentId: "sub-1",
        });
        session.emitHookEvent({
          kind: "file_change",
          path: "src/a.ts",
          action: "modify",
          agentId: "sub-1",
        });
        await new Promise((resolve) => setImmediate(resolve));
        const [beforeRedelivery] = session.toInfo().subagents;
        expect(beforeRedelivery.fileChanges).toBe(1);

        // A redelivered/duplicate SubagentStart for the SAME agentId must
        // not reset the accumulated fileChanges or startedAt.
        session.emitHookEvent({
          kind: "subagent",
          state: "started",
          agentType: "Explore",
          agentId: "sub-1",
        });
        const [afterRedelivery] = session.toInfo().subagents;
        expect(afterRedelivery.startedAt).toBe(beforeRedelivery.startedAt);
        expect(afterRedelivery.fileChanges).toBe(1);
        expect(session.toInfo().subagents).toHaveLength(1);
      });

      it("a still-open entry is finalized by its OWN staleness even after an unrelated orphaned/duplicate finish has already clamped subagentCount to 0", async () => {
        // This is the desync case the independent registry sweep exists
        // for: subagentCount and the registry can legitimately disagree,
        // and subagentCount reaching 0 must not be read as "nothing is
        // running" — the registry is the more precise of the two once
        // they disagree.
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          const now = Date.now();
          // A real subagent starts and is genuinely still running.
          session.emitHookEvent({
            kind: "subagent",
            state: "started",
            agentType: "Explore",
            agentId: "sub-1",
          });
          expect(session.toInfo().subagentCount).toBe(1);

          // An orphaned/duplicate "finished" for a DIFFERENT (or already
          // resolved) agentId clamps the aggregate count to 0, even though
          // sub-1 is still genuinely open.
          session.emitHookEvent({ kind: "subagent", state: "finished", agentId: "never-started" });
          expect(session.toInfo().subagentCount).toBe(0);
          expect(session.toInfo().subagentCountAt).toBeNull();
          const [entryBeforeSweep] = session.toInfo().subagents;
          expect(entryBeforeSweep.endedAt).toBeNull();

          // The subagentCount-gated block can no longer fire (count is
          // already 0) — only the independent per-entry sweep can finalize
          // sub-1's still-open entry.
          expect(session.clearStaleBlockedIfOlderThan(1000, 1000, now + 5000)).toBe(true);
          const [entryAfterSweep] = session.toInfo().subagents;
          expect(entryAfterSweep.endedAt).toBe(now + 5000);
          expect(entryAfterSweep.summary).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it("elicitation: sets elicitationState to pending, flips attention, and clears on finish", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });

      expect(session.toInfo()).toMatchObject({
        elicitationState: "pending",
        elicitationServer: "my-mcp",
        attention: true,
      });
      const events = session.getEvents();
      expect(events[events.length - 2]).toMatchObject({
        kind: "elicitation",
        payload: { state: "started", server: "my-mcp" },
      });
      expect(events[events.length - 1]).toMatchObject({
        kind: "attention",
        payload: { attention: true, signal: "elicitation" },
      });

      session.emitHookEvent({ kind: "elicitation", state: "finished" });

      expect(session.toInfo()).toMatchObject({
        elicitationState: "idle",
        elicitationServer: null,
        attention: false,
      });
    });

    it("permission_resolved: clears permissionState and a confirmed permissionRequest attention signal", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      // Confirm it first — this test is specifically about clearing an
      // already-CONFIRMED flag (see the next test for the "still pending,
      // never confirmed at all" case, which is the actual 537-phantom-
      // permission fix).
      session.tick(Date.now() + 2_000);
      expect(session.toInfo()).toMatchObject({ permissionState: "pending", attention: true });

      session.emitHookEvent({ kind: "permission_resolved" });

      expect(session.toInfo()).toMatchObject({ permissionState: "idle", attention: false });
    });

    it("settle-window fix: permission_resolved arriving BEFORE the settle window elapses cancels the still-pending deferred emit with ZERO events — the 537-of-538 auto-approved-opencode-permission case", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const eventsBefore = session.getEvents().length;

      session.emitHookEvent({
        kind: "permission_request",
        tool: "opencode",
        summary: "external_directory /tmp/worktree/*",
      });
      // permissionState is truthful immediately — the sidebar must reflect
      // the agent being genuinely blocked, even though nothing has been
      // reported to the user yet.
      expect(session.toInfo()).toMatchObject({ permissionState: "pending", attention: false });

      // Auto-approved by the agent's own trust config well inside the 2s
      // settle window (measured mean: 26ms) — no session.tick() at all.
      session.emitHookEvent({ kind: "permission_resolved" });

      expect(session.toInfo()).toMatchObject({ permissionState: "idle", attention: false });
      // No permission_request row, no attention event — nothing at all.
      // Advance well past the window too, to prove drainDeferred() has
      // nothing left to flush (the entry was actually removed, not just
      // not-yet-due).
      session.tick(Date.now() + 5_000);
      expect(session.getEvents().slice(eventsBefore)).toEqual([]);
    });

    describe("settle-window cancel on session exit/respawn (issue #720)", () => {
      // Each test arms a deferred attention signal through the REAL hook
      // chain (emitHookEvent), then kills the attach-client before the settle
      // window elapses — exercising pty-manager.ts:2021's onExit
      // clearDeferred() AND, via the forced respawn, pty-manager.ts:1628's
      // spawn()-reset clearDeferred() — then advances the clock well past the
      // original deadline and asserts the deferred emit never fires. This is
      // the "drive it through the real hook chain, not just internal methods"
      // gap the rest of this PR's tests already cover for the
      // resolution-hook cancel path (see the test just above).
      //
      // The clock is anchored with fake `Date` timers (mirroring the sibling
      // settle test at pty-manager-gates.test.ts's markHooksProven test) so the
      // "well past the deadline" advance is explicit and deterministic rather
      // than relying on real wall-clock time between arming and ticking. The
      // kill + respawn run under that fake clock too, but only `Date` is
      // faked (setImmediate/setTimeout stay real), so the respawn's
      // waitForSpawn still resolves.
      async function spawnAndKillMidWindow(session: InstanceType<typeof Session>): Promise<void> {
        // Session dies before the settle window elapses.
        fakePtyChildren[0].kill();
        // Force the respawn so the spawn()-reset clearDeferred path is also
        // exercised (the kill's onExit already ran its own clearDeferred).
        manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
      }

      it("settle-window cancel on exit/respawn: a pending permissionRequest deferred emit is dropped with ZERO events", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const eventsBefore = session.getEvents().length;
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const start = Date.now();
          vi.setSystemTime(start);

          session.emitHookEvent({
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          });
          // permissionState is truthful immediately — the sidebar must reflect
          // the agent being genuinely blocked, even though nothing has been
          // reported to the user yet.
          expect(session.toInfo()).toMatchObject({ permissionState: "pending", attention: false });

          await spawnAndKillMidWindow(session);

          // Advance well past the original 2s deadline.
          vi.setSystemTime(start + 5_000);
          session.tick(Date.now());
        } finally {
          vi.useRealTimers();
        }

        const emitted = session.getEvents().slice(eventsBefore);
        // No permission_request row, no attention ping — nothing at all
        // escaped the settle window for a session that no longer exists.
        expect(emitted.some((e) => e.kind === "attention")).toBe(false);
        expect(emitted.some((e) => e.kind === "permission_request")).toBe(false);
      });

      it("settle-window cancel on exit/respawn: a pending agentIdle deferred emit is dropped with ZERO events", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const eventsBefore = session.getEvents().length;
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const start = Date.now();
          vi.setSystemTime(start);

          // progress:done arms the deferred agentIdle ping (3s window).
          session.emitHookEvent({ kind: "progress", phase: "done" });
          expect(session.toInfo().attention).toBe(false);

          await spawnAndKillMidWindow(session);

          // Advance well past the original 3s deadline.
          vi.setSystemTime(start + 5_000);
          session.tick(Date.now());
        } finally {
          vi.useRealTimers();
        }

        const emitted = session.getEvents().slice(eventsBefore);
        // agentIdle carries no alsoEmit companion, so only the attention ping
        // would have fired — and it must not.
        expect(emitted.some((e) => e.kind === "attention")).toBe(false);
      });

      it("settle-window cancel on exit/respawn: a pending toolFailure deferred ping is dropped (the immediate tool_failure row still fires)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const eventsBefore = session.getEvents().length;
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const start = Date.now();
          vi.setSystemTime(start);

          // Unlike permissionRequest, tool_failure emits its NotificationEvent
          // IMMEDIATELY and only defers the attention ping (D1: the agent's own
          // next output chunk resolves it). So the row is expected; the ping is not.
          session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });
          expect(session.toInfo()).toMatchObject({ errorState: "tool_failure" });

          await spawnAndKillMidWindow(session);

          // Advance well past the original 2s deadline.
          vi.setSystemTime(start + 5_000);
          session.tick(Date.now());
        } finally {
          vi.useRealTimers();
        }

        const emitted = session.getEvents().slice(eventsBefore);
        expect(emitted.some((e) => e.kind === "attention")).toBe(false);
        // The immediate notification event must still be present — only the
        // deferred ping was cancelled.
        expect(emitted.some((e) => e.kind === "tool_failure")).toBe(true);
      });

      it("settle-window cancel on exit/respawn: a pending apiError deferred ping is dropped (the immediate stop_failure row still fires)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const eventsBefore = session.getEvents().length;
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const start = Date.now();
          vi.setSystemTime(start);

          // stop_failure → api_error: NotificationEvent fires immediately, only
          // the attention ping is deferred.
          session.emitHookEvent({ kind: "stop_failure", error: "rate_limit" });
          expect(session.toInfo()).toMatchObject({ errorState: "api_error" });

          await spawnAndKillMidWindow(session);

          // Advance well past the original 2s deadline.
          vi.setSystemTime(start + 5_000);
          session.tick(Date.now());
        } finally {
          vi.useRealTimers();
        }

        const emitted = session.getEvents().slice(eventsBefore);
        expect(emitted.some((e) => e.kind === "attention")).toBe(false);
        expect(emitted.some((e) => e.kind === "stop_failure")).toBe(true);
      });
    });
  });
});
