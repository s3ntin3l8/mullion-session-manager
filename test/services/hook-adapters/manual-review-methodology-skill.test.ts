import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFrontmatter } from "../../../src/services/skills.js";
import {
  buildTaskMasterPreamble,
  buildReviewPrompt,
  type TaskPromptTask,
} from "../../../src/services/task-prompt.js";

// Phase 6 (issue #1113, re-scoped by the plan tracked at #1210) —
// task-worker/task-reviewer self-gate off the moment they detect a human is
// driving, so a manual session directing its own subagents/child sessions
// got no Mullion-authored methodology at all. This skill is gated the
// OPPOSITE way: fires only when NEITHER Task Master gate phrase is present.
// Same "depend on the real production builders' output, not a hand-copied
// string" posture as task-reviewer-skill.test.ts/task-worker-skill.test.ts —
// a future reword of either prompt must fail this test, not silently break
// this skill's own gate check.
const skillDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "src",
  "bundle",
  "skills",
  "manual-review-methodology",
);

const skillBody = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const skillBodyNoFrontmatter = skillBody.replace(FRONTMATTER_RE, "");

const TASK: TaskPromptTask = {
  id: 42,
  issueNumber: 314,
  title: "fix: the widget explodes on Tuesdays",
  body: "## Context\n\nIt explodes.\n\n## Scope\n\n- [ ] Stop it exploding",
};

const WORKER_PREAMBLE = buildTaskMasterPreamble({
  task: TASK,
  branchName: "mullion/task-42",
  worktreePath: "/srv/repo/.mullion-worktrees/mullion-task-42",
  budgetMinutes: 120,
});

const REVIEW_PROMPT = buildReviewPrompt({
  task: TASK,
  worktreePath: "/srv/repo/.mullion-worktrees/mullion-task-42",
  findingsPath: "/sessions/task-42.review.0.md",
});

const WORKER_GATE_PHRASE = "as a Mullion Task Master worker";
const REVIEW_GATE_PHRASE = "Review this task's diff. You are not expected to make changes.";

describe("manual-review-methodology skill — parses and gates the opposite way from task-worker/task-reviewer", () => {
  it("has valid, parseable frontmatter", () => {
    const parsed = parseSkillFrontmatter(skillBody);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("manual-review-methodology");
  });

  // Hermes review, PR #1214 — the DESCRIPTION, not just the body, is what a
  // skill-selection layer keys on when deciding whether to load a skill at
  // all. A reword that dropped the Task Master deferral from the
  // description alone (leaving the body's own gate check untouched) would
  // weaken the gate before any body-window test below could ever catch it.
  it("the frontmatter description itself carries the Task Master deferral, not just the body", () => {
    const parsed = parseSkillFrontmatter(skillBody);
    expect(parsed?.description).toMatch(/Task Master/);
    expect(parsed?.description).toMatch(/does not apply/i);
  });

  it("quotes both real gate phrases verbatim, so it recognizes a Task Master session and defers", () => {
    expect(skillBodyNoFrontmatter).toContain(WORKER_GATE_PHRASE);
    expect(skillBodyNoFrontmatter).toContain(REVIEW_GATE_PHRASE);
  });

  it("both gate phrases sit near the top of the body, not buried past a skim", () => {
    const GATE_WINDOW_CHARS = 400;
    const window = skillBodyNoFrontmatter.slice(0, GATE_WINDOW_CHARS);
    expect(window).toContain(WORKER_GATE_PHRASE);
    expect(window).toContain(REVIEW_GATE_PHRASE);
  });

  // The symmetric check to task-reviewer-skill.test.ts's own version: the
  // real prompts a Task Master session actually receives must still carry
  // the phrases this skill's gate looks for, or the gate silently stops
  // recognizing them.
  it("the worker preamble really opens with the phrase this skill's gate looks for", () => {
    expect(WORKER_PREAMBLE).toContain(WORKER_GATE_PHRASE);
  });

  it("the review prompt really opens with the phrase this skill's gate looks for", () => {
    expect(REVIEW_PROMPT).toContain(REVIEW_GATE_PHRASE);
  });
});

