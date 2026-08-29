import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCodeAdapter } from "../../../src/services/hook-adapters/opencode.js";
import { sessionAgentGuidePath } from "../../../src/services/agent-guide.js";
import { sessionBriefingPath } from "../../../src/services/project-briefing.js";
import { resolveMullionBundleDir } from "../../../src/services/hook-adapters/mullion-bundle.js";

describe("openCodeAdapter.matches (issue #175)", () => {
  it("matches a bare opencode invocation", () => {
    expect(openCodeAdapter.matches("opencode")).toBe(true);
  });

  it("matches opencode with trailing arguments", () => {
    expect(openCodeAdapter.matches("opencode --continue")).toBe(true);
  });

  it("matches a path-qualified opencode", () => {
    expect(openCodeAdapter.matches("/usr/local/bin/opencode")).toBe(true);
  });

  it("does not match a different program", () => {
    expect(openCodeAdapter.matches("bash")).toBe(false);
  });

  it("does not match opencode as a substring of another program name", () => {
    expect(openCodeAdapter.matches("opencode-wrapper")).toBe(false);
  });

  it("tolerates leading/trailing whitespace around a simple invocation", () => {
    expect(openCodeAdapter.matches("  opencode  ")).toBe(true);
  });
});

describe("openCodeAdapter.prepareLaunch (issue #175)", () => {
  // injectAgentGuide/injectProjectBriefing: false here — the plugin-file/
  // OPENCODE_CONFIG_DIR mechanics under test in this describe block are
  // independent of the agent-guide/briefing injection added in issue #437c
  // (and its agent-briefing follow-up); those gates have their own describe
  // blocks below so these assertions don't also need to account for
  // OPENCODE_CONFIG_CONTENT.
  const ctx = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    injectAgentGuide: false,
    injectProjectBriefing: false,
  };

  it("writes the plugin file under a per-session ephemeral plugins/ subdirectory", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(plan.settingsFiles).toHaveLength(1);
    expect(plan.settingsFiles?.[0].path).toBe(
      "/tmp/mullion-sessions/42.opencode-config/plugins/mullion-hook-emitter.js",
    );
    expect(plan.settingsFiles?.[0].contents).toContain("MullionHookEmitter");
  });

  it("points OPENCODE_CONFIG_DIR at the same ephemeral directory", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(plan.envAdditions).toEqual({
      OPENCODE_CONFIG_DIR: "/tmp/mullion-sessions/42.opencode-config",
    });
  });

  it("never rewrites the command — OPENCODE_CONFIG_DIR is env-only", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform).toBeUndefined();
    expect(plan.managedInstall).toBeUndefined();
  });
});

