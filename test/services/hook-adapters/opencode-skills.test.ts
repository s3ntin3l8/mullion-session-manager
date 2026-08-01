import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readOpenCodeSkillEnabledMap,
  writeOpenCodeSkillEnabled,
  resolveOpenCodeConfigPath,
  resolveOpenCodeConfigHome,
  OpenCodeConfigParseError,
} from "../../../src/services/hook-adapters/opencode-skills.js";
import { InvalidSkillNameError } from "../../../src/services/hook-adapters/skill-name.js";

describe("opencode-skills.ts (issue #463)", () => {
  let homeDir: string;
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-home-"));
    process.env.HOME = homeDir;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
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

    // Hermes review, PR #469 — a blind delete on enable used to discard any
    // OTHER value the user had set for their own reasons, not just Mullion's
    // own "deny". Only "deny" (the one value this writer itself ever
    // produces) is safe to delete on enable.
    it("leaves a non-deny user-authored value untouched on enable", () => {
      writeConfig({ permission: { skill: { foo: "ask" } } });
      writeOpenCodeSkillEnabled("foo", true);
      const written = readConfig();
      expect(written.permission.skill.foo).toBe("ask");
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

    // Independent review, PR #469 — a config.json with a literal "__proto__"
    // JSON key is not itself an attack (JSON.parse makes it an ordinary own
    // property, never a real prototype link), but this locks in that a
    // read-modify-write cycle over such a file can't turn it into one:
    // Object.assign(Object.create(null), existingSkill) only ever copies it
    // as an own data property on a null-prototype target, and the later
    // object-spreads (`{...existingPermission, skill}`, `{...config,
    // permission}`) use CreateDataProperty semantics, never [[Set]].
    it("round-trips a pre-existing literal __proto__ JSON key without polluting Object.prototype", () => {
      // Written as raw JSON text, not a JS object literal — `{ __proto__:
      // "deny" }` in source is special-cased by the language itself (it sets
      // [[Prototype]], and is silently ignored for a non-object value like a
      // string, never becoming an own property), so it wouldn't actually
      // exercise this. JSON.parse has no such special case: "__proto__" in
      // JSON text becomes an ordinary own property (CreateDataProperty).
      mkdirSync(path.dirname(configPath()), { recursive: true });
      writeFileSync(configPath(), '{"permission":{"skill":{"__proto__":"deny","foo":"ask"}}}');
      writeOpenCodeSkillEnabled("bar", false);

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      const written = readConfig();
      expect(written.permission.skill.bar).toBe("deny");
      expect(written.permission.skill.foo).toBe("ask");
      expect(Object.prototype.hasOwnProperty.call(written.permission.skill, "__proto__")).toBe(
        true,
      );
    });
  });

  // Hermes review, PR #469 — opencode resolves its whole config tree
  // through XDG_CONFIG_HOME when set (verified directly against the real
  // binary — `opencode debug config` picks up a config placed under
  // $XDG_CONFIG_HOME/opencode, not ~/.config/opencode, once the env var is
  // set). A hardcoded ~/.config path silently wrote to — and read from — a
  // file opencode itself never touches on such a host.
  describe("resolveOpenCodeConfigHome (issue #463)", () => {
    it("resolves under ~/.config/opencode when XDG_CONFIG_HOME is unset", () => {
      expect(resolveOpenCodeConfigHome()).toBe(path.join(homeDir, ".config", "opencode"));
    });

    it("resolves under $XDG_CONFIG_HOME/opencode when set", () => {
      const xdgDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-xdg-"));
      try {
        process.env.XDG_CONFIG_HOME = xdgDir;
        expect(resolveOpenCodeConfigHome()).toBe(path.join(xdgDir, "opencode"));
      } finally {
        rmSync(xdgDir, { recursive: true, force: true });
      }
    });

    it("writes to and reads from the XDG_CONFIG_HOME path, not ~/.config, once set", () => {
      const xdgDir = mkdtempSync(path.join(os.tmpdir(), "mullion-opencode-xdg-"));
      try {
        process.env.XDG_CONFIG_HOME = xdgDir;
        writeOpenCodeSkillEnabled("foo", false);
        expect(readOpenCodeSkillEnabledMap().get("foo")).toBe(false);
        expect(existsSync(path.join(homeDir, ".config", "opencode", "opencode.json"))).toBe(false);
      } finally {
        rmSync(xdgDir, { recursive: true, force: true });
      }
    });
  });
});
