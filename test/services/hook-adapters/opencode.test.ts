import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Issue #941 — defaults to "not synced" everywhere, matching this file's
// existing expectations that the shipped bundle's skills dir is always
// pushed onto skills.paths when injectMullionBundle is on. A dedicated
// describe block below flips this to exercise the new fallback-skip path.
// Mocked (rather than exercising the real manifest file) so this suite
// never touches the real developer/CI-runner's own ~/.mullion/.
const mockIsBundleSyncedFor = vi.fn((_cli: string): boolean => false);
// Issue #1079 — resolves to a distinguishable value per call so a test can
// assert the adapter awaited it (rather than fired-and-forgot a promise no
// one checked) without depending on bundle-sync.ts's own internals.
const mockRemoveBundleContentForCli = vi.fn((_cli: string) =>
  Promise.resolve({ skillsRemoved: 1, agentsRemoved: 1 }),
);
vi.mock("../../../src/services/bundle-sync.js", () => ({
  isBundleSyncedFor: (cli: string) => mockIsBundleSyncedFor(cli),
  removeBundleContentForCli: (cli: "claude-code" | "opencode") =>
    mockRemoveBundleContentForCli(cli),
}));

const { openCodeAdapter, buildOpenCodeMcpConfig, opencodeStandaloneTransform, OPENCODE_EMITS } =
  await import("../../../src/services/hook-adapters/opencode.js");
const { resolveMcpServerPath } = await import("../../../src/services/hook-adapters/shared.js");
const { buildAgentGuideBlock, sessionAgentGuidePath } =
  await import("../../../src/services/agent-guide.js");
const { sessionBriefingPath } = await import("../../../src/services/project-briefing.js");
const { sessionWorkflowConventionsPath } =
  await import("../../../src/services/workflow-conventions.js");
const { resolveMullionBundleDir } =
  await import("../../../src/services/hook-adapters/mullion-bundle.js");

// Issue #881 — the mcp.mullion entry is now unconditional (see
// opencode.ts's own comment on why), so every OPENCODE_CONFIG_CONTENT
// payload in this file carries it alongside whatever else is under test.
// This helper computes the exact expected value from a given ctx, the same
// way opencode.ts itself builds it, so assertions stay effect-under-test
// rather than re-deriving the mcp shape by hand at each call site.
function expectedMcp(ctx: {
  hookSocketPath: string;
  hookToken: string;
  controlSocketPath: string;
}) {
  return buildOpenCodeMcpConfig(
    resolveMcpServerPath(),
    ctx.hookSocketPath,
    ctx.hookToken,
    ctx.controlSocketPath,
  );
}

// The always-present part of OPENCODE_CONFIG_CONTENT: the Mullion MCP server
// (issue #881) plus the per-session plugin DIRECTORY (opencode v2 resolves
// `server.js` inside a configured plugin directory — a bare file path is
// rejected).
function expectedBase(ctx: {
  sessionsDir: string;
  hookSocketPath: string;
  hookToken: string;
  controlSocketPath: string;
}) {
  return {
    mcp: expectedMcp(ctx),
    plugins: [path.join(ctx.sessionsDir, "42.opencode-config", "plugin")],
  };
}

// The instruction files' absolute paths, as handed to the plugin (v2 parses
// but never reads the `instructions` config key, so they ride
// MULLION_OPENCODE_INSTRUCTIONS and the plugin's `context` hook instead).
function instructionsEnv(plan: { envAdditions?: Record<string, string> }): string[] | undefined {
  const raw = plan.envAdditions?.MULLION_OPENCODE_INSTRUCTIONS;
  return raw === undefined ? undefined : (JSON.parse(raw) as string[]);
}

