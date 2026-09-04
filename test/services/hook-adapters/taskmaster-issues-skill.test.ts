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

describe("taskmaster-issues skill — SKILL.md's own prose never doubles as a directive", () => {
  // Mirrors task-prompt.test.ts's "directive-line collisions" guard on the
  // preamble text, extended to all six directives this skill documents.
  // Not a live hazard (nothing parses SKILL.md), but a skill that
  // illustrates a directive on its own line would be teaching the wrong
  // lesson about what "on its own line" means.
  const DIRECTIVE_RES = [
    /^\s*Manual:\s*true\s*$/im,
    /^\s*Agent:\s*(\S+)\s*$/im,
    /^\s*ReviewAgent:\s*(\S+)\s*$/im,
    /^\s*Model:\s*(\S+)\s*$/im,
    /^\s*Reviewer-Model:\s*(\S+)\s*$/im,
    /^\s*SmallModel:\s*(\S+)\s*$/im,
  ];

  for (const re of DIRECTIVE_RES) {
    it(`contains no whole line matching ${re}`, () => {
      expect(re.test(skillBody)).toBe(false);
    });
  }
});
