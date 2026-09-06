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

  // Issue #940 — the source dir must NOT carry the `mullion-` prefix
  // itself (installBundleSkills, mullion-bundle.ts, prepends it on
  // install; a prefixed source produced a double-`mullion-mullion-host`
  // installed name). Named explicitly, not just "however many dirs exist
  // today", so a regression that re-adds the prefix — or silently drops
  // one of these seven — fails loudly here instead of only showing up in a
  // live codex/agy install.
  it("ships exactly the seven expected, unprefixed skill source directories", () => {
    const skillsDir = path.join(bundleDir, "skills");
    const skillNames = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(skillNames).toEqual(
      [
        "browser",
        "host",
        "session-ops",
        "task-reviewer",
        "task-worker",
        "taskmaster-issues",
        "troubleshooting",
      ].sort(),
    );
  });

  // Issue #940 — each env-var-coupled skill must self-identify as inert
  // without Mullion's own env vars, so an agent reading it in a
  // non-Mullion session recognizes "not applicable here" immediately
  // rather than following instructions that reference unset variables.
  // Approximated mechanically: the BODY (frontmatter stripped, so a
  // `description:` field that happens to contain "unset" can't satisfy
  // this for free) must open — within its first `GUARD_WINDOW_CHARS` —
  // with a guard-shaped phrase ("unset" or "Check for"), before the first
  // mention of any of these vars. Not a proof the check is correct (it
  // doesn't confirm the guard names the SAME var that follows), just that
  // one wasn't simply forgotten or buried deep in the file.
  const GUARDED_ENV_VARS = [
    "MULLION_HOOK_SOCKET",
    "MULLION_HOOK_TOKEN",
    "MULLION_SOCKET_PATH",
    "MULLION_SESSION_ID",
  ];
  const GUARD_PHRASE_RE = /unset|Check for/i;
  const GUARD_WINDOW_CHARS = 400;
  const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

  it("never references a session env var without a preceding conditional check near the top of the body", () => {
    const skillsDir = path.join(bundleDir, "skills");
    const skillNames = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const skillName of skillNames) {
      const raw = readFileSync(path.join(skillsDir, skillName, "SKILL.md"), "utf8");
      const body = raw.replace(FRONTMATTER_RE, "");
      const firstVarIndex = Math.min(
        ...GUARDED_ENV_VARS.map((v) => body.indexOf(v)).filter((i) => i >= 0),
        Infinity,
      );
      if (!Number.isFinite(firstVarIndex)) continue; // this skill mentions no env var at all

      const guardIndex = body.slice(0, GUARD_WINDOW_CHARS).search(GUARD_PHRASE_RE);
      expect(
        guardIndex,
        `${skillName}/SKILL.md's body doesn't open with a guard phrase ("unset"/"Check for") within its first ${GUARD_WINDOW_CHARS} chars`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        guardIndex,
        `${skillName}/SKILL.md references a session env var before its opening guard phrase`,
      ).toBeLessThan(firstVarIndex);
    }
  });
});
