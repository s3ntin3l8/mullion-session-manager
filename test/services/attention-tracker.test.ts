// PR 33b (Wave 6) — unit tests for the attention state machine's stateful
// half, now that it's isolated from Session (pty-manager.ts) onto its own
// AttentionTracker class. Before this extraction these transitions were
// only reachable indirectly through Session's public surface (tick()/
// write()/emitHookEvent()/toInfo() in test/services/pty-manager.test.ts,
// which stays green — see that file's own attention-related tests) — this
// file exercises the same methods directly, with a spy `emitEvent` standing
// in for Session, exactly the shape AttentionTrackerHost specifies.

import { describe, it, expect, vi } from "vitest";
import { AttentionTracker } from "../../src/services/attention-tracker.js";
import { advanceAttention } from "../../src/services/attention-detect.js";
import type { BackgroundTask } from "../../src/services/hook-protocol.js";

function makeTracker() {
  const emitEvent = vi.fn();
  const tracker = new AttentionTracker({ sessionId: "1", emitEvent });
  return { tracker, emitEvent };
}

function outstandingTask(id = "t1"): BackgroundTask {
  return { id, type: "subagent", status: "running", description: "Explore agent" };
}

function doneTask(id = "t1"): BackgroundTask {
  return { id, type: "subagent", status: "completed", description: "Explore agent" };
}

