import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTaskMasterPreamble,
  buildReviewPrompt,
  type TaskPromptTask,
} from "../../../src/services/task-prompt.js";

// Drift guard for src/bundle/skills/task-reviewer/ (issue #955) — the
// review-side counterpart to task-worker-skill.test.ts. The skill
// elaborates on buildReviewPrompt rather than restating it, and gates
// itself on prompt text rather than an env var (ctx.taskId never reaches
// the process). Both depend on the REAL production builders' output, not a
// hand-copied string, so a future reword of either prompt fails this test
// instead of silently breaking the skill's own claims.
const skillDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "src",
  "bundle",
  "skills",
  "task-reviewer",
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

describe("task-reviewer skill — the gate keys off real prompt text", () => {
  it("the review prompt really opens with the phrase the skill's gate looks for", () => {
    expect(REVIEW_PROMPT).toContain(REVIEW_GATE_PHRASE);
  });

  it("the worker preamble does NOT carry the review gate phrase", () => {
    expect(WORKER_PREAMBLE).not.toContain(REVIEW_GATE_PHRASE);
  });

  // The symmetric negative task-worker-skill.test.ts's own version of this
  // describe block omits — both prompts' distinct openings need checking
  // both ways, or the two skills' gates could silently both fire (or both
  // stay silent) on the same session.
  it("the review prompt does NOT carry the worker gate phrase", () => {
    expect(REVIEW_PROMPT).not.toContain(WORKER_GATE_PHRASE);
  });

  it("the worker preamble carries its own distinct opening the skill excludes on", () => {
    expect(WORKER_PREAMBLE).toContain(WORKER_GATE_PHRASE);
  });

  it("the skill body quotes both gate phrases verbatim", () => {
    expect(skillBodyNoFrontmatter).toContain(REVIEW_GATE_PHRASE);
    expect(skillBodyNoFrontmatter).toContain(WORKER_GATE_PHRASE);
  });

  // The skill ships to every session on every CLI, including human-driven
  // and worker ones — it must say what it doesn't apply to before anything
  // else, the same posture task-worker's own gate and host/SKILL.md's
  // $MULLION_SESSION_ID check take.
  it("both gate phrases sit near the top of the body, not buried past a skim", () => {
    const GATE_WINDOW_CHARS = 400;
    const window = skillBodyNoFrontmatter.slice(0, GATE_WINDOW_CHARS);
    expect(window).toContain(REVIEW_GATE_PHRASE);
    expect(window).toContain(WORKER_GATE_PHRASE);
  });
});

describe("task-reviewer skill — elaborates buildReviewPrompt, does not restate it", () => {
  // Claims the intro paragraph makes about what the prompt "already
  // carries" — if the prompt ever drops one, the skill's pointer becomes a
  // lie.
  const POINTED_TO_RULES = [
    "Do not create or modify any file here",
    "End your turn and stay running",
  ];

  for (const rule of POINTED_TO_RULES) {
    it(`the review prompt still carries the rule the skill points at: "${rule}"`, () => {
      expect(REVIEW_PROMPT).toContain(rule);
    });
  }

  // The single most load-bearing external claim the whole "calibrate at
  // the finding, not the verdict" section depends on — if this ever gets
  // reworded to permit "clean with nits", the skill's entire spine no
  // longer describes the real contract.
  it('the review prompt still fixes the verdict mechanically ("clean" only when nothing found)', () => {
    expect(REVIEW_PROMPT).toContain('Write "clean" only when you found nothing at all');
  });

  it("the review prompt still has a verified field for what was actually checked", () => {
    expect(REVIEW_PROMPT).toContain('"verified"');
    expect(REVIEW_PROMPT).toContain("what you actually ran/checked");
  });

  // The skill must not re-paste the mechanical contract it's elaborating
  // on — the JSON shape block and the atomic-write recipe belong in the
  // force-delivered prompt only.
  it("does not re-paste the JSON verdict shape", () => {
    expect(skillBodyNoFrontmatter).not.toContain('"verdict": "clean" | "changes-requested"');
  });

  it("does not re-paste the atomic findings-file write recipe", () => {
    expect(skillBodyNoFrontmatter).not.toContain(".tmp");
  });
});

describe("task-reviewer skill — stays CLI-neutral and self-contained", () => {
  // Task Master runs against arbitrary target repos on four CLIs — the
  // same bar buildTaskMasterPreamble's own doc comment sets, extended here
  // to also forbid naming an external plugin skill or a repo-specific
  // reviewer subagent: this skill is deliberately self-contained and must
  // not read as depending on either being present (issue #955's own
  // design decision — neither is guaranteed on an arbitrary target
  // repo/CLI).
  const FORBIDDEN_NAME_RE =
    /claude code|claude-code|codex|opencode|\bagy\b|superpowers|brainstorming|writing-plans|finishing-a-development-branch|autonomous-pr-review|mullion-reviewer/i;

  // Checked against the FULL body, frontmatter included: the `description`
  // field is itself the discoverability gate a CLI reads to decide whether
  // to open this skill at all, so a forbidden reference planted there would
  // slip past a check scoped to skillBodyNoFrontmatter alone.
  it("names no CLI, no superpowers skill, and no external or repo-specific reviewer tooling", () => {
    expect(skillBody).not.toMatch(FORBIDDEN_NAME_RE);
  });

  // The installed name differs per CLI (task-reviewer under
  // --plugin-dir/skills.paths, mullion-task-reviewer on codex/agy/synced
  // opencode — see INSTALLED_SKILL_PREFIX, mullion-bundle.ts), and the
  // sibling worker skill installs under its own distinct name too — so
  // this skill must never assume any of those spellings is what the
  // reader sees it as.
  it("never refers to itself or its sibling worker skill by name", () => {
    expect(skillBodyNoFrontmatter).not.toMatch(/\btask-reviewer\b/);
    expect(skillBodyNoFrontmatter).not.toMatch(/mullion-task-reviewer/);
    expect(skillBodyNoFrontmatter).not.toMatch(/\btask-worker\b/);
    expect(skillBodyNoFrontmatter).not.toMatch(/mullion-task-worker/);
  });
});

// Mirrors task-prompt.test.ts's "directive-line collisions" guard and
// task-worker-skill.test.ts's own copy of it — not a live hazard (nothing
// parses SKILL.md), but prose illustrating a directive on its own line
// would teach the wrong lesson about what "its own line" means.
describe("task-reviewer skill — no whole-line directive collision", () => {
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
