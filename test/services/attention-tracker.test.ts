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

describe("AttentionTracker.clearAttention", () => {
  // Fix: sticky needs_input (D2/D4) — unlike clearIfConfirmedKind, this is
  // unconditional: `turn_start` (UserPromptSubmit) needs it because a
  // confirmedKind can be orphaned (e.g. by the D2 generic/specific race)
  // with no way to name the right kind to clear.
  it("clears back to idle regardless of which kind is confirmed", () => {
    const { tracker } = makeTracker();
    tracker.emitAttentionSignalWithExtras("reviewGate", { prompt: "approve?" });
    expect(tracker.state.state).toBe("attention");

    tracker.clearAttention();

    expect(tracker.state.state).toBe("idle");
    expect(tracker.state.confirmedKind).toBeNull();
  });

  it("clears an immune kind too — unlike a plain output chunk, it isn't gated on OUTPUT_IMMUNE_KINDS", () => {
    const { tracker, emitEvent } = makeTracker();
    tracker.emitAttentionSignalWithExtras("permissionRequest", { tool: "Bash", summary: "ls" });
    emitEvent.mockClear();

    tracker.clearAttention();

    expect(tracker.state.state).toBe("idle");
    expect(emitEvent).toHaveBeenCalledWith("attention", { attention: false });
  });

  it("is a no-op outside the 'attention' state (e.g. still idle)", () => {
    const { tracker, emitEvent } = makeTracker();
    tracker.clearAttention();
    expect(tracker.state.state).toBe("idle");
    expect(emitEvent).not.toHaveBeenCalled();
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

  it("SCHEDULES (not fires) the agentIdle ping once the turn has ended and nothing is outstanding, then fires it once its settle window (ATTENTION_SETTLE_MS) elapses", () => {
    const { tracker, emitEvent } = makeTracker();
    tracker.lastTurnEndedAt = Date.now();
    tracker.setBackgroundTasks([]);
    emitEvent.mockClear();

    tracker.resolveDeferredTurnEnd();

    // The one-shot guard latches immediately (so a second concurrent call
    // can't double-schedule) but nothing is emitted yet — see
    // emitAttentionSignalDeferred's own doc comment.
    expect(tracker.turnEndPingSent).toBe(true);
    expect(emitEvent).not.toHaveBeenCalled();

    tracker.drainDeferred(Date.now() + 3_000);

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
    // Let the first ping actually fire, so the guard below is proven
    // against a genuinely already-PINGED latch, not merely an already-
    // scheduled one.
    tracker.drainDeferred(Date.now() + 3_000);
    expect(tracker.turnEndPingSent).toBe(true);
    emitEvent.mockClear();

    // A later, unrelated call (e.g. a reordered SubagentStop) must not
    // re-schedule (let alone re-fire) a duplicate "Finished" ping for this
    // same still-latched turn.
    tracker.resolveDeferredTurnEnd();
    tracker.drainDeferred(Date.now() + 3_000);

    expect(emitEvent).not.toHaveBeenCalled();
  });
});

// Settle-window mechanism (ATTENTION_SETTLE_MS) — the core fix for the
// 537-of-538-measured phantom opencode permission notifications (see the PR
// description). emitAttentionSignalDeferred() schedules a kind into the
// `deferred` map WITHOUT touching `state`/emitting anything; drainDeferred()
// flushes anything past its dueAt; cancelDeferred()/clearIfConfirmedKind()/
// clearAttention() drop a pending entry with NOTHING ever emitted — that
// silence (not a confirm-then-immediately-clear race) is what makes a
// fast-resolving permission produce zero bell rows, zero timeline rows, zero
// pushes.
describe("AttentionTracker settle window (emitAttentionSignalDeferred/drainDeferred/cancelDeferred)", () => {
  it("a resolution arriving BEFORE the settle window elapses cancels the deferred emit with ZERO events — no attention, no paired NotificationEvent", () => {
    const { tracker, emitEvent } = makeTracker();

    tracker.emitAttentionSignalDeferred("permissionRequest", { tool: "opencode" }, [
      {
        kind: "permission_request",
        payload: { tool: "opencode", summary: "external_directory /x/*" },
      },
    ]);
    expect(emitEvent).not.toHaveBeenCalled();

    // Auto-approved well inside the window — clearIfConfirmedKind is what
    // permission_resolved (hook-handlers.ts) actually calls; it cancels a
    // still-PENDING deferred entry even though nothing has confirmed yet
    // (state never left "idle" — see its own doc comment for why this is
    // the PRIMARY cancel path, not a fallback).
    tracker.clearIfConfirmedKind("permissionRequest");

    // Even advancing well past the window now finds nothing left to flush.
    tracker.drainDeferred(Date.now() + 5_000);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(tracker.state.state).toBe("idle");
  });

  it("confirm-after-window emits alsoEmit FIRST, then the attention event, preserving today's ordering", () => {
    const { tracker, emitEvent } = makeTracker();
    const now = Date.now();

    tracker.emitAttentionSignalDeferred(
      "permissionRequest",
      { tool: "Bash", summary: "rm -rf /tmp/x" },
      [{ kind: "permission_request", payload: { tool: "Bash", summary: "rm -rf /tmp/x" } }],
    );
    expect(emitEvent).not.toHaveBeenCalled();

    tracker.drainDeferred(now + 2_000);

    expect(emitEvent).toHaveBeenNthCalledWith(1, "permission_request", {
      tool: "Bash",
      summary: "rm -rf /tmp/x",
    });
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      "attention",
      expect.objectContaining({ attention: true, signal: "permissionRequest", tool: "Bash" }),
    );
    expect(tracker.state.state).toBe("attention");
    expect(tracker.state.confirmedKind).toBe("permissionRequest");
  });

  it("a not-yet-due deferred emit is left alone by a drain that hasn't reached its window yet", () => {
    const { tracker, emitEvent } = makeTracker();
    const now = Date.now();

    tracker.emitAttentionSignalDeferred("toolFailure", { title: "Tool failed" });
    tracker.drainDeferred(now + 500); // well short of toolFailure's 2s window

    expect(emitEvent).not.toHaveBeenCalled();
    expect(tracker.state.state).toBe("idle");
  });

  it("two deferred kinds in flight at once each flush independently on their own dueAt — the Map-keyed-by-kind design, not a single slot", () => {
    const { tracker, emitEvent } = makeTracker();
    const now = Date.now();

    // permissionRequest: 2s window. toolFailure: also 2s, but scheduled
    // later in wall-clock terms — its own dueAt is independent.
    tracker.emitAttentionSignalDeferred("permissionRequest", { tool: "Bash" }, [
      { kind: "permission_request", payload: { tool: "Bash" } },
    ]);
    tracker.emitAttentionSignalDeferred("toolFailure", { title: "Tool failed" });

    // Cancelling ONE must never touch the OTHER's own pending entry.
    tracker.cancelDeferred("permissionRequest");
    tracker.drainDeferred(now + 5_000);

    // permissionRequest was cancelled — neither its alsoEmit nor its
    // attention event ever appears.
    expect(emitEvent).not.toHaveBeenCalledWith("permission_request", expect.anything());
    expect(emitEvent).not.toHaveBeenCalledWith(
      "attention",
      expect.objectContaining({ signal: "permissionRequest" }),
    );
    // toolFailure, never cancelled, confirms on its own.
    expect(emitEvent).toHaveBeenCalledWith(
      "attention",
      expect.objectContaining({ attention: true, signal: "toolFailure" }),
    );
  });

  it("a pending agentIdle survives arbitrary plain output (deliberately NOT output-cancellable — see ATTENTION_SETTLE_MS's own comment) and still confirms on tick", () => {
    const { tracker, emitEvent } = makeTracker();
    const now = Date.now();

    tracker.emitAttentionSignalDeferred("agentIdle", {});
    // A plain output-driven transition through the byte-parsed machine (the
    // agent's own post-Stop prompt redraw) must not touch the deferred map
    // at all — applyAttentionTransition only ever mutates `state`/emits via
    // the machine's own `emit` entries, which a bare "output" input from
    // idle never produces.
    tracker.applyAttentionTransition(advanceAttention(tracker.state, { type: "output", now }));
    expect(emitEvent).not.toHaveBeenCalled();

    tracker.drainDeferred(now + 5_000);

    expect(emitEvent).toHaveBeenCalledWith(
      "attention",
      expect.objectContaining({ attention: true, signal: "agentIdle" }),
    );
  });

  it("a pending agentIdle IS cancelled by cancelDeferred — what hook-handlers.ts's progress case calls on a phase:'generating' message", () => {
    const { tracker, emitEvent } = makeTracker();
    const now = Date.now();

    tracker.emitAttentionSignalDeferred("agentIdle", {});
    tracker.cancelDeferred("agentIdle");
    tracker.drainDeferred(now + 5_000);

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it.each(["toolFailure", "apiError"] as const)(
    "a pending %s IS cancelled by cancelDeferred — what pty-manager.ts's onData calls on the agent's next real output chunk",
    (kind) => {
      const { tracker, emitEvent } = makeTracker();
      const now = Date.now();

      tracker.emitAttentionSignalDeferred(kind, { title: "x" });
      tracker.cancelDeferred(kind);
      tracker.drainDeferred(now + 5_000);

      expect(emitEvent).not.toHaveBeenCalled();
    },
  );

  it("clearDeferred() drops everything pending with nothing emitted — the exit/respawn path", () => {
    const { tracker, emitEvent } = makeTracker();
    const now = Date.now();

    tracker.emitAttentionSignalDeferred("permissionRequest", { tool: "Bash" }, [
      { kind: "permission_request", payload: { tool: "Bash" } },
    ]);
    tracker.emitAttentionSignalDeferred("agentIdle", {});

    tracker.clearDeferred();
    tracker.drainDeferred(now + 5_000);

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("clearAttention() also drops every pending deferred emit, not just the confirmed flag — a fresh human prompt supersedes whatever was still settling", () => {
    const { tracker, emitEvent } = makeTracker();
    const now = Date.now();

    tracker.emitAttentionSignalDeferred("permissionRequest", { tool: "Bash" }, [
      { kind: "permission_request", payload: { tool: "Bash" } },
    ]);
    tracker.clearAttention(); // turn_start / a genuine keystroke
    emitEvent.mockClear();

    tracker.drainDeferred(now + 5_000);

    expect(emitEvent).not.toHaveBeenCalled();
  });
});
