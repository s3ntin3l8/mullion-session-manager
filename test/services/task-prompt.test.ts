import { describe, it, expect } from "vitest";
import {
  buildTaskMasterPreamble,
  buildWorkerPrompt,
  buildRejectPrompt,
  buildReviewPrompt,
  buildReviewFeedbackPrompt,
  taskReviewFindingsPath,
  type TaskPromptTask,
} from "../../src/services/task-prompt.js";

const TASK: TaskPromptTask = {
  id: 42,
  issueNumber: 314,
  title: "fix: the widget explodes on Tuesdays",
  body: "## Context\n\nIt explodes.\n\n## Scope\n\n- [ ] Stop it exploding",
};

const BASE = {
  task: TASK,
  branchName: "mullion/task-42",
  worktreePath: "/srv/repo/.mullion-worktrees/mullion-task-42",
  budgetMinutes: 120,
  auto: true,
};

describe("buildTaskMasterPreamble", () => {
  it("names the task, its issue, the branch, and the worktree path", () => {
    const out = buildTaskMasterPreamble(BASE);
    expect(out).toContain("task 42 (GitHub issue #314)");
    expect(out).toContain("mullion/task-42");
    expect(out).toContain("/srv/repo/.mullion-worktrees/mullion-task-42");
  });

  it("omits the issue reference for a local task with no linked issue", () => {
    const out = buildTaskMasterPreamble({ ...BASE, task: { ...TASK, issueNumber: null } });
    expect(out).toContain("task 42");
    expect(out).not.toContain("GitHub issue #");
  });

  // The four rules that motivate this module existing at all — each is
  // unguessable from inside the worktree, so each gets a guard here.
  it("states the completion contract: end the turn, do not exit", () => {
    const out = buildTaskMasterPreamble(BASE);
    expect(out).toContain("End your turn and stay running");
    expect(out).toMatch(/Do NOT run `exit` or `\/quit`/);
  });

  it("warns that untracked files block approval", () => {
    expect(buildTaskMasterPreamble(BASE)).toContain("Untracked files count as dirty");
  });

  it("warns that an outstanding background job suppresses the completion signal", () => {
    expect(buildTaskMasterPreamble(BASE)).toContain(
      "Finish or cancel any background job before you end your turn",
    );
  });

  it("tells the agent not to push, open a PR, or comment on the issue", () => {
    expect(buildTaskMasterPreamble(BASE)).toContain(
      "Do not push, open a\npull request, or comment on the issue yourself",
    );
  });

  it("includes the budget when one is set", () => {
    expect(buildTaskMasterPreamble(BASE)).toContain("Budget: 120 minutes");
  });

  // 0 is the "unlimited" sentinel (env.ts's MULLION_TASK_BUDGET_MINUTES) —
  // promising "0 minutes" would be worse than saying nothing.
  it("omits the budget line entirely when budgetMinutes is 0 (unlimited)", () => {
    const out = buildTaskMasterPreamble({ ...BASE, budgetMinutes: 0 });
    expect(out).not.toContain("Budget:");
    expect(out).not.toContain("minutes from when this task was claimed");
  });

  it("tells an autonomous worker not to stop and ask", () => {
    expect(buildTaskMasterPreamble({ ...BASE, auto: true })).toContain(
      "Nobody is watching this session",
    );
  });

  // A human who clicked Claim IS watching; suppressing the check-in would
  // make a manual claim strictly worse.
  it("does NOT tell a manually-claimed worker to skip asking questions", () => {
    const out = buildTaskMasterPreamble({ ...BASE, auto: false });
    expect(out).not.toContain("Nobody is watching this session");
    // ...but every other rule still applies to a manual claim.
    expect(out).toContain("End your turn and stay running");
  });
});

describe("buildWorkerPrompt", () => {
  it("puts the preamble first, then the issue title and body after a break", () => {
    const out = buildWorkerPrompt({ ...BASE, mode: "claim" });
    expect(out).toContain("Mullion Task Master worker");
    expect(out).toContain("\n\n---\n\n");
    expect(out).toContain(TASK.title);
    expect(out).toContain("- [ ] Stop it exploding");
    expect(out.indexOf("Mullion Task Master worker")).toBeLessThan(out.indexOf(TASK.title));
  });

  it("falls back to the title alone when the issue has no body", () => {
    const out = buildWorkerPrompt({ ...BASE, task: { ...TASK, body: null }, mode: "claim" });
    expect(out.endsWith(TASK.title)).toBe(true);
  });

  it("adds a retry note on the retry path only", () => {
    const retry = buildWorkerPrompt({ ...BASE, mode: "retry" });
    const claim = buildWorkerPrompt({ ...BASE, mode: "claim" });
    expect(retry).toContain("This is a retry");
    expect(retry).toContain("already carries the earlier attempt's commits");
    expect(claim).not.toContain("This is a retry");
  });
});

