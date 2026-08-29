import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFrontmatter } from "../../../src/services/skills.js";

// Guards the shipped bundle's own shape (src/bundle/) — a bundle edit that
// silently broke SKILL.md frontmatter or the plugin manifest would
// otherwise only surface live, against a real Claude Code session (see
// mullion-bundle.ts's own header for why this bundle exists and how it's
// delivered).
const bundleDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "src",
  "bundle",
);

describe("src/bundle — the shipped Mullion tooling bundle", () => {
  it("has a valid .claude-plugin/plugin.json with a name", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(bundleDir, ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
  });

  it("every skills/*/SKILL.md parses under skills.ts's own parseSkillFrontmatter", () => {
    const skillsDir = path.join(bundleDir, "skills");
    const skillNames = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(skillNames.length).toBeGreaterThan(0);

    for (const skillName of skillNames) {
      const raw = readFileSync(path.join(skillsDir, skillName, "SKILL.md"), "utf8");
      const parsed = parseSkillFrontmatter(raw);
      expect(parsed, `${skillName}/SKILL.md frontmatter failed to parse`).not.toBeNull();
      expect(parsed?.name).toBe(skillName);
      expect(parsed?.description.length).toBeGreaterThan(0);
    }
  });
});