describe("openCodeAdapter.prepareLaunch — agent-guide injection (issue #437c)", () => {
  // Deliberately a real temp dir with a real file at the per-session guide
  // path, not the fake "/tmp/mullion-sessions" path the other describe
  // block in this file uses: prepareLaunch checks existsSync on the actual
  // per-session copy (not agentGuideSourceExists(), the shipped source doc
  // — see prepareLaunch's own doc comment for why), so a fixture that
  // never writes a real file there would make every "setting is on" test
  // below false-negative into the "omitted" branch instead of genuinely
  // exercising the gate.
  let sessionsDir: string;
  let baseCtx: {
    sessionId: string;
    sessionsDir: string;
    hookSocketPath: string;
    hookToken: string;
    controlSocketPath: string;
    forwarderPath: string;
    injectProjectBriefing: boolean;
  };

  beforeEach(() => {
    sessionsDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-adapter-"));
    baseCtx = {
      sessionId: "42",
      sessionsDir,
      hookSocketPath: path.join(sessionsDir, "hooks.sock"),
      hookToken: "token123",
      controlSocketPath: path.join(sessionsDir, "mullion.sock"),
      forwarderPath: "/abs/path/forwarder.mjs",
      // Off by default in this describe block — it's about the
      // injectAgentGuide gate specifically; the briefing gate has its own
      // describe block below.
      injectProjectBriefing: false,
    };
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("points OPENCODE_CONFIG_CONTENT's instructions at this session's own guide file when the setting is on and the copy exists", () => {
    writeFileSync(sessionAgentGuidePath(sessionsDir, "42"), "guide content");
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: true });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeDefined();
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
      instructions: [sessionAgentGuidePath(sessionsDir, "42")],
    });
  });

  it("still sets OPENCODE_CONFIG_DIR alongside OPENCODE_CONFIG_CONTENT", () => {
    writeFileSync(sessionAgentGuidePath(sessionsDir, "42"), "guide content");
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: true });
    expect(plan.envAdditions?.OPENCODE_CONFIG_DIR).toBe(
      path.join(sessionsDir, "42.opencode-config"),
    );
  });

  it("omits OPENCODE_CONFIG_CONTENT entirely when the setting is off — mirrors hooks.ts gating the pointer, not the on-disk write, for every other agent", () => {
    writeFileSync(sessionAgentGuidePath(sessionsDir, "42"), "guide content");
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: false });
    expect(plan.envAdditions).toEqual({
      OPENCODE_CONFIG_DIR: path.join(sessionsDir, "42.opencode-config"),
    });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  // Issue #437c, Hermes review on PR #457 — the dangling-path corner case:
  // the setting is on and the SOURCE doc exists (agentGuideSourceExists()
  // would report true), but writeSessionAgentGuide's own copy write never
  // happened (or failed) for this session, so the per-session copy this
  // adapter would reference genuinely isn't there.
  it("omits OPENCODE_CONFIG_CONTENT when the setting is on but the per-session guide copy doesn't exist (e.g. writeSessionAgentGuide's write failed)", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: true });
    expect(plan.envAdditions).toEqual({
      OPENCODE_CONFIG_DIR: path.join(sessionsDir, "42.opencode-config"),
    });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
});

