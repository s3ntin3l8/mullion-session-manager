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
});
