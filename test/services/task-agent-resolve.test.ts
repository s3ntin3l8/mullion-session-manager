import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockGetStoredSettings = vi.hoisted(() => vi.fn());
const mockHermesUsable = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: mockGetStoredSettings,
}));

// Only consulted when some tier names `hermes`; the cases that don't must not
// reach it (their settings mock has no `reviewRelay`).
vi.mock("../../src/services/hermes-integration.js", () => ({
  hermesTaskReviewerUsable: mockHermesUsable,
}));

import {
  resolveAgentCommand,
  resolveReviewAgentCommand,
  resolveReviewer,
  hermesReviewAgentRefusal,
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
    mockGetStoredSettings.mockReturnValue({ taskMaster: { defaultAgent: "claude" } });
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
  beforeEach(() => {
    mockGetStoredSettings.mockReset();
    mockGetStoredSettings.mockReturnValue({
      taskMaster: { defaultAgent: "claude", defaultReviewAgent: "none" },
    });
  });

  it("returns null when nothing configures a review agent and the install-wide default is 'none'", () => {
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

  it("falls through to the install-wide taskMaster.defaultReviewAgent when nothing per-task or per-project configures one", () => {
    mockGetStoredSettings.mockReturnValue({
      taskMaster: { defaultAgent: "claude", defaultReviewAgent: "codex" },
    });
    const app = mockApp();
    const command = resolveReviewAgentCommand(app, {
      issueBody: null,
      projectDefaultReviewAgent: null,
    });
    expect(command).toBe("codex");
    expect(mockGetStoredSettings).toHaveBeenCalled();
  });

  it("treats an empty install-wide defaultReviewAgent as no review agent", () => {
    mockGetStoredSettings.mockReturnValue({
      taskMaster: { defaultAgent: "claude", defaultReviewAgent: "" },
    });
    const app = mockApp();
    const command = resolveReviewAgentCommand(app, {
      issueBody: null,
      projectDefaultReviewAgent: null,
    });
    expect(command).toBeNull();
  });

  it("resolves an unrecognized install-wide defaultReviewAgent to no review agent, logging a warning — mirrors tiers 1-3 validating against KNOWN_AGENTS", () => {
    mockGetStoredSettings.mockReturnValue({
      taskMaster: { defaultAgent: "claude", defaultReviewAgent: "not-a-real-agent" },
    });
    const app = mockApp();
    const command = resolveReviewAgentCommand(app, {
      issueBody: null,
      projectDefaultReviewAgent: null,
    });
    expect(command).toBeNull();
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "not-a-real-agent" }),
      expect.stringContaining("unrecognized agent"),
    );
  });

  it("lets a per-task or per-project review agent beat the install-wide default", () => {
    mockGetStoredSettings.mockReturnValue({
      taskMaster: { defaultAgent: "claude", defaultReviewAgent: "codex" },
    });
    const app = mockApp();
    const command = resolveReviewAgentCommand(app, {
      taskReviewAgent: "agy",
      issueBody: "ReviewAgent: codex",
      projectDefaultReviewAgent: "opencode",
    });
    expect(command).toBe("agy");
    expect(mockGetStoredSettings).not.toHaveBeenCalled();
  });
});

