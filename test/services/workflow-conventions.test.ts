import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKFLOW_CONVENTION_QUESTIONS,
  buildWorkflowConventionsText,
  buildSessionWorkflowConventionsContent,
  sessionWorkflowConventionsPath,
  writeSessionWorkflowConventions,
  readSessionWorkflowConventions,
  MAX_WORKFLOW_CONVENTIONS_BYTES,
} from "../../src/services/workflow-conventions.js";

// Issue #937 — buildWorkflowConventionsText is a deterministic, pure
// function (no agent, no I/O), same "pure function assembling structural
// output" posture as mullion-scaffold.ts's computeScaffold. These tests
// cover the assembly logic directly; session-lifecycle-workflow-conventions.
// test.ts covers the end-to-end gating/injection this file's write/read
// helpers support.
describe("buildWorkflowConventionsText", () => {
  it("returns an empty string for empty answers — a fresh install has no opinion yet", () => {
    expect(buildWorkflowConventionsText({})).toBe("");
  });

  it("assembles a single selected fragment", () => {
    const text = buildWorkflowConventionsText({ branching: "branch-pr" });
    expect(text).toBe("Never commit directly to the default branch. Always branch and open a PR.");
  });

  it("assembles multiple selected fragments in WORKFLOW_CONVENTION_QUESTIONS's own fixed order, not answer-object key order", () => {
    const text = buildWorkflowConventionsText({
      // Deliberately out of question order.
      mergeStrategy: "squash",
      branching: "branch-pr",
    });
    const branchingFragment =
      "Never commit directly to the default branch. Always branch and open a PR.";
    const mergeFragment =
      "Squash-merge PRs — the PR title becomes the commit message on the default branch.";
    expect(text).toBe(`${branchingFragment}\n\n${mergeFragment}`);
  });

  it("is deterministic — the same answers always produce the same text", () => {
    const answers = { branching: "branch-pr", titleConvention: "conventional-commits" };
    expect(buildWorkflowConventionsText(answers)).toBe(buildWorkflowConventionsText(answers));
  });

  it("silently skips a question with no answer, rather than defaulting it", () => {
    const text = buildWorkflowConventionsText({ branching: "branch-pr" });
    // Only one fragment — every other question's own default option prose
    // never appears just because it went unanswered.
    expect(text.split("\n\n")).toHaveLength(1);
  });

  it("silently skips an unrecognized option id for a real question", () => {
    expect(buildWorkflowConventionsText({ branching: "not-a-real-option" })).toBe("");
  });

  it("silently skips an unrecognized question id", () => {
    expect(buildWorkflowConventionsText({ notARealQuestion: "whatever" })).toBe("");
  });

  it("produces every option's fragment across the full v1 question set with no crash or empty fragment", () => {
    for (const question of WORKFLOW_CONVENTION_QUESTIONS) {
      for (const option of question.options) {
        const text = buildWorkflowConventionsText({ [question.id]: option.id });
        expect(text).toBe(option.fragment);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  // Issue #937's own "Starting question set" named the original ten axes;
  // issue #1203 (Phase 2 of the follow-up plan) added `worktrees` as an
  // eleventh, right after `branchBase` (a refinement of the same "how do
  // you start work on a branch" question). Pinning the id list here so a
  // future edit that silently drops, renames, or reorders one of them
  // fails a test instead of just shrinking or reshuffling the wizard.
  it("covers the eleven v1+worktrees question axes, in order", () => {
    expect(WORKFLOW_CONVENTION_QUESTIONS.map((q) => q.id)).toEqual([
      "branching",
      "branchBase",
      "worktrees",
      "titleConvention",
      "mergeStrategy",
      "preMergeRequirements",
      "codeReview",
      "reviewFeedback",
      "deferredWork",
      "postMergeCleanup",
      "prePushChecks",
    ]);
  });

  it("answering the full question set produces a longer, all-fragments-present text (a full 'regenerate' run)", () => {
    const answers: Record<string, string> = {};
    for (const question of WORKFLOW_CONVENTION_QUESTIONS) {
      answers[question.id] = question.options[0].id;
    }
    const text = buildWorkflowConventionsText(answers);
    expect(text.split("\n\n")).toHaveLength(WORKFLOW_CONVENTION_QUESTIONS.length);
  });

  // Issue #1203 (Phase 2) — the worktree question specifically: named
  // as one of the five conventions the whole follow-up plan tracks, and
  // unlike the other v1 axes, `worktree` text already existed as a
  // sub-clause of postMergeCleanup's own cleanup fragment before this —
  // these assertions pin down that the NEW dedicated question's own
  // fragment is what's selected, not a false-positive match against that
  // pre-existing text.
  describe("worktrees question", () => {
    it("selects the dedicated-worktree-per-branch fragment, not the postMergeCleanup cleanup clause", () => {
      const text = buildWorkflowConventionsText({ worktrees: "worktree" });
      expect(text).toContain("Work in a dedicated worktree per branch");
      expect(text).toContain("git worktree add");
      // postMergeCleanup's own "delete" option fragment (a DIFFERENT
      // question, unanswered here) — confirms this isn't a false-positive
      // match against that pre-existing worktree-adjacent text.
      expect(text).not.toContain("remove any associated worktree");
    });

    it("selects the main-checkout fragment when chosen", () => {
      const text = buildWorkflowConventionsText({ worktrees: "main-checkout" });
      expect(text).toBe("Work directly in the main checkout — no separate worktree per branch.");
    });

    it("is silently skipped, like every other unanswered question, when omitted", () => {
      const text = buildWorkflowConventionsText({ branching: "branch-pr" });
      expect(text).not.toContain("worktree");
    });
  });

  // Regression guard: buildWorkflowConventionsText(SCAFFOLD_DEFAULT_WORKFLOW_ANSWERS)
  // is Phase 1's own byte-identical-when-unset fallback
  // (mullion-scaffold.ts's workflowConventionsSection) — adding a question
  // here must not change what that fixed default answer set (which
  // deliberately never answers `worktrees`) produces.
  it("SCAFFOLD_DEFAULT_WORKFLOW_ANSWERS still produces its pre-#1203 text, unaffected by the new question", async () => {
    const { SCAFFOLD_DEFAULT_WORKFLOW_ANSWERS } =
      await import("../../src/services/mullion-scaffold.js");
    const text = buildWorkflowConventionsText(SCAFFOLD_DEFAULT_WORKFLOW_ANSWERS);
    expect(text).not.toContain("worktree");
    expect(text).toContain("Never commit directly to the default branch");
  });
});

describe("buildSessionWorkflowConventionsContent", () => {
  it("prepends a self-identifying header before the body", () => {
    const content = buildSessionWorkflowConventionsContent("always branch, never commit to main");
    expect(content).toContain("always branch, never commit to main");
    expect(content.startsWith(">")).toBe(true);
  });
});

describe("sessionWorkflowConventionsPath", () => {
  it("builds a deterministic per-session path", () => {
    expect(sessionWorkflowConventionsPath("/tmp/sessions", "42")).toBe(
      "/tmp/sessions/42.workflow-conventions.md",
    );
  });
});

describe("writeSessionWorkflowConventions / readSessionWorkflowConventions", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-conventions-write-test-"));
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("writes the resolved text and reads it back", () => {
    writeSessionWorkflowConventions(
      sessionsDir,
      "1",
      console,
      "always branch, never commit to main",
    );
    expect(readSessionWorkflowConventions(sessionsDir, "1")).toContain(
      "always branch, never commit to main",
    );
  });

  it("writes nothing (no file) when text is undefined", () => {
    writeSessionWorkflowConventions(sessionsDir, "2", console, undefined);
    expect(fs.existsSync(sessionWorkflowConventionsPath(sessionsDir, "2"))).toBe(false);
    expect(readSessionWorkflowConventions(sessionsDir, "2")).toBeNull();
  });

  // UNLIKE writeSessionBriefing (project-briefing.ts), an empty string here
  // is treated exactly like `undefined` — see this function's own doc
  // comment for why (there is no "select-all-delete, then Save" UI action
  // for this field the way there is for the pinned note).
  it("writes nothing (no file) when text is an empty string", () => {
    writeSessionWorkflowConventions(sessionsDir, "3", console, "");
    expect(fs.existsSync(sessionWorkflowConventionsPath(sessionsDir, "3"))).toBe(false);
  });

  it("unlinks a stale copy from a previous spawn when text becomes undefined", () => {
    writeSessionWorkflowConventions(sessionsDir, "4", console, "some text");
    expect(fs.existsSync(sessionWorkflowConventionsPath(sessionsDir, "4"))).toBe(true);

    writeSessionWorkflowConventions(sessionsDir, "4", console, undefined);
    expect(fs.existsSync(sessionWorkflowConventionsPath(sessionsDir, "4"))).toBe(false);
  });

  it("clamps text over MAX_WORKFLOW_CONVENTIONS_BYTES", () => {
    const huge = "a".repeat(MAX_WORKFLOW_CONVENTIONS_BYTES + 1000);
    writeSessionWorkflowConventions(sessionsDir, "5", console, huge);
    const written = readSessionWorkflowConventions(sessionsDir, "5");
    expect(written).not.toBeNull();
    expect(Buffer.byteLength(written as string, "utf8")).toBeLessThan(huge.length);
  });

  it("reading a session with no file returns null", () => {
    expect(readSessionWorkflowConventions(sessionsDir, "nonexistent")).toBeNull();
  });
});
