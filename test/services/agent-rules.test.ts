import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listAgentRules,
  getAgentRule,
  writeAgentRule,
  deleteAgentRule,
  resolveTarget,
  listTargetDefs,
  AgentRuleTooLargeError,
  MAX_RULE_FILE_BYTES,
} from "../../src/services/agent-rules.js";

// Every global-scope target resolves off os.homedir() (and CODEX_HOME for
// codex) — this MUST be redirected to a scratch dir for every test in this
// file, never the real developer/CI-runner's own ~/.claude, ~/.codex,
// ~/.config/opencode, or ~/.gemini. os.homedir() reads process.env.HOME
// live on every call (verified empirically, not assumed), so overriding it
// per-test is sufficient — no need to also stub os.homedir() itself.
describe("agent-rules service", () => {
  let fakeHome: string;
  let projectCwd: string;
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "mullion-agent-rules-home-"));
    projectCwd = mkdtempSync(path.join(os.tmpdir(), "mullion-agent-rules-project-"));
    process.env.HOME = fakeHome;
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  describe("resolveTarget / listTargetDefs", () => {
    it("resolves every allow-listed id", () => {
      for (const def of listTargetDefs()) {
        expect(resolveTarget(def.id)).toEqual(def);
      }
    });

    it("returns null for an id outside the allow-list — the only path a caller-supplied id can take", () => {
      expect(resolveTarget("../../etc/passwd")).toBeNull();
      expect(resolveTarget("claude-code:nonsense")).toBeNull();
      expect(resolveTarget("")).toBeNull();
    });

    it("covers all four agents from the plan's table", () => {
      const agents = new Set(listTargetDefs().map((t) => t.agent));
      expect(agents).toEqual(new Set(["claude-code", "codex", "opencode", "agy"]));
    });
  });

  describe("listAgentRules", () => {
    it("reports every target as non-existent for a project/home with no rule files at all", async () => {
      const targets = await listAgentRules(projectCwd);
      expect(targets.length).toBe(listTargetDefs().length);
      for (const t of targets) {
        expect(t.exists).toBe(false);
        expect(t.content).toBeNull();
        expect(t.status).toBeNull();
      }
    });

    it("inlines content for an existing project-scope file", async () => {
      writeFileSync(path.join(projectCwd, "CLAUDE.md"), "# hello");
      const targets = await listAgentRules(projectCwd);
      const claude = targets.find((t) => t.id === "claude-code:project")!;
      expect(claude.exists).toBe(true);
      expect(claude.content).toBe("# hello");
      expect(claude.status).toBe("active");
    });

    it("reads a global-scope file from the redirected fake HOME", async () => {
      mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
      writeFileSync(path.join(fakeHome, ".claude", "CLAUDE.md"), "global guidance");
      const targets = await listAgentRules(projectCwd);
      const globalClaude = targets.find((t) => t.id === "claude-code:global")!;
      expect(globalClaude.exists).toBe(true);
      expect(globalClaude.content).toBe("global guidance");
      expect(globalClaude.absolutePath).toBe(path.join(fakeHome, ".claude", "CLAUDE.md"));
    });

    it("marks AGENTS.md shadowed when AGENTS.override.md also exists, for Codex only", async () => {
      writeFileSync(path.join(projectCwd, "AGENTS.md"), "base rules");
      writeFileSync(path.join(projectCwd, "AGENTS.override.md"), "override rules");

      const targets = await listAgentRules(projectCwd);
      const codexAgents = targets.find((t) => t.id === "codex:project")!;
      const codexOverride = targets.find((t) => t.id === "codex:project:override")!;
      const opencodeAgents = targets.find((t) => t.id === "opencode:project")!;

      expect(codexAgents.status).toBe("shadowed");
      expect(codexOverride.status).toBe("active");
      // opencode has no override concept — the same underlying AGENTS.md
      // file is "active" from opencode's perspective regardless of Codex's
      // override existing, per agent-rules.ts's own doc comment on this.
      expect(opencodeAgents.status).toBe("active");
      expect(opencodeAgents.absolutePath).toBe(codexAgents.absolutePath);
    });

    it("reports AGENTS.md as active when no override file exists", async () => {
      writeFileSync(path.join(projectCwd, "AGENTS.md"), "base rules");
      const targets = await listAgentRules(projectCwd);
      expect(targets.find((t) => t.id === "codex:project")!.status).toBe("active");
    });

    it("resolves Codex's global scope from CODEX_HOME when set, not ~/.codex", async () => {
      const customCodexHome = mkdtempSync(path.join(os.tmpdir(), "mullion-codex-home-"));
      process.env.CODEX_HOME = customCodexHome;
      writeFileSync(path.join(customCodexHome, "AGENTS.md"), "custom codex home rules");

      const targets = await listAgentRules(projectCwd);
      const globalCodex = targets.find((t) => t.id === "codex:global")!;
      expect(globalCodex.exists).toBe(true);
      expect(globalCodex.absolutePath).toBe(path.join(customCodexHome, "AGENTS.md"));

      rmSync(customCodexHome, { recursive: true, force: true });
    });

    it("withholds content but still reports exists/size for a file over MAX_RULE_FILE_BYTES", async () => {
      writeFileSync(path.join(projectCwd, "CLAUDE.md"), "x".repeat(MAX_RULE_FILE_BYTES + 1));
      const targets = await listAgentRules(projectCwd);
      const claude = targets.find((t) => t.id === "claude-code:project")!;
      expect(claude.exists).toBe(true);
      expect(claude.content).toBeNull();
      expect(claude.truncated).toBe(true);
      expect(claude.size).toBe(MAX_RULE_FILE_BYTES + 1);
    });
  });

  describe("getAgentRule", () => {
    it("returns a single target's info without needing the full list", async () => {
      writeFileSync(path.join(projectCwd, "GEMINI.md"), "agy rules");
      const target = resolveTarget("agy:project")!;
      const result = await getAgentRule(target, projectCwd);
      expect(result.exists).toBe(true);
      expect(result.content).toBe("agy rules");
    });

    it("ignores the projectCwd argument for a global-scope target", async () => {
      mkdirSync(path.join(fakeHome, ".gemini"), { recursive: true });
      writeFileSync(path.join(fakeHome, ".gemini", "GEMINI.md"), "global agy rules");
      const target = resolveTarget("agy:global")!;
      const result = await getAgentRule(target, "/some/unrelated/path/that/does/not/exist");
      expect(result.exists).toBe(true);
      expect(result.content).toBe("global agy rules");
    });
  });

  describe("writeAgentRule / deleteAgentRule", () => {
    it("writes a new project-scope file, creating no unexpected directories", async () => {
      const target = resolveTarget("claude-code:project")!;
      writeAgentRule(target, projectCwd, "new content");
      const result = await getAgentRule(target, projectCwd);
      expect(result.content).toBe("new content");
    });

    it("creates missing parent directories for a global-scope target", async () => {
      const target = resolveTarget("opencode:global")!;
      writeAgentRule(target, projectCwd, "opencode global rules");
      const result = await getAgentRule(target, projectCwd);
      expect(result.exists).toBe(true);
      expect(result.absolutePath).toBe(path.join(fakeHome, ".config", "opencode", "AGENTS.md"));
    });

    it("overwrites existing content", async () => {
      const target = resolveTarget("agy:project")!;
      writeAgentRule(target, projectCwd, "first");
      writeAgentRule(target, projectCwd, "second");
      const result = await getAgentRule(target, projectCwd);
      expect(result.content).toBe("second");
    });

    it("throws AgentRuleTooLargeError rather than writing an oversized file", async () => {
      const target = resolveTarget("claude-code:project")!;
      const oversized = "x".repeat(MAX_RULE_FILE_BYTES + 1);
      expect(() => writeAgentRule(target, projectCwd, oversized)).toThrow(AgentRuleTooLargeError);
      const result = await getAgentRule(target, projectCwd);
      expect(result.exists).toBe(false);
    });

    it("deletes an existing file", async () => {
      const target = resolveTarget("claude-code:project")!;
      writeAgentRule(target, projectCwd, "content");
      deleteAgentRule(target, projectCwd);
      const result = await getAgentRule(target, projectCwd);
      expect(result.exists).toBe(false);
    });

    it("is a no-op, not an error, deleting a file that was never there", async () => {
      const target = resolveTarget("claude-code:project")!;
      expect(() => deleteAgentRule(target, projectCwd)).not.toThrow();
    });
  });
});
