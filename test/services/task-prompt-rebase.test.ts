import { describe, it, expect } from "vitest";
import { buildRebasePrompt } from "../../src/services/task-prompt.js";

// Split from task-prompt.test.ts, which sits at its max-file-lines ceiling.
describe("buildRebasePrompt generated files", () => {
  const out = buildRebasePrompt({
    task: { id: 42, issueNumber: 314, title: "fix: x", body: "## Scope\n\n- [ ] x" },
    branchName: "mullion/task-42",
    worktreePath: "/srv/repo/.mullion-worktrees/mullion-task-42",
    budgetMinutes: 60,
    agentCommand: "claude",
    baseRef: "main",
  });

  it("tells the worker to regenerate generated files rather than hand-merge them", () => {
    expect(out).toContain("Generated files are not merged by hand");
    expect(out).toContain("take main's copy");
    expect(out).toContain("git checkout --ours <file>");
    expect(out).toContain("regenerate it with the command");
    expect(out).toContain("AGENTS.md, CONTRIBUTING.md or the file's own header");
    expect(out).toContain("If no regeneration command is documented, say so");
    expect(out).toContain("git grep -nE '^(<<<<<<<|>>>>>>>)'");
  });

  it("names categories of generated file, not one repo's filenames", () => {
    expect(out).toContain("a lockfile");
    expect(out).toContain("import-boundary baseline");
    expect(out).not.toMatch(/\.secrets\.baseline|shard_durations\.\w+\.json/);
  });
});
