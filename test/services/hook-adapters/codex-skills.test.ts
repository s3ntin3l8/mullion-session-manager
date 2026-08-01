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
import { InvalidSkillNameError } from "../../../src/services/hook-adapters/skill-name.js";

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

    // Hermes review, PR #469 — a user adding an inline comment to a
    // Mullion-managed line is an ordinary edit to a file they're allowed to
    // hand-edit. Before this fix, findMarkedBlock's line regexes required
    // nothing but trailing whitespace, so a comment made the block
    // unrecognizable as Mullion's own even though smol-toml still parsed
    // the entry — the write then wrongly threw CodexSkillUserAuthoredError
    // against a block Mullion itself wrote.
    it("still recognizes its own marked block when the user adds an inline comment", () => {
      writeCodexSkillEnabled("foo", false);
      const withComment = readConfig().replace('name = "foo"', 'name = "foo"  # why is this here?');
      writeFileSync(configPath(), withComment);

      writeCodexSkillEnabled("foo", true);

      expect(readCodexSkillEnabledMap().get("foo")).toBe(true);
      expect(readConfig()).toContain("# why is this here?");
      expect(readConfig().match(/# mullion-managed/g)).toHaveLength(1);
    });

    it("preserves a comment on the enabled line itself when flipping", () => {
      writeCodexSkillEnabled("foo", false);
      const withComment = readConfig().replace(
        "enabled = false",
        "enabled = false  # was disabled for testing",
      );
      writeFileSync(configPath(), withComment);

      writeCodexSkillEnabled("foo", true);

      const text = readConfig();
      expect(text).toContain("enabled = true  # was disabled for testing");
      expect(readCodexSkillEnabledMap().get("foo")).toBe(true);
    });

    it("refuses a name that already has a user-authored (unmarked) entry", () => {
      writeFileSync(configPath(), '[[skills.config]]\nname = "foo"\nenabled = true\n');
      expect(() => writeCodexSkillEnabled("foo", false)).toThrow(CodexSkillUserAuthoredError);
      // Left untouched.
      expect(readConfig()).toBe('[[skills.config]]\nname = "foo"\nenabled = true\n');
    });

    // Hermes review, PR #469 — a later, non-Mullion duplicate entry for the
    // same name wins under Codex's last-wins semantics. Flipping the earlier
    // Mullion block in place would silently have no effect on what Codex
    // actually observes, so this must refuse rather than flip.
    it("refuses to flip a marked block when a later user-authored duplicate would win instead", () => {
      writeCodexSkillEnabled("foo", false);
      const withUserDuplicate =
        readConfig() + '\n[[skills.config]]\nname = "foo"\nenabled = true\n';
      writeFileSync(configPath(), withUserDuplicate);

      expect(() => writeCodexSkillEnabled("foo", true)).toThrow(CodexSkillUserAuthoredError);
      // Left untouched — neither block was rewritten.
      expect(readConfig()).toBe(withUserDuplicate);
    });

    it("refuses to write when config.toml doesn't parse", () => {
      writeFileSync(configPath(), "this is not valid toml [[[");
      expect(() => writeCodexSkillEnabled("foo", false)).toThrow(CodexSkillsConfigParseError);
    });

    it("escapes a name containing a double quote", () => {
      writeCodexSkillEnabled('weird"name', false);
      expect(readCodexSkillEnabledMap().get('weird"name')).toBe(false);
    });

    // Independent review / CodeQL — refuses before ever touching the
    // filesystem, so a dangerous name can't corrupt config.toml even if the
    // resolveSkillForToggle guard upstream were ever bypassed.
    it("refuses a dangerous property name (__proto__) without writing anything", () => {
      expect(() => writeCodexSkillEnabled("__proto__", false)).toThrow(InvalidSkillNameError);
      expect(readCodexSkillEnabledMap().size).toBe(0);
    });

    it("refuses a name containing a raw newline", () => {
      expect(() => writeCodexSkillEnabled("foo\nbar", false)).toThrow(InvalidSkillNameError);
    });
  });
});
