import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readCodexSkillEnabledMap,
  writeCodexSkillEnabled,
  CodexSkillsConfigParseError,
  CodexSkillUserAuthoredError,
} from "../../../src/services/hook-adapters/codex-skills.js";

describe("codex-skills.ts (issue #463)", () => {
  let codexHome: string;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    codexHome = mkdtempSync(path.join(os.tmpdir(), "mullion-codex-skills-"));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  function configPath() {
    return path.join(codexHome, "config.toml");
  }

  function readConfig() {
    return readFileSync(configPath(), "utf8");
  }

  describe("readCodexSkillEnabledMap", () => {
    it("returns an empty map when config.toml doesn't exist", () => {
      expect(readCodexSkillEnabledMap().size).toBe(0);
    });

    it("reads name -> enabled for name-keyed entries", () => {
      writeFileSync(
        configPath(),
        '[[skills.config]]\nname = "foo"\nenabled = false\n\n' +
          '[[skills.config]]\nname = "bar"\nenabled = true\n',
      );
      const map = readCodexSkillEnabledMap();
      expect(map.get("foo")).toBe(false);
      expect(map.get("bar")).toBe(true);
    });

    it("ignores path-keyed entries — verified empirically that path has no effect on visibility", () => {
      writeFileSync(configPath(), `[[skills.config]]\npath = "/some/dir"\nenabled = false\n`);
      expect(readCodexSkillEnabledMap().size).toBe(0);
    });

    it("last entry wins for a repeated name — verified empirically against codex-cli", () => {
      writeFileSync(
        configPath(),
        '[[skills.config]]\nname = "foo"\nenabled = true\n\n' +
          '[[skills.config]]\nname = "foo"\nenabled = false\n',
      );
      expect(readCodexSkillEnabledMap().get("foo")).toBe(false);
    });

    it("throws CodexSkillsConfigParseError for an unparseable file", () => {
      writeFileSync(configPath(), "this is not valid toml [[[");
      expect(() => readCodexSkillEnabledMap()).toThrow(CodexSkillsConfigParseError);
    });
  });

  describe("writeCodexSkillEnabled", () => {
    it("appends a new Mullion-marked block when config.toml doesn't exist", () => {
      writeCodexSkillEnabled("foo", false);
      const text = readConfig();
      expect(text).toContain("# mullion-managed");
      expect(text).toContain("[[skills.config]]");
      expect(text).toContain('name = "foo"');
      expect(text).toContain("enabled = false");
      expect(readCodexSkillEnabledMap().get("foo")).toBe(false);
    });

    it("appends a new block after existing content, preserving it", () => {
      writeFileSync(configPath(), 'model = "o3"\n');
      writeCodexSkillEnabled("foo", true);
      const text = readConfig();
      expect(text).toContain('model = "o3"');
      expect(readCodexSkillEnabledMap().get("foo")).toBe(true);
    });

    it("flips enabled in place on a second write, not appending a duplicate block", () => {
      writeCodexSkillEnabled("foo", false);
      writeCodexSkillEnabled("foo", true);
      const text = readConfig();
      expect(text.match(/# mullion-managed/g)).toHaveLength(1);
      expect(text.match(/\[\[skills\.config\]\]/g)).toHaveLength(1);
      expect(readCodexSkillEnabledMap().get("foo")).toBe(true);
    });

    it("manages two different names as two independent marked blocks", () => {
      writeCodexSkillEnabled("foo", false);
      writeCodexSkillEnabled("bar", true);
      writeCodexSkillEnabled("foo", true);
      const map = readCodexSkillEnabledMap();
      expect(map.get("foo")).toBe(true);
      expect(map.get("bar")).toBe(true);
      expect(readConfig().match(/# mullion-managed/g)).toHaveLength(2);
    });

    it("refuses a name that already has a user-authored (unmarked) entry", () => {
      writeFileSync(configPath(), '[[skills.config]]\nname = "foo"\nenabled = true\n');
      expect(() => writeCodexSkillEnabled("foo", false)).toThrow(CodexSkillUserAuthoredError);
      // Left untouched.
      expect(readConfig()).toBe('[[skills.config]]\nname = "foo"\nenabled = true\n');
    });

    it("refuses to write when config.toml doesn't parse", () => {
      writeFileSync(configPath(), "this is not valid toml [[[");
      expect(() => writeCodexSkillEnabled("foo", false)).toThrow(CodexSkillsConfigParseError);
    });

    it("escapes a name containing a double quote", () => {
      writeCodexSkillEnabled('weird"name', false);
      expect(readCodexSkillEnabledMap().get('weird"name')).toBe(false);
    });
  });
});
