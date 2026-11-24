import { describe, it, expect } from "vitest";
import {
  ALL_KINDS,
  bellClass,
  sessionGroupedSummary,
  sessionOpenDecisions,
} from "./eventDescriptions.js";
import type { BellClass, DecisionLatches } from "./eventDescriptions.js";
import type { NotificationEvent } from "./api/index.js";

function makeEvent(overrides: Partial<NotificationEvent>): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "attention",
    ts: Date.now(),
    payload: {},
    ...overrides,
  };
}

// #3458 — the bell's classification (design note, "Every notification type").
describe("bellClass", () => {
  // Every kind, with the payloads that decide its class. Adding a kind to
  // NotificationEvent without classifying it fails here (and in bellClass's
  // own exhaustive switch, at compile time).
  const TABLE: Record<
    NotificationEvent["kind"],
    Array<[payload: Record<string, unknown>, cls: BellClass]>
  > = {
    attention: [
      [{ attention: true, signal: "hookNotification" }, "decision"],
      [{ attention: true, signal: "agentIdle" }, "grouped"],
      [{ attention: true, signal: "permissionRequest" }, "dropped"],
      [{ attention: true, signal: "planReady" }, "dropped"],
      [{ attention: true, signal: "question" }, "dropped"],
      [{ attention: true, signal: "reviewGate" }, "dropped"],
      [{ attention: true, signal: "apiError" }, "dropped"],
      [{ attention: true, signal: "toolFailure" }, "dropped"],
      [{ attention: true, signal: "bell" }, "dropped"],
      [{ attention: true, signal: "silence" }, "dropped"],
      [{ attention: true, signal: "titleIdle" }, "dropped"],
      [{ attention: true, signal: "altScreenExit" }, "dropped"],
      [{ attention: true, signal: "notification" }, "dropped"],
      [{ attention: false }, "dropped"],
    ],
    permission_request: [[{ tool: "Bash" }, "decision"]],
    plan_ready: [[{}, "decision"]],
    question: [
      [{ state: "started" }, "decision"],
      [{ state: "finished" }, "dropped"],
    ],
    elicitation: [
      [{ state: "started" }, "decision"],
      [{ state: "finished" }, "dropped"],
    ],
    review_gate: [
      [{ state: "waiting" }, "decision"],
      [{ state: "approved" }, "dropped"],
    ],
    promote_request: [
      [{ summary: "x" }, "decision"],
      [{ state: "accepted" }, "dropped"],
    ],
    dev_server_detected: [
      [{ port: "5173" }, "decision"],
      [{ port: "5173", state: "accepted" }, "dropped"],
    ],
    stop_failure: [[{ error: "overloaded" }, "failed"]],
    tool_failure: [[{ tool: "Bash" }, "dropped"]],
    session_end: [
      [{ exitCode: 1 }, "failed"],
      [{ exitCode: 0 }, "dropped"],
      [{ exitCode: null }, "dropped"],
    ],
    status_change: [
      [{ reason: "exited" }, "grouped"],
      [{ phase: "done" }, "dropped"],
    ],
    pr_ci_failed: [[{ number: 1 }, "failed"]],
    pr_conflicts: [[{ number: 1 }, "failed"]],
    pr_review_submitted: [
      [{ number: 1, decision: "CHANGES_REQUESTED" }, "verdict"],
      [{ number: 1, decision: "APPROVED" }, "verdict"],
    ],
    pr_ci_passed: [[{ number: 1 }, "dropped"]],
    pr_merged: [[{ number: 1 }, "dropped"]],
    pr_new_comments: [[{ number: 1 }, "dropped"]],
    title_change: [[{ title: "x" }, "dropped"]],
    file_change: [[{ path: "x" }, "dropped"]],
    todo: [[{}, "dropped"]],
    session_diff: [[{}, "dropped"]],
    message_sent: [[{}, "dropped"]],
    message_received: [[{}, "dropped"]],
  };

  it("covers every NotificationEvent kind", () => {
    expect(Object.keys(TABLE).sort()).toEqual([...ALL_KINDS].sort());
  });

  for (const kind of ALL_KINDS) {
    it(`classifies ${kind}`, () => {
      for (const [payload, cls] of TABLE[kind]) {
        expect({ payload, cls: bellClass({ kind, payload }) }).toEqual({ payload, cls });
      }
    });
  }
});

