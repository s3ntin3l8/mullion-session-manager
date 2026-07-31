import { describe, it, expect } from "vitest";
import {
  deriveSessionStatus,
  type DeriveSessionStatusInput,
} from "../../src/services/session-status.js";
import type { BackgroundTask } from "../../src/services/hook-protocol.js";

// Issue #428 — a single outstanding (non-terminal-status) background task,
// for tests that just need "one thing still running", not its specific
// fields.
const ONE_OUTSTANDING_TASK: BackgroundTask[] = [
  { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
];

// A fully-idle baseline — every branch in deriveSessionStatus starts from
// this and overrides only what the test cares about, so each test reads as
// "given this ONE signal, what wins" rather than restating the whole shape
// every time.
const BASE: DeriveSessionStatusInput["info"] = {
  activity: "idle",
  attention: false,
  attentionKind: null,
  permissionState: "idle",
  planState: "idle",
  gateState: "idle",
  promoteState: "idle",
  questionState: "idle",
  elicitationState: "idle",
  errorState: "idle",
  errorDetail: null,
  endedReason: null,
  exitCode: null,
  compactState: "idle",
  subagentCount: 0,
  lastTurnEndedAt: null,
  outstandingBackgroundTasks: [],
};

function derive(
  overrides: Partial<DeriveSessionStatusInput["info"]> = {},
  dbStatus: "active" | "killed" | "exited" = "active",
) {
  return deriveSessionStatus({ dbStatus, info: { ...BASE, ...overrides } });
}

describe("deriveSessionStatus", () => {
  it("returns idle/dormant for a freshly-created, fully-quiet session", () => {
    expect(derive()).toEqual({
      status: "idle",
      severity: "dormant",
      detail: null,
      attentionRequired: false,
    });
  });

  it("returns working/busy when activity is working and nothing else applies", () => {
    expect(derive({ activity: "working" })).toEqual({
      status: "working",
      severity: "busy",
      detail: null,
      attentionRequired: false,
    });
  });

  describe("liveness axis", () => {
    it("reports exited/gone for a DB-killed session regardless of live activity", () => {
      expect(derive({ activity: "working", permissionState: "pending" }, "killed")).toEqual({
        status: "exited",
        severity: "gone",
        detail: null,
        attentionRequired: false,
      });
    });

    it("reports exited/gone for a DB-exited session, with endedReason as detail", () => {
      expect(derive({ endedReason: "process crashed" }, "exited")).toMatchObject({
        status: "exited",
        severity: "gone",
        detail: "process crashed",
      });
    });

    it("falls back to an exit-code detail string when endedReason is absent", () => {
      expect(derive({ exitCode: 1 }, "exited")).toMatchObject({
        status: "exited",
        detail: "exit code 1",
      });
    });

    it("combines endedReason and exitCode when both are present, rather than dropping one (Hermes review, PR #316)", () => {
      expect(derive({ endedReason: "process crashed", exitCode: 1 }, "exited")).toMatchObject({
        status: "exited",
        detail: "process crashed (exit code 1)",
      });
    });

    it("unifies killed and exited into the same status (fixes the prior Sidebar/kanban inconsistency)", () => {
      expect(derive({}, "killed").status).toBe("exited");
      expect(derive({}, "exited").status).toBe("exited");
    });

    it("does NOT treat a merely-not-yet-reattached session (dbStatus active, no live signal) as exited", () => {
      // This is the ordinary post-restart/pre-reattach case — see the
      // function's own doc comment for why collapsing it into "exited"
      // would flash every session on the board as gone on every restart.
      expect(derive({}, "active").status).toBe("idle");
    });
  });

  describe("agent-activity axis precedence — each case's signal wins over every case below it", () => {
    // Reordered (fix: transient status clearing): every awaiting_* now
    // outranks both error states, since none of the awaiting_* states have
    // an automatic release path the way tool_failure does (see its own
    // gating test below) — a live blocking prompt must never be hidden
    // behind a possibly-stale error.
    it("a pending permission request outranks api_error", () => {
      expect(
        derive({ errorState: "api_error", errorDetail: "rate_limit", permissionState: "pending" }),
      ).toMatchObject({
        status: "awaiting_permission",
        severity: "blocked",
      });
    });

    it("a pending plan outranks tool_failure", () => {
      expect(
        derive({ errorState: "tool_failure", errorDetail: "Bash", planState: "pending" }),
      ).toMatchObject({
        status: "awaiting_plan",
        severity: "blocked",
      });
    });

    it("api_error outranks tool_failure", () => {
      expect(
        derive({ errorState: "api_error", errorDetail: "rate_limit" }, "active"),
      ).toMatchObject({
        status: "api_error",
        severity: "failed",
        detail: "rate_limit",
      });
    });

    it("api_error outranks a finished latch", () => {
      expect(
        derive({ errorState: "api_error", errorDetail: "overloaded", lastTurnEndedAt: 123 }),
      ).toMatchObject({
        status: "api_error",
        severity: "failed",
      });
    });

    it("tool_failure surfaces once the agent has stalled (activity idle)", () => {
      expect(
        derive({ errorState: "tool_failure", errorDetail: "Bash", activity: "idle" }),
      ).toMatchObject({
        status: "tool_failure",
        severity: "failed",
        detail: "Bash",
      });
    });

    it("tool_failure stays hidden behind `working` while the agent is still going", () => {
      expect(
        derive({ errorState: "tool_failure", errorDetail: "Bash", activity: "working" }),
      ).toMatchObject({
        status: "working",
        severity: "busy",
      });
    });

    it("tool_failure outranks finished/needs_input once the agent has stalled", () => {
      expect(
        derive({ errorState: "tool_failure", errorDetail: "Bash", lastTurnEndedAt: 123 }),
      ).toMatchObject({
        status: "tool_failure",
      });
    });

    it("truncates a long detail string rather than letting it overflow the UI", () => {
      const longDetail = `Bash: ${"x".repeat(100)}`;
      const result = derive({ errorState: "api_error", errorDetail: longDetail });
      expect(result.detail).toHaveLength(49); // 48 chars + ellipsis
      expect(result.detail?.endsWith("…")).toBe(true);
    });

    it("leaves a short detail string untouched", () => {
      expect(derive({ errorState: "api_error", errorDetail: "rate_limit" }).detail).toBe(
        "rate_limit",
      );
    });

    it("awaiting_permission outranks a pending plan", () => {
      expect(derive({ permissionState: "pending", planState: "pending" }).status).toBe(
        "awaiting_permission",
      );
    });

    it("awaiting_plan outranks a waiting review gate", () => {
      expect(derive({ planState: "pending", gateState: "waiting" }).status).toBe("awaiting_plan");
    });

    it("awaiting_review_gate outranks a pending promote request", () => {
      expect(derive({ gateState: "waiting", promoteState: "pending" }).status).toBe(
        "awaiting_review_gate",
      );
    });

    it("awaiting_promote outranks a pending question", () => {
      expect(derive({ promoteState: "pending", questionState: "pending" }).status).toBe(
        "awaiting_promote",
      );
    });

    it("awaiting_question outranks a pending elicitation", () => {
      expect(derive({ questionState: "pending", elicitationState: "pending" }).status).toBe(
        "awaiting_question",
      );
    });

    it("awaiting_question maps questionState:pending to status", () => {
      expect(derive({ questionState: "pending" }).status).toBe("awaiting_question");
    });

    it("awaiting_elicitation outranks a finished latch", () => {
      expect(derive({ elicitationState: "pending", lastTurnEndedAt: 123 }).status).toBe(
        "awaiting_elicitation",
      );
    });

    it("finished outranks byte-heuristic attention", () => {
      expect(derive({ lastTurnEndedAt: 123, attention: true, attentionKind: "bell" }).status).toBe(
        "finished",
      );
    });

    it("needs_input outranks compacting", () => {
      expect(
        derive({ attention: true, attentionKind: "silence", compactState: "compacting" }).status,
      ).toBe("needs_input");
    });

    it("needs_input carries the raw attentionKind as detail", () => {
      expect(derive({ attention: true, attentionKind: "titleIdle" })).toMatchObject({
        status: "needs_input",
        severity: "waiting",
        detail: "titleIdle",
      });
    });

    it("compacting outranks a running subagent", () => {
      expect(derive({ compactState: "compacting", subagentCount: 2 }).status).toBe("compacting");
    });

    it("subagent outranks plain working, with the count as detail", () => {
      expect(derive({ subagentCount: 3, activity: "working" })).toMatchObject({
        status: "subagent",
        severity: "busy",
        detail: "3 running",
      });
    });

    // Issue #428 — a Stop hook fired (lastTurnEndedAt latched) but backend-
    // reported backgroundTasks are still outstanding: `background`, not
    // `finished` — this is the core bug the fix addresses.
    it("background outranks finished when backgroundTasks are still outstanding", () => {
      expect(
        derive({ lastTurnEndedAt: 123, outstandingBackgroundTasks: ONE_OUTSTANDING_TASK }),
      ).toMatchObject({
        status: "background",
        severity: "busy",
        detail: "1 task",
      });
    });

    it("finished wins once outstandingBackgroundTasks drains to empty", () => {
      expect(derive({ lastTurnEndedAt: 123, outstandingBackgroundTasks: [] }).status).toBe(
        "finished",
      );
    });

    it("subagent outranks background", () => {
      expect(
        derive({ subagentCount: 1, outstandingBackgroundTasks: ONE_OUTSTANDING_TASK }).status,
      ).toBe("subagent");
    });

    it("background pluralizes the detail count", () => {
      const twoTasks: BackgroundTask[] = [
        { id: "t1", type: "shell", status: "running", description: "tail logs" },
        { id: "t2", type: "subagent", status: "running", description: "Explore agent" },
      ];
      expect(derive({ outstandingBackgroundTasks: twoTasks })).toMatchObject({
        status: "background",
        detail: "2 tasks",
      });
    });
  });

  describe("severity -> attentionRequired mapping", () => {
    it.each([
      ["exited", "gone", false],
      ["api_error", "failed", true],
      ["tool_failure", "failed", true],
      ["awaiting_permission", "blocked", true],
      ["awaiting_plan", "blocked", true],
      ["awaiting_review_gate", "blocked", true],
      ["awaiting_promote", "blocked", true],
      ["awaiting_question", "blocked", true],
      ["awaiting_elicitation", "blocked", true],
      ["finished", "done", true],
      ["needs_input", "waiting", true],
      ["compacting", "busy", false],
      ["subagent", "busy", false],
      ["background", "busy", false],
      ["working", "busy", false],
      ["idle", "dormant", false],
    ] as const)("%s (%s severity) has attentionRequired=%s", (_status, _severity, expected) => {
      // Cross-check every status reachable from BASE with a single
      // targeted override, rather than re-deriving the table by hand —
      // this is the same "exercise every declared member" posture
      // attention-detect.test.ts uses for its own signal-kind tables.
      const overridesByStatus: Record<string, Partial<DeriveSessionStatusInput["info"]>> = {
        exited: {},
        api_error: { errorState: "api_error" },
        tool_failure: { errorState: "tool_failure" },
        awaiting_permission: { permissionState: "pending" },
        awaiting_plan: { planState: "pending" },
        awaiting_review_gate: { gateState: "waiting" },
        awaiting_promote: { promoteState: "pending" },
        awaiting_question: { questionState: "pending" },
        awaiting_elicitation: { elicitationState: "pending" },
        finished: { lastTurnEndedAt: 123 },
        needs_input: { attention: true, attentionKind: "bell" },
        compacting: { compactState: "compacting" },
        subagent: { subagentCount: 1 },
        background: { outstandingBackgroundTasks: ONE_OUTSTANDING_TASK },
        working: { activity: "working" },
        idle: {},
      };
      const dbStatus = _status === "exited" ? "exited" : "active";
      const result = derive(overridesByStatus[_status], dbStatus);
      expect(result.status).toBe(_status);
      expect(result.attentionRequired).toBe(expected);
    });
  });
});
