import { describe, it, expect } from "vitest";
import {
  buildTaskMasterPreamble,
  buildWorkerPrompt,
  buildRejectPrompt,
  buildReviewPrompt,
  buildReviewFeedbackPrompt,
  taskReviewFindingsPath,
  taskCommitTitlePath,
  parseReviewFindings,
  parseCommitTitle,
  renderReviewFindingsMarkdown,
  severityPrefix,
  renderCiSummary,
  type ReviewCiInfo,
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

  // The reviewer that follows this worker cannot edit anything and draws on
  // a small, never-reset round budget — a defect the worker catches itself
  // is free; the same one caught downstream is not. This instruction must
  // stay CLI-neutral: it runs against arbitrary target repos and CLIs, so it
  // must not name a specific command or subagent that may not exist there.
  it("tells the worker to review its own diff, without naming a CLI-specific tool", () => {
    const out = buildTaskMasterPreamble(BASE);
    expect(out).toContain("Look over your own diff with fresh eyes before committing");
    expect(out).not.toContain("/code-review");
    expect(out).not.toContain("mullion-reviewer");
  });

  // Pins the bullet's position so a future reword can't silently reorder the
  // contract's emphasis: verify → self-review → commit, so the worker always
  // reviews with the FULL verification-gate diff in view, before it's split
  // across commits.
  it("places the self-review bullet after the verification gate and before committing", () => {
    const out = buildTaskMasterPreamble(BASE);
    const verifyIdx = out.indexOf("Run the repo's own verification gate before you commit");
    const selfReviewIdx = out.indexOf("Look over your own diff with fresh eyes before committing");
    const commitIdx = out.indexOf(`Commit your work on ${BASE.branchName}`);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(selfReviewIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(selfReviewIdx).toBeGreaterThan(verifyIdx);
    expect(commitIdx).toBeGreaterThan(selfReviewIdx);
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

  // #761 — gated entirely on the caller supplying `commitTitlePath` (which
  // every caller only does when the project has `conventionalCommitTitles`
  // on); omitted by default so an off-by-default feature stays silent for
  // every project that hasn't opted in.
  it("omits the PR title instruction when commitTitlePath is not supplied", () => {
    const out = buildTaskMasterPreamble(BASE);
    expect(out).not.toContain("Conventional Commits title");
  });

  it("tells the worker where to write a Conventional Commits title when commitTitlePath is supplied", () => {
    const out = buildTaskMasterPreamble({
      ...BASE,
      commitTitlePath: "/srv/mullion-sessions/task-42.title",
    });
    expect(out).toContain("/srv/mullion-sessions/task-42.title");
    expect(out).toContain("Conventional Commits title");
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

// #939/#1016 — a worker's prompt today is exactly `${title}\n\n${body}`;
// these cover the optional comments/parent/siblings context
// task-issue-context.ts resolves and threads through TaskPromptTask.
describe("buildWorkerPrompt — issue context (#939/#1016)", () => {
  it("does not render any extra section when comments/parent/siblings are absent (unchanged shape)", () => {
    const out = buildWorkerPrompt({ ...BASE, mode: "claim" });
    expect(out.endsWith("- [ ] Stop it exploding")).toBe(true);
    expect(out).not.toContain("Comments on this issue");
    expect(out).not.toContain("Parent tracking issue");
    expect(out).not.toContain("Sibling sub-issues");
  });

  it("renders the task's own comments after the issue spec, newest-last", () => {
    const out = buildWorkerPrompt({
      ...BASE,
      mode: "claim",
      task: {
        ...TASK,
        comments: [
          { author: "alice", body: "first thought", createdAt: "2026-01-01T00:00:00Z" },
          { author: "bob", body: "second thought", createdAt: "2026-01-02T00:00:00Z" },
        ],
      },
    });
    expect(out).toContain("## Comments on this issue");
    expect(out).toContain("@alice: first thought");
    expect(out).toContain("@bob: second thought");
    expect(out.indexOf("@alice")).toBeLessThan(out.indexOf("@bob"));
    expect(out.indexOf("Stop it exploding")).toBeLessThan(out.indexOf("@alice"));
  });

  it("renders 'someone' for a comment with no author", () => {
    const out = buildWorkerPrompt({
      ...BASE,
      mode: "claim",
      task: {
        ...TASK,
        comments: [{ author: null, body: "anonymous note", createdAt: "2026-01-01T00:00:00Z" }],
      },
    });
    expect(out).toContain("- someone: anonymous note");
  });

  it("caps rendered comments to the last 10 and notes how many were omitted", () => {
    const comments = Array.from({ length: 13 }, (_, i) => ({
      author: `user${i}`,
      body: `comment ${i}`,
      createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const out = buildWorkerPrompt({ ...BASE, mode: "claim", task: { ...TASK, comments } });
    expect(out).toContain("(3 earlier comments omitted for length)");
    expect(out).not.toContain("user0:");
    expect(out).not.toContain("user2:");
    expect(out).toContain("user3:");
    expect(out).toContain("user12:");
  });

  it("truncates an overlong comment body", () => {
    const longBody = "x".repeat(2000);
    const out = buildWorkerPrompt({
      ...BASE,
      mode: "claim",
      task: {
        ...TASK,
        comments: [{ author: "alice", body: longBody, createdAt: "2026-01-01T00:00:00Z" }],
      },
    });
    expect(out).toContain("x".repeat(800) + "…");
    expect(out).not.toContain("x".repeat(801));
  });

  it("renders the parent epic as context-only, with the 'not your task' framing", () => {
    const out = buildWorkerPrompt({
      ...BASE,
      mode: "claim",
      task: {
        ...TASK,
        parent: {
          number: 939,
          repo: "s3ntin3l8/mullion-session-manager",
          title: "feat: rework agent instruction architecture",
          body: "streams S1-S6...",
          comments: [],
        },
      },
    });
    expect(out).toContain("## Parent tracking issue #939 (s3ntin3l8/mullion-session-manager)");
    expect(out).toContain("context only, not your task");
    expect(out).toContain("Do not implement the epic's other streams");
    expect(out).toContain("feat: rework agent instruction architecture");
    expect(out).toContain("streams S1-S6...");
  });

  it("renders the parent's own comments, nested under the parent section", () => {
    const out = buildWorkerPrompt({
      ...BASE,
      mode: "claim",
      task: {
        ...TASK,
        parent: {
          number: 939,
          repo: "owner/repo",
          title: "Epic",
          body: null,
          comments: [
            { author: "carol", body: "spike result: X", createdAt: "2026-01-01T00:00:00Z" },
          ],
        },
      },
    });
    expect(out).toContain("Parent issue comments:");
    expect(out).toContain("@carol: spike result: X");
  });

  it("does not render a parent section when parent is null (resolved: genuinely no parent)", () => {
    const out = buildWorkerPrompt({ ...BASE, mode: "claim", task: { ...TASK, parent: null } });
    expect(out).not.toContain("Parent tracking issue");
  });

  it("renders sibling sub-issues, somebody-else's-job framing included", () => {
    const out = buildWorkerPrompt({
      ...BASE,
      mode: "claim",
      task: {
        ...TASK,
        siblings: [
          { issueNumber: 940, title: "Decompose agent guide", status: "in_progress" },
          { issueNumber: 941, title: "Host-local content sync", status: "ready" },
        ],
      },
    });
    expect(out).toContain("## Sibling sub-issues");
    expect(out).toContain("somebody else's job, not yours");
    expect(out).toContain("- #940 (in_progress): Decompose agent guide");
    expect(out).toContain("- #941 (ready): Host-local content sync");
  });

  it("never folds injected context into the directive-parsed task.body", () => {
    // #1016/task-agent-resolve.ts/task-model-resolve.ts all re-parse
    // task.body for directives — a parent's body containing one must never
    // reach that parsing. This is a structural guarantee (comments/parent/
    // siblings are separate TaskPromptTask fields, never merged into body),
    // asserted here so a future refactor that merges them trips a test.
    const out = buildWorkerPrompt({
      ...BASE,
      mode: "claim",
      task: {
        ...TASK,
        parent: {
          number: 1,
          repo: "owner/repo",
          title: "Epic",
          body: "Manual: true\nAgent: codex",
          comments: [],
        },
      },
    });
    // The parent's directive-shaped lines still appear (as context text),
    // but only inside the fenced parent section, not as this task's own
    // body — i.e. TASK.body itself is untouched by this widened task object.
    expect(TASK.body).not.toContain("Manual: true");
    expect(out).toContain("Manual: true");
    expect(out).toContain("## Parent tracking issue");
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
    expect(out).toContain("a real file:line in this diff");
    expect(out).toContain("inline");
    // No longer a dangling pointer to a skill this repo doesn't ship — see
    // task-prompt.ts's buildReviewPrompt doc comment.
    expect(out).not.toContain("autonomous-pr-review");
  });

  it("asks for a one-sentence summary and the optional verified/notes/looksGood arrays", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain('"summary": "one sentence');
    expect(out).toContain('"verified"');
    expect(out).toContain('"notes"');
    expect(out).toContain('"looksGood"');
  });

  it("warns a changes-requested verdict may be sent back to the worker automatically", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain("may be sent back to the worker automatically");
  });

  it("omits any CI paragraph when ci is not given", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).not.toContain("CI on this PR");
    expect(out).not.toContain("CI status on this PR");
  });

  it("includes the rendered CI summary before the task spec when ci is given", () => {
    const ci: ReviewCiInfo = {
      headSha: "d2cc8f96f200690f2353b2b57defc460f75105d", // pragma: allowlist secret
      status: "failure",
      runs: [{ name: "CI / golangci-lint", conclusion: "failure", htmlUrl: "https://x/1" }],
    };
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
      ci,
    });
    expect(out).toContain("CI on this PR's head commit d2cc8f9 is FAILURE");
    expect(out.indexOf("CI on this PR")).toBeLessThan(out.indexOf(`Task: ${TASK.title}`));
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

  it("marks a well-formed JSON review as structured, and freeform text as not", () => {
    expect(parseReviewFindings(CLEAN_JSON).structured).toBe(true);
    expect(parseReviewFindings("Fix the null check on line 42.").structured).toBe(false);
    expect(parseReviewFindings('{"verdict": "clean", "summary": ').structured).toBe(false);
  });

  it("defaults verified/notes/looksGood to empty arrays when omitted", () => {
    const parsed = parseReviewFindings(CLEAN_JSON);
    expect(parsed.verified).toEqual([]);
    expect(parsed.notes).toEqual([]);
    expect(parsed.looksGood).toEqual([]);
  });

  it("parses verified/notes/looksGood, dropping non-string entries rather than throwing", () => {
    const parsed = parseReviewFindings(
      JSON.stringify({
        verdict: "clean",
        summary: "s",
        verified: ["make lint && make typecheck", "", 42, "vitest run test/x.test.ts"],
        notes: ["worth a follow-up issue"],
        looksGood: ["clean removal of the deprecated option"],
      }),
    );
    expect(parsed.verified).toEqual(["make lint && make typecheck", "vitest run test/x.test.ts"]);
    expect(parsed.notes).toEqual(["worth a follow-up issue"]);
    expect(parsed.looksGood).toEqual(["clean removal of the deprecated option"]);
  });

  it("defaults verified/notes/looksGood to [] when present but not an array", () => {
    const parsed = parseReviewFindings(
      JSON.stringify({ verdict: "clean", summary: "s", verified: "make lint" }),
    );
    expect(parsed.verified).toEqual([]);
  });
});

// Hermes review, PR #736 — shared between this file's own bullet renderer
// and task-github-sync.ts's inline-anchor comment body, so the two can't
// silently drift into different severity styling.
describe("severityPrefix", () => {
  it("renders a bracketed prefix with a trailing space for a recognized severity", () => {
    expect(severityPrefix("blocker")).toBe("[blocker] ");
  });

  it("renders nothing for null", () => {
    expect(severityPrefix(null)).toBe("");
  });
});

const FULL_SHAPE_JSON = JSON.stringify({
  verdict: "changes-requested",
  summary: "One blocker and a nit.",
  findings: [
    {
      path: "cmd/branchdam/main_test.go",
      line: 669,
      side: "RIGHT",
      severity: "blocker",
      body: "`defer occupied.Close()` ignores its error return.",
    },
    {
      path: "cmd/branchdam/main.go",
      line: 12,
      side: "RIGHT",
      severity: "nit",
      body: "Prefer `const` over `let` here.",
    },
  ],
  verified: ["make lint && make typecheck", "npx vitest run test/x.test.ts"],
  notes: ["Worth filing a follow-up issue for the flaky test."],
  looksGood: ["Root-cause-clean removal of the deprecated option."],
});

describe("renderReviewFindingsMarkdown", () => {
  it("returns the summary verbatim for a freeform (non-JSON) review, no headings", () => {
    const parsed = parseReviewFindings("Fix the null check on line 42.");
    const out = renderReviewFindingsMarkdown(parsed);
    expect(out).toBe("Fix the null check on line 42.");
    expect(out).not.toContain("**Verdict:**");
    expect(out).not.toContain("###");
  });

  it("returns the summary verbatim for malformed JSON too", () => {
    const parsed = parseReviewFindings('{"verdict": "clean", "summary": ');
    const out = renderReviewFindingsMarkdown(parsed);
    expect(out).not.toContain("**Verdict:**");
    expect(out).not.toContain("###");
  });

  // Hermes review, PR #992 — valid JSON in the OLD contract shape (the
  // whole review dumped into `summary`) still parses as `structured: true`;
  // length is the only signal left to catch it and avoid wrapping a
  // paragraph in "**Verdict:**" above four empty "- None" sections.
  it("returns a suspiciously long structured summary verbatim too, even though it parsed as JSON", () => {
    const longSummary =
      "Reviewed the full diff across every changed file. ".repeat(8) + "No issues found.";
    expect(longSummary.length).toBeGreaterThan(300);
    const parsed = parseReviewFindings(JSON.stringify({ verdict: "clean", summary: longSummary }));
    expect(parsed.structured).toBe(true);
    const out = renderReviewFindingsMarkdown(parsed);
    expect(out).toBe(longSummary);
    expect(out).not.toContain("**Verdict:**");
    expect(out).not.toContain("###");
  });

  it("does not leave a dangling em-dash when the reviewer left summary empty", () => {
    const parsed = parseReviewFindings(JSON.stringify({ verdict: "clean", summary: "" }));
    const out = renderReviewFindingsMarkdown(parsed);
    expect(out).toContain("**Verdict:** clean\n");
    expect(out).not.toContain("— \n");
    expect(out).not.toMatch(/— *$/m);
  });

  it("renders a legacy-shape (verdict/summary/findings only) JSON review with sections and no Verified", () => {
    const out = renderReviewFindingsMarkdown(parseReviewFindings(CLEAN_JSON));
    expect(out).toContain("**Verdict:** clean — Reviewed the diff and ran `go test ./...`");
    expect(out).toContain("### Critical\n- None");
    expect(out).toContain("### Warnings\n- None");
    expect(out).toContain("### Suggestions\n- None");
    expect(out).toContain("### Looks Good\n- None");
    expect(out).not.toContain("### Verified");
  });

  it("renders a full-shape review in Hermes section order, grouped by severity", () => {
    const out = renderReviewFindingsMarkdown(parseReviewFindings(FULL_SHAPE_JSON));
    const order = [
      "**Verdict:**",
      "### Critical",
      "### Warnings",
      "### Suggestions",
      "### Verified",
      "### Looks Good",
    ];
    let cursor = -1;
    for (const marker of order) {
      const idx = out.indexOf(marker);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
    expect(out).toContain("### Critical\n- [blocker] **cmd/branchdam/main_test.go:669**");
    expect(out).toContain("### Warnings\n- None");
    expect(out).toContain("### Suggestions\n- [nit] **cmd/branchdam/main.go:12**");
    expect(out).toContain(
      "### Verified\n- make lint && make typecheck\n- npx vitest run test/x.test.ts",
    );
    expect(out).toContain("### Notes\n- Worth filing a follow-up issue for the flaky test.");
    expect(out).toContain("### Looks Good\n- Root-cause-clean removal of the deprecated option.");
  });

  it("puts a severity-less finding under Warnings, not Suggestions", () => {
    const parsed = parseReviewFindings(
      JSON.stringify({
        verdict: "changes-requested",
        summary: "s",
        findings: [{ path: "a.go", line: 1, body: "b" }],
      }),
    );
    const out = renderReviewFindingsMarkdown(parsed);
    expect(out).toContain("### Warnings\n- **a.go:1** — b");
    expect(out).toContain("### Suggestions\n- None");
  });

  it("notes non-blocking-only when changes-requested has no Critical findings", () => {
    const parsed = parseReviewFindings(
      JSON.stringify({
        verdict: "changes-requested",
        summary: "s",
        findings: [{ path: "a.go", line: 1, body: "b", severity: "nit" }],
      }),
    );
    const out = renderReviewFindingsMarkdown(parsed);
    expect(out).toContain("**Verdict:** changes requested (non-blocking findings only) — s");
    expect(out).toContain("### Critical\n- None");
  });

  it("does not add the non-blocking note when Critical has a real finding", () => {
    const out = renderReviewFindingsMarkdown(parseReviewFindings(CHANGES_REQUESTED_JSON));
    expect(out).toContain("**Verdict:** changes requested — One errcheck failure");
    expect(out).not.toContain("non-blocking findings only");
  });

  describe('mode: "review-body"', () => {
    it("emits a per-section anchored-count line instead of path:line prose", () => {
      const out = renderReviewFindingsMarkdown(parseReviewFindings(FULL_SHAPE_JSON), "review-body");
      expect(out).toContain("### Critical\n- 1 finding(s) anchored inline below");
      expect(out).toContain("### Suggestions\n- 1 finding(s) anchored inline below");
      expect(out).not.toContain("cmd/branchdam/main_test.go:669");
      expect(out).not.toContain("ignores its error return");
    });
  });

  describe('mode: "worker-prompt"', () => {
    it("renders findings and notes, but no Looks Good, Verified, or empty sections", () => {
      const out = renderReviewFindingsMarkdown(
        parseReviewFindings(FULL_SHAPE_JSON),
        "worker-prompt",
      );
      expect(out).toContain("[blocker] **cmd/branchdam/main_test.go:669**");
      expect(out).toContain("[nit] **cmd/branchdam/main.go:12**");
      expect(out).toContain("Worth filing a follow-up issue for the flaky test.");
      expect(out).not.toContain("Looks Good");
      expect(out).not.toContain("Verified");
      expect(out).not.toContain("- None");
      expect(out).not.toContain("###");
      expect(out).not.toContain("**Verdict:**");
    });

    it("falls back to the summary verbatim for a freeform review", () => {
      const parsed = parseReviewFindings("Fix the null check on line 42.");
      expect(renderReviewFindingsMarkdown(parsed, "worker-prompt")).toBe(
        "Fix the null check on line 42.",
      );
    });
  });
});

describe("renderCiSummary", () => {
  it("lists every run under an uppercased status header, keyed to a shortened head sha", () => {
    const out = renderCiSummary({
      headSha: "d2cc8f96f200690f2353b2b57defc460f75105d", // pragma: allowlist secret
      status: "failure",
      runs: [
        { name: "CI / golangci-lint", conclusion: "failure", htmlUrl: "https://x/1" },
        { name: "CI / go test", conclusion: "success", htmlUrl: "https://x/2" },
      ],
    });
    expect(out).toContain("CI on this PR's head commit d2cc8f9 is FAILURE:");
    expect(out).toContain("- CI / golangci-lint — failure — https://x/1");
    expect(out).toContain("- CI / go test — success — https://x/2");
  });

  it("tells the reviewer a failing check is a finding, only when the status is failure", () => {
    const failing = renderCiSummary({ headSha: "abc1234", status: "failure", runs: [] });
    const passing = renderCiSummary({ headSha: "abc1234", status: "success", runs: [] });
    expect(failing).toContain("A failing check is a finding");
    expect(passing).not.toContain("A failing check is a finding");
  });

  it("stays terse for success, with no per-run bullets required to have content", () => {
    const out = renderCiSummary({ headSha: "abc1234", status: "success", runs: [] });
    expect(out).toContain("CI on this PR's head commit abc1234 is SUCCESS:");
  });

  it("renders a distinct message for a null status (no runs, or the lookup failed)", () => {
    const out = renderCiSummary({ headSha: "abc1234", status: null, runs: [] });
    expect(out).toContain("could not be determined");
    expect(out).toContain("no runs, or the lookup failed");
  });

  it("surfaces a custom note instead of the default explanation when one is given", () => {
    const timedOut = renderCiSummary({
      headSha: "abc1234",
      status: "in_progress",
      runs: [],
      note: "still running after the 15-minute wait",
    });
    expect(timedOut).toContain("IN_PROGRESS (still running after the 15-minute wait):");

    const lookupFailed = renderCiSummary({
      headSha: "abc1234",
      status: null,
      runs: [],
      note: "token unavailable",
    });
    expect(lookupFailed).toContain("could not be determined (token unavailable)");
    expect(lookupFailed).not.toContain("no runs, or the lookup failed");
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

describe("taskCommitTitlePath", () => {
  it("builds a fixed (not round-suffixed) path under the given sessions dir", () => {
    expect(taskCommitTitlePath("/srv/mullion-sessions", 42)).toBe(
      "/srv/mullion-sessions/task-42.title",
    );
  });
});

describe("parseCommitTitle", () => {
  it.each([
    "feat: add credential storage",
    "fix(sidebar): stop the drag handle from jittering",
    "chore!: drop the deprecated v1 endpoints",
    "refactor(auth)!: replace the token cache with a single source of truth",
  ])("accepts a well-formed Conventional Commits title: %s", (title) => {
    expect(parseCommitTitle(title)).toBe(title);
  });

  it("trims surrounding whitespace and a trailing newline", () => {
    expect(parseCommitTitle("  feat: add credential storage  \n")).toBe(
      "feat: add credential storage",
    );
  });

  it.each([
    "just some prose with no type prefix",
    "feat : a space before the colon isn't the spec",
    "FEAT: uppercase type isn't a recognized type",
    "unknowntype: not one of the recognized types",
    "feat:missing the space after the colon",
    "",
    "   ",
  ])("rejects a malformed title: %s", (title) => {
    expect(parseCommitTitle(title)).toBeNull();
  });

  it("rejects an embedded newline even if the first line alone would parse", () => {
    expect(parseCommitTitle("feat: add credential storage\nrm -rf /")).toBeNull();
  });

  it("rejects a title beyond the length bound", () => {
    const tooLong = `feat: ${"x".repeat(200)}`;
    expect(parseCommitTitle(tooLong)).toBeNull();
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
