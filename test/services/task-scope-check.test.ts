import { describe, it, expect } from "vitest";
import {
  buildReviewPrompt,
  buildTaskMasterPreamble,
  deriveVerdict,
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
};

const FINDINGS_PATH = "/srv/mullion-sessions/task-42.review.0.md";

describe("scope check (#2599)", () => {
  const parse = (o: Record<string, unknown>) =>
    parseReviewFindings(JSON.stringify({ verdict: "approved", summary: "s", ...o }));
  const entry = (status: string, evidence = "src/a.ts:3") => ({ item: "Do it", status, evidence });

  it("the review prompt carries the Scope step, the scope shape and the delta rule", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
    });
    expect(out).toContain("for every Scope checkbox of the");
    expect(out).toContain("Out of scope");
    expect(out).toContain('"scope": [');
    const followUp = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
      priorRound: { reviewedSha: "abc1234", findings: "- x" },
    });
    expect(followUp).toContain("Re-check only the Scope items");
  });

  it("lists the worker's declared decisions as claims to judge", () => {
    const out = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
      declaredDecisions: ["Decision: kept the old API", "Skipped: docs"],
    });
    expect(out).toContain("Declared by the worker (judge them, do not take them as given):");
    expect(out).toContain("- Decision: kept the old API");
    expect(out).toContain("- Skipped: docs");
    const none = buildReviewPrompt({
      task: TASK,
      worktreePath: BASE.worktreePath,
      findingsPath: FINDINGS_PATH,
      declaredDecisions: [],
    });
    expect(none).not.toContain("Declared by the worker");
  });

  it("the worker prompt asks for the declaration lines", () => {
    const out = buildTaskMasterPreamble(BASE);
    for (const prefix of ["Decision:", "Skipped:", "Deferred:", "Not run locally:"]) {
      expect(out).toContain(prefix);
    }
  });

  it.each([undefined, null, "met", 3, {}])("tolerates scope = %j", (scope) => {
    const parsed = parse({ scope });
    expect(parsed.scope).toEqual([]);
    expect(parsed.verdict).toBe("approved");
  });

  it("drops malformed entries and keeps the good ones", () => {
    const parsed = parse({
      scope: [
        null,
        "x",
        { item: "", status: "met" },
        { item: "no status" },
        { item: "bad status", status: "done" },
        { item: "no evidence", status: "met" },
        entry("met"),
      ],
    });
    expect(parsed.scope).toEqual([
      { item: "no evidence", status: "met", evidence: "" },
      { item: "Do it", status: "met", evidence: "src/a.ts:3" },
    ]);
    expect(parsed.verdict).toBe("approved");
  });

  it("is empty on the freeform fallback", () => {
    expect(parseReviewFindings("not json").scope).toEqual([]);
  });

  it("approves when every item is met", () => {
    expect(parse({ scope: [entry("met")] }).verdict).toBe("approved");
  });

  it.each(["partial", "missing"])("a %s item forces changes-requested", (status) => {
    const parsed = parse({ scope: [entry("met"), entry(status)] });
    expect(parsed.verdict).toBe("changes-requested");
    expect(parsed.notes.join("\n")).toContain('Reviewer wrote "approved"');
  });

  it("a deviated item that cites a declared decision does not block", () => {
    const parsed = parse({
      scope: [entry("deviated", "Decision: kept the old API (commit abc123)")],
    });
    expect(parsed.verdict).toBe("approved");
    expect(parsed.scope[0].status).toBe("deviated");
  });

  it("a deviated item that cites none is treated as missing", () => {
    const parsed = parse({ scope: [entry("deviated", "the worker did it differently")] });
    expect(parsed.verdict).toBe("changes-requested");
    expect(parsed.scope[0].status).toBe("missing");
    expect(parsed.scope[0].evidence).toContain("without citing a declared decision");
    expect(parse({ scope: [entry("deviated", "")] }).verdict).toBe("changes-requested");
  });

  it("deriveVerdict applies the same rule to a raw scope list", () => {
    const base = { findings: [], previous: [], claimed: "approved" };
    expect(deriveVerdict({ ...base, scope: [entry("missing") as never] })).toBe(
      "changes-requested",
    );
    expect(deriveVerdict({ ...base, scope: [entry("deviated", "x") as never] })).toBe(
      "changes-requested",
    );
    expect(deriveVerdict({ ...base, scope: [entry("deviated", "Skipped: x") as never] })).toBe(
      "approved",
    );
  });

  it("renders a Scope check section in the comment and review-body modes", () => {
    const parsed = parse({
      scope: [entry("met"), { item: "Docs", status: "partial", evidence: "only one page" }],
    });
    for (const mode of ["comment", "review-body"] as const) {
      const out = renderReviewFindingsMarkdown(parsed, mode);
      expect(out).toContain("### Scope check");
      expect(out).toContain("- **met** — Do it: src/a.ts:3");
      expect(out).toContain("- **partial** — Docs: only one page");
    }
  });

  it("omits the section when there is no scope, and sends unmet items to the worker", () => {
    expect(renderReviewFindingsMarkdown(parse({}))).not.toContain("Scope check");
    const parsed = parse({ scope: [entry("met"), { item: "Docs", status: "missing" }] });
    const out = renderReviewFindingsMarkdown(parsed, "worker-prompt");
    expect(out).toContain("Scope item not done: **Docs**");
    expect(out).not.toContain("Do it");
  });
});