// The bundle is checked in (src/bundle/) and genuinely present in this
// checkout, so — unlike the agent-guide/briefing describes above, which
// each need a real per-session file fixture — no setup is needed here
// beyond the ctx flag itself. resolveMullionBundleDir() resolves the same
// real directory both this test and opencode.ts's prepareLaunch see.
describe("openCodeAdapter.prepareLaunch — Mullion tooling bundle skills.paths (issue: make Mullion's tooling work in every repo)", () => {
  const ctx = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    injectAgentGuide: false,
    injectProjectBriefing: false,
  };

  it("points OPENCODE_CONFIG_CONTENT's skills.paths at the shipped bundle's skills dir when the setting is on", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...ctx, injectMullionBundle: true });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeDefined();
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
      skills: { paths: [path.join(resolveMullionBundleDir()!, "skills")] },
    });
  });

  it("omits OPENCODE_CONFIG_CONTENT entirely when the setting is off", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...ctx, injectMullionBundle: false });
    expect(plan.envAdditions).toEqual({
      OPENCODE_CONFIG_DIR: "/tmp/mullion-sessions/42.opencode-config",
    });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it("composes with instructions from the agent-guide gate into one OPENCODE_CONFIG_CONTENT payload", () => {
    const sessionsDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-bundle-"));
    try {
      writeFileSync(sessionAgentGuidePath(sessionsDir, "42"), "guide content");
      const plan = openCodeAdapter.prepareLaunch({
        ...ctx,
        sessionsDir,
        hookSocketPath: path.join(sessionsDir, "hooks.sock"),
        controlSocketPath: path.join(sessionsDir, "mullion.sock"),
        injectAgentGuide: true,
        injectMullionBundle: true,
      });
      expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
        instructions: [sessionAgentGuidePath(sessionsDir, "42")],
        skills: { paths: [path.join(resolveMullionBundleDir()!, "skills")] },
      });
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// PR-5 — a project's own skill/reviewer content, threaded from
// project_tooling. Uses a real temp sessionsDir (same posture as the
// agent-guide describe block below) so settingsFiles' actual writes can be
// asserted on disk, not just inspected as returned entries.
describe("openCodeAdapter.prepareLaunch — per-project skill/reviewer (PR-5)", () => {
  const ctx = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    injectAgentGuide: false,
    injectProjectBriefing: false,
    injectMullionBundle: true,
  };

  const validSkill = "---\nname: my-project-skill\ndescription: d\n---\nbody";
  const validReviewerAgent =
    "---\nname: my-project-reviewer\ndescription: reviews stuff\ntools: Read, Grep\nmodel: inherit\n---\nreview body";

  it("writes the project skill under a dedicated subdir and adds it to skills.paths", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...ctx, projectSkill: validSkill });
    const skillFile = plan.settingsFiles?.find(
      (f) => f.path.endsWith("SKILL.md") && f.path.includes("mullion-project-skills"),
    );
    expect(skillFile).toBeDefined();
    expect(skillFile!.path).toBe(
      "/tmp/mullion-sessions/42.opencode-config/mullion-project-skills/my-project-skill/SKILL.md",
    );
    expect(skillFile!.contents).toBe(validSkill);

    const configContent = JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT);
    expect(configContent.skills.paths).toContain(
      "/tmp/mullion-sessions/42.opencode-config/mullion-project-skills",
    );
    // Alongside the shipped bundle's own skills dir, not instead of it.
    expect(configContent.skills.paths).toContain(path.join(resolveMullionBundleDir()!, "skills"));
  });

  it("translates the reviewer agent into opencode's own agent/<name>.md shape — never writes the raw Claude Code frontmatter", () => {
    const plan = openCodeAdapter.prepareLaunch({
      ...ctx,
      projectReviewerAgent: validReviewerAgent,
    });
    const agentFile = plan.settingsFiles?.find((f) => f.path.endsWith("my-project-reviewer.md"));
    expect(agentFile).toBeDefined();
    expect(agentFile!.path).toBe(
      "/tmp/mullion-sessions/42.opencode-config/agent/my-project-reviewer.md",
    );
    expect(agentFile!.contents).not.toContain("tools:");
    expect(agentFile!.contents).not.toContain("model:");
    expect(agentFile!.contents).toContain("mode: subagent");
  });

  it("skips both when injectMullionBundle is off, even with project content set", () => {
    const plan = openCodeAdapter.prepareLaunch({
      ...ctx,
      injectMullionBundle: false,
      projectSkill: validSkill,
      projectReviewerAgent: validReviewerAgent,
    });
    expect(plan.settingsFiles?.some((f) => f.path.includes("mullion-project-skills"))).toBe(false);
    expect(plan.settingsFiles?.some((f) => f.path.includes("agent"))).toBe(false);
  });

  it("silently skips unparseable project content rather than throwing", () => {
    expect(() =>
      openCodeAdapter.prepareLaunch({
        ...ctx,
        projectSkill: "not a skill",
        projectReviewerAgent: "not an agent",
      }),
    ).not.toThrow();
    const plan = openCodeAdapter.prepareLaunch({
      ...ctx,
      projectSkill: "not a skill",
      projectReviewerAgent: "not an agent",
    });
    expect(plan.settingsFiles?.some((f) => f.path.includes("mullion-project-skills"))).toBe(false);
    expect(
      plan.settingsFiles?.some(
        (f) => f.path.endsWith(".md") && f.path.includes(`${path.sep}agent${path.sep}`),
      ),
    ).toBe(false);
  });
});

