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
  resolveSeedDelivered,
} from "../../src/services/task-agent-resolve.js";
import { LOCAL_HOST_ID } from "../../src/services/host-registry.js";

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

  it("prefers the task's own agent column over issue body and project default", () => {
    const app = mockApp();
    const command = resolveAgentCommand(app, {
      taskAgent: "agy",
      issueBody: "Some spec.\nAgent: codex\nMore text.",
      projectDefaultAgent: "opencode",
    });
    expect(command).toBe("agy");
  });

  it("prefers the issue body's Agent: line over project default when task agent is unset", () => {
    const app = mockApp();
    const command = resolveAgentCommand(app, {
      issueBody: "Some spec.\nAgent: codex\nMore text.",
      projectDefaultAgent: "opencode",
    });
    expect(command).toBe("codex");
  });

  it("falls through past an unrecognized task agent name, logging a warning", () => {
    const app = mockApp();
    const command = resolveAgentCommand(app, {
      taskAgent: "invalid-cli",
      issueBody: "Agent: codex",
      projectDefaultAgent: "opencode",
    });
    expect(command).toBe("codex");
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "invalid-cli" }),
      expect.stringContaining("unrecognized agent"),
    );
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

  it("prefers the task's own reviewAgent column over issue body and project default", () => {
    const app = mockApp();
    const command = resolveReviewAgentCommand(app, {
      taskReviewAgent: "opencode",
      issueBody: "ReviewAgent: codex",
      projectDefaultReviewAgent: "agy",
    });
    expect(command).toBe("opencode");
  });

  it("explicitly disables review agent when taskReviewAgent is 'none' or empty string", () => {
    const app = mockApp();
    const commandNone = resolveReviewAgentCommand(app, {
      taskReviewAgent: "none",
      issueBody: "ReviewAgent: codex",
      projectDefaultReviewAgent: "agy",
    });
    expect(commandNone).toBeNull();

    const commandEmpty = resolveReviewAgentCommand(app, {
      taskReviewAgent: "",
      issueBody: "ReviewAgent: codex",
      projectDefaultReviewAgent: "agy",
    });
    expect(commandEmpty).toBeNull();
  });

  it("falls through past an unrecognized task reviewAgent name, logging a warning", () => {
    const app = mockApp();
    const command = resolveReviewAgentCommand(app, {
      taskReviewAgent: "not-an-agent",
      issueBody: "ReviewAgent: codex",
      projectDefaultReviewAgent: "agy",
    });
    expect(command).toBe("codex");
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "not-an-agent" }),
      expect.stringContaining("unrecognized agent"),
    );
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

  // Follow-up to #678/#684's promote-seed work — opencode gained
  // `initialPromptArgs` (`--prompt`, verified to actually submit a turn;
  // see opencode.ts's own comment) so its promoted/claimed sessions stop
  // landing idle with an unsubmitted seed. This is NOT gated on
  // `session_start` being in opencode's `emits` list (it still isn't —
  // opencode has no live hook round trip at all) — `commandSupportsSeed`
  // only ever checked `adapterHasInitialPromptArgs`, so the old title here
  // ("no session_start in its emits list") described a correlation among
  // the three adapters that had this at the time, not an actual gate. Same
  // "pinned explicitly" posture as the agy case below: a future adapter
  // change shouldn't silently regress this again.
  it("returns true for opencode (--prompt genuinely submits a turn)", () => {
    expect(commandSupportsSeed("opencode")).toBe(true);
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

// Hermes review, PR #538 — a remote-hosted spawn's `seedDelivered` can't be
// trusted from local capability alone: an agent build too old to know about
// `initialPrompt` silently strips it (Fastify's `removeAdditional`
// behavior), so the session spawns promptless while a naive
// `seedDelivered: seedCapable` would still claim success.
describe("resolveSeedDelivered", () => {
  it("returns false outright when the command isn't seed-capable, regardless of host or echo", () => {
    expect(resolveSeedDelivered(false, LOCAL_HOST_ID, undefined)).toBe(false);
    expect(resolveSeedDelivered(false, "remote-1", true)).toBe(false);
  });

  it("trusts seedCapable directly for a local host — no version-skew risk (same process/build)", () => {
    expect(resolveSeedDelivered(true, LOCAL_HOST_ID, undefined)).toBe(true);
    expect(resolveSeedDelivered(true, LOCAL_HOST_ID, false)).toBe(true);
  });

  it("trusts a remote host's explicit confirmation", () => {
    expect(resolveSeedDelivered(true, "remote-1", true)).toBe(true);
  });

  it("does NOT trust a remote host when initialPromptApplied is undefined — the version-skew signal (an old build's response never includes the field)", () => {
    expect(resolveSeedDelivered(true, "remote-1", undefined)).toBe(false);
  });

  it("does not trust a remote host that explicitly reports it did not apply the prompt", () => {
    expect(resolveSeedDelivered(true, "remote-1", false)).toBe(false);
  });
});