describe("manual-review-methodology skill — doesn't restate the Task Master-specific contract it explicitly excludes itself from", () => {
  it("does not paste a JSON verdict shape (task-reviewer's contract, not this skill's)", () => {
    expect(skillBodyNoFrontmatter).not.toContain('"verdict"');
  });

  it("does not reference Task Master's own findings-file path or file-write mechanics", () => {
    expect(skillBodyNoFrontmatter).not.toMatch(/findingsPath|\.review\.\d|\.tmp/i);
  });

  it("never claims to apply inside a Task Master session", () => {
    expect(skillBodyNoFrontmatter).not.toMatch(/this skill applies to you/i);
  });
});

describe("manual-review-methodology skill — only references skills that actually exist", () => {
  // session-ops is the one skill this one explicitly points to for
  // spawn_child_session mechanics — verify it's still a real, shipped
  // sibling skill, not a name that drifted after a rename.
  it("session-ops (the skill it points to) is a real sibling skill", () => {
    const sessionOpsPath = path.resolve(skillDir, "..", "session-ops", "SKILL.md");
    expect(() => readFileSync(sessionOpsPath, "utf8")).not.toThrow();
  });
});

// Mirrors task-reviewer-skill.test.ts's/task-worker-skill.test.ts's own
// CLI-neutrality guard: this skill ships to every session on every CLI
// (claude-code, codex, opencode, agy), so it must never assume one
// specific CLI, an external plugin skill, or a repo-specific reviewer
// subagent is present. Unlike those two siblings, it deliberately does
// reference session-ops by name (a legitimate cross-skill pointer, not a
// gate-paired mutual exclusion) — checked separately above, not banned
// here.
describe("manual-review-methodology skill — stays CLI-neutral and self-contained", () => {
  const FORBIDDEN_NAME_RE =
    /claude code|claude-code|codex|opencode|\bagy\b|superpowers|brainstorming|writing-plans|finishing-a-development-branch|autonomous-pr-review|mullion-reviewer/i;

  it("names no CLI, no superpowers skill, and no external or repo-specific reviewer tooling", () => {
    expect(skillBody).not.toMatch(FORBIDDEN_NAME_RE);
  });

  // The installed name differs per CLI (manual-review-methodology under
  // --plugin-dir/skills.paths, mullion-manual-review-methodology on
  // codex/agy/synced opencode — see INSTALLED_SKILL_PREFIX,
  // mullion-bundle.ts) — so, same as its task-worker/task-reviewer
  // siblings, it must never assume any one of those spellings is what the
  // reader sees it as, including its own.
  it("never refers to itself, or to its gate-paired task-worker/task-reviewer siblings, by name", () => {
    expect(skillBodyNoFrontmatter).not.toMatch(/manual-review-methodology/);
    expect(skillBodyNoFrontmatter).not.toMatch(/\btask-worker\b/);
    expect(skillBodyNoFrontmatter).not.toMatch(/mullion-task-worker/);
    expect(skillBodyNoFrontmatter).not.toMatch(/\btask-reviewer\b/);
    expect(skillBodyNoFrontmatter).not.toMatch(/mullion-task-reviewer/);
  });
});

// Mirrors task-reviewer-skill.test.ts's/task-worker-skill.test.ts's own copy
// of this guard — not a live hazard (nothing parses SKILL.md for these), but
// prose illustrating a directive on its own line would teach the wrong
// lesson about what "its own line" means.
describe("manual-review-methodology skill — no whole-line directive collision", () => {
  const DIRECTIVE_PATTERNS = [
    { name: "Manual:", re: /^\s*Manual:\s*true\s*$/im },
    { name: "Agent:", re: /^\s*Agent:\s*(\S+)\s*$/im },
    { name: "ReviewAgent:", re: /^\s*ReviewAgent:\s*(\S+)\s*$/im },
  ];

  for (const { name, re } of DIRECTIVE_PATTERNS) {
    it(`contains no whole line matching ${name}`, () => {
      expect(re.test(skillBodyNoFrontmatter)).toBe(false);
    });
  }
});
