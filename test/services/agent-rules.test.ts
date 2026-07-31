import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listAgentRules,
  getAgentRule,
  writeAgentRule,
  deleteAgentRule,
  resolveTarget,
  listTargetDefs,
  listExistingProjectRuleFileNames,
  AgentRuleTooLargeError,
  AgentRuleSymlinkError,
  AgentRulesTimeoutError,
  MAX_RULE_FILE_BYTES,
  __testing,
} from "../../src/services/agent-rules.js";

const { withReadDeadline, FS_READ_DEADLINE_MS } = __testing;

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

    // Issue #431, Hermes review on PR #458 — opencode's own docs: "if you
    // have both AGENTS.md and CLAUDE.md, only AGENTS.md is used." This is a
    // within-agent precedence distinct from the cross-agent AGENTS.md
    // sharing the test above covers (opencode vs Codex both reading the
    // SAME AGENTS.md independently).
    it("marks opencode's project CLAUDE.md shadowed when its own AGENTS.md also exists", async () => {
      writeFileSync(path.join(projectCwd, "AGENTS.md"), "agents rules");
      writeFileSync(path.join(projectCwd, "CLAUDE.md"), "claude rules");

      const targets = await listAgentRules(projectCwd);
      const opencodeAgents = targets.find((t) => t.id === "opencode:project")!;
      const opencodeClaude = targets.find((t) => t.id === "opencode:project:claude")!;

      expect(opencodeAgents.status).toBe("active");
      expect(opencodeClaude.status).toBe("shadowed");
    });

    it("reports opencode's project CLAUDE.md active when no AGENTS.md exists", async () => {
      writeFileSync(path.join(projectCwd, "CLAUDE.md"), "claude rules");
      const targets = await listAgentRules(projectCwd);
      expect(targets.find((t) => t.id === "opencode:project:claude")!.status).toBe("active");
    });

    it("marks opencode's global CLAUDE.md shadowed when its own global AGENTS.md also exists", async () => {
      mkdirSync(path.join(fakeHome, ".config", "opencode"), { recursive: true });
      writeFileSync(path.join(fakeHome, ".config", "opencode", "AGENTS.md"), "agents rules");
      mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
      writeFileSync(path.join(fakeHome, ".claude", "CLAUDE.md"), "claude rules");

      const targets = await listAgentRules(projectCwd);
      expect(targets.find((t) => t.id === "opencode:global")!.status).toBe("active");
      expect(targets.find((t) => t.id === "opencode:global:claude")!.status).toBe("shadowed");
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

    // Issue #431, Hermes review on PR #458 — stat() follows a symlink to
    // report the real target's size/mtime/content, but the write path
    // refuses to save through one; isSymlink is how the read side flags
    // that mismatch so the UI doesn't offer a doomed edit.
    it("flags a symlinked rule file with isSymlink, while still inlining its content", async () => {
      const realFile = path.join(fakeHome, "real-secret.txt");
      writeFileSync(realFile, "the real content");
      symlinkSync(realFile, path.join(projectCwd, "CLAUDE.md"));

      const targets = await listAgentRules(projectCwd);
      const claude = targets.find((t) => t.id === "claude-code:project")!;
      expect(claude.isSymlink).toBe(true);
      expect(claude.exists).toBe(true);
      expect(claude.content).toBe("the real content");
    });

    it("reports isSymlink false for a regular file", async () => {
      writeFileSync(path.join(projectCwd, "CLAUDE.md"), "regular file");
      const targets = await listAgentRules(projectCwd);
      const claude = targets.find((t) => t.id === "claude-code:project")!;
      expect(claude.isSymlink).toBe(false);
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

    // Issue #431, Hermes review on PR #458 — writeFileSync's default flags
    // follow a symlink at the destination and overwrite whatever it points
    // to. A cloned repo could ship a rule file that's actually a symlink
    // pointing outside the repo; refuse rather than silently write through
    // it.
    it("refuses to write through a symlinked rule file, leaving the real target untouched", async () => {
      const target = resolveTarget("claude-code:project")!;
      const realFile = path.join(fakeHome, "real-secret.txt");
      writeFileSync(realFile, "original contents");
      symlinkSync(realFile, path.join(projectCwd, "CLAUDE.md"));

      expect(() => writeAgentRule(target, projectCwd, "attempted overwrite")).toThrow(
        AgentRuleSymlinkError,
      );
      expect(readFileSync(realFile, "utf8")).toBe("original contents");
    });
  });

  describe("listExistingProjectRuleFileNames", () => {
    // The runtime array is a hand-written literal (issue #431, PR #458 —
    // CodeQL flagged the version derived from listTargetDefs()/
    // resolveTarget() as tainted, even for these compile-time-only calls;
    // see the source's own comment on PROJECT_SCOPE_FILE_NAMES). This test
    // is what actually keeps it in sync with the allow-list, since nothing
    // at runtime derives one from the other anymore.
    it("covers exactly the distinct project-scope filenames resolveTarget's own allow-list carries", () => {
      const derived = new Set(
        listTargetDefs()
          .filter((t) => t.scope === "project")
          .map((t) => t.fileName),
      );
      writeFileSync(path.join(projectCwd, "CLAUDE.md"), "x");
      writeFileSync(path.join(projectCwd, "AGENTS.md"), "x");
      writeFileSync(path.join(projectCwd, "AGENTS.override.md"), "x");
      writeFileSync(path.join(projectCwd, "GEMINI.md"), "x");
      const found = new Set(listExistingProjectRuleFileNames(projectCwd));
      expect(found).toEqual(derived);
    });
  });

  // Issue #431, Hermes review on PR #458 — the original withReadDeadline
  // wrapped a SYNCHRONOUS fs call in a setTimeout race, which can never
  // work: a hung sync call blocks the event loop the timer itself needs to
  // fire on. Verified empirically before fixing (a 2s sync busy-wait
  // resolved intact instead of rejecting at a 500ms deadline). These tests
  // prove the fixed, Promise-based version actually races correctly —
  // using fake timers + a deliberately-never-resolving promise (the async
  // analog of a hung FUSE/WSL/network mount) rather than a real multi-
  // second wall-clock wait or an actual stuck filesystem.
  describe("withReadDeadline (issue #431, Hermes review on PR #458)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects with AgentRulesTimeoutError once the deadline elapses, for an operation that never resolves", async () => {
      vi.useFakeTimers();
      const neverResolves = new Promise<string>(() => {});
      const assertion = expect(withReadDeadline(neverResolves, "/some/path")).rejects.toThrow(
        AgentRulesTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(FS_READ_DEADLINE_MS);
      await assertion;
    });

    it("resolves with the real value when the operation finishes before the deadline", async () => {
      await expect(withReadDeadline(Promise.resolve("real content"), "/some/path")).resolves.toBe(
        "real content",
      );
    });

    it("propagates the operation's own rejection (e.g. a permission error) when it fails before the deadline", async () => {
      const permissionError = new Error("EACCES");
      await expect(withReadDeadline(Promise.reject(permissionError), "/some/path")).rejects.toBe(
        permissionError,
      );
    });

    // Hermes review, PR #458 — the deadline timer used to never be
    // cleared: when `op` won the race it still fired FS_READ_DEADLINE_MS
    // later (rejecting an already-settled promise is a silent no-op), just
    // holding the event loop open for up to 2s past every successful read.
    it("clears its deadline timer once the operation resolves, leaving no pending timer behind", async () => {
      vi.useFakeTimers();
      await withReadDeadline(Promise.resolve("done"), "/some/path");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
