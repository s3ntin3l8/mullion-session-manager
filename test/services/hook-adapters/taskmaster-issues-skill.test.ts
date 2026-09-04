import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Drift guard for src/bundle/skills/taskmaster-issues/ — the skill tells
// authors exactly what six directives do and how they're matched. Rather
// than re-declaring the parsers' regexes here (a copy drifts right along
// with the source and detects nothing), this feeds the skill's own worked
// example through the REAL production resolvers, so a future change to
// task-watcher.ts/task-agent-resolve.ts/task-model-resolve.ts that changes
// what the example resolves to fails this test, not just a live issue.
const mockGetStoredSettings = vi.hoisted(() => vi.fn());

vi.mock("../../../src/services/settings.js", () => ({
  getStoredSettings: mockGetStoredSettings,
}));

import { isManualOnly } from "../../../src/services/task-watcher.js";
import {
  resolveAgentCommand,
  resolveReviewAgentCommand,
} from "../../../src/services/task-agent-resolve.js";
import {
  resolveOpenCodeModel,
  resolveOpenCodeSmallModel,
} from "../../../src/services/task-model-resolve.js";

function mockApp(): FastifyInstance {
  return {
    log: { warn: vi.fn() },
    db: {},
  } as unknown as FastifyInstance;
}

const skillDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "src",
  "bundle",
  "skills",
  "taskmaster-issues",
);

const skillBody = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
const workedExample = readFileSync(path.join(skillDir, "references", "worked-example.md"), "utf8");

describe("taskmaster-issues skill — worked example resolves as documented", () => {
  beforeEach(() => {
    mockGetStoredSettings.mockReset();
    // Defaults deliberately null/different from the example's own values,
    // so a silent fall-through (the example's directive not actually
    // taking effect) fails loudly instead of passing by accident.
    mockGetStoredSettings.mockReturnValue({
      taskMaster: { defaultAgent: "opencode", defaultReviewAgent: "opencode" },
      opencode: { implementerModel: null, reviewerModel: null, defaultSmallModel: null },
    });
  });

  it("is not Manual: true — the example is meant to auto-claim", () => {
    expect(isManualOnly(workedExample)).toBe(false);
  });

  it("resolves Agent: codex over a differing project default", () => {
    const command = resolveAgentCommand(mockApp(), {
      issueBody: workedExample,
      projectDefaultAgent: "opencode",
    });
    expect(command).toBe("codex");
  });

  it("resolves ReviewAgent: claude over a differing project default", () => {
    const command = resolveReviewAgentCommand(mockApp(), {
      issueBody: workedExample,
      projectDefaultReviewAgent: "opencode",
    });
    expect(command).toBe("claude");
  });

  it("has no Model:/Reviewer-Model:/SmallModel: directive — all resolve to the (null) global default", () => {
    const app = mockApp();
    expect(resolveOpenCodeModel(app, { issueBody: workedExample, role: "implementer" })).toBeNull();
    expect(resolveOpenCodeModel(app, { issueBody: workedExample, role: "reviewer" })).toBeNull();
    expect(resolveOpenCodeSmallModel(app, { issueBody: workedExample })).toBeNull();
  });
});

