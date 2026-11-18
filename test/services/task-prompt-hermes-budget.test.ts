import { describe, it, expect } from "vitest";
import { buildReviewPrompt, HERMES_REVIEW_TURN_BUDGET } from "../../src/services/task-prompt.js";

// Its own file because task-prompt.test.ts is at its max-file-lines ceiling.
const task = { id: 42, issueNumber: 314, title: "fix: x", body: "## Scope\n\n- [ ] x" };

describe("buildReviewPrompt turn budget", () => {
  it("tells a reply reviewer its turn budget", () => {
    const out = buildReviewPrompt({
      task,
      output: "reply",
      workspace: "clone",
      remote: { owner: "acme", repo: "widgets", headSha: "h1", prNumber: 7 },
    });
    expect(out).toContain(`about ${HERMES_REVIEW_TURN_BUDGET} tool turns`);
    expect(out).toContain("not-checked");
  });

  it("does not mention a turn budget to a session reviewer", () => {
    const out = buildReviewPrompt({
      task,
      worktreePath: "/srv/repo/.mullion-worktrees/mullion-task-42",
      findingsPath: "/tmp/findings.json",
    });
    expect(out).not.toContain("tool turns");
  });
});
