import { describe, it, expect } from "vitest";
import {
  buildTaskMasterPreamble,
  buildWorkerPrompt,
  buildRejectPrompt,
  buildReviewPrompt,
  buildReviewFeedbackPrompt,
  taskReviewFindingsPath,
  parseReviewFindings,
  renderReviewFindingsMarkdown,
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

  // The worker's own CI never exists yet — Mullion opens the PR only after
  // the turn ends — so a confident "CI is green" claim can only be a guess.
  it("tells the worker to run its own verification gate and not claim CI is green", () => {
    const out = buildTaskMasterPreamble(BASE);
    expect(out).toContain("Run the repo's own verification gate before you commit");
    expect(out).toContain("do not claim CI is green");
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
    expect(out).toContain("Always write your findings");
  });

  // The regression this contract exists to prevent: file-existence alone
  // used to mean "no findings" — see task-reconciler.test.ts's own
  // regression tests for the reconciler side of this guard.
  it("requires an explicit verdict and tells the agent a missing file is inconclusive, not clean", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain('"verdict": "clean" | "changes-requested"');
    expect(out).toMatch(/missing or unparseable[\s\S]*inconclusive/);
    expect(out).not.toContain("do not create\nthat file at all");
  });

  it("tells the agent every finding needs a real file:line, not prose in the summary", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain("autonomous-pr-review skill");
    expect(out).toContain("inline");
  });

  it("warns a changes-requested verdict may be sent back to the worker automatically", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain("may be sent back to the worker automatically");
  });
});

const CLEAN_JSON = JSON.stringify({
  verdict: "clean",
  summary: "Reviewed the diff and ran `go test ./...`; no issues found.",
});

const CHANGES_REQUESTED_JSON = JSON.stringify({
  verdict: "changes-requested",
  summary: "One errcheck failure golangci-lint would catch.",
  findings: [
    {
      path: "cmd/branchdam/main_test.go",
      line: 669,
      side: "RIGHT",
      severity: "major",
      body: "`defer occupied.Close()` ignores its error return — wrap it or assign to `_` explicitly.",
    },
  ],
});

describe("parseReviewFindings", () => {
  it("parses a well-formed clean verdict with no findings array", () => {
    const parsed = parseReviewFindings(CLEAN_JSON);
    expect(parsed.verdict).toBe("clean");
    expect(parsed.summary).toContain("go test");
    expect(parsed.findings).toEqual([]);
  });

  it("parses a well-formed changes-requested verdict with anchored findings", () => {
    const parsed = parseReviewFindings(CHANGES_REQUESTED_JSON);
    expect(parsed.verdict).toBe("changes-requested");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      path: "cmd/branchdam/main_test.go",
      line: 669,
      side: "RIGHT",
      severity: "major",
    });
  });

  it("defaults an omitted side to RIGHT and an unrecognized severity to null", () => {
    const parsed = parseReviewFindings(
      JSON.stringify({
        verdict: "changes-requested",
        summary: "s",
        findings: [{ path: "a.go", line: 1, body: "b", severity: "catastrophic" }],
      }),
    );
    expect(parsed.findings[0].side).toBe("RIGHT");
    expect(parsed.findings[0].severity).toBeNull();
  });

  it("drops a findings-array entry missing a required field rather than throwing", () => {
    const parsed = parseReviewFindings(
      JSON.stringify({
        verdict: "changes-requested",
        summary: "s",
        findings: [{ path: "a.go", body: "no line number" }],
      }),
    );
    expect(parsed.findings).toEqual([]);
  });

  // Hermes review, PR #733 — an LLM routinely emits a numeric string
  // ("line": "42") rather than a bare number; coercing it is what keeps a
  // real finding from silently vanishing.
  it("coerces a numeric-string line to a number rather than dropping the finding", () => {
    const parsed = parseReviewFindings(
      JSON.stringify({
        verdict: "changes-requested",
        summary: "s",
        findings: [{ path: "a.go", line: "42", body: "b" }],
      }),
    );
    expect(parsed.findings).toEqual([
      { path: "a.go", line: 42, side: "RIGHT", severity: null, body: "b" },
    ]);
  });

  // Hermes review, PR #733 — a 0/negative/fractional line would later fail
  // as a GitHub inline-comment anchor (createPullRequestReview); dropping it
  // here is better than surfacing a 422 downstream.
  it("drops a finding whose line is zero, negative, fractional, or non-numeric text", () => {
    for (const line of [0, -1, 3.5, "not-a-number"]) {
      const parsed = parseReviewFindings(
        JSON.stringify({
          verdict: "changes-requested",
          summary: "s",
          findings: [{ path: "a.go", line, body: "b" }],
        }),
      );
      expect(parsed.findings).toEqual([]);
    }
  });

  // The safety property Change 1 exists for: an agent that ignores the JSON
  // contract must never silently read as "clean" — it must default to the
  // verdict that keeps a human in the loop.
  it("treats freeform/legacy text as changes-requested with the raw text as the summary", () => {
    const parsed = parseReviewFindings("Fix the null check on line 42.");
    expect(parsed.verdict).toBe("changes-requested");
    expect(parsed.summary).toBe("Fix the null check on line 42.");
    expect(parsed.findings).toEqual([]);
  });

  it("treats malformed JSON the same as freeform text, not as a crash", () => {
    const parsed = parseReviewFindings('{"verdict": "clean", "summary": ');
    expect(parsed.verdict).toBe("changes-requested");
    expect(parsed.findings).toEqual([]);
  });

  it("treats valid JSON with an unrecognized verdict value as freeform text", () => {
    const parsed = parseReviewFindings(JSON.stringify({ verdict: "looks fine", summary: "s" }));
    expect(parsed.verdict).toBe("changes-requested");
  });
});

describe("renderReviewFindingsMarkdown", () => {
  it("renders just the summary when there are no anchored findings", () => {
    const out = renderReviewFindingsMarkdown(parseReviewFindings(CLEAN_JSON));
    expect(out).toBe("Reviewed the diff and ran `go test ./...`; no issues found.");
  });

  it("renders the summary followed by a path:line bullet per finding, prefixed with its severity", () => {
    const out = renderReviewFindingsMarkdown(parseReviewFindings(CHANGES_REQUESTED_JSON));
    expect(out).toContain("One errcheck failure golangci-lint would catch.");
    expect(out).toContain("[major] **cmd/branchdam/main_test.go:669**");
    expect(out).toContain("wrap it or assign to `_` explicitly");
  });

  it("omits the severity prefix entirely for a finding with no recognized severity", () => {
    const parsed = parseReviewFindings(
      JSON.stringify({
        verdict: "changes-requested",
        summary: "s",
        findings: [{ path: "a.go", line: 1, body: "b" }],
      }),
    );
    const out = renderReviewFindingsMarkdown(parsed);
    expect(out).toContain("- **a.go:1** — b");
    expect(out).not.toContain("[null]");
    expect(out).not.toContain("undefined");
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
