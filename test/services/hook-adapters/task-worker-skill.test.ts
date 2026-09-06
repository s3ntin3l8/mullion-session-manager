import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTaskMasterPreamble,
  buildReviewPrompt,
  type TaskPromptTask,
} from "../../../src/services/task-prompt.js";

// Drift guard for src/bundle/skills/task-worker/ (issue #964) — the skill
// elaborates on buildTaskMasterPreamble rather than restating it, and gates
// itself on prompt text rather than an env var (ctx.taskId never reaches
// the process — see task-prompt.ts's own header comment). Both of those
// depend on the REAL production builders' output, not a hand-copied string,
// so a future reword of either prompt fails this test instead of silently
// breaking the skill's own claims — same idiom as
// taskmaster-issues-skill.test.ts.
const skillDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "src",
  "bundle",
  "skills",
  "task-worker",
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

describe("task-worker skill — the gate keys off real prompt text", () => {
  it("the worker preamble really opens with the phrase the skill's gate looks for", () => {
    expect(WORKER_PREAMBLE).toContain(WORKER_GATE_PHRASE);
  });

  it("the review prompt does NOT carry the worker gate phrase", () => {
    expect(REVIEW_PROMPT).not.toContain(WORKER_GATE_PHRASE);
  });

  it("the review prompt carries its own distinct opening the skill excludes on", () => {
    expect(REVIEW_PROMPT).toContain(REVIEW_GATE_PHRASE);
  });

  it("the skill body quotes both gate phrases verbatim", () => {
    expect(skillBodyNoFrontmatter).toContain(WORKER_GATE_PHRASE);
    expect(skillBodyNoFrontmatter).toContain(REVIEW_GATE_PHRASE);
  });

  // The skill ships to every session on every CLI, including human-driven
  // ones — it must say what it doesn't apply to before anything else, the
  // same posture host/SKILL.md's $MULLION_SESSION_ID check takes.
  it("both gate phrases sit near the top of the body, not buried past a skim", () => {
    const GATE_WINDOW_CHARS = 500;
    const window = skillBodyNoFrontmatter.slice(0, GATE_WINDOW_CHARS);
    expect(window).toContain(WORKER_GATE_PHRASE);
    expect(window).toContain(REVIEW_GATE_PHRASE);
  });
});

describe("task-worker skill — elaborates the preamble, does not restate it", () => {
  // The intro paragraph name-checks these rules as "already carried" rather
  // than re-explaining them — if the preamble ever drops one, the skill's
  // pointer becomes a lie.
  const POINTED_TO_RULES = [
    "End your turn and stay running",
    "Untracked files count as dirty",
    "Commit your work on",
    "Finish or cancel any background job",
    "Look over your own diff with fresh eyes",
  ];

  for (const rule of POINTED_TO_RULES) {
    it(`the preamble still carries the rule the skill points at: "${rule}"`, () => {
      expect(WORKER_PREAMBLE).toContain(rule);
    });
  }

  // Issue #964's own follow-up: the preamble's "nobody may be watching"
  // bullet is force-delivered and unconditional (task-prompt.ts) — the
  // skill must not merely repeat it, so this only asserts the preamble
  // still says it, not that the skill also does.
  it("the preamble unconditionally tells the worker not to block on a question", () => {
    expect(WORKER_PREAMBLE).toContain("Nobody may be watching this session");
    expect(WORKER_PREAMBLE).toContain("Never block on a question or a");
  });
});

describe("task-worker skill — stays CLI-neutral and names no superpowers skill", () => {
  // Task Master runs against arbitrary target repos on four CLIs — the same
  // bar buildTaskMasterPreamble's own doc comment sets. Naming a skill by
  // name here would also stop generalizing the moment superpowers adds a
  // new one with the same shape (the whole reason #964 asks for a positive
  // instruction instead of only a deny list).
  const FORBIDDEN_NAME_RE =
    /claude code|claude-code|codex|opencode|\bagy\b|superpowers|brainstorming|writing-plans|finishing-a-development-branch/i;

  // Checked against the FULL body, frontmatter included: the `description`
  // field is itself the discoverability gate a CLI reads to decide whether
  // to open this skill at all, so a forbidden reference planted there would
  // slip past a check scoped to skillBodyNoFrontmatter alone (issue #1107).
  it("names no CLI and no superpowers skill", () => {
    expect(skillBody).not.toMatch(FORBIDDEN_NAME_RE);
  });

  // The installed name differs per CLI (task-worker under --plugin-dir/
  // skills.paths, mullion-task-worker on codex/agy/synced opencode — see
  // INSTALLED_SKILL_PREFIX, mullion-bundle.ts) so the skill must never
  // assume either spelling is what the reader sees it as.
  it("never refers to itself by name", () => {
    expect(skillBodyNoFrontmatter).not.toMatch(/\btask-worker\b/);
    expect(skillBodyNoFrontmatter).not.toMatch(/mullion-task-worker/);
  });
});

// Mirrors task-prompt.test.ts's "directive-line collisions" guard and
// taskmaster-issues-skill.test.ts's own copy of it — not a live hazard
// (nothing parses SKILL.md), but prose illustrating a directive on its own
// line would teach the wrong lesson about what "its own line" means.
describe("task-worker skill — no whole-line directive collision", () => {
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