describe("resolveReviewer — hermes (#2369)", () => {
  const settings = (defaultReviewAgent = "none") => ({
    taskMaster: { defaultAgent: "claude", defaultReviewAgent },
  });
  const none = { issueBody: null, projectDefaultReviewAgent: null } as const;

  beforeEach(() => {
    mockGetStoredSettings.mockReset();
    mockGetStoredSettings.mockReturnValue(settings());
    mockHermesUsable.mockReset();
    mockHermesUsable.mockReturnValue(true);
  });

  describe("when Hermes is usable", () => {
    it("is Hermes at the task tier", () => {
      expect(resolveReviewer(mockApp(), { ...none, taskReviewAgent: "hermes" })).toEqual({
        kind: "hermes",
      });
    });

    it("is Hermes at the issue directive tier", () => {
      expect(resolveReviewer(mockApp(), { ...none, issueBody: "ReviewAgent: hermes" })).toEqual({
        kind: "hermes",
      });
    });

    it("is Hermes at the project tier", () => {
      expect(resolveReviewer(mockApp(), { ...none, projectDefaultReviewAgent: "hermes" })).toEqual({
        kind: "hermes",
      });
    });

    it("is Hermes at the install-wide tier", () => {
      mockGetStoredSettings.mockReturnValue(settings("hermes"));
      expect(resolveReviewer(mockApp(), none)).toEqual({ kind: "hermes" });
    });

    it("keeps the usual precedence: the most specific tier wins, either way round", () => {
      expect(
        resolveReviewer(mockApp(), {
          taskReviewAgent: "hermes",
          issueBody: "ReviewAgent: codex",
          projectDefaultReviewAgent: "agy",
        }),
      ).toEqual({ kind: "hermes" });
      expect(
        resolveReviewer(mockApp(), {
          taskReviewAgent: "agy",
          issueBody: "ReviewAgent: hermes",
          projectDefaultReviewAgent: "hermes",
        }),
      ).toEqual({ kind: "cli", command: "agy" });
    });

    it("lets 'none' at a higher tier switch Hermes off", () => {
      expect(
        resolveReviewer(mockApp(), {
          taskReviewAgent: "none",
          issueBody: null,
          projectDefaultReviewAgent: "hermes",
        }),
      ).toBeNull();
    });
  });

  describe("when Hermes is not usable", () => {
    beforeEach(() => {
      mockHermesUsable.mockReturnValue(false);
    });

    it("resolves to no reviewer at the task tier — not to the next tier's CLI", () => {
      const app = mockApp();
      expect(
        resolveReviewer(app, {
          taskReviewAgent: "hermes",
          issueBody: "ReviewAgent: codex",
          projectDefaultReviewAgent: "agy",
        }),
      ).toBeNull();
      expect(app.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ source: "task" }),
        expect.stringContaining("isn't usable"),
      );
    });

    it("resolves to no reviewer at the issue directive tier", () => {
      expect(
        resolveReviewer(mockApp(), {
          issueBody: "ReviewAgent: hermes",
          projectDefaultReviewAgent: "agy",
        }),
      ).toBeNull();
    });

    it("resolves to no reviewer at the project tier, ignoring the install-wide CLI", () => {
      mockGetStoredSettings.mockReturnValue(settings("codex"));
      expect(
        resolveReviewer(mockApp(), { issueBody: null, projectDefaultReviewAgent: "hermes" }),
      ).toBeNull();
    });

    it("resolves to no reviewer at the install-wide tier", () => {
      mockGetStoredSettings.mockReturnValue(settings("hermes"));
      const app = mockApp();
      expect(resolveReviewer(app, none)).toBeNull();
      expect(app.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ source: "install-wide" }),
        expect.stringContaining("isn't usable"),
      );
    });
  });

  it("never consults Hermes when no tier names it", () => {
    resolveReviewer(mockApp(), { ...none, taskReviewAgent: "agy" });
    resolveReviewer(mockApp(), { ...none, issueBody: "ReviewAgent: codex" });
    resolveReviewer(mockApp(), { ...none, projectDefaultReviewAgent: "opencode" });
    mockGetStoredSettings.mockReturnValue(settings("codex"));
    resolveReviewer(mockApp(), none);
    expect(mockHermesUsable).not.toHaveBeenCalled();
  });

  it("returns a CLI reviewer as { kind: 'cli' } for every known name", () => {
    expect(resolveReviewer(mockApp(), { ...none, taskReviewAgent: "codex" })).toEqual({
      kind: "cli",
      command: "codex",
    });
  });

  it("matches the name exactly: 'Hermes' is unrecognised and falls through, like any typo", () => {
    const app = mockApp();
    expect(
      resolveReviewer(app, {
        ...none,
        taskReviewAgent: "Hermes",
        projectDefaultReviewAgent: "agy",
      }),
    ).toEqual({ kind: "cli", command: "agy" });
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Hermes" }),
      expect.stringContaining("unrecognized agent"),
    );
    expect(mockHermesUsable).not.toHaveBeenCalled();
  });

  describe("resolveReviewAgentCommand, the CLI-only view of it", () => {
    it("is null for Hermes, usable or not, so a CLI spawn or placement never sees it", () => {
      expect(
        resolveReviewAgentCommand(mockApp(), { ...none, taskReviewAgent: "hermes" }),
      ).toBeNull();
      mockHermesUsable.mockReturnValue(false);
      expect(
        resolveReviewAgentCommand(mockApp(), { ...none, taskReviewAgent: "hermes" }),
      ).toBeNull();
    });

    it("is the command for a CLI reviewer", () => {
      expect(resolveReviewAgentCommand(mockApp(), { ...none, taskReviewAgent: "agy" })).toBe("agy");
    });
  });
});

describe("hermesReviewAgentRefusal (#2369)", () => {
  beforeEach(() => {
    mockHermesUsable.mockReset();
  });

  it("refuses 'hermes' while Hermes isn't usable, and says where to fix it", () => {
    mockHermesUsable.mockReturnValue(false);
    expect(hermesReviewAgentRefusal(mockApp(), "hermes")).toContain("Settings → Review relay");
  });

  it("lets 'hermes' through while Hermes is usable", () => {
    mockHermesUsable.mockReturnValue(true);
    expect(hermesReviewAgentRefusal(mockApp(), "hermes")).toBeNull();
  });

  it("has nothing to say about any other name, and never consults Hermes for one", () => {
    expect(hermesReviewAgentRefusal(mockApp(), "agy")).toBeNull();
    expect(hermesReviewAgentRefusal(mockApp(), "none")).toBeNull();
    expect(hermesReviewAgentRefusal(mockApp(), null)).toBeNull();
    expect(hermesReviewAgentRefusal(mockApp(), undefined)).toBeNull();
    expect(mockHermesUsable).not.toHaveBeenCalled();
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
