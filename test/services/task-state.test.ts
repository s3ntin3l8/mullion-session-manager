import { describe, it, expect } from "vitest";
import {
  canTransition,
  TASK_STATUSES,
  CONCURRENCY_CAPPED_STATUSES,
} from "../../src/services/task-state.js";
import type { TaskStatus } from "../../src/db/schema.js";

// Every (from, to) pair the state machine is expected to allow — kept as an
// explicit table so a missing/extra edge shows up as a specific failing
// assertion rather than a diff against the module's own private table.
const LEGAL: [TaskStatus, TaskStatus][] = [
  ["backlog", "ready"],
  ["backlog", "failed"],
  ["ready", "claimed"],
  ["ready", "backlog"],
  ["ready", "failed"],
  ["claimed", "in_progress"],
  ["claimed", "reviewing"],
  ["claimed", "failed"],
  ["in_progress", "reviewing"],
  ["in_progress", "failed"],
  ["reviewing", "done"],
  ["reviewing", "in_progress"],
  ["reviewing", "failed"],
  ["failed", "backlog"],
  ["failed", "ready"],
];

describe("task-state canTransition", () => {
  it("allows every documented legal transition", () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from, to), `${from} -> ${to} should be legal`).toBe(true);
    }
  });

  it("rejects every pair not in the legal table, including self-transitions", () => {
    const legalSet = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const key = `${from}->${to}`;
        if (legalSet.has(key)) continue;
        expect(canTransition(from, to), `${from} -> ${to} should be illegal`).toBe(false);
      }
    }
  });

  it("done is terminal — no transitions out", () => {
    for (const to of TASK_STATUSES) {
      expect(canTransition("done", to)).toBe(false);
    }
  });

  it("does not allow reviewing -> claimed or backlog/ready (session death doesn't fail a reviewing task automatically, but it also can't jump backwards)", () => {
    expect(canTransition("reviewing", "claimed")).toBe(false);
    expect(canTransition("reviewing", "backlog")).toBe(false);
    expect(canTransition("reviewing", "ready")).toBe(false);
  });
});

describe("task-state status sets", () => {
  // Task-claim queueing (rate-limit-storm fix) — "claimed" was removed:
  // it's now the queue state (task-claim.ts's enqueueTask/
  // dispatchClaimedTask split), and must never reject a human's claim
  // click with a 429. See this constant's own doc comment in task-state.ts.
  it("CONCURRENCY_CAPPED_STATUSES is exactly in_progress", () => {
    expect(CONCURRENCY_CAPPED_STATUSES).toEqual(["in_progress"]);
  });
});