// Issue #881 — pins buildOpenCodeMcpConfig's exact output literally, with
// no helper in between. Every other test in this file computes its
// expectation via expectedMcp()/buildOpenCodeMcpConfig itself, which only
// proves prepareLaunch forwards the builder's output — it would stay green
// even if the builder's own shape drifted (e.g. `environment` renamed to
// `env`, or `command` split into `command`/`args` to match
// buildClaudeMcpConfig's differently-shaped Claude Code output). This is
// the one test that actually catches that: the literal shape below is
// OpenCode's own, confirmed against the real CLI (`opencode mcp list`
// reporting `mullion  connected` against a stdio probe server — see this
// function's own doc comment for the two-step verification).
describe("buildOpenCodeMcpConfig (issue #881)", () => {
  it("uses OpenCode's own mcp shape, not Claude Code's", () => {
    expect(
      buildOpenCodeMcpConfig("/srv.mjs", "/h.sock", "tok", "/c.sock", "/usr/bin/node"),
    ).toEqual({
      mullion: {
        type: "local",
        command: ["/usr/bin/node", "/srv.mjs"],
        environment: {
          MULLION_HOOK_SOCKET: "/h.sock",
          MULLION_HOOK_TOKEN: "tok",
          MULLION_SOCKET_PATH: "/c.sock",
        },
        enabled: true,
      },
    });
  });
});

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
    // Issue #1079 — explicitly false (not just omitted/undefined) to match
    // this describe block's pre-existing "shipped bundle off" expectations
    // (e.g. no `skills` key in OPENCODE_CONFIG_CONTENT below) byte-for-byte
    // — an explicit `false` and an omitted value behave identically for
    // every other gate in this file, but now also means `managedInstall`
    // is set (see its own dedicated describe block below, which is the
    // only place in this file that actually calls it).
    injectMullionBundle: false,
  };

  it("writes the plugin as server.js inside a per-session ephemeral plugin/ directory", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(plan.settingsFiles).toHaveLength(1);
    expect(plan.settingsFiles?.[0].path).toBe(
      "/tmp/mullion-sessions/42.opencode-config/plugin/server.js",
    );
    expect(plan.settingsFiles?.[0].contents).toContain("mullion-hook-emitter");
  });

  it("references the plugin DIRECTORY from OPENCODE_CONFIG_CONTENT's plugins (v2 rejects a bare file path)", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT).plugins).toEqual([
      "/tmp/mullion-sessions/42.opencode-config/plugin",
    ]);
  });

  // v2's OPENCODE_CONFIG_DIR REPLACES the user's global config root (1.x
  // loaded it additively), which would silently drop their own opencode.json
  // (MCP servers, permission.skill rules), global AGENTS.md and skills inside
  // every Mullion session.
  it("never sets OPENCODE_CONFIG_DIR", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(plan.envAdditions).not.toHaveProperty("OPENCODE_CONFIG_DIR");
  });

  // By default the v2 TUI attaches to ONE shared background service per user,
  // which would inherit the first session's MULLION_* env and config content.
  it("adds --standalone to the launch command so the TUI gets a private per-session server", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform).toBeInstanceOf(Function);
    expect(plan.commandTransform!("opencode")).toBe("opencode --standalone");
  });

  // Issue #881 — the Mullion MCP server is registered unconditionally,
  // independently of every other gate in this file (agent-guide, briefing,
  // bundle, project skill/reviewer) — mirroring claude-code.ts's
  // unconditional --mcp-config and agy.ts's unconditional
  // mergeAgyMcpConfig. Neither is gated on a setting; the tools it exposes
  // are core Mullion functionality.
  it("registers the Mullion MCP server unconditionally via OPENCODE_CONFIG_CONTENT", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(ctx));
  });
});