describe("sessionOpenDecisions", () => {
  const idle: DecisionLatches = {
    id: 1,
    alive: true,
    attention: false,
    attentionKind: null,
    permissionState: "idle",
    planState: "idle",
    elicitationState: "idle",
    promoteState: "idle",
    errorState: "idle",
    gates: [],
    pendingDevServerPort: null,
  };
  const ev = (seq: number, kind: NotificationEvent["kind"], payload = {}, ts = 1000 + seq) =>
    makeEvent({ seq, kind, payload, ts });
  const seqs = (s: DecisionLatches, events: NotificationEvent[], taskOwned = false) =>
    sessionOpenDecisions(s, events, {}, false, taskOwned).map((d) => d.event.seq);

  it("keys each latched kind off its own latch, newest event only", () => {
    const events = [ev(1, "permission_request"), ev(2, "plan_ready"), ev(3, "permission_request")];
    expect(seqs(idle, events)).toEqual([]);
    expect(seqs({ ...idle, permissionState: "pending" }, events)).toEqual([3]);
    expect(seqs({ ...idle, planState: "pending" }, events)).toEqual([2]);
  });

  it("lists a latched kind's event only if it was emitted for the current raise", () => {
    // Permission A (seq 1) was answered; B was raised at 5000 and is still
    // settling (its event comes up to 2s later, or never if auto-approved).
    const a = ev(1, "permission_request", { summary: "A" }, 1_001);
    const s = { ...idle, permissionState: "pending" as const, permissionAt: 5_000 };
    expect(seqs(s, [a])).toEqual([]);
    expect(seqs(s, [a, ev(2, "permission_request", { summary: "B" }, 6_900)])).toEqual([2]);
    // Without the timestamp (an older backend), the newest event stands in.
    expect(seqs({ ...s, permissionAt: undefined }, [a])).toEqual([1]);
    const plan = ev(3, "plan_ready", {}, 1_000);
    expect(seqs({ ...idle, planState: "pending", planAt: 9_000 }, [plan])).toEqual([]);
  });

  it("closes a question, elicitation or promote by its own later resolution record", () => {
    const s: DecisionLatches = {
      ...idle,
      attention: true,
      attentionKind: "question",
      elicitationState: "pending",
      promoteState: "pending",
    };
    const asks = [
      ev(1, "question", { state: "started" }),
      ev(2, "elicitation", { state: "started" }),
      ev(3, "promote_request", { summary: "x" }),
    ];
    expect(seqs(s, asks)).toEqual([3, 2, 1]);
    const resolved = [
      ...asks,
      ev(4, "question", { state: "finished" }),
      ev(5, "elicitation", { state: "finished" }),
      ev(6, "promote_request", { state: "accepted" }),
    ];
    expect(seqs(s, resolved)).toEqual([]);
  });

  it("keeps a question open on its own latch, even when a later plan took the attention", () => {
    const events = [ev(1, "question", { state: "started" }), ev(2, "plan_ready")];
    const s = {
      ...idle,
      attention: true,
      attentionKind: "planReady",
      planState: "pending" as const,
    };
    expect(seqs({ ...s, questionState: "pending" }, events)).toEqual([2, 1]);
    expect(seqs({ ...s, questionState: "idle" }, events)).toEqual([2]);
  });

  it("without the latch (an older backend), keeps a question open while it is the confirmed attention", () => {
    const events = [ev(1, "question", { state: "started" })];
    expect(seqs({ ...idle, attention: true, attentionKind: "question" }, events)).toEqual([1]);
    expect(seqs({ ...idle, attention: true, attentionKind: "agentIdle" }, events)).toEqual([]);
  });

  it("lists every waiting gate still in `gates`, by gateId", () => {
    const s = { ...idle, gates: [{ gateId: "b" }] };
    const events = [
      ev(1, "review_gate", { state: "waiting", gateId: "a" }),
      ev(2, "review_gate", { state: "waiting", gateId: "b" }),
    ];
    expect(seqs(s, events)).toEqual([2]);
  });

  it("lists a legacy gate with no gateId once, while any gate waits", () => {
    const events = [
      ev(1, "review_gate", { state: "waiting" }),
      ev(2, "review_gate", { state: "waiting" }),
    ];
    expect(seqs({ ...idle, gates: [{ gateId: "x" }] }, events)).toEqual([2]);
    expect(seqs(idle, events)).toEqual([]);
  });

  it("lists an unpaired generic notification while it is the confirmed attention", () => {
    const s = { ...idle, attention: true, attentionKind: "hookNotification" };
    const note = ev(1, "attention", { attention: true, signal: "hookNotification" }, 10_000);
    expect(seqs(s, [note])).toEqual([1]);
    // A specific ask within 5s, before or after, answered or not, covers it.
    expect(seqs(s, [ev(0, "permission_request", {}, 6_000), note])).toEqual([]);
    expect(seqs(s, [note, ev(2, "plan_ready", {}, 14_000)])).toEqual([]);
    // A resolution record is not an ask: it hides nothing.
    expect(seqs(s, [ev(0, "question", { state: "finished" }, 9_000), note])).toEqual([1]);
    // Further apart, it stands on its own.
    expect(seqs(s, [ev(0, "permission_request", {}, 1_000), note])).toEqual([1]);
  });

  it("keeps a dev-server offer open while the session's pending port is this one", () => {
    const events = [ev(1, "dev_server_detected", { port: "5173" })];
    expect(seqs({ ...idle, pendingDevServerPort: "5173" }, events)).toEqual([1]);
    expect(seqs({ ...idle, pendingDevServerPort: "3000" }, events)).toEqual([]);
  });

  it("keeps a stop failure open while errorState is api_error, a non-zero exit while not alive", () => {
    const events = [ev(1, "stop_failure"), ev(2, "session_end", { exitCode: 3 })];
    expect(seqs({ ...idle, errorState: "api_error", alive: false }, events)).toEqual([2, 1]);
    expect(seqs({ ...idle, errorState: "tool_failure" }, events)).toEqual([]);
  });

  it("settles PR news per PR number, and drops it for a task's session", () => {
    const events = [
      ev(1, "pr_ci_failed", { number: 7 }),
      ev(2, "pr_ci_failed", { number: 8 }),
      ev(3, "pr_conflicts", { number: 7 }),
      ev(4, "pr_review_submitted", { number: 7, decision: "CHANGES_REQUESTED" }),
      ev(5, "pr_ci_passed", { number: 8 }),
    ];
    expect(seqs(idle, events)).toEqual([4, 3, 1]);
    const merged = [...events, ev(6, "pr_merged", { number: 7 })];
    expect(seqs(idle, merged)).toEqual([]);
    expect(seqs(idle, events, true)).toEqual([]);
  });

  it("returns nothing for a muted session, and skips a dismissed event", () => {
    const s = { ...idle, permissionState: "pending" as const };
    const e = ev(1, "permission_request");
    expect(sessionOpenDecisions(s, [e], {}, true)).toEqual([]);
    expect(sessionOpenDecisions(s, [e], { [`1:1:${e.ts}`]: true }, false)).toEqual([]);
  });
});

describe("sessionGroupedSummary", () => {
  const finished = (seq: number) =>
    makeEvent({ seq, ts: 1000 + seq, payload: { attention: true, signal: "agentIdle" } });
  const exited = (seq: number) =>
    makeEvent({ seq, ts: 1000 + seq, kind: "status_change", payload: { reason: "exited" } });

  it("summarises one session's finished turns and exit, newest first", () => {
    expect(sessionGroupedSummary(1, [finished(1), exited(2)], 1, {}, false)).toEqual({
      finished: true,
      exited: true,
      seqs: [2, 1],
      newestTs: 1002,
      unread: true,
    });
  });

  it("leaves out a failed exit (already a Failed row) and dismissed events", () => {
    expect(sessionGroupedSummary(1, [exited(2)], 0, {}, true)).toBeNull();
    expect(sessionGroupedSummary(1, [finished(1)], 0, { "1:1:1001": true }, false)).toBeNull();
    expect(sessionGroupedSummary(1, undefined, 0, {}, false)).toBeNull();
  });
});