describe("taskmaster-issues skill — the example obeys the skill's own rules", () => {
  it("names no other issue by bare number", () => {
    expect(workedExample).not.toMatch(/#\d+/);
  });

  it("puts no PR/merge/cleanup step in Scope — Mullion owns that, not the worker", () => {
    expect(workedExample).not.toMatch(
      /open a pull request|open the pr|push the branch|merge |comment on the issue|git worktree remove/i,
    );
  });
});

// Shared by both the SKILL.md prose-collision guard and the worked-example
// exact-count guard below, so the two can't drift apart from each other.
const DIRECTIVE_PATTERNS = [
  { name: "Manual:", re: /^\s*Manual:\s*true\s*$/im },
  { name: "Agent:", re: /^\s*Agent:\s*(\S+)\s*$/im },
  { name: "ReviewAgent:", re: /^\s*ReviewAgent:\s*(\S+)\s*$/im },
  { name: "Model:", re: /^\s*Model:\s*(\S+)\s*$/im },
  { name: "Reviewer-Model:", re: /^\s*Reviewer-Model:\s*(\S+)\s*$/im },
  { name: "SmallModel:", re: /^\s*SmallModel:\s*(\S+)\s*$/im },
];

function countDirectiveLines(text: string, re: RegExp): number {
  const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  return [...text.matchAll(globalRe)].length;
}

describe("taskmaster-issues skill — SKILL.md's own prose never doubles as a directive", () => {
  // Mirrors task-prompt.test.ts's "directive-line collisions" guard on the
  // preamble text, extended to all six directives this skill documents.
  // Not a live hazard (nothing parses SKILL.md), but a skill that
  // illustrates a directive on its own line would be teaching the wrong
  // lesson about what "on its own line" means.
  for (const { name, re } of DIRECTIVE_PATTERNS) {
    it(`contains no whole line matching ${name}`, () => {
      expect(countDirectiveLines(skillBody, re)).toBe(0);
    });
  }
});

describe("taskmaster-issues skill — worked-example.md carries exactly its two directives", () => {
  // Hermes review on #1031: the resolver-driven assertions above only ever
  // read the FIRST Agent:/ReviewAgent: line (exec with no /g — "first match
  // wins" is the documented behavior), so a later edit that appends a stray
  // extra directive line below the intended two would pass every assertion
  // above silently. Count occurrences instead of just resolving one.
  const EXPECTED_COUNTS: Record<string, number> = {
    "Manual:": 0,
    "Agent:": 1,
    "ReviewAgent:": 1,
    "Model:": 0,
    "Reviewer-Model:": 0,
    "SmallModel:": 0,
  };

  for (const { name, re } of DIRECTIVE_PATTERNS) {
    it(`has exactly ${EXPECTED_COUNTS[name]} ${name} line(s)`, () => {
      expect(countDirectiveLines(workedExample, re)).toBe(EXPECTED_COUNTS[name]);
    });
  }
});

describe("taskmaster-issues skill — documented matching rules hold against the real parsers", () => {
  // Hermes review on #1031: the worked-example tests above only exercise
  // the example's own two directives. These exercise the OTHER rules the
  // skill's "Matching rules" section documents, each through the real
  // production resolver rather than a re-declared regex.
  beforeEach(() => {
    mockGetStoredSettings.mockReset();
    mockGetStoredSettings.mockReturnValue({
      taskMaster: { defaultAgent: "opencode", defaultReviewAgent: "opencode" },
      opencode: { implementerModel: null, reviewerModel: null, defaultSmallModel: null },
    });
  });

  it("Agent: Claude (wrong case) fails the allow-list and falls through", () => {
    const command = resolveAgentCommand(mockApp(), {
      issueBody: "Agent: Claude",
      projectDefaultAgent: "codex",
    });
    expect(command).toBe("codex");
  });

  it("ReviewAgent: none disables review", () => {
    expect(
      resolveReviewAgentCommand(mockApp(), {
        issueBody: "ReviewAgent: none",
        projectDefaultReviewAgent: "claude",
      }),
    ).toBeNull();
  });

  it("ReviewAgent: false disables review", () => {
    expect(
      resolveReviewAgentCommand(mockApp(), {
        issueBody: "ReviewAgent: false",
        projectDefaultReviewAgent: "claude",
      }),
    ).toBeNull();
  });

  it("Reviewer-Model: falls back to Model: when absent", () => {
    const command = resolveOpenCodeModel(mockApp(), {
      issueBody: "Model: anthropic/claude-sonnet-4-5",
      role: "reviewer",
    });
    expect(command).toBe("anthropic/claude-sonnet-4-5");
  });

  it("a directive inside a fenced code block still fires", () => {
    const body = "Some context.\n\n```\nAgent: codex\n```\n";
    const command = resolveAgentCommand(mockApp(), {
      issueBody: body,
      projectDefaultAgent: "opencode",
    });
    expect(command).toBe("codex");
  });

  it("the first Agent: line wins when the body has two", () => {
    const body = "Agent: codex\nAgent: claude\n";
    const command = resolveAgentCommand(mockApp(), {
      issueBody: body,
      projectDefaultAgent: "opencode",
    });
    expect(command).toBe("codex");
  });
});
