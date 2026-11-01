import { describe, it, expect } from "vitest";
import { buildRejectFollowUpPrompt } from "../../src/services/task-prompt.js";

describe("buildRejectFollowUpPrompt", () => {
  it("carries only the feedback and the branch — a live worker already has the spec", () => {
    const out = buildRejectFollowUpPrompt({
      branchName: "mullion/task-42-fix",
      feedback: "not this way",
    });
    expect(out).toContain("requested changes:\n\nnot this way");
    expect(out).toContain("mullion/task-42-fix");
    expect(out).not.toContain("Mullion Task Master worker");
  });

  it("asks for more work, without inventing feedback, when there is none", () => {
    const out = buildRejectFollowUpPrompt({ branchName: "b", feedback: null });
    expect(out).toContain("asked for more work on it");
    expect(out).not.toContain("requested changes");
  });

  it("tells the worker that ending its turn sends the task back to review", () => {
    const out = buildRejectFollowUpPrompt({ branchName: "b", feedback: "x" });
    expect(out).toContain("Ending your turn sends the task back to review");
  });

  it("points at the title file only when the project wants conventional titles", () => {
    expect(buildRejectFollowUpPrompt({ branchName: "b", feedback: null })).not.toContain(".title");
    const withTitle = buildRejectFollowUpPrompt({
      branchName: "b",
      feedback: null,
      commitTitlePath: "/s/42.title",
    });
    expect(withTitle).toContain("/s/42.title");
  });
});