describe("opencodeStandaloneTransform", () => {
  it("inserts --standalone right after the program token", () => {
    expect(opencodeStandaloneTransform("opencode")).toBe("opencode --standalone");
    expect(opencodeStandaloneTransform("opencode --model a/b")).toBe(
      "opencode --standalone --model a/b",
    );
    expect(opencodeStandaloneTransform("/usr/local/bin/opencode --continue")).toBe(
      "/usr/local/bin/opencode --standalone --continue",
    );
  });

  it("attaches to the program token, not the end of a chained command", () => {
    expect(opencodeStandaloneTransform("opencode && echo done")).toBe(
      "opencode --standalone && echo done",
    );
    expect(opencodeStandaloneTransform("opencode | tee out.log")).toBe(
      "opencode --standalone | tee out.log",
    );
  });

  it("is idempotent", () => {
    expect(opencodeStandaloneTransform("opencode --standalone --continue")).toBe(
      "opencode --standalone --continue",
    );
  });

  it("leaves an opencode SUBCOMMAND alone — --standalone belongs to the default (TUI) command", () => {
    expect(opencodeStandaloneTransform("opencode run 'fix it'")).toBe("opencode run 'fix it'");
    expect(opencodeStandaloneTransform("opencode models")).toBe("opencode models");
  });

  it("still treats a positional directory as the default command", () => {
    expect(opencodeStandaloneTransform("opencode ./some/dir")).toBe(
      "opencode --standalone ./some/dir",
    );
  });

  it("leaves a command that attaches to a server (--server) alone", () => {
    expect(opencodeStandaloneTransform("opencode --server http://127.0.0.1:4000")).toBe(
      "opencode --server http://127.0.0.1:4000",
    );
    expect(opencodeStandaloneTransform("opencode --server=http://h:1 --continue")).toBe(
      "opencode --server=http://h:1 --continue",
    );
  });

  it("returns a non-opencode command unchanged", () => {
    expect(opencodeStandaloneTransform("bash -l")).toBe("bash -l");
  });
});

// Issue #1079 — opencode's own counterpart to codex's/agy's managedInstall
// uninstall step: actively removes this CLI's globally-synced bundle content
// the moment a session launches with the setting off, rather than waiting
// for the next Mullion process restart.
describe("openCodeAdapter.prepareLaunch — managedInstall bundle removal (issue #1079)", () => {
  const ctx = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    injectAgentGuide: false,
    injectProjectBriefing: false,
    injectMullionBundle: false,
  };

  beforeEach(() => {
    mockRemoveBundleContentForCli.mockClear();
  });

  it("sets managedInstall when injectMullionBundle is off, and it calls removeBundleContentForCli('opencode')", async () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(plan.managedInstall).toBeInstanceOf(Function);
    await plan.managedInstall?.();
    expect(mockRemoveBundleContentForCli).toHaveBeenCalledWith("opencode");
    expect(mockRemoveBundleContentForCli).toHaveBeenCalledTimes(1);
  });

  it("never sets managedInstall when injectMullionBundle is on — leaves everything alone, no accidental deletion", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...ctx, injectMullionBundle: true });
    expect(plan.managedInstall).toBeUndefined();
    expect(mockRemoveBundleContentForCli).not.toHaveBeenCalled();
  });
});

