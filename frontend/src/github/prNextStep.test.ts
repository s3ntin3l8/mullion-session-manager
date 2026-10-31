import { describe, expect, it } from "vitest";
import { nextStep } from "./prNextStep.js";

describe("nextStep", () => {
  it("names the one thing each phase needs", () => {
    expect(nextStep("ready_to_merge", 0)).toEqual({
      kind: "merge",
      label: "Squash & merge",
      disabled: false,
    });
    expect(nextStep("changes_requested", 0)).toMatchObject({
      kind: "handoff",
      label: "Address changes",
    });
    expect(nextStep("conflicts", 0)).toMatchObject({ kind: "handoff", label: "Fix conflicts" });
    expect(nextStep("ci_failing", 0)).toMatchObject({ kind: "checks" });
    expect(nextStep("review_pending", 0)).toMatchObject({ kind: "reReview" });
    expect(nextStep("reviewed", 0)).toMatchObject({ kind: "reReview" });
  });

  it("makes updating the branch the step for a PR strict protection holds back", () => {
    expect(nextStep("behind", 0)).toEqual({
      kind: "update",
      label: "Update branch",
      disabled: false,
    });
  });

  it("counts the open conversations", () => {
    expect(nextStep("threads_unresolved", 1).label).toBe("Resolve 1 conversation");
    expect(nextStep("threads_unresolved", 3).label).toBe("Resolve 3 conversations");
    expect(nextStep("threads_unresolved", 0).label).toBe("Resolve conversations");
  });

  it("shows, but does not offer, a step the PR cannot take yet", () => {
    expect(nextStep("draft", 0)).toEqual({ kind: "none", label: "Draft", disabled: true });
    expect(nextStep("ci_pending", 0)).toMatchObject({ kind: "none", disabled: true });
    expect(nextStep(undefined, 0)).toMatchObject({ kind: "none", disabled: true });
  });

  describe("for a Task Master task's PR", () => {
    const task = (over = {}) => ({
      status: "reviewing" as const,
      rebaseStartedAt: null,
      mergeError: null,
      ...over,
    });

    it("sends a reviewing task back to its worker", () => {
      for (const phase of ["changes_requested", "conflicts"] as const) {
        expect(nextStep(phase, 0, { task: task(), workerLive: false })).toEqual({
          kind: "sendBack",
          label: "Send back to worker",
          disabled: false,
        });
      }
    });

    it("opens a live worker session instead of starting one", () => {
      expect(
        nextStep("changes_requested", 0, {
          task: task({ status: "in_progress" }),
          workerLive: true,
        }),
      ).toMatchObject({ kind: "openWorker", disabled: false });
    });

    it("says auto-rebase owns a done task's conflicts", () => {
      const done = (over = {}) => ({
        task: task({ status: "done", ...over }),
        workerLive: false,
      });
      expect(nextStep("conflicts", 0, done({ rebaseStartedAt: "2026-01-01" }))).toEqual({
        kind: "none",
        label: "Auto-rebase in progress",
        disabled: true,
      });
      expect(nextStep("conflicts", 0, done({ mergeError: "conflicts" }))).toMatchObject({
        label: "Auto-rebase will retry",
        disabled: true,
      });
      expect(nextStep("conflicts", 0, done())).toMatchObject({
        label: "Auto-rebase will fix conflicts",
        disabled: true,
      });
    });

    it("never offers an ad-hoc session for any other task state", () => {
      expect(
        nextStep("changes_requested", 0, { task: task({ status: "done" }), workerLive: false }),
      ).toMatchObject({ kind: "none", disabled: true });
    });

    it("leaves non-handoff steps alone", () => {
      expect(nextStep("ci_failing", 0, { task: task(), workerLive: false })).toMatchObject({
        kind: "checks",
      });
    });
  });
});
