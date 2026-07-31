import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readOpenCodeSkillEnabledMap,
  writeOpenCodeSkillEnabled,
  resolveOpenCodeConfigPath,
  OpenCodeConfigParseError,
} from "../../../src/services/hook-adapters/opencode-skills.js";
import { InvalidSkillNameError } from "../../../src/services/hook-adapters/skill-name.js";

describe("opencode-skills.ts (issue #463)", () => {
  let homeDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-home-"));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(homeDir, { recursive: true, force: true });
  });

  function configPath() {
    return resolveOpenCodeConfigPath();
  }

  function writeConfig(obj: unknown) {
    mkdirSync(path.dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(obj, null, 2));
  }

  function readConfig() {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  }

  describe("readOpenCodeSkillEnabledMap", () => {
    it("returns an empty map when opencode.json doesn't exist", () => {
      expect(readOpenCodeSkillEnabledMap().size).toBe(0);
    });

    it("returns an empty map when permission.skill is absent", () => {
      writeConfig({ $schema: "https://opencode.ai/config.json" });
      expect(readOpenCodeSkillEnabledMap().size).toBe(0);
    });

    it("maps a 'deny' action to false and any other action to true", () => {
      writeConfig({ permission: { skill: { foo: "deny", bar: "ask", baz: "allow" } } });
      const map = readOpenCodeSkillEnabledMap();
      expect(map.get("foo")).toBe(false);
      expect(map.get("bar")).toBe(true);
      expect(map.get("baz")).toBe(true);
    });

    it("throws OpenCodeConfigParseError for invalid JSON", () => {
      mkdirSync(path.dirname(configPath()), { recursive: true });
      writeFileSync(configPath(), "{ not valid json");
      expect(() => readOpenCodeSkillEnabledMap()).toThrow(OpenCodeConfigParseError);
    });
  });

  describe("writeOpenCodeSkillEnabled", () => {
    it("creates opencode.json with permission.skill when none exists", () => {
      writeOpenCodeSkillEnabled("foo", false);
      const written = readConfig();
      expect(written.permission.skill.foo).toBe("deny");
    });

    it("preserves unrelated top-level keys and permission siblings", () => {
      writeConfig({
        $schema: "https://opencode.ai/config.json",
        plugin: ["superpowers@git+https://example.com/superpowers.git"],
        mcp: { github: { type: "remote", url: "https://example.com" } },
        permission: { edit: "deny" },
      });
      writeOpenCodeSkillEnabled("foo", false);
      const written = readConfig();
      expect(written.$schema).toBe("https://opencode.ai/config.json");
      expect(written.plugin).toEqual(["superpowers@git+https://example.com/superpowers.git"]);
      expect(written.mcp.github.url).toBe("https://example.com");
      expect(written.permission.edit).toBe("deny");
      expect(written.permission.skill.foo).toBe("deny");
    });

    it("deletes the key (reverts to default) rather than writing an explicit allow", () => {
      writeConfig({ permission: { skill: { foo: "deny" } } });
      writeOpenCodeSkillEnabled("foo", true);
      const written = readConfig();
      expect(written.permission.skill.foo).toBeUndefined();
      expect("foo" in written.permission.skill).toBe(false);
    });

    it("manages two different skills independently", () => {
      writeOpenCodeSkillEnabled("foo", false);
      writeOpenCodeSkillEnabled("bar", false);
      writeOpenCodeSkillEnabled("foo", true);
      const written = readConfig();
      expect("foo" in written.permission.skill).toBe(false);
      expect(written.permission.skill.bar).toBe("deny");
    });

    it("refuses to write when opencode.json doesn't parse", () => {
      mkdirSync(path.dirname(configPath()), { recursive: true });
      writeFileSync(configPath(), "{ not valid json");
      expect(() => writeOpenCodeSkillEnabled("foo", false)).toThrow(OpenCodeConfigParseError);
    });

    it("ends the file with a trailing newline", () => {
      writeOpenCodeSkillEnabled("foo", false);
      expect(readFileSync(configPath(), "utf8").endsWith("\n")).toBe(true);
    });

    // Independent review / CodeQL (js/remote-property-injection) — `name`
    // becomes an object property key (`skill[name] = "deny"` /
    // `delete skill[name]`); refuse the dangerous keys outright rather than
    // relying on `__proto__`'s accessor happening to no-op for a
    // non-object assignment.
    it("refuses __proto__/constructor/prototype as a skill name without writing anything", () => {
      for (const dangerous of ["__proto__", "constructor", "prototype"]) {
        expect(() => writeOpenCodeSkillEnabled(dangerous, false)).toThrow(InvalidSkillNameError);
      }
      expect(readOpenCodeSkillEnabledMap().size).toBe(0);
    });

    it("refuses a name containing a raw newline", () => {
      expect(() => writeOpenCodeSkillEnabled("foo\nbar", false)).toThrow(InvalidSkillNameError);
    });
  });
});