describe("openCodeAdapter.prepareLaunch — agent-guide tier-0 push (issue #949, formerly #437c)", () => {
  // A real temp dir, same posture the pre-#949 version of this describe
  // block used — not because prepareLaunch still checks existsSync on the
  // full per-session guide copy (it no longer does: this adapter now
  // writes its OWN small tier-0 file via settingsFiles, so the
  // `instructions` entry can never dangle regardless of whether that other
  // copy exists — see prepareLaunch's own doc comment), but because
  // buildAgentGuideBlock's pointer sentence still names that copy's path,
  // and assertions below reconstruct the expected tier-0 content from it.
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

  function tier0Path(): string {
    return path.join(sessionsDir, "42.opencode-tier0.md");
  }

  it("writes a small tier-0 file and hands its path to the plugin via MULLION_OPENCODE_INSTRUCTIONS when the setting is on", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: true });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeDefined();
    // The inert `instructions` config key is no longer emitted (v2 never reads it).
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
    expect(instructionsEnv(plan)).toEqual([tier0Path()]);
    const tier0File = plan.settingsFiles?.find((f) => f.path === tier0Path());
    expect(tier0File).toBeDefined();
    expect(tier0File!.contents).toBe(
      buildAgentGuideBlock(sessionAgentGuidePath(sessionsDir, "42"), true),
    );
  });

  it("reflects ctx.authEnabled in the tier-0 file's scope sentence, the same live host state hooks.ts's own SessionStart reply carries", () => {
    const plan = openCodeAdapter.prepareLaunch({
      ...baseCtx,
      injectAgentGuide: true,
      authEnabled: true,
    });
    const tier0File = plan.settingsFiles?.find((f) => f.path === tier0Path());
    expect(tier0File!.contents).toBe(
      buildAgentGuideBlock(sessionAgentGuidePath(sessionsDir, "42"), true),
    );
    expect(tier0File!.contents).toContain("MULLION_HOOK_TOKEN; MULLION_AUTH_TOKEN");
  });

  it("treats ctx.authEnabled as session-scope when omitted (conservative default — assumes auth is enabled)", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: true });
    const tier0File = plan.settingsFiles?.find((f) => f.path === tier0Path());
    expect(tier0File!.contents).toContain("MULLION_HOOK_TOKEN; MULLION_AUTH_TOKEN");
  });

  it("never sets OPENCODE_CONFIG_DIR alongside OPENCODE_CONFIG_CONTENT", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: true });
    expect(plan.envAdditions).not.toHaveProperty("OPENCODE_CONFIG_DIR");
  });

  it("omits the tier-0 push from instructions and settingsFiles when the setting is off — mirrors hooks.ts gating the push for every other agent (OPENCODE_CONFIG_CONTENT itself stays present for the unconditional mcp entry, issue #881)", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: false });
    expect(instructionsEnv(plan)).toBeUndefined();
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
    expect(plan.settingsFiles?.some((f) => f.path === tier0Path())).toBe(false);
  });

  // Issue #949 — this is what used to be the dangling-path corner case
  // (Hermes review, PR #457, on the pre-#949 version of this adapter): the
  // setting is on, but writeSessionAgentGuide's own copy of the FULL guide
  // never happened (or failed) for this session. Previously that omitted
  // the guide pointer entirely, since `instructions` pointed straight at
  // that copy. Now it doesn't: this adapter writes its own tier-0 file
  // regardless, so `instructions` never dangles on that other write's
  // success — only the tier-0 block's OWN pointer sentence (inside the
  // file, not the `instructions` entry itself) can still go stale, the
  // same accepted risk the other three agents' pointer already has.
  it("still pushes the tier-0 file even when the full per-session guide copy was never written", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: true });
    expect(instructionsEnv(plan)).toEqual([tier0Path()]);
  });
});

