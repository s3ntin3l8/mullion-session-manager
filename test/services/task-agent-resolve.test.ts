import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockGetStoredSettings = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: mockGetStoredSettings,
}));

import {
  resolveAgentCommand,
  resolveReviewAgentCommand,
  commandSupportsSeed,
} from "../../src/services/task-agent-resolve.js";

function mockApp(): FastifyInstance {
  return {
    log: { warn: vi.fn() },
    db: {},
  } as unknown as FastifyInstance;
}

describe("resolveAgentCommand", () => {
  beforeEach(() => {
    mockGetStoredSettings.mockReset();
    mockGetStoredSettings.mockReturnValue({ launchers: { defaultAgent: "claude" } });
  });

  it("prefers the issue body's Agent: line over everything else", () => {
    const app = mockApp();
    const command = resolveAgentCommand(app, {
      issueBody: "Some spec.\nAgent: codex\nMore text.",
      projectDefaultAgent: "opencode",
    });
    expect(command).toBe("codex");
  });

  it("falls through to the project default when the issue has no Agent: line", () => {
    const app = mockApp();
    const command = resolveAgentCommand(app, {
      issueBody: "Just a spec, no directive.",
      projectDefaultAgent: "agy",
    });
    expect(command).toBe("agy");
  });

  it("falls through to the global default when neither issue nor project specify one", () => {
    const app = mockApp();
    const command = resolveAgentCommand(app, { issueBody: null, projectDefaultAgent: null });
    expect(command).toBe("claude");
  });

  it("falls through past an unrecognized issue-body agent name, logging a warning", () => {
    const app = mockApp();
    const command = resolveAgentCommand(app, {
      issueBody: "Agent: some-made-up-cli",
      projectDefaultAgent: "opencode",
    });
    expect(command).toBe("opencode");
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "some-made-up-cli" }),
      expect.stringContaining("unrecognized agent"),
    );
  });

  it("falls through past an unrecognized project default, logging a warning", () => {
    const app = mockApp();
    const command = resolveAgentCommand(app, {
      issueBody: null,
      projectDefaultAgent: "not-a-real-agent",
    });
    expect(command).toBe("claude");
    expect(app.log.warn).toHaveBeenCalled();
  });

  it("does not treat a body that merely mentions Agent: in prose as a directive", () => {
    const app = mockApp();
    const command = resolveAgentCommand(app, {
      issueBody: "Note: this repo uses an Agent: <name> convention, see docs.",
      projectDefaultAgent: "agy",
    });
    expect(command).toBe("agy");
  });
});

describe("resolveReviewAgentCommand", () => {
  it("returns null when nothing configures a review agent", () => {
    const app = mockApp();
    const command = resolveReviewAgentCommand(app, {
      issueBody: null,
      projectDefaultReviewAgent: null,
    });
    expect(command).toBeNull();
  });

  it("prefers the issue body's ReviewAgent: line over the project default", () => {
    const app = mockApp();
    const command = resolveReviewAgentCommand(app, {
      issueBody: "ReviewAgent: codex",
      projectDefaultReviewAgent: "agy",
    });
    expect(command).toBe("codex");
  });

  it("falls through to the project default when the issue has no ReviewAgent: line", () => {
    const app = mockApp();
    const command = resolveReviewAgentCommand(app, {
      issueBody: null,
      projectDefaultReviewAgent: "agy",
    });
    expect(command).toBe("agy");
  });

  it("has no global-settings fallback tier — unlike the worker agent, it stays null", () => {
    const app = mockApp();
    const command = resolveReviewAgentCommand(app, {
      issueBody: "not-a-real-agent-name mentioned in prose",
      projectDefaultReviewAgent: null,
    });
    expect(command).toBeNull();
    expect(mockGetStoredSettings).not.toHaveBeenCalled();
  });
});

describe("commandSupportsSeed", () => {
  it("returns true for claude", () => {
    expect(commandSupportsSeed("claude")).toBe(true);
  });

  it("returns true for codex", () => {
    expect(commandSupportsSeed("codex")).toBe(true);
  });

  it("returns false for opencode (no session_start in its emits list)", () => {
    expect(commandSupportsSeed("opencode")).toBe(false);
  });

  // #487 — agy's adapter gained session_start in commit 7fd21ce1
  // (2026-07-26), making it seed-capable. This file previously asserted
  // only claude/codex/opencode/bash, so agy's flip from unseedable to
  // seedable drifted unnoticed through docs and comments elsewhere in the
  // repo until this issue caught it. Pinned explicitly so a future adapter
  // change can't silently regress it the same way again.
  it("returns true for agy (session_start added to its emits list)", () => {
    expect(commandSupportsSeed("agy")).toBe(true);
  });

  it("returns false for a bare shell command with no matching adapter", () => {
    expect(commandSupportsSeed("bash")).toBe(false);
  });

  it("matches a full launch command with a path and flags, not just the bare binary", () => {
    expect(commandSupportsSeed("/usr/local/bin/claude --dangerously-skip-permissions")).toBe(true);
  });
});
