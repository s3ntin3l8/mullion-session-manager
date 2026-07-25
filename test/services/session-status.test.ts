import { describe, it, expect } from "vitest";
import { deriveSessionStatus, type DeriveSessionStatusInput } from "../../src/services/session-status.js";

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
  elicitationState: "idle",
  errorState: "idle",
  errorDetail: null,
  endedReason: null,
  exitCode: null,
  compactState: "idle",
  subagentCount: 0,
  lastTurnEndedAt: null,
};

function derive(overrides: Partial<DeriveSessionStatusInput["info"]> = {}, dbStatus: "active" | "killed" | "exited" = "active") {
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
    it("api_error outranks a pending permission request", () => {
      expect(derive({ errorState: "api_error", errorDetail: "rate_limit", permissionState: "pending" })).toMatchObject({
        status: "api_error",
        severity: "failed",
        detail: "rate_limit",
      });
    });

    it("tool_failure outranks a pending plan", () => {
      expect(derive({ errorState: "tool_failure", errorDetail: "Bash", planState: "pending" })).toMatchObject({
        status: "tool_failure",
        severity: "failed",
        detail: "Bash",
      });
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

    it("awaiting_promote outranks a pending elicitation", () => {
      expect(derive({ promoteState: "pending", elicitationState: "pending" }).status).toBe(
        "awaiting_promote",
      );
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
      ["awaiting_elicitation", "blocked", true],
      ["finished", "done", true],
      ["needs_input", "waiting", true],
      ["compacting", "busy", false],
      ["subagent", "busy", false],
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
        awaiting_elicitation: { elicitationState: "pending" },
        finished: { lastTurnEndedAt: 123 },
        needs_input: { attention: true, attentionKind: "bell" },
        compacting: { compactState: "compacting" },
        subagent: { subagentCount: 1 },
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
