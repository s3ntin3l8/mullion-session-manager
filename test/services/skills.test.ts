import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listProjectSkills,
  listGlobalSkills,
  toggleSkillEnabled,
  classifySkillToggleError,
  SkillsTimeoutError,
  isTransientReadError,
  resolveSkillForToggle,
  __testing,
} from "../../src/services/skills.js";
import { writeCodexSkillEnabled } from "../../src/services/hook-adapters/codex-skills.js";
import {
  writeOpenCodeSkillEnabled,
  resolveOpenCodeConfigPath,
} from "../../src/services/hook-adapters/opencode-skills.js";
import { writeClaudeCodeSkillEnabled } from "../../src/services/hook-adapters/claude-code-skills.js";
import { InvalidSkillNameError } from "../../src/services/hook-adapters/skill-name.js";

const {
  parseSkillFrontmatter,
  parseAgentOrCommandFrontmatter,
  scanSkillDirs,
  scanFileDirs,
  withReadDeadline,
  FS_READ_DEADLINE_MS,
} = __testing;

function writeSkill(dir: string, name: string, description: string, body = "# body\n") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
  );
}

// Issue #885 — writes a single loose `.md` file directly inside `dir` (no
// per-item subdirectory), the shape scanFileDirs/readMdFilesSafe scans for
// subagents and commands. `frontmatter` is the raw block between the `---`
// markers, verbatim — callers decide whether to include a `name:` key at
// all, since that's exactly the thing under test (a command's name commonly
// falls back to its filename).
function writeAgentOrCommandFile(
  dir: string,
  fileName: string,
  frontmatter: string,
  body = "# body\n",
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), `---\n${frontmatter}\n---\n\n${body}`);
}