describe("buildRejectPrompt", () => {
  // The regression guard for the bug this module fixes: the previous
  // feedback-only prompt stranded a freshly-respawned agent with no spec.
  it("carries the task spec as well as the feedback", () => {
    const out = buildRejectPrompt({ ...BASE, feedback: "the fix races on startup" });
    expect(out).toContain("the fix races on startup");
    expect(out).toContain(TASK.title);
    expect(out).toContain("- [ ] Stop it exploding");
  });

  it("still carries the spec when a reject has no feedback text", () => {
    const out = buildRejectPrompt({ ...BASE, feedback: null });
    expect(out).toContain("asked for more work on it");
    expect(out).toContain(TASK.title);
  });

  it("keeps the worker preamble so a respawned agent knows the contract", () => {
    const out = buildRejectPrompt({ ...BASE, feedback: "nope" });
    expect(out).toContain("End your turn and stay running");
    expect(out).toContain("mullion/task-42");
  });
});

const FINDINGS_PATH = "/srv/mullion-sessions/task-42.review.0.md";

describe("buildReviewPrompt", () => {
  it("keeps the original advisory framing verbatim", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain("Review this task's diff. You are not expected to make changes.");
  });

  // The review agent runs in the WORKER's worktree, so anything it writes
  // blocks the human's approve via task-promote.ts's dirty-tree refusal.
  it("warns that writing files in the worker's worktree blocks approval", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain(BASE.worktreePath);
    expect(out).toContain("Do not create or modify any file here");
  });

  it("includes the task spec so the reviewer knows what was asked for", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain(TASK.title);
    expect(out).toContain("- [ ] Stop it exploding");
  });

  it("tells the agent where to write findings, and that doing so is safe there", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain(FINDINGS_PATH);
    expect(out).toContain("If you have no findings, do not create\nthat file at all");
  });

  it("warns findings may be sent back to the worker automatically", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain("may be sent back to the worker automatically");
  });
});

describe("taskReviewFindingsPath", () => {
  it("builds a round-suffixed path under the given sessions dir", () => {
    expect(taskReviewFindingsPath("/srv/mullion-sessions", 42, 0)).toBe(
      "/srv/mullion-sessions/task-42.review.0.md",
    );
  });

  // Round-suffixed, not fixed — a second review (after an auto-returned
  // round) must not reuse or overwrite the first round's file.
  it("produces a different path per round for the same task", () => {
    const round0 = taskReviewFindingsPath("/srv/mullion-sessions", 42, 0);
    const round1 = taskReviewFindingsPath("/srv/mullion-sessions", 42, 1);
    expect(round0).not.toBe(round1);
  });
});

describe("buildReviewFeedbackPrompt", () => {
  it("delivers the findings as if a human had rejected with that feedback", () => {
    const out = buildReviewFeedbackPrompt({ ...BASE, findings: "The retry loop never backs off." });
    expect(out).toContain("An automated review of your work found the following");
    expect(out).toContain("The retry loop never backs off.");
  });

  it("still carries the task spec, since a re-seeded agent may be completely fresh", () => {
    const out = buildReviewFeedbackPrompt({ ...BASE, findings: "fix the thing" });
    expect(out).toContain(TASK.title);
    expect(out).toContain("- [ ] Stop it exploding");
  });

  it("keeps the worker preamble so a respawned agent knows the completion contract", () => {
    const out = buildReviewFeedbackPrompt({ ...BASE, findings: "fix the thing" });
    expect(out).toContain("End your turn and stay running");
    expect(out).toContain("mullion/task-42");
  });
});

// task-watcher.ts and task-agent-resolve.ts scan an issue BODY for these
// whole-line directives. They never scan an assembled prompt, so there's no
// live collision today — this guards a future reword from introducing one,
// which would be invisible until an agent got silently mis-resolved.
describe("directive-line collisions", () => {
  const MANUAL_LINE_RE = /^\s*Manual:\s*true\s*$/im;
  const AGENT_LINE_RE = /^\s*Agent:\s*(\S+)\s*$/im;
  const REVIEW_AGENT_LINE_RE = /^\s*ReviewAgent:\s*(\S+)\s*$/im;

  const preambles = {
    "worker preamble (auto)": buildTaskMasterPreamble({ ...BASE, auto: true }),
    "worker preamble (manual)": buildTaskMasterPreamble({ ...BASE, auto: false }),
    "worker preamble (unlimited budget)": buildTaskMasterPreamble({ ...BASE, budgetMinutes: 0 }),
    "review preamble": buildReviewPrompt({
      task: { ...TASK, body: null },
      worktreePath: "/w",
      findingsPath: "/w-findings/task-42.review.0.md",
    }),
    "review-feedback prompt": buildReviewFeedbackPrompt({ ...BASE, findings: "fix the thing" }),
  };

  for (const [name, text] of Object.entries(preambles)) {
    it(`${name} contains no whole-line Manual:/Agent:/ReviewAgent: directive`, () => {
      expect(MANUAL_LINE_RE.test(text)).toBe(false);
      expect(AGENT_LINE_RE.test(text)).toBe(false);
      expect(REVIEW_AGENT_LINE_RE.test(text)).toBe(false);
    });
  }
});