// The bundle is checked in (src/bundle/) and genuinely present in this
// checkout, so — unlike the agent-guide/briefing describes above, which
// each need a real per-session file fixture — no setup is needed here
// beyond the ctx flag itself. resolveMullionBundleDir() resolves the same
// real directory both this test and opencode.ts's prepareLaunch see.
describe("openCodeAdapter.prepareLaunch — Mullion tooling bundle skills (issue: make Mullion's tooling work in every repo)", () => {
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

  // v2's config key is `skills: string[]` (1.x's `skills.paths`).
  it("points OPENCODE_CONFIG_CONTENT's skills at the shipped bundle's skills dir when the setting is on", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...ctx, injectMullionBundle: true });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeDefined();
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
      skills: [path.join(resolveMullionBundleDir()!, "skills")],
      ...expectedBase(ctx),
    });
  });

  it("omits skills when the setting is off (mcp entry is unaffected — issue #881, it's gated independently)", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...ctx, injectMullionBundle: false });
    expect(plan.envAdditions).not.toHaveProperty("OPENCODE_CONFIG_DIR");
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(ctx));
  });

  it("composes with the instruction files from the agent-guide tier-0 gate (config content + env var)", () => {
    const sessionsDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-bundle-"));
    try {
      const scopedCtx = {
        ...ctx,
        sessionsDir,
        hookSocketPath: path.join(sessionsDir, "hooks.sock"),
        controlSocketPath: path.join(sessionsDir, "mullion.sock"),
        injectAgentGuide: true,
        injectMullionBundle: true,
      };
      const plan = openCodeAdapter.prepareLaunch(scopedCtx);
      expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
        skills: [path.join(resolveMullionBundleDir()!, "skills")],
        ...expectedBase(scopedCtx),
      });
      expect(instructionsEnv(plan)).toEqual([path.join(sessionsDir, "42.opencode-tier0.md")]);
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// Issue #941 — once bundle-sync.ts's boot-time sync has globally installed
// the shipped bundle for opencode, pushing the SAME skills dir onto
// skills.paths here becomes redundant and should be skipped.
describe("openCodeAdapter.prepareLaunch — bundle-sync fallback (issue #941)", () => {
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

  beforeEach(() => {
    mockIsBundleSyncedFor.mockClear();
  });

  afterEach(() => {
    mockIsBundleSyncedFor.mockReturnValue(false);
  });

  it("omits the shipped bundle's skills entry once bundle-sync reports opencode as synced", () => {
    mockIsBundleSyncedFor.mockReturnValue(true);
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(mockIsBundleSyncedFor).toHaveBeenCalledWith("opencode");
    const parsed = JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT);
    expect(parsed.skills).toBeUndefined();
  });

  it("still pushes skills when bundle-sync reports opencode as NOT synced (today's behavior)", () => {
    mockIsBundleSyncedFor.mockReturnValue(false);
    const plan = openCodeAdapter.prepareLaunch(ctx);
    const parsed = JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT);
    expect(parsed.skills).toContain(path.join(resolveMullionBundleDir()!, "skills"));
  });

  it("never checks bundle-sync status when injectMullionBundle is off", () => {
    mockIsBundleSyncedFor.mockReturnValue(true);
    openCodeAdapter.prepareLaunch({ ...ctx, injectMullionBundle: false });
    expect(mockIsBundleSyncedFor).not.toHaveBeenCalled();
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

  it("writes the project skill under a dedicated subdir and adds it to skills", () => {
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
    expect(configContent.skills).toContain(
      "/tmp/mullion-sessions/42.opencode-config/mullion-project-skills",
    );
    // Alongside the shipped bundle's own skills dir, not instead of it.
    expect(configContent.skills).toContain(path.join(resolveMullionBundleDir()!, "skills"));
  });

  // Issue #941 — the project's own skill is a separate, always-per-session
  // mechanism, never gated on bundle-sync's global-install status; only the
  // shipped bundle's OWN entry is dropped once synced.
  it("still writes the project skill and keeps it in skills even when bundle-sync reports opencode as synced", () => {
    mockIsBundleSyncedFor.mockReturnValue(true);
    const plan = openCodeAdapter.prepareLaunch({ ...ctx, projectSkill: validSkill });
    mockIsBundleSyncedFor.mockReturnValue(false);

    const configContent = JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT);
    expect(configContent.skills).toContain(
      "/tmp/mullion-sessions/42.opencode-config/mullion-project-skills",
    );
    // The shipped bundle's own entry IS dropped now that it's synced.
    expect(configContent.skills).not.toContain(path.join(resolveMullionBundleDir()!, "skills"));
  });

  // v2's OPENCODE_CONFIG_DIR/agent/<name>.md discovery depended on the
  // config-dir redirect Mullion no longer sets, so the reviewer rides an
  // inline `agents.<name>` config entry — and, as before, never the raw Claude
  // Code frontmatter (`tools`/`model` keys hard-fail opencode's config loader).
  it("delivers the reviewer agent as an inline agents.<name> entry — no agent file, no raw Claude Code frontmatter keys", () => {
    const plan = openCodeAdapter.prepareLaunch({
      ...ctx,
      projectReviewerAgent: validReviewerAgent,
    });
    const configContent = JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT);
    expect(configContent.agents).toEqual({
      "my-project-reviewer": {
        description: "reviews stuff",
        mode: "subagent",
        system: "review body",
      },
    });
    expect(plan.settingsFiles?.some((f) => f.path.endsWith("my-project-reviewer.md"))).toBe(false);
  });

  it("puts the title model and the reviewer agent in the same agents map", () => {
    const plan = openCodeAdapter.prepareLaunch({
      ...ctx,
      smallModel: "anthropic/claude-haiku-5-5",
      projectReviewerAgent: validReviewerAgent,
    });
    const configContent = JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT);
    expect(Object.keys(configContent.agents).sort()).toEqual(["my-project-reviewer", "title"]);
    expect(configContent.agents.title).toEqual({ model: "anthropic/claude-haiku-5-5" });
  });

  it("skips both when injectMullionBundle is off, even with project content set", () => {
    const plan = openCodeAdapter.prepareLaunch({
      ...ctx,
      injectMullionBundle: false,
      projectSkill: validSkill,
      projectReviewerAgent: validReviewerAgent,
    });
    expect(plan.settingsFiles?.some((f) => f.path.includes("mullion-project-skills"))).toBe(false);
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT).agents).toBeUndefined();
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
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT).agents).toBeUndefined();
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

  it("hands this session's own briefing file to the plugin when the setting is on and the copy exists", () => {
    writeFileSync(sessionBriefingPath(sessionsDir, "42"), "briefing content");
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectProjectBriefing: true });
    expect(instructionsEnv(plan)).toEqual([sessionBriefingPath(sessionsDir, "42")]);
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
  });

  it("omits the briefing from the instruction files when the setting is off (mcp entry unaffected, issue #881)", () => {
    writeFileSync(sessionBriefingPath(sessionsDir, "42"), "briefing content");
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectProjectBriefing: false });
    expect(instructionsEnv(plan)).toBeUndefined();
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
  });

  it("omits the briefing pointer from instructions when the setting is on but the per-session briefing copy doesn't exist (no briefing for this project, or writeSessionBriefing unlinked a stale one)", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectProjectBriefing: true });
    expect(instructionsEnv(plan)).toBeUndefined();
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
  });

  it("exact instructions order is [guide tier-0, briefing, seed] when all three are present", () => {
    writeFileSync(sessionBriefingPath(sessionsDir, "42"), "briefing content");
    const plan = openCodeAdapter.prepareLaunch({
      ...baseCtx,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      seedPrompt: "resume the refactor",
    });
    expect(instructionsEnv(plan)).toEqual([
      path.join(sessionsDir, "42.opencode-tier0.md"),
      sessionBriefingPath(sessionsDir, "42"),
      path.join(sessionsDir, "42.opencode-seed.md"),
    ]);
  });
});