// Every global/builtin dir this module scans resolves off os.homedir() (and
// CODEX_HOME for codex) — same reasoning and same redirection requirement as
// agent-rules.test.ts's own header comment.
describe("skills service", () => {
  let fakeHome: string;
  let projectCwd: string;
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(os.tmpdir(), "mullion-skills-home-"));
    projectCwd = mkdtempSync(path.join(os.tmpdir(), "mullion-skills-project-"));
    process.env.HOME = fakeHome;
    delete process.env.CODEX_HOME;
    // resolveOpenCodeConfigHome() (opencode-skills.ts) resolves under
    // XDG_CONFIG_HOME when set — GitHub Actions runners set it ambiently,
    // unlike a local dev sandbox, so a fixture written under
    // fakeHome/.config/opencode would silently miss it there.
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
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

    it("discovers agy's documented project-scope skills dir, .agents/skills (issue #467)", async () => {
      writeSkill(
        path.join(projectCwd, ".agents", "skills", "agy-project-skill"),
        "agy-project-skill",
        "workspace-specific agy skill",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "agy-project-skill");
      expect(found?.scope).toBe("project");
      expect(found?.agents).toContain("agy");
    });

    it("merges .agents/skills into one row across codex/opencode/agy rather than three (issue #467)", async () => {
      writeSkill(
        path.join(projectCwd, ".agents", "skills", "shared-skill"),
        "shared-skill",
        "reachable by three agents",
      );
      const skills = await listProjectSkills(projectCwd);
      const matches = skills.filter((s) => s.name === "shared-skill");
      expect(matches).toHaveLength(1);
      expect(matches[0].agents.sort()).toEqual(["agy", "codex", "opencode"]);
    });

    it("discovers agy's documented global skills dir, ~/.gemini/config/skills (issue #888)", async () => {
      writeSkill(
        path.join(fakeHome, ".gemini", "config", "skills", "agy-global-skill"),
        "agy-global-skill",
        "all-workspaces agy skill",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "agy-global-skill");
      expect(found?.scope).toBe("global");
      expect(found?.agents).toEqual(["agy"]);
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

    // Independent review, PR #459 — readBoundedPrefix used to only wrap
    // open() in a try/catch, not the read itself. open() succeeds on a
    // directory on Linux, so a "SKILL.md" that's actually a directory (a
    // stray mkdir, an aborted checkout) threw EISDIR straight out of
    // handle.read(), uncaught — which propagated all the way through
    // scanSkillDirs and took down the ENTIRE listing instead of being
    // skipped like every other malformed entry in this same directory.
    it("skips a skill whose SKILL.md is actually a directory, without failing other skills in the same listing", async () => {
      mkdirSync(path.join(projectCwd, ".claude", "skills", "bad-entry", "SKILL.md"), {
        recursive: true,
      });
      writeSkill(
        path.join(projectCwd, ".claude", "skills", "good-entry"),
        "good-entry",
        "still works",
      );
      const skills = await listProjectSkills(projectCwd);
      expect(skills.find((s) => s.sourceDir.endsWith("bad-entry"))).toBeUndefined();
      expect(skills.find((s) => s.name === "good-entry")).toBeDefined();
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

    // Issue #470 — globalSkillDirs()'s claude-code entry was hardcoded to
    // ~/.claude/skills; Claude Code itself resolves its whole user-scope
    // config tree off CLAUDE_CONFIG_DIR when set (verified statically
    // against the installed 2.1.220 bundle), so a skill installed under a
    // real CLAUDE_CONFIG_DIR setup used to be silently invisible here —
    // same root cause as the opencode XDG_CONFIG_HOME bug #469 fixed.
    it("discovers a global claude-code skill under CLAUDE_CONFIG_DIR, not ~/.claude, once set", async () => {
      const configDir = mkdtempSync(path.join(os.tmpdir(), "mullion-skills-claude-config-"));
      const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
      try {
        process.env.CLAUDE_CONFIG_DIR = configDir;
        writeSkill(path.join(configDir, "skills", "via-config-dir"), "via-config-dir", "z");
        writeSkill(path.join(fakeHome, ".claude", "skills", "via-home"), "via-home", "z");
        const skills = await listGlobalSkills();
        expect(skills.find((s) => s.name === "via-config-dir")).toBeDefined();
        expect(skills.find((s) => s.name === "via-home")).toBeUndefined();
      } finally {
        if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  // Issue #468 (retargeted — see below) — this repo ships its own repo-
  // specific review-invariants doc as a project skill,
  // `.claude/skills/mullion-review-invariants/SKILL.md`, with an
  // `.agents/skills/mullion-review-invariants` symlink alongside it so Codex
  // and opencode's own `.agents/skills` scan reaches it too. Runs against
  // the REAL repo root, same posture as agent-guide.test.ts's own
  // "is true in this checkout" test — vitest's process.cwd() is the repo
  // root, no fixture needed. Fails loudly if the frontmatter is ever broken
  // (e.g. edited into an unsupported block-scalar description).
  //
  // Originally covered `mullion-agent-guide` — removed by the "make
  // Mullion's tooling work in every repo" plan, which deleted that
  // repo-local skill+symlink in favor of a session-scoped `--plugin-dir`
  // bundle shipped from `src/bundle/` (see mullion-bundle.ts and
  // src/bundle/skills/host/, covered by its own test under
  // test/services/hook-adapters/). `mullion-review-invariants` is
  // repo-specific by design (it will never move into that bundle) and has
  // the identical two-location shape, so it's the natural replacement
  // target for this exact coverage.
  //
  // The symlink does NOT make this one merged SkillInfo row: scanSkillDirs
  // merges by the exact joined `sourceDir` string, and
  // `.claude/skills/mullion-review-invariants` is a different string from
  // `.agents/skills/mullion-review-invariants` even though the latter
  // resolves to the former's file via the symlink — path.join never
  // resolves symlinks. So this produces two independent rows sharing the
  // same frontmatter name, one per real parent directory. That in turn
  // means opencode (which scans BOTH `.claude/skills` and `.agents/skills`)
  // sees the name twice and correctly degrades to non-toggleable via the
  // existing ambiguous-name guard (issue #463) — expected, safe behavior,
  // not a defect this PR needs to fix. Codex (which only scans
  // `.agents/skills`) sees the name once and stays independently
  // toggleable.
  describe("mullion-review-invariants SKILL.md (issue #468)", () => {
    it("is discovered via both .claude/skills and the .agents/skills symlink in this checkout", async () => {
      const skills = await listProjectSkills(process.cwd());
      const rows = skills.filter((s) => s.name === "mullion-review-invariants");

      // At least the two real/symlinked project-scope rows — not an exact
      // count, since a sibling PR may add agy's own .agents/skills scanning
      // and land before or after this one merges.
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(row.scope).toBe("project");
        expect(row.description.length).toBeGreaterThan(0);
      }

      const agentsSeen = new Set(rows.flatMap((row) => row.agents));
      expect(agentsSeen.has("claude-code")).toBe(true);
      expect(agentsSeen.has("codex")).toBe(true);
      expect(agentsSeen.has("opencode")).toBe(true);

      const claudeSkillsRow = rows.find((row) =>
        row.sourceDir.endsWith(path.join(".claude", "skills", "mullion-review-invariants")),
      );
      const agentsSkillsRow = rows.find((row) =>
        row.sourceDir.endsWith(path.join(".agents", "skills", "mullion-review-invariants")),
      );
      expect(claudeSkillsRow).toBeDefined();
      expect(agentsSkillsRow).toBeDefined();
      expect(claudeSkillsRow?.agents).toContain("claude-code");
      expect(agentsSkillsRow?.agents).toContain("codex");
    });
  });

  describe("parseAgentOrCommandFrontmatter (issue #885)", () => {
    it("requires both name and description for kind 'agent', same as a skill", () => {
      expect(
        parseAgentOrCommandFrontmatter(
          "---\nname: reviewer\ndescription: reviews things\n---\n",
          "agent",
          "fallback",
        ),
      ).toEqual({ name: "reviewer", description: "reviews things" });
      expect(
        parseAgentOrCommandFrontmatter(
          "---\ndescription: reviews things\n---\n",
          "agent",
          "fallback",
        ),
      ).toBeNull();
    });

    it("falls back to the given filename when kind 'command' has no name key", () => {
      const parsed = parseAgentOrCommandFrontmatter(
        "---\ndescription: does a thing\n---\n",
        "command",
        "my-command",
      );
      expect(parsed).toEqual({ name: "my-command", description: "does a thing" });
    });

    it("prefers an explicit name over the fallback for kind 'command'", () => {
      const parsed = parseAgentOrCommandFrontmatter(
        "---\nname: explicit-name\ndescription: does a thing\n---\n",
        "command",
        "my-command",
      );
      expect(parsed).toEqual({ name: "explicit-name", description: "does a thing" });
    });

    it("returns null for kind 'command' with no description, even with a fallback name available", () => {
      expect(
        parseAgentOrCommandFrontmatter("---\nname: x\n---\n", "command", "my-command"),
      ).toBeNull();
    });
  });

  // Issue #885 — discovers Claude Code/opencode subagents and Claude Code
  // slash commands alongside skills. `listProjectSkills`'s project/global/
  // builtin dir tables each grow a sibling agent/command entry, scanned by
  // scanFileDirs (a loose `.md` FILE per item, not a subdirectory).
  describe("agents and commands (issue #885)", () => {
    it("discovers a project-scope Claude Code subagent under .claude/agents", async () => {
      writeAgentOrCommandFile(
        path.join(projectCwd, ".claude", "agents"),
        "reviewer.md",
        "name: reviewer\ndescription: reviews PRs",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "reviewer");
      expect(found).toBeDefined();
      expect(found?.kind).toBe("agent");
      expect(found?.scope).toBe("project");
      expect(found?.agents).toEqual(["claude-code"]);
      expect(found?.sourceDir).toBe(path.join(projectCwd, ".claude", "agents", "reviewer.md"));
      expect(found?.enabledByAgent["claude-code"]).toBeNull();
    });

    it("discovers a project-scope Claude Code command under .claude/commands, named by filename", async () => {
      writeAgentOrCommandFile(
        path.join(projectCwd, ".claude", "commands"),
        "od-contribute.md",
        'description: "Open a first-contribution PR"',
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.sourceDir.endsWith("od-contribute.md"));
      expect(found).toBeDefined();
      expect(found?.kind).toBe("command");
      expect(found?.name).toBe("od-contribute");
      expect(found?.enabledByAgent["claude-code"]).toBeNull();
    });

    it("uses an explicit frontmatter name for a command when one is present", async () => {
      writeAgentOrCommandFile(
        path.join(projectCwd, ".claude", "commands"),
        "deploy.md",
        "name: deploy-prod\ndescription: deploys to production",
      );
      const skills = await listProjectSkills(projectCwd);
      expect(skills.find((s) => s.sourceDir.endsWith("deploy.md"))?.name).toBe("deploy-prod");
    });

    it("skips a subagent file missing a name (no filename fallback for kind 'agent')", async () => {
      writeAgentOrCommandFile(
        path.join(projectCwd, ".claude", "agents"),
        "unnamed.md",
        "description: has no name key",
      );
      const skills = await listProjectSkills(projectCwd);
      expect(skills.find((s) => s.sourceDir.endsWith("unnamed.md"))).toBeUndefined();
    });

    it("skips a command file with no description at all", async () => {
      writeAgentOrCommandFile(
        path.join(projectCwd, ".claude", "commands"),
        "broken.md",
        "name: broken",
      );
      const skills = await listProjectSkills(projectCwd);
      expect(skills.find((s) => s.sourceDir.endsWith("broken.md"))).toBeUndefined();
    });

    it("ignores a non-.md file sitting in an agents/commands directory", async () => {
      mkdirSync(path.join(projectCwd, ".claude", "agents"), { recursive: true });
      writeFileSync(path.join(projectCwd, ".claude", "agents", "README.txt"), "not a subagent");
      const skills = await listProjectSkills(projectCwd);
      expect(skills.find((s) => s.sourceDir.endsWith("README.txt"))).toBeUndefined();
    });

    it("discovers a global Claude Code subagent under CLAUDE_CONFIG_DIR/agents", async () => {
      const configDir = mkdtempSync(path.join(os.tmpdir(), "mullion-skills-claude-config-"));
      const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
      try {
        process.env.CLAUDE_CONFIG_DIR = configDir;
        writeAgentOrCommandFile(
          path.join(configDir, "agents"),
          "global-reviewer.md",
          "name: global-reviewer\ndescription: a global subagent",
        );
        const skills = await listProjectSkills(projectCwd);
        const found = skills.find((s) => s.name === "global-reviewer");
        expect(found?.kind).toBe("agent");
        expect(found?.scope).toBe("global");
      } finally {
        if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it("discovers a global opencode subagent under the singular agent/ dir, not agents/", async () => {
      writeAgentOrCommandFile(
        path.join(fakeHome, ".config", "opencode", "agent"),
        "oc-reviewer.md",
        "name: oc-reviewer\ndescription: an opencode subagent",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "oc-reviewer");
      expect(found?.kind).toBe("agent");
      expect(found?.agents).toEqual(["opencode"]);
    });

    it("discovers an installed Claude Code plugin's agents and commands as builtin scope", async () => {
      const installPath = path.join(
        fakeHome,
        ".claude",
        "plugins",
        "cache",
        "acme",
        "widgets",
        "1.0.0",
      );
      writeAgentOrCommandFile(
        path.join(installPath, "agents"),
        "plugin-agent.md",
        "name: plugin-agent\ndescription: from a plugin",
      );
      writeAgentOrCommandFile(
        path.join(installPath, "commands"),
        "plugin-cmd.md",
        "description: also from a plugin",
      );
      mkdirSync(path.join(fakeHome, ".claude", "plugins"), { recursive: true });
      writeFileSync(
        path.join(fakeHome, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: { "widgets@acme": [{ scope: "user", installPath }] },
        }),
      );
      const skills = await listProjectSkills(projectCwd);
      const agentRow = skills.find((s) => s.name === "plugin-agent");
      expect(agentRow?.kind).toBe("agent");
      expect(agentRow?.scope).toBe("builtin");
      const commandRow = skills.find((s) => s.sourceDir.endsWith("plugin-cmd.md"));
      expect(commandRow?.kind).toBe("command");
      expect(commandRow?.scope).toBe("builtin");
      expect(commandRow?.name).toBe("plugin-cmd");
    });

    it("never attributes a Claude Code agent/command row to codex or agy — neither scans .claude/agents", async () => {
      writeAgentOrCommandFile(
        path.join(projectCwd, ".claude", "agents"),
        "reviewer.md",
        "name: reviewer\ndescription: reviews PRs",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "reviewer");
      expect(found?.agents).not.toContain("codex");
      expect(found?.agents).not.toContain("agy");
    });

    it("never emits a codex agent/command row at all — codex has no subagent/command concept", async () => {
      writeAgentOrCommandFile(
        path.join(projectCwd, ".claude", "agents"),
        "reviewer.md",
        "name: reviewer\ndescription: reviews PRs",
      );
      const skills = await listProjectSkills(projectCwd);
      expect(skills.some((s) => s.kind !== "skill" && s.agents.includes("codex"))).toBe(false);
    });

    // Issue #1080 — resolveAgyGlobalAgentsDir() (~/.gemini/config/agents,
    // agy's own real global agent-discovery dir, also the destination
    // bundle-sync.ts's AGENT_TARGETS installs into) was previously absent
    // from globalAgentAndCommandDirs entirely, making anything placed there
    // — Mullion-installed or hand-authored — invisible to the Skills
    // Manager. Verifies discovery AND the enable/disable posture: every
    // kind-"agent" row is discovery-only regardless of which CLI it belongs
    // to (issue #885's `attachEnabledByAgent` early branch), so this must
    // come back `null` here exactly like the "discovers a global Claude Code
    // subagent under CLAUDE_CONFIG_DIR/agents" case above (same file's own
    // globalAgentAndCommandDirs claude-code entry) — never a functioning
    // toggle, but also never a silently-broken one, since none ever existed
    // for this kind.
    it("discovers a global agy subagent under ~/.gemini/config/agents (issue #1080)", async () => {
      writeAgentOrCommandFile(
        path.join(fakeHome, ".gemini", "config", "agents"),
        "mullion-reviewer.md",
        "name: reviewer\ndescription: an agy subagent",
      );
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find(
        (s) => s.kind === "agent" && s.agents.includes("agy") && s.name === "reviewer",
      );
      expect(found).toBeDefined();
      expect(found?.scope).toBe("global");
      expect(found?.sourceDir).toBe(
        path.join(fakeHome, ".gemini", "config", "agents", "mullion-reviewer.md"),
      );
      // Discovery-only, same as every other agent/command row — not a
      // regression, since kind "agent" has never had a working toggle for
      // any CLI (see attachEnabledByAgent's own doc comment, issue #885).
      expect(found?.enabledByAgent.agy).toBeNull();
    });

    it("also surfaces the same global agy subagent from listGlobalSkills (no project cwd)", async () => {
      writeAgentOrCommandFile(
        path.join(fakeHome, ".gemini", "config", "agents"),
        "mullion-reviewer.md",
        "name: reviewer\ndescription: an agy subagent",
      );
      const skills = await listGlobalSkills();
      const found = skills.find((s) => s.kind === "agent" && s.agents.includes("agy"));
      expect(found).toBeDefined();
      expect(found?.name).toBe("reviewer");
      expect(found?.enabledByAgent.agy).toBeNull();
    });

    // Regression guard for the exact hazard the plan calls out: without
    // kind-scoping, an agent/command sharing a skill's frontmatter name (or,
    // for claude-code, its directory-basename-turned-filename) would
    // spuriously make an otherwise-unambiguous SKILL degrade to
    // non-toggleable.
    it("does not make an unrelated skill ambiguous or non-toggleable when a subagent shares its name", async () => {
      writeSkill(path.join(fakeHome, ".codex", "skills", "reviewer"), "reviewer", "a real skill");
      writeAgentOrCommandFile(
        path.join(projectCwd, ".claude", "agents"),
        "reviewer.md",
        "name: reviewer\ndescription: an unrelated subagent",
      );
      const skills = await listProjectSkills(projectCwd);
      const skillRow = skills.find((s) => s.kind === "skill" && s.name === "reviewer");
      const agentRow = skills.find((s) => s.kind === "agent" && s.name === "reviewer");
      expect(skillRow?.enabledByAgent.codex).toBe(true);
      expect(agentRow?.enabledByAgent["claude-code"]).toBeNull();
    });

    it("is discovered as kind 'agent' via .claude/agents/mullion-reviewer.md in this real checkout", async () => {
      const skills = await listProjectSkills(process.cwd());
      const found = skills.find(
        (s) =>
          s.kind === "agent" &&
          s.sourceDir.endsWith(path.join(".claude", "agents", "mullion-reviewer.md")),
      );
      expect(found).toBeDefined();
      expect(found?.name).toBe("mullion-reviewer");
      expect(found?.description.length).toBeGreaterThan(0);
      expect(found?.enabledByAgent["claude-code"]).toBeNull();
    });
  });

  describe("scanFileDirs merge behavior (issue #885)", () => {
    it("prefers project scope over global on merge, regardless of scan order, mirroring scanSkillDirs", async () => {
      writeAgentOrCommandFile(
        projectCwd,
        "shared.md",
        "name: shared\ndescription: reachable both ways",
      );
      const files = await scanFileDirs([
        { dir: projectCwd, agent: "opencode", scope: "global", kind: "agent" },
        { dir: projectCwd, agent: "claude-code", scope: "project", kind: "agent" },
      ]);
      const found = files.find((f) => f.name === "shared");
      expect(found?.scope).toBe("project");
      expect(found?.agents).toEqual(["opencode", "claude-code"]);
    });
  });

  // Issue #463 — enable/disable data-model wiring. Uses the same
  // redirected-HOME/CODEX_HOME scaffolding as the rest of this file, plus
  // the real writers (codex-skills.ts/opencode-skills.ts) to seed config
  // state, so these tests exercise the exact same code path a real toggle
  // would.
  describe("enabledByAgent (issue #463)", () => {
    it("defaults to true when no config entry exists for a toggleable agent", async () => {
      writeSkill(path.join(fakeHome, ".codex", "skills", "my-skill"), "my-skill", "does a thing");
      const skills = await listGlobalSkills();
      const found = skills.find((s) => s.name === "my-skill");
      expect(found?.enabledByAgent.codex).toBe(true);
    });

    it("reflects a Codex config.toml entry disabling the skill", async () => {
      writeSkill(path.join(fakeHome, ".codex", "skills", "my-skill"), "my-skill", "does a thing");
      writeCodexSkillEnabled("my-skill", false);
      const skills = await listGlobalSkills();
      const found = skills.find((s) => s.name === "my-skill");
      expect(found?.enabledByAgent.codex).toBe(false);
    });

    it("reflects an opencode config entry disabling the skill", async () => {
      writeSkill(
        path.join(fakeHome, ".config", "opencode", "skills", "my-skill"),
        "my-skill",
        "does a thing",
      );
      writeOpenCodeSkillEnabled("my-skill", false);
      const skills = await listGlobalSkills();
      const found = skills.find((s) => s.name === "my-skill");
      expect(found?.enabledByAgent.opencode).toBe(false);
    });

    it("is always null for agy — no per-skill write mechanism exists (issue #467)", async () => {
      writeSkill(
        path.join(fakeHome, ".gemini", "antigravity-cli", "builtin", "skills", "my-skill"),
        "my-skill",
        "does a thing",
      );
      const skills = await listGlobalSkills();
      const found = skills.find((s) => s.name === "my-skill");
      expect(found?.enabledByAgent.agy).toBeNull();
    });

    it("claude-code is null from listGlobalSkills (cwd-less) even with no config entry at all (issue #467)", async () => {
      writeSkill(path.join(fakeHome, ".claude", "skills", "my-skill"), "my-skill", "does a thing");
      const skills = await listGlobalSkills();
      const found = skills.find((s) => s.name === "my-skill");
      expect(found?.enabledByAgent["claude-code"]).toBeNull();
    });

    it("claude-code reports a real boolean from listProjectSkills, which has a cwd (issue #467)", async () => {
      writeSkill(path.join(fakeHome, ".claude", "skills", "my-skill"), "my-skill", "does a thing");
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "my-skill");
      expect(found?.enabledByAgent["claude-code"]).toBe(true);
    });

    it("claude-code reflects a real settings.json entry disabling the skill (issue #467)", async () => {
      writeSkill(path.join(fakeHome, ".claude", "skills", "my-skill"), "my-skill", "does a thing");
      writeClaudeCodeSkillEnabled(projectCwd, "my-skill", false);
      const skills = await listProjectSkills(projectCwd);
      const found = skills.find((s) => s.name === "my-skill");
      expect(found?.enabledByAgent["claude-code"]).toBe(false);
    });

    it("claude-code stays null for a builtin-scope (plugin-sourced) skill while a project-scope skill is a real boolean (issue #467)", async () => {
      writeSkill(
        path.join(fakeHome, ".claude", "plugins", "some-plugin", "skills", "plugin-skill"),
        "plugin-skill",
        "from a plugin",
      );
      mkdirSync(path.join(fakeHome, ".claude", "plugins"), { recursive: true });
      writeFileSync(
        path.join(fakeHome, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "some-plugin": [
              { installPath: path.join(fakeHome, ".claude", "plugins", "some-plugin") },
            ],
          },
        }),
      );
      writeSkill(
        path.join(projectCwd, ".claude", "skills", "project-skill"),
        "project-skill",
        "a normal project skill",
      );
      const skills = await listProjectSkills(projectCwd);
      expect(
        skills.find((s) => s.name === "plugin-skill")?.enabledByAgent["claude-code"],
      ).toBeNull();
      expect(skills.find((s) => s.name === "project-skill")?.enabledByAgent["claude-code"]).toBe(
        true,
      );
    });

    it("claude-code degrades both rows to null when two directories share a basename across scopes (issue #467)", async () => {
      writeSkill(path.join(fakeHome, ".claude", "skills", "shared"), "globalName", "global copy");
      writeSkill(
        path.join(projectCwd, ".claude", "skills", "shared"),
        "projectName",
        "project copy",
      );
      const skills = await listProjectSkills(projectCwd);
      const globalRow = skills.find((s) => s.name === "globalName");
      const projectRow = skills.find((s) => s.name === "projectName");
      expect(globalRow?.enabledByAgent["claude-code"]).toBeNull();
      expect(projectRow?.enabledByAgent["claude-code"]).toBeNull();
    });

    it("is null (ambiguous) for both rows when two different directories share a name for the same agent", async () => {
      writeSkill(path.join(fakeHome, ".codex", "skills", "dup"), "dup", "first copy");
      writeSkill(path.join(fakeHome, ".agents", "skills", "dup"), "dup", "second copy");
      const skills = await listGlobalSkills();
      const matches = skills.filter((s) => s.name === "dup");
      expect(matches).toHaveLength(2);
      expect(matches[0].enabledByAgent.codex).toBeNull();
      expect(matches[1].enabledByAgent.codex).toBeNull();
    });

    it("degrades to null (not toggleable) rather than failing the whole listing when config.toml is unparseable", async () => {
      writeSkill(path.join(fakeHome, ".codex", "skills", "my-skill"), "my-skill", "does a thing");
      mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
      writeFileSync(path.join(fakeHome, ".codex", "config.toml"), "not valid toml [[[");
      const skills = await listGlobalSkills();
      const found = skills.find((s) => s.name === "my-skill");
      expect(found?.enabledByAgent.codex).toBeNull();
    });
  });

  describe("resolveSkillForToggle (issue #463)", () => {
    it("resolves ok:true for a single unambiguous match", async () => {
      writeSkill(path.join(fakeHome, ".codex", "skills", "my-skill"), "my-skill", "does a thing");
      const skills = await listGlobalSkills();
      const result = resolveSkillForToggle(skills, "codex", "my-skill");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.skill.name).toBe("my-skill");
    });

    it("returns not-found for a name that doesn't exist", async () => {
      const result = resolveSkillForToggle([], "codex", "nope");
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns not-toggleable for agy (issue #467)", async () => {
      writeSkill(
        path.join(fakeHome, ".gemini", "antigravity-cli", "builtin", "skills", "my-skill"),
        "my-skill",
        "does a thing",
      );
      const skills = await listGlobalSkills();
      const result = resolveSkillForToggle(skills, "agy", "my-skill");
      expect(result).toEqual({ ok: false, reason: "not-toggleable" });
    });

    it("resolves ok:true for a claude-code project-scope skill (issue #467)", async () => {
      writeSkill(path.join(fakeHome, ".claude", "skills", "my-skill"), "my-skill", "does a thing");
      const skills = await listProjectSkills(projectCwd);
      const result = resolveSkillForToggle(skills, "claude-code", "my-skill");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.skill.name).toBe("my-skill");
    });

    it("returns claude-code-plugin-sourced for a builtin-scope claude-code skill (issue #467)", async () => {
      mkdirSync(path.join(fakeHome, ".claude", "plugins"), { recursive: true });
      writeFileSync(
        path.join(fakeHome, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "some-plugin": [
              { installPath: path.join(fakeHome, ".claude", "plugins", "some-plugin") },
            ],
          },
        }),
      );
      writeSkill(
        path.join(fakeHome, ".claude", "plugins", "some-plugin", "skills", "plugin-skill"),
        "plugin-skill",
        "from a plugin",
      );
      const skills = await listProjectSkills(projectCwd);
      const result = resolveSkillForToggle(skills, "claude-code", "plugin-skill");
      expect(result).toEqual({ ok: false, reason: "claude-code-plugin-sourced" });
    });

    it("returns claude-code-basename-collision when two scopes share a directory basename (issue #467)", async () => {
      writeSkill(path.join(fakeHome, ".claude", "skills", "shared"), "globalName", "global copy");
      writeSkill(
        path.join(projectCwd, ".claude", "skills", "shared"),
        "projectName",
        "project copy",
      );
      const skills = await listProjectSkills(projectCwd);
      const result = resolveSkillForToggle(skills, "claude-code", "projectName");
      expect(result).toEqual({ ok: false, reason: "claude-code-basename-collision" });
    });

    it("returns ambiguous when two directories share a name for the target agent", async () => {
      writeSkill(path.join(fakeHome, ".codex", "skills", "dup"), "dup", "first copy");
      writeSkill(path.join(fakeHome, ".agents", "skills", "dup"), "dup", "second copy");
      const skills = await listGlobalSkills();
      const result = resolveSkillForToggle(skills, "codex", "dup");
      expect(result).toEqual({ ok: false, reason: "ambiguous" });
    });
  });

  describe("toggleSkillEnabled — dangerous name guard (issue #463, CodeQL)", () => {
    it("rejects a __proto__ name before ever running discovery or writing", async () => {
      await expect(toggleSkillEnabled(projectCwd, "codex", "__proto__", false)).rejects.toThrow(
        InvalidSkillNameError,
      );
    });

    it("classifySkillToggleError maps it to 400", async () => {
      const err = await toggleSkillEnabled(projectCwd, "codex", "__proto__", false).catch(
        (e: unknown) => e,
      );
      expect(classifySkillToggleError(err)).toEqual({
        statusCode: 400,
        message: 'Refusing to use "__proto__" as a skill name',
      });
    });
  });

  // Hermes review, PR #469, round 3 — through the full toggleSkillEnabled
  // path, not just the writer unit, so the route-facing error classification
  // is covered too.
  describe("toggleSkillEnabled — opencode disable refuses a user-authored non-deny value", () => {
    it("rejects with OpenCodeSkillUserAuthoredError and classifySkillToggleError maps it to 400", async () => {
      writeSkill(
        path.join(fakeHome, ".config", "opencode", "skills", "my-skill"),
        "my-skill",
        "does a thing",
      );
      const configPath = resolveOpenCodeConfigPath();
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ permission: { skill: { "my-skill": "ask" } } }));

      const err = await toggleSkillEnabled(projectCwd, "opencode", "my-skill", false).catch(
        (e: unknown) => e,
      );
      expect((err as Error).name).toBe("OpenCodeSkillUserAuthoredError");
      expect(classifySkillToggleError(err)).toEqual({
        statusCode: 400,
        message: 'permission.skill already has a user-authored entry for "my-skill"',
      });
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

  // Independent review, PR #459 — __testing exported these specifically so
  // the deadline race could be proven, mirroring agent-rules.test.ts's own
  // identically-named describe block, but nothing here actually exercised
  // them: no test proved a hung fs operation produces a SkillsTimeoutError.
  describe("withReadDeadline", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects with SkillsTimeoutError once the deadline elapses, for an operation that never resolves", async () => {
      vi.useFakeTimers();
      const neverResolves = new Promise<string>(() => {});
      const assertion = expect(withReadDeadline(neverResolves, "/some/path")).rejects.toThrow(
        SkillsTimeoutError,
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

    it("clears its deadline timer once the operation resolves, leaving no pending timer behind", async () => {
      vi.useFakeTimers();
      await withReadDeadline(Promise.resolve("done"), "/some/path");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
