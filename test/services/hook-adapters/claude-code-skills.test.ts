import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readClaudeCodeSkillEnabledMap,
  writeClaudeCodeSkillEnabled,
  ClaudeCodeSettingsParseError,
  ClaudeCodeSkillUserAuthoredError,
  ClaudeCodeSkillProjectOverrideError,
  ClaudeCodeSkillBasenameCollisionError,
  ClaudeCodeSkillPluginSourcedError,
} from "../../../src/services/hook-adapters/claude-code-skills.js";
import { InvalidSkillNameError } from "../../../src/services/hook-adapters/skill-name.js";

describe("claude-code-skills.ts (issue #467)", () => {
  let homeDir: string;
  let projectDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), "mullion-claude-home-"));
    projectDir = mkdtempSync(path.join(os.tmpdir(), "mullion-claude-project-"));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function userSettingsPath() {
    return path.join(homeDir, ".claude", "settings.json");
  }

  function projectSettingsPath() {
    return path.join(projectDir, ".claude", "settings.json");
  }

  function projectLocalSettingsPath() {
    return path.join(projectDir, ".claude", "settings.local.json");
  }

  function writeJson(filePath: string, obj: unknown) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(obj, null, 2));
  }

  function readUserSettings() {
    return JSON.parse(readFileSync(userSettingsPath(), "utf8"));
  }

  describe("readClaudeCodeSkillEnabledMap", () => {
    it("returns an empty map when settings.json doesn't exist anywhere", () => {
      expect(readClaudeCodeSkillEnabledMap(projectDir).size).toBe(0);
    });

    it("maps 'off' to false and 'on' to true from user settings", () => {
      writeJson(userSettingsPath(), { skillOverrides: { foo: "off", bar: "on" } });
      const map = readClaudeCodeSkillEnabledMap(projectDir);
      expect(map.get("foo")).toBe(false);
      expect(map.get("bar")).toBe(true);
    });

    it("maps 'name-only' and 'user-invocable-only' to null (not representable)", () => {
      writeJson(userSettingsPath(), {
        skillOverrides: { nameOnly: "name-only", invocableOnly: "user-invocable-only" },
      });
      const map = readClaudeCodeSkillEnabledMap(projectDir);
      expect(map.get("nameOnly")).toBeNull();
      expect(map.get("invocableOnly")).toBeNull();
    });

    it("project settings.json takes precedence over user settings", () => {
      writeJson(userSettingsPath(), { skillOverrides: { foo: "off" } });
      writeJson(projectSettingsPath(), { skillOverrides: { foo: "on" } });
      expect(readClaudeCodeSkillEnabledMap(projectDir).get("foo")).toBe(true);
    });

    it("project settings.local.json takes precedence over project settings.json", () => {
      writeJson(projectSettingsPath(), { skillOverrides: { foo: "off" } });
      writeJson(projectLocalSettingsPath(), { skillOverrides: { foo: "on" } });
      expect(readClaudeCodeSkillEnabledMap(projectDir).get("foo")).toBe(true);
    });

    it("ignores a non-object skillOverrides value", () => {
      writeJson(userSettingsPath(), { skillOverrides: ["off"] });
      expect(readClaudeCodeSkillEnabledMap(projectDir).size).toBe(0);
    });
  });

  describe("writeClaudeCodeSkillEnabled", () => {
    it("writes 'off' for a fresh basename", () => {
      writeClaudeCodeSkillEnabled(projectDir, "my-skill", false);
      expect(readUserSettings().skillOverrides["my-skill"]).toBe("off");
    });

    it("disable-then-enable round trip actually DELETES the key, not sets it to 'on'", () => {
      writeClaudeCodeSkillEnabled(projectDir, "my-skill", false);
      expect(readUserSettings().skillOverrides["my-skill"]).toBe("off");

      writeClaudeCodeSkillEnabled(projectDir, "my-skill", true);
      const settings = readUserSettings();
      expect(settings.skillOverrides).not.toHaveProperty("my-skill");
    });

    it("enable leaves an explicit 'on' value untouched", () => {
      writeJson(userSettingsPath(), { skillOverrides: { "my-skill": "on" } });
      writeClaudeCodeSkillEnabled(projectDir, "my-skill", true);
      expect(readUserSettings().skillOverrides["my-skill"]).toBe("on");
    });

    it("disable refuses over an existing 'name-only' value, leaving the file untouched", () => {
      writeJson(userSettingsPath(), { skillOverrides: { "my-skill": "name-only" } });
      const before = readFileSync(userSettingsPath(), "utf8");
      expect(() => writeClaudeCodeSkillEnabled(projectDir, "my-skill", false)).toThrow(
        ClaudeCodeSkillUserAuthoredError,
      );
      expect(readFileSync(userSettingsPath(), "utf8")).toBe(before);
    });

    it("disable refuses over an existing 'user-invocable-only' value, leaving the file untouched", () => {
      writeJson(userSettingsPath(), { skillOverrides: { "my-skill": "user-invocable-only" } });
      const before = readFileSync(userSettingsPath(), "utf8");
      expect(() => writeClaudeCodeSkillEnabled(projectDir, "my-skill", false)).toThrow(
        ClaudeCodeSkillUserAuthoredError,
      );
      expect(readFileSync(userSettingsPath(), "utf8")).toBe(before);
    });

    it("refuses when project settings.json already has an entry for this basename", () => {
      writeJson(projectSettingsPath(), { skillOverrides: { "my-skill": "off" } });
      expect(() => writeClaudeCodeSkillEnabled(projectDir, "my-skill", true)).toThrow(
        ClaudeCodeSkillProjectOverrideError,
      );
      // User-scope file must never have been created.
      expect(() => readUserSettings()).toThrow();
    });

    it("refuses when project settings.local.json already has an entry for this basename", () => {
      writeJson(projectLocalSettingsPath(), { skillOverrides: { "my-skill": "on" } });
      expect(() => writeClaudeCodeSkillEnabled(projectDir, "my-skill", false)).toThrow(
        ClaudeCodeSkillProjectOverrideError,
      );
      expect(() => readUserSettings()).toThrow();
    });

    it("preserves unrelated top-level keys and unrelated skillOverrides entries", () => {
      writeJson(userSettingsPath(), {
        permissions: { allow: ["Bash(git *)"] },
        statusLine: { type: "command" },
        skillOverrides: { "other-skill": "off" },
      });
      writeClaudeCodeSkillEnabled(projectDir, "my-skill", false);
      const settings = readUserSettings();
      expect(settings.permissions).toEqual({ allow: ["Bash(git *)"] });
      expect(settings.statusLine).toEqual({ type: "command" });
      expect(settings.skillOverrides["other-skill"]).toBe("off");
      expect(settings.skillOverrides["my-skill"]).toBe("off");
    });

    it("throws ClaudeCodeSettingsParseError on unparseable JSON, leaving the file untouched", () => {
      mkdirSync(path.dirname(userSettingsPath()), { recursive: true });
      writeFileSync(userSettingsPath(), "{ not valid json");
      expect(() => writeClaudeCodeSkillEnabled(projectDir, "my-skill", false)).toThrow(
        ClaudeCodeSettingsParseError,
      );
      expect(readFileSync(userSettingsPath(), "utf8")).toBe("{ not valid json");
    });

    it("rejects a dangerous basename before touching any file", () => {
      expect(() => writeClaudeCodeSkillEnabled(projectDir, "__proto__", false)).toThrow(
        InvalidSkillNameError,
      );
      expect(() => readUserSettings()).toThrow();
    });
  });

  // ClaudeCodeSkillBasenameCollisionError / ClaudeCodeSkillPluginSourcedError
  // are thrown from skills.ts's resolveSkillForToggle (computed across the
  // full discovery result, not from this module in isolation) — covered in
  // test/services/skills.test.ts. Referenced here only so an unused-import
  // lint rule can't silently drop the assertion that they're part of this
  // module's public error surface.
  it("exports the discovery-level error classes for skills.ts to throw", () => {
    expect(ClaudeCodeSkillBasenameCollisionError).toBeDefined();
    expect(ClaudeCodeSkillPluginSourcedError).toBeDefined();
  });
});