describe("AttentionTracker.applyAttentionTransition", () => {
  it("adopts the transition's next state and emits every `emit` entry, for a genuine (non-pending-churn) transition", () => {
    const { tracker, emitEvent } = makeTracker();
    // A "silence" signal from idle goes straight to pending_attention first
    // (zero-threshold candidate kinds still route through PENDING_ATTENTION
    // — see attention-detect.ts's ATTENTION_CONFIRM_MS), so drive it to a
    // genuine confirm via a synthetic "tick" once ATTENTION_CONFIRM_MS has
    // elapsed, matching how Session.tick() itself drives confirmation.
    const now = 1_000;
    tracker.applyAttentionTransition(
      advanceAttention(tracker.state, { type: "signal", kind: "bell", now }),
    );
    expect(tracker.state.state).toBe("pending_attention");
    emitEvent.mockClear();

    tracker.applyAttentionTransition(
      advanceAttention(tracker.state, { type: "tick", now: now + 10_000 }),
    );

    expect(tracker.state.state).toBe("attention");
    expect(tracker.state.confirmedKind).toBe("bell");
    expect(emitEvent).toHaveBeenCalledWith(
      "attention",
      expect.objectContaining({ attention: true, signal: "bell" }),
    );
  });

  it("still adopts `next` on a PENDING_ATTENTION churn transition (idle -> pending_attention) even though it's not logged", () => {
    const { tracker } = makeTracker();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      tracker.applyAttentionTransition(
        advanceAttention(tracker.state, { type: "signal", kind: "bell", now: 1_000 }),
      );
      expect(tracker.state.state).toBe("pending_attention");
      // The idle -> pending_attention edge is exactly the churn
      // applyAttentionTransition's own doc comment says is skipped from
      // console.debug — state still moves, only the log line is suppressed.
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("logs a genuine confirm/clear edge but not PENDING_ATTENTION churn", () => {
    const { tracker } = makeTracker();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const now = 1_000;
      tracker.applyAttentionTransition(
        advanceAttention(tracker.state, { type: "signal", kind: "bell", now }),
      );
      expect(debugSpy).not.toHaveBeenCalled(); // pending_attention churn, suppressed

      tracker.applyAttentionTransition(
        advanceAttention(tracker.state, { type: "tick", now: now + 10_000 }),
      );
      expect(debugSpy).toHaveBeenCalledTimes(1); // idle -> attention, a real edge
      expect(debugSpy.mock.calls[0]?.[0]).toContain("pending_attention -> attention");
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe("AttentionTracker.emitAttentionSignalWithExtras", () => {
  it("emits even when the same kind is already confirmed (unlike the byte-driven path)", () => {
    const { tracker, emitEvent } = makeTracker();
    tracker.emitAttentionSignalWithExtras("hookNotification", { title: "first", body: "a" });
    expect(tracker.state.state).toBe("attention");
    expect(tracker.state.confirmedKind).toBe("hookNotification");
    emitEvent.mockClear();

    // A second, distinct notification while already confirmed on the same
    // kind — confirmAttention()'s alreadyConfirmed guard would suppress a
    // generic re-signal, but this method always emits regardless (see its
    // own doc comment: hook notification content is "never nothing new").
    tracker.emitAttentionSignalWithExtras("hookNotification", { title: "second", body: "b" });

    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith("attention", {
      attention: true,
      signal: "hookNotification",
      title: "second",
      body: "b",
    });
  });

  it("confirms attention immediately (no PENDING_ATTENTION step) for a zero-threshold hook kind", () => {
    const { tracker } = makeTracker();
    tracker.emitAttentionSignalWithExtras("reviewGate", { prompt: "approve?" });
    expect(tracker.state.state).toBe("attention");
    expect(tracker.state.confirmedKind).toBe("reviewGate");
    expect(tracker.state.confirmedAt).not.toBeNull();
  });
});

describe("AttentionTracker.clearIfConfirmedKind", () => {
  it("clears back to idle when the confirmed kind matches", () => {
    const { tracker } = makeTracker();
    tracker.emitAttentionSignalWithExtras("reviewGate", { prompt: "approve?" });
    expect(tracker.state.state).toBe("attention");

    tracker.clearIfConfirmedKind("reviewGate");

    expect(tracker.state.state).toBe("idle");
    expect(tracker.state.confirmedKind).toBeNull();
  });

  it("is a no-op when the confirmed kind does not match", () => {
    const { tracker } = makeTracker();
    tracker.emitAttentionSignalWithExtras("reviewGate", { prompt: "approve?" });

    tracker.clearIfConfirmedKind("promoteRequest");

    expect(tracker.state.state).toBe("attention");
    expect(tracker.state.confirmedKind).toBe("reviewGate");
  });

  it("is a no-op outside the 'attention' state (e.g. still idle)", () => {
    const { tracker } = makeTracker();
    tracker.clearIfConfirmedKind("reviewGate");
    expect(tracker.state.state).toBe("idle");
  });
});

describe("AttentionTracker.setBackgroundTasks", () => {
  it("stamps backgroundTasksAt to now when outstanding tasks remain", () => {
    const { tracker } = makeTracker();
    tracker.setBackgroundTasks([outstandingTask()]);
    expect(tracker.backgroundTasks).toEqual([outstandingTask()]);
    expect(tracker.backgroundTasksAt).not.toBeNull();
  });

  it("sets backgroundTasksAt to null when nothing is outstanding", () => {
    const { tracker } = makeTracker();
    tracker.setBackgroundTasks([doneTask()]);
    expect(tracker.backgroundTasksAt).toBeNull();
  });

  it("re-stamps backgroundTasksAt to a later time on a repeat call that still has outstanding work", async () => {
    const { tracker } = makeTracker();
    tracker.setBackgroundTasks([outstandingTask()]);
    const first = tracker.backgroundTasksAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    tracker.setBackgroundTasks([outstandingTask()]);
    expect(tracker.backgroundTasksAt).not.toBeNull();
    expect(tracker.backgroundTasksAt).toBeGreaterThanOrEqual(first ?? 0);
  });
});

describe("AttentionTracker.resolveDeferredTurnEnd", () => {
  it("is a no-op when lastTurnEndedAt is still null (turn hasn't ended)", () => {
    const { tracker, emitEvent } = makeTracker();
    tracker.resolveDeferredTurnEnd();
    expect(emitEvent).not.toHaveBeenCalled();
    expect(tracker.turnEndPingSent).toBe(false);
  });

  it("is a no-op when outstanding background tasks remain", () => {
    const { tracker, emitEvent } = makeTracker();
    tracker.lastTurnEndedAt = Date.now();
    tracker.setBackgroundTasks([outstandingTask()]);
    emitEvent.mockClear();

    tracker.resolveDeferredTurnEnd();

    expect(emitEvent).not.toHaveBeenCalled();
    expect(tracker.turnEndPingSent).toBe(false);
  });

  it("fires the deferred agentIdle ping once the turn has ended and nothing is outstanding", () => {
    const { tracker, emitEvent } = makeTracker();
    tracker.lastTurnEndedAt = Date.now();
    tracker.setBackgroundTasks([]);
    emitEvent.mockClear();

    tracker.resolveDeferredTurnEnd();

    expect(tracker.turnEndPingSent).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith(
      "attention",
      expect.objectContaining({ attention: true, signal: "agentIdle" }),
    );
  });

  it("is a no-op (guarded by turnEndPingSent) on a second call for the same already-pinged latch", () => {
    const { tracker, emitEvent } = makeTracker();
    tracker.lastTurnEndedAt = Date.now();
    tracker.setBackgroundTasks([]);
    tracker.resolveDeferredTurnEnd();
    expect(tracker.turnEndPingSent).toBe(true);
    emitEvent.mockClear();

    // A later, unrelated call (e.g. a reordered SubagentStop) must not
    // re-fire a duplicate "Finished" ping for this same still-latched turn.
    tracker.resolveDeferredTurnEnd();

    expect(emitEvent).not.toHaveBeenCalled();
  });
});