describe("openCodeAdapter.prepareLaunch — project briefing injection (agent-briefing follow-up to #405)", () => {
  // Same "real temp dir, real per-session file, existsSync-gated" posture
  // as the agent-guide injection describe block above, for the identical
  // reason (opencode's instructions config is a reference its own CLI
  // resolves, so a dangling entry is a real failure to catch here).
  let sessionsDir: string;
  let baseCtx: {
    sessionId: string;
    sessionsDir: string;
    hookSocketPath: string;
    hookToken: string;
    controlSocketPath: string;
    forwarderPath: string;
    injectAgentGuide: boolean;
  };

  beforeEach(() => {
    sessionsDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-briefing-"));
    baseCtx = {
      sessionId: "42",
      sessionsDir,
      hookSocketPath: path.join(sessionsDir, "hooks.sock"),
      hookToken: "token123",
      controlSocketPath: path.join(sessionsDir, "mullion.sock"),
      forwarderPath: "/abs/path/forwarder.mjs",
      injectAgentGuide: false,
    };
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("points OPENCODE_CONFIG_CONTENT's instructions at this session's own briefing file when the setting is on and the copy exists", () => {
    writeFileSync(sessionBriefingPath(sessionsDir, "42"), "briefing content");
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectProjectBriefing: true });
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
      instructions: [sessionBriefingPath(sessionsDir, "42")],
    });
  });

  it("omits OPENCODE_CONFIG_CONTENT entirely when the setting is off", () => {
    writeFileSync(sessionBriefingPath(sessionsDir, "42"), "briefing content");
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectProjectBriefing: false });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it("omits OPENCODE_CONFIG_CONTENT when the setting is on but the per-session briefing copy doesn't exist (no briefing for this project, or writeSessionBriefing unlinked a stale one)", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectProjectBriefing: true });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it("exact instructions order is [guide, briefing, seed] when all three are present", () => {
    writeFileSync(sessionAgentGuidePath(sessionsDir, "42"), "guide content");
    writeFileSync(sessionBriefingPath(sessionsDir, "42"), "briefing content");
    const plan = openCodeAdapter.prepareLaunch({
      ...baseCtx,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      seedPrompt: "resume the refactor",
    });
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
      instructions: [
        sessionAgentGuidePath(sessionsDir, "42"),
        sessionBriefingPath(sessionsDir, "42"),
        path.join(sessionsDir, "42.opencode-seed.md"),
      ],
    });
  });
});

describe("openCodeAdapter.prepareLaunch — promote-flow seed injection (issue #678)", () => {
  let sessionsDir: string;
  let baseCtx: {
    sessionId: string;
    sessionsDir: string;
    hookSocketPath: string;
    hookToken: string;
    controlSocketPath: string;
    forwarderPath: string;
    injectAgentGuide: boolean;
    injectProjectBriefing: boolean;
  };

  beforeEach(() => {
    sessionsDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-seed-"));
    baseCtx = {
      sessionId: "42",
      sessionsDir,
      hookSocketPath: path.join(sessionsDir, "hooks.sock"),
      hookToken: "token123",
      controlSocketPath: path.join(sessionsDir, "mullion.sock"),
      forwarderPath: "/abs/path/forwarder.mjs",
      injectAgentGuide: false,
      injectProjectBriefing: false,
    };
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  const seedPath = () => path.join(sessionsDir, "42.opencode-seed.md");

  it("writes the seed to a per-session file and points instructions at it, independently of injectAgentGuide", () => {
    const plan = openCodeAdapter.prepareLaunch({
      ...baseCtx,
      injectAgentGuide: false,
      seedPrompt: "resume the refactor",
    });
    const seedFile = plan.settingsFiles?.find((f) => f.path === seedPath());
    expect(seedFile?.contents).toBe("resume the refactor");
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
      instructions: [seedPath()],
    });
  });

  it("still writes the plugin file alongside the seed file", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, seedPrompt: "resume here" });
    expect(plan.settingsFiles).toHaveLength(2);
    expect(plan.settingsFiles?.map((f) => f.path)).toContain(
      path.join(sessionsDir, "42.opencode-config", "plugins", "mullion-hook-emitter.js"),
    );
  });

  it("concatenates the seed path with the agent-guide path when both are gated on", () => {
    writeFileSync(sessionAgentGuidePath(sessionsDir, "42"), "guide content");
    const plan = openCodeAdapter.prepareLaunch({
      ...baseCtx,
      injectAgentGuide: true,
      seedPrompt: "resume the refactor",
    });
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
      instructions: [sessionAgentGuidePath(sessionsDir, "42"), seedPath()],
    });
  });

  it("omits the seed entirely when seedPrompt is an empty string", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, seedPrompt: "" });
    expect(plan.settingsFiles).toHaveLength(1);
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it("omits the seed entirely when seedPrompt is absent (existing agent-guide-only behavior unaffected)", () => {
    const plan = openCodeAdapter.prepareLaunch(baseCtx);
    expect(plan.settingsFiles).toHaveLength(1);
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
});

describe("OPENCODE_EMITS (issue #321)", () => {
  it("includes compact for session.compacting events", () => {
    expect(openCodeAdapter.emits).toContain("compact");
  });

  it("includes subagent for session.subagent events", () => {
    expect(openCodeAdapter.emits).toContain("subagent");
  });
});
