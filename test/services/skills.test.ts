import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listProjectSkills,
  listGlobalSkills,
  SkillsTimeoutError,
  isTransientReadError,
  __testing,
} from "../../src/services/skills.js";

const { parseSkillFrontmatter, scanSkillDirs } = __testing;

function writeSkill(dir: string, name: string, description: string, body = "# body\n") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
  );
}

// Every global/builtin dir this module scans resolves off os.homedir() (and
// CODEX_HOME for codex) — same reasoning and same redirection requirement as
// agent-rules.test.ts's own header comment.
describe("skills service", () => {
  let fakeHome: string;
  let projectCwd: string;
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "mullion-skills-home-"));
    projectCwd = mkdtempSync(path.join(os.tmpdir(), "mullion-skills-project-"));
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

  describe("parseSkillFrontmatter", () => {
    it("parses a flat name/description block", () => {
      const parsed = parseSkillFrontmatter(
        "---\nname: foo\ndescription: does a thing\n---\n\nbody",
      );
      expect(parsed).toEqual({ name: "foo", description: "does a thing" });
    });

    it("strips matching quotes around a value", () => {
      const parsed = parseSkillFrontmatter(
        "---\nname: \"quoted-name\"\ndescription: 'quoted desc'\n---\n",
      );
      expect(parsed).toEqual({ name: "quoted-name", description: "quoted desc" });
    });

    it("returns null when there is no frontmatter block", () => {
      expect(parseSkillFrontmatter("# just a heading\n")).toBeNull();
    });

    it("returns null when name or description is missing", () => {
      expect(parseSkillFrontmatter("---\nname: foo\n---\n")).toBeNull();
      expect(parseSkillFrontmatter("---\ndescription: only desc\n---\n")).toBeNull();
    });

    it("skips a block-scalar description rather than capturing the literal indicator", () => {
      const parsed = parseSkillFrontmatter(
        "---\nname: foo\ndescription: |\n  multiple\n  lines\n---\n",
      );
      expect(parsed).toBeNull();
    });
  });

  describe("listProjectSkills", () => {
    it("returns an empty list when no skill directories exist anywhere", async () => {
      expect(await listProjectSkills(projectCwd)).toEqual([]);
    });

    it("discovers a project-scope Claude Code skill", async () => {
      writeSkill(
        path.join(projectCwd, ".claude", "skills", "my-skill"),
        "my-skill",
        "does a thing",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "my-skill");
      expect(found).toBeDefined();
      expect(found?.scope).toBe("project");
      expect(found?.description).toBe("does a thing");
      expect(found?.agents).toEqual(["claude-code", "opencode"]);
      expect(found?.sourceDir).toBe(path.join(projectCwd, ".claude", "skills", "my-skill"));
    });

    it("discovers a global-scope skill from the redirected fake HOME", async () => {
      writeSkill(
        path.join(fakeHome, ".claude", "skills", "global-skill"),
        "global-skill",
        "a global one",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "global-skill");
      expect(found?.scope).toBe("global");
      expect(found?.agents).toEqual(expect.arrayContaining(["claude-code", "opencode"]));
    });

    it("discovers a Codex project-scope skill under .agents/skills", async () => {
      writeSkill(
        path.join(projectCwd, ".agents", "skills", "codex-skill"),
        "codex-skill",
        "codex only",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "codex-skill");
      expect(found?.agents).toEqual(expect.arrayContaining(["codex", "opencode"]));
    });

    it("discovers an opencode-only project-scope skill under .opencode/skills", async () => {
      writeSkill(
        path.join(projectCwd, ".opencode", "skills", "opencode-skill"),
        "opencode-skill",
        "opencode only",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "opencode-skill");
      expect(found?.agents).toEqual(["opencode"]);
    });

    it("discovers agy's builtin skills dir", async () => {
      writeSkill(
        path.join(fakeHome, ".gemini", "antigravity-cli", "builtin", "skills", "agy-builtin"),
        "agy-builtin",
        "ships with agy",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "agy-builtin");
      expect(found?.scope).toBe("builtin");
      expect(found?.agents).toEqual(["agy"]);
    });

    it("discovers an agy extension's skills", async () => {
      writeSkill(
        path.join(fakeHome, ".gemini", "extensions", "my-ext", "skills", "ext-skill"),
        "ext-skill",
        "from an extension",
      );
      const skills = await listProjectSkills(projectCwd);
      expect(skills.find((s) => s.name === "ext-skill")?.scope).toBe("builtin");
    });

    it("discovers an installed Claude Code plugin's skills via installed_plugins.json", async () => {
      const installPath = path.join(
        fakeHome,
        ".claude",
        "plugins",
        "cache",
        "acme",
        "widgets",
        "1.0.0",
      );
      writeSkill(path.join(installPath, "skills", "plugin-skill"), "plugin-skill", "from a plugin");
      mkdirSync(path.join(fakeHome, ".claude", "plugins"), { recursive: true });
      writeFileSync(
        path.join(fakeHome, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: { "widgets@acme": [{ scope: "user", installPath }] },
        }),
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "plugin-skill");
      expect(found?.scope).toBe("builtin");
      expect(found?.agents).toEqual(["claude-code"]);
    });

    // Hermes review, PR #459 — an earlier version's `if
    // (!Array.isArray(entries)) continue` silently skipped the legacy (v1)
    // shape entirely: a single install-record object per plugin id, not an
    // array. Claude Code migrates v1 -> v2 on load, but a host that hadn't
    // re-opened it since installing a plugin would show zero plugin skills
    // with no error.
    it("discovers an installed plugin's skills from a legacy (v1) installed_plugins.json", async () => {
      const installPath = path.join(
        fakeHome,
        ".claude",
        "plugins",
        "cache",
        "acme",
        "legacy",
        "1.0.0",
      );
      writeSkill(path.join(installPath, "skills", "legacy-skill"), "legacy-skill", "v1 shape");
      mkdirSync(path.join(fakeHome, ".claude", "plugins"), { recursive: true });
      writeFileSync(
        path.join(fakeHome, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 1,
          plugins: { "legacy@acme": { scope: "user", installPath } },
        }),
      );
      const skills = await listProjectSkills(projectCwd);
      expect(skills.find((s) => s.name === "legacy-skill")).toBeDefined();
    });

    // Hermes review, PR #459 — this read used to have no byte cap at all,
    // unlike every other file this module reads. A file past the cap is
    // read as a truncated prefix, which fails JSON.parse the same way any
    // other malformed file does — no throw, no plugin skills, not a crash.
    it("treats an installed_plugins.json past the byte cap as unparseable rather than reading it whole", async () => {
      mkdirSync(path.join(fakeHome, ".claude", "plugins"), { recursive: true });
      const oversized = JSON.stringify({
        version: 2,
        plugins: { padding: [{ scope: "user", installPath: "x".repeat(2 * 1024 * 1024) }] },
      });
      writeFileSync(path.join(fakeHome, ".claude", "plugins", "installed_plugins.json"), oversized);
      expect(await listProjectSkills(projectCwd)).toEqual([]);
    });

    it("ignores a malformed installed_plugins.json rather than throwing", async () => {
      mkdirSync(path.join(fakeHome, ".claude", "plugins"), { recursive: true });
      writeFileSync(
        path.join(fakeHome, ".claude", "plugins", "installed_plugins.json"),
        "{not json",
      );
      expect(await listProjectSkills(projectCwd)).toEqual([]);
    });

    it("discovers a skill whose SKILL.md body is far larger than the frontmatter read cap", async () => {
      // Regression test: an earlier version gated on the FILE's total size
      // (stat-then-readFile) and skipped any skill whose body pushed it past
      // MAX_FRONTMATTER_READ_BYTES, even though only the frontmatter (always
      // at the top) is ever read. A ~200KB body must not hide a small,
      // perfectly parseable frontmatter block.
      writeSkill(
        path.join(projectCwd, ".claude", "skills", "big-body"),
        "big-body",
        "small frontmatter, huge body",
        "x".repeat(200 * 1024),
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "big-body");
      expect(found).toBeDefined();
      expect(found?.description).toBe("small frontmatter, huge body");
    });

    // Hermes review, PR #459 — an unreadable directory used to abort the
    // ENTIRE listing (propagating EACCES up through scanSkillDirs), so one
    // permission-denied directory among many independent ones (e.g. a
    // machine-wide /etc/codex/skills an ordinary user can't read) took down
    // every skill this call would otherwise have found. Now it's skipped
    // like a missing directory, and every other readable directory's skills
    // still come through.
    it("skips an unreadable directory instead of failing the whole listing", async () => {
      const lockedDir = path.join(projectCwd, ".claude", "skills");
      mkdirSync(lockedDir, { recursive: true });
      chmodSync(lockedDir, 0o000);
      writeSkill(path.join(fakeHome, ".claude", "skills", "still-found"), "still-found", "x");
      try {
        const skills = await listProjectSkills(projectCwd);
        expect(skills.find((s) => s.name === "still-found")).toBeDefined();
      } finally {
        chmodSync(lockedDir, 0o700);
      }
    });

    // Hermes review, PR #459 — Dirent.isDirectory() reports the raw
    // directory-entry type (DT_LNK for a symlink) without following it, so a
    // symlinked skills dir (common with a dotfiles manager symlinking
    // ~/.claude/skills into a dotfiles repo) was silently invisible even
    // though it resolves to a normal, readable directory.
    it("discovers a skill inside a symlinked skills directory", async () => {
      const realDir = mkdtempSync(path.join(os.tmpdir(), "mullion-skills-real-"));
      writeSkill(path.join(realDir, "symlinked-skill"), "symlinked-skill", "reached via a symlink");
      mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
      symlinkSync(realDir, path.join(fakeHome, ".claude", "skills"));
      try {
        const skills = await listProjectSkills(projectCwd);
        expect(skills.find((s) => s.name === "symlinked-skill")).toBeDefined();
      } finally {
        rmSync(realDir, { recursive: true, force: true });
      }
    });

    it("skips a skill directory with no SKILL.md", async () => {
      mkdirSync(path.join(projectCwd, ".claude", "skills", "empty-dir"), { recursive: true });
      const skills = await listProjectSkills(projectCwd);
      expect(skills.find((s) => s.sourceDir.endsWith("empty-dir"))).toBeUndefined();
    });

    it("skips a SKILL.md with malformed frontmatter", async () => {
      mkdirSync(path.join(projectCwd, ".claude", "skills", "broken"), { recursive: true });
      writeFileSync(
        path.join(projectCwd, ".claude", "skills", "broken", "SKILL.md"),
        "no frontmatter here",
      );
      const skills = await listProjectSkills(projectCwd);
      expect(skills.find((s) => s.sourceDir.endsWith("broken"))).toBeUndefined();
    });
  });

  // Hermes review, PR #459 — the merge previously kept whichever source's
  // scope happened to be encountered FIRST, correct today only because
  // listProjectSkills always spreads project-scope sources before
  // global/builtin ones — "source-order luck," not a rule. Exercises
  // scanSkillDirs directly (bypassing listProjectSkills's fixed ordering)
  // to prove project scope wins even when a global-scope source for the
  // exact same directory is scanned first.
  describe("scanSkillDirs merge behavior", () => {
    it("prefers project scope over global on merge, regardless of scan order", async () => {
      writeSkill(path.join(projectCwd, "shared-skill"), "shared-skill", "reachable both ways");
      const skills = await scanSkillDirs([
        { dir: projectCwd, agent: "opencode", scope: "global" },
        { dir: projectCwd, agent: "claude-code", scope: "project" },
      ]);
      const found = skills.find((s) => s.name === "shared-skill");
      expect(found?.scope).toBe("project");
      expect(found?.agents).toEqual(["opencode", "claude-code"]);
    });
  });

  describe("listGlobalSkills", () => {
    it("excludes project-scope directories", async () => {
      writeSkill(path.join(projectCwd, ".claude", "skills", "project-only"), "project-only", "x");
      writeSkill(path.join(fakeHome, ".claude", "skills", "global-one"), "global-one", "y");
      const skills = await listGlobalSkills();
      expect(skills.find((s) => s.name === "project-only")).toBeUndefined();
      expect(skills.find((s) => s.name === "global-one")).toBeDefined();
    });
  });

  describe("isTransientReadError", () => {
    it("recognizes EACCES and EPERM, nothing else", () => {
      expect(isTransientReadError({ code: "EACCES" })).toBe(true);
      expect(isTransientReadError({ code: "EPERM" })).toBe(true);
      expect(isTransientReadError({ code: "ENOENT" })).toBe(false);
      expect(isTransientReadError(new Error("plain"))).toBe(false);
    });
  });

  describe("SkillsTimeoutError", () => {
    it("is a real Error subclass carrying the path in its message", () => {
      const err = new SkillsTimeoutError("/some/path");
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("/some/path");
    });
  });
});