describe("openCodeAdapter.prepareLaunch — workflow-conventions injection (issue #937)", () => {
  // Same "real temp dir, real per-session file, existsSync-gated" posture
  // as the agent-guide/briefing injection describe blocks above.
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
    sessionsDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-workflow-conventions-"));
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

  // Unlike injectAgentGuide/injectProjectBriefing above, there is no
  // ctx.injectWorkflowConventions boolean at all — see opencode.ts's own
  // comment on that block for why file presence alone already encodes both
  // gates session-lifecycle.ts resolved on the primary.
  it("hands this session's own workflow-conventions file to the plugin when the per-session copy exists", () => {
    writeFileSync(
      sessionWorkflowConventionsPath(sessionsDir, "42"),
      "always branch, never commit to main",
    );
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx });
    expect(instructionsEnv(plan)).toEqual([sessionWorkflowConventionsPath(sessionsDir, "42")]);
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
  });

  it("omits workflow conventions from the instruction files when the per-session copy doesn't exist (opted out, or no global text configured)", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx });
    expect(instructionsEnv(plan)).toBeUndefined();
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
  });

  it("exact instructions order is [guide tier-0, workflow-conventions, briefing, seed] when all four are present", () => {
    writeFileSync(
      sessionWorkflowConventionsPath(sessionsDir, "42"),
      "workflow conventions content",
    );
    writeFileSync(sessionBriefingPath(sessionsDir, "42"), "briefing content");
    const plan = openCodeAdapter.prepareLaunch({
      ...baseCtx,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      seedPrompt: "resume the refactor",
    });
    expect(instructionsEnv(plan)).toEqual([
      path.join(sessionsDir, "42.opencode-tier0.md"),
      sessionWorkflowConventionsPath(sessionsDir, "42"),
      sessionBriefingPath(sessionsDir, "42"),
      path.join(sessionsDir, "42.opencode-seed.md"),
    ]);
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

  it("writes the seed to a per-session file and hands it to the plugin, independently of injectAgentGuide", () => {
    const plan = openCodeAdapter.prepareLaunch({
      ...baseCtx,
      injectAgentGuide: false,
      seedPrompt: "resume the refactor",
    });
    const seedFile = plan.settingsFiles?.find((f) => f.path === seedPath());
    expect(seedFile?.contents).toBe("resume the refactor");
    expect(instructionsEnv(plan)).toEqual([seedPath()]);
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
  });

  it("still writes the plugin file alongside the seed file", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, seedPrompt: "resume here" });
    expect(plan.settingsFiles).toHaveLength(2);
    expect(plan.settingsFiles?.map((f) => f.path)).toContain(
      path.join(sessionsDir, "42.opencode-config", "plugin", "server.js"),
    );
  });

  it("concatenates the seed path with the agent-guide tier-0 path when both are gated on", () => {
    const plan = openCodeAdapter.prepareLaunch({
      ...baseCtx,
      injectAgentGuide: true,
      seedPrompt: "resume the refactor",
    });
    expect(instructionsEnv(plan)).toEqual([
      path.join(sessionsDir, "42.opencode-tier0.md"),
      seedPath(),
    ]);
  });

  it("omits the seed from instructions when seedPrompt is an empty string (mcp entry unaffected, issue #881)", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, seedPrompt: "" });
    expect(plan.settingsFiles).toHaveLength(1);
    expect(instructionsEnv(plan)).toBeUndefined();
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
  });

  it("omits the seed from instructions when seedPrompt is absent (existing agent-guide-only behavior unaffected)", () => {
    const plan = openCodeAdapter.prepareLaunch(baseCtx);
    expect(plan.settingsFiles).toHaveLength(1);
    expect(instructionsEnv(plan)).toBeUndefined();
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
  });
});

