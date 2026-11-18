// emitHookEvent (issue #176) and resolveGate (issue #178) — the review-gate lifecycle and the keystroke clears.
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

  describe("resolveGate (issue #178)", () => {
    it("Session.resolveGate flips gateState/clears gatePrompt and emits a review_gate event with the outcome", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
      const gateId = session.toInfo().gates[0].gateId;

      session.resolveGate(gateId, "denied", "looks unsafe");

      expect(session.toInfo()).toMatchObject({
        gateState: "denied",
        gatePrompt: null,
        gates: [],
        // Follow-up to #275 (gap #3): resolveGate is now the superseding
        // resolution that clears a reviewGate-confirmed flag (it no longer
        // clears on the tool call's own PTY output — see resolveGate's doc
        // comment), so the attention flag comes down alongside the decision.
        attention: false,
      });
      const events = session.getEvents();
      // The gap #3 clear fires an "attention" event AFTER the review_gate
      // event — check the review_gate event by content, not by position.
      const reviewGateEvent = events.findLast((e) => e.kind === "review_gate");
      expect(reviewGateEvent).toMatchObject({
        kind: "review_gate",
        payload: { state: "denied", reason: "looks unsafe", gateId, prompt: "Deploy?" },
      });
      expect(events[events.length - 1]).toMatchObject({
        kind: "attention",
        payload: { attention: false },
      });
    });

    it("Session.resolveGate omits `reason` from the event payload when none is given", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "x" });
      const gateId = session.toInfo().gates[0].gateId;

      session.resolveGate(gateId, "approved");

      const events = session.getEvents();
      const reviewGateEvent = events.findLast((e) => e.kind === "review_gate");
      expect(reviewGateEvent?.payload).toEqual({ state: "approved", gateId, prompt: "x" });
    });

    it("Session.resolveGate does not dismiss a NEWER, unrelated confirmed flag (gated on confirmedKind)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
      const gateId = session.toInfo().gates[0].gateId;
      // A fresh, unrelated permission request supersedes the reviewGate as
      // the currently-confirmed kind before the gate decision arrives. Uses
      // a second SPECIFIC immune kind, not a generic hookNotification —
      // fix: sticky needs_input (D2) added a guard specifically so a
      // generic hookNotification can no longer steal confirmedKind from an
      // already-confirmed specific kind (see attention-detect.ts's
      // GENERIC_IMMUNE_KINDS), which is the race this test used to rely on
      // to construct "a newer, unrelated confirmed flag" in the first
      // place — two distinct specific kinds still replace each other
      // exactly as before.
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      // permissionRequest settles for 2s before it confirms and actually
      // supersedes reviewGate as confirmedKind — advance past it, or
      // resolveGate(gateId, "approved") below would still be resolving the
      // CURRENTLY-confirmed reviewGate (not a stale one) and this test
      // would no longer be exercising what its name says.
      session.tick(Date.now() + 2_000);
      expect(session.toInfo().attention).toBe(true);

      session.resolveGate(gateId, "approved");

      // The stale gate resolution must not clear the newer permission request.
      expect(session.toInfo().attention).toBe(true);
    });

    it("Session.resolveGate is a silent no-op for an unknown gateId (already resolved, or never existed)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.resolveGate("nonexistent-gate", "approved"); // no prior "waiting" review_gate at all

      expect(session.toInfo().attention).toBe(false);
      const events = session.getEvents();
      expect(events.some((e) => e.kind === "attention")).toBe(false);
      expect(events.some((e) => e.kind === "review_gate")).toBe(false);
    });

    it("PtyManager.resolveGate() routes to the right session/gate and is a no-op for an untracked session or gate id", async () => {
      const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      await waitForSpawn(a);
      await waitForSpawn(b);
      b.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "x" });
      const gateId = b.toInfo().gates[0].gateId;

      manager.resolveGate("2", gateId, "approved");

      expect(a.toInfo().gateState).toBe("idle");
      expect(b.toInfo().gateState).toBe("approved");
      expect(() => manager.resolveGate("999", "whatever", "denied")).not.toThrow();
      expect(() => manager.resolveGate("2", "unknown-gate", "denied")).not.toThrow();
    });
  });

  describe("emitHookEvent (issue #176)", () => {
    it("plan_resolved: clears planState and a confirmed planReady attention signal", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });
      expect(session.toInfo()).toMatchObject({ planState: "pending", attention: true });

      session.emitHookEvent({ kind: "plan_resolved" });

      expect(session.toInfo()).toMatchObject({ planState: "idle", attention: false });
    });

    it("PtyManager.emitHookEvent() routes to the right session by id", async () => {
      const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      await waitForSpawn(a);
      await waitForSpawn(b);

      manager.emitHookEvent("2", { kind: "progress", phase: "done" });
      // agentIdle settles for 3s before it confirms — advance the RIGHT
      // session's clock past that window (proving routing extends to
      // drainDeferred() too: `a` never scheduled anything, so ticking it
      // would be a no-op regardless).
      b.tick(Date.now() + 3_000);

      expect(a.getEvents()).toHaveLength(0);
      // "done" also drives attention (issue: agentIdle) — see the dedicated
      // "progress: done" describe block below for that behavior in detail.
      expect(b.getEvents().map((e) => e.kind)).toEqual(["status_change", "attention"]);
      expect(b.getEvents()[0].payload).toEqual({ phase: "done" });
    });

    it("PtyManager.emitHookEvent() is a no-op for an id it isn't tracking", () => {
      expect(() => manager.emitHookEvent("999", { kind: "progress", phase: "done" })).not.toThrow();
    });

    it("PtyManager.markHooksProven() routes to the right session by id and is a no-op for an untracked id (gap #1)", async () => {
      const a = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(a);

      expect(() => manager.markHooksProven("999")).not.toThrow();

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("splash frame 1");
        vi.setSystemTime(start + 1_200);
        fakePtyChildren[0].emitData("splash frame 2");

        manager.markHooksProven("1");
        a.tick(start + 1_200 + 10_000); // short bound -- must not fire, now proven
        expect(a.toInfo().attention).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("review_gate: waiting sets SessionInfo.gateState/gatePrompt; a resolved state clears the prompt", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo()).toMatchObject({ gateState: "idle", gatePrompt: null });

      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
      expect(session.toInfo()).toMatchObject({ gateState: "waiting", gatePrompt: "Deploy?" });

      session.emitHookEvent({ kind: "review_gate", state: "approved", prompt: "Deploy?" });
      expect(session.toInfo()).toMatchObject({ gateState: "approved", gatePrompt: null });
    });

    it("the gatePrompt/gateAt summary keeps tracking the OLDEST gate, not the newest, once a second one arrives (Hermes review, PR #912)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "first command" });
      expect(session.toInfo()).toMatchObject({ gateState: "waiting", gatePrompt: "first command" });
      const firstGateAt = session.toInfo().gateAt;

      // A second, concurrent gate must NOT swap the scalar summary to its
      // own prompt, nor reset "waiting since" for the first — the summary
      // is documented (SessionInfo.gatePrompt/gateAt) as tracking the
      // OLDEST still-waiting gate, and the stale sweep's TTL is measured
      // against gateAt.
      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "second command" });
      expect(session.toInfo()).toMatchObject({
        gateState: "waiting",
        gatePrompt: "first command",
        gateAt: firstGateAt,
      });
      expect(session.toInfo().gates).toHaveLength(2);

      // Once the first (oldest) resolves, the summary re-points at the
      // second, now the only one left.
      const firstId = session.toInfo().gates[0].gateId;
      session.resolveGate(firstId, "approved");
      expect(session.toInfo()).toMatchObject({
        gateState: "waiting",
        gatePrompt: "second command",
      });
    });

    it("a genuine keystroke does NOT clear a waiting review_gate's attention badge, unlike hookNotification (concurrent-gates investigation)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "review_gate",
        state: "waiting",
        prompt: "git worktree add …",
      });
      expect(session.toInfo()).toMatchObject({ gateState: "waiting", attention: true });

      // Simulates the user answering a DIFFERENT, concurrently fallen-
      // through native prompt in the terminal (issue: two PermissionRequest
      // hooks fire for the same session; hooks.ts's single-gate-per-session
      // bookkeeping lets only one become a Mullion gate, the other falls
      // through to the agent's own dialog). That keystroke is genuine user
      // input, but it did not answer THIS gate — gateState must stay
      // "waiting" and the badge must stay raised until a real
      // resolveGate() (approve/deny/timeout/lapse/stale-sweep).
      session.write("y");
      expect(session.toInfo()).toMatchObject({ gateState: "waiting", attention: true });

      // A real decision is still the thing that clears it. The gate has to
      // be addressed BY ID — resolveGate(gateId, decision) — so the pending
      // one is looked up rather than guessed at.
      const gateId = session.toInfo().gates[0]!.gateId;
      session.resolveGate(gateId, "approved");
    });

    it("a genuine keystroke DOES clear the badge when a newer immune kind has superseded reviewGate as confirmedKind, even though gateState still reads 'waiting' underneath it (Hermes review, PR #910)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "x" });
      expect(session.toInfo()).toMatchObject({ gateState: "waiting", attentionKind: "reviewGate" });

      // A promote_request is a second, unrelated immune kind — it
      // supersedes reviewGate as the currently-CONFIRMED kind (both settle
      // at 0ms, same as reviewGate), while gateState stays "waiting"
      // underneath it: the original gate hasn't been resolved, it's simply
      // no longer what's confirmed.
      session.emitHookEvent({ kind: "promote_request", summary: "start work" });
      expect(session.toInfo()).toMatchObject({
        gateState: "waiting",
        attentionKind: "promoteRequest",
      });

      // A genuine keystroke here is answering the PROMOTE prompt, not the
      // stale gate — must clear its badge, not be blocked by the unrelated
      // gate still pending in the background.
      session.write("y");
      expect(session.toInfo().attention).toBe(false);
      // The gate itself is untouched by this keystroke — still genuinely
      // waiting, just no longer the confirmed badge.
      expect(session.toInfo().gateState).toBe("waiting");
    });

    it("permission_request state clears on progress:done", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().permissionState).toBe("idle");

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "npm install" });
      expect(session.toInfo().permissionState).toBe("pending");

      session.emitHookEvent({ kind: "progress", phase: "done" });
      expect(session.toInfo().permissionState).toBe("idle");
    });

    it("stop_failure error state clears on any progress event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().errorState).toBe("idle");

      const eventsBefore = session.getEvents().length;
      session.emitHookEvent({ kind: "stop_failure", error: "rate_limit" });
      expect(session.toInfo().errorState).toBe("api_error");

      // Recovery arriving purely over the hook channel (no PTY output bytes
      // in between) must cancel the still-settling deferred apiError ping
      // too, not just clear errorState — otherwise the ping fires 2s later
      // reporting a failure the session has already recovered from.
      session.emitHookEvent({ kind: "progress", phase: "thinking" });
      expect(session.toInfo().errorState).toBe("idle");

      session.tick(Date.now() + 5_000);
      const emitted = session.getEvents().slice(eventsBefore);
      expect(emitted.some((e) => e.kind === "attention")).toBe(false);
    });
  });
});