describe("OPENCODE_EMITS (issue #321)", () => {
  it("includes compact for session.compaction.* events", () => {
    expect(openCodeAdapter.emits).toContain("compact");
  });

  it("includes subagent for child-session lifecycle events", () => {
    expect(openCodeAdapter.emits).toContain("subagent");
  });

  // opencode v2 has no server-side source for these three 1.x events (no
  // todo tool, no session.diff, no toast / worktree.failed /
  // mcp.browser.open.failed publisher), so advertising them would promise
  // statuses the plugin can never produce.
  it.each(["todo", "session_diff", "notification"])("no longer advertises %s", (kind) => {
    expect(OPENCODE_EMITS).not.toContain(kind);
  });
});

// Task Master — when ctx.taskId is set (only for worker / review / retry /
// re-seed sessions, see task-claim.ts and task-reconciler.ts's spawn sites),
// prepareLaunch must add `permission.skill.<name>: "deny"` entries to
// OPENCODE_CONFIG_CONTENT for the three superpowers skills that gate on a
// human in the loop. Verified failing in branchdam-mobile tasks #66 / #67,
// where the opencode worker invoked `brainstorming`, asked a clarifying
// question the unattended session couldn't answer, then ended its turn with
// no commits (the #722 "no commits ahead of base" gate correctly failed
// the task).
describe("openCodeAdapter.prepareLaunch — Task Master skill denials", () => {
  const baseCtx = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    injectAgentGuide: false,
    injectProjectBriefing: false,
  };

  it("denies brainstorming / writing-plans / finishing-a-development-branch when ctx.taskId is set", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, taskId: 348423 });
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
      ...expectedBase(baseCtx),
      permission: {
        skill: {
          brainstorming: "deny",
          "writing-plans": "deny",
          "finishing-a-development-branch": "deny",
        },
      },
    });
  });

  it("omits the permission block entirely when ctx.taskId is not set (a non-Task-Master session of the same agent is unaffected)", () => {
    const plan = openCodeAdapter.prepareLaunch(baseCtx);
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual(expectedBase(baseCtx));
  });

  it("treats ctx.taskId of 0 the same as any other defined value (the gate is `!== undefined`, not truthy, so a 0 task id is still a real Task Master session)", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, taskId: 0 });
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
      ...expectedBase(baseCtx),
      permission: {
        skill: {
          brainstorming: "deny",
          "writing-plans": "deny",
          "finishing-a-development-branch": "deny",
        },
      },
    });
  });

  it("composes the permission block alongside other OPENCODE_CONFIG_CONTENT keys (agent-guide / skills / plugins / mcp) — none of the other gates interact with the deny list", () => {
    // A real temp dir for the tier-0 file this adapter writes, same
    // posture as the agent-guide tier-0 describe block above.
    const realSessionsDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-taskid-"));
    try {
      const plan = openCodeAdapter.prepareLaunch({
        ...baseCtx,
        sessionsDir: realSessionsDir,
        hookSocketPath: path.join(realSessionsDir, "hooks.sock"),
        controlSocketPath: path.join(realSessionsDir, "mullion.sock"),
        injectAgentGuide: true,
        taskId: 348423,
      });
      expect(instructionsEnv(plan)).toEqual([path.join(realSessionsDir, "42.opencode-tier0.md")]);
      expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
        ...expectedBase({
          sessionsDir: realSessionsDir,
          hookSocketPath: path.join(realSessionsDir, "hooks.sock"),
          hookToken: baseCtx.hookToken,
          controlSocketPath: path.join(realSessionsDir, "mullion.sock"),
        }),
        permission: {
          skill: {
            brainstorming: "deny",
            "writing-plans": "deny",
            "finishing-a-development-branch": "deny",
          },
        },
      });
    } finally {
      rmSync(realSessionsDir, { recursive: true, force: true });
    }
  });

  // Hermes review, PR #966 — regression guard for the opencode
  // `OPENCODE_CONFIG_CONTENT.permission` deep-merge posture
  // (verified empirically in issue #968 against opencode v1.18.26).
  //
  // The contract this test pins down: the adapter sets
  // `permission.skill.<name>: "deny"` and NOTHING ELSE under the
  // top-level `permission` key. The deep-merge property (verified
  // above: a user's `permission.bash: "ask"` and
  // `permission.skill.user-only-skill: "ask"` survive an
  // unattended-worker spawn intact) depends on the adapter not
  // asserting any other permission keys — adding `bash: "..."` or
  // `edit: "..."` here would still deep-merge correctly today, but
  // would silently lock those keys to whatever the adapter chose,
  // and any future opencode release that flips to shallow-replacement
  // semantics would then CLOBBER the user's matching keys.
  //
  // Keep this block a one-key `permission: { skill: {...} }` shape
  // unless a follow-up issue justifies widening it (with its own
  // live-spike verification).
  it('sets ONLY `permission.skill.<name>: "deny"` under the permission block — no other permission keys, to preserve the deep-merge posture empirically verified in issue #968', () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, taskId: 348423 });
    const config = JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT);
    expect(Object.keys(config.permission)).toEqual(["skill"]);
    expect(Object.keys(config.permission.skill).sort()).toEqual(
      ["brainstorming", "finishing-a-development-branch", "writing-plans"].sort(),
    );
    for (const value of Object.values(config.permission.skill)) {
      expect(value).toBe("deny");
    }
  });
});
