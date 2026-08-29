import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveMullionBundleDir,
  installBundleSkills,
  uninstallBundleSkills,
  deriveContentName,
  composeClaudeSessionBundle,
  deriveOpenCodeReviewerAgentFile,
} from "../../../src/services/hook-adapters/mullion-bundle.js";

const VALID_SKILL = `---
name: my-project-skill
description: A project-specific skill.
---

Do the project-specific thing.
`;

const VALID_REVIEWER_AGENT = `---
name: my-project-reviewer
description: Reviews diffs for this project's own invariants.
tools: Read, Grep, Glob, Bash
model: inherit
---

You are reviewing a change in this project.
`;

// Same resolution shape as shared.test.ts's resolveForwarderPath coverage —
// import.meta.url-relative in a dev checkout, MULLION_HOME's stable
// `current/dist` symlink on a versioned-release install — plus the
// existence check neither of those functions has: resolveMullionBundleDir
// must return null (never a dangling path) whenever the bundle isn't
// actually there, since claude-code.ts's commandTransform decides whether
// to emit `--plugin-dir` based on this return value alone.
describe("resolveMullionBundleDir", () => {
  const originalMullionHome = process.env.MULLION_HOME;

  beforeEach(() => {
    delete process.env.MULLION_HOME;
  });

  afterEach(() => {
    if (originalMullionHome === undefined) delete process.env.MULLION_HOME;
    else process.env.MULLION_HOME = originalMullionHome;
  });

  it("resolves the checked-in src/bundle dir when MULLION_HOME is unset (dev checkout)", () => {
    const dir = resolveMullionBundleDir();
    expect(dir).not.toBeNull();
    expect(dir).not.toContain("current");
    expect(dir?.endsWith(path.join("src", "bundle"))).toBe(true);
  });

  it("returns null when MULLION_HOME points at a location with no bundle", () => {
    process.env.MULLION_HOME = "/nonexistent/mullion/home";
    expect(resolveMullionBundleDir()).toBeNull();
  });

  it("treats a blank MULLION_HOME the same as unset", () => {
    process.env.MULLION_HOME = "   ";
    expect(resolveMullionBundleDir()).not.toBeNull();
  });
});

// installBundleSkills/uninstallBundleSkills — the zero-repo-change delivery
// vehicle for codex and agy (neither has an ephemeral per-session overlay
// the way Claude Code's --plugin-dir or opencode's skills.paths config key
// do). destRoot is a plain scratch dir here, not a real
// ~/.agents/skills or ~/.gemini/config/skills — codex.test.ts/agy.test.ts
// cover the real per-agent destRoot resolution and HOME redirection; this
// file only needs to prove the copy/containment logic itself.
describe("installBundleSkills / uninstallBundleSkills", () => {
  let destRoot: string;

  beforeEach(() => {
    destRoot = mkdtempSync(path.join(os.tmpdir(), "mullion-bundle-install-"));
  });

  afterEach(() => {
    rmSync(destRoot, { recursive: true, force: true });
  });

  it("installs every shipped skill under destRoot/mullion-<name>/", () => {
    installBundleSkills(destRoot);
    const skillPath = path.join(destRoot, "mullion-mullion-host", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("mullion-host");
  });

  it("is idempotent — a second install call doesn't touch files whose content already matches", async () => {
    installBundleSkills(destRoot);
    const skillPath = path.join(destRoot, "mullion-mullion-host", "SKILL.md");
    const mtimeBefore = statSync(skillPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 5));
    installBundleSkills(destRoot);

    const mtimeAfter = statSync(skillPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("overwrites a file whose on-disk content has drifted from the shipped skill", () => {
    installBundleSkills(destRoot);
    const skillPath = path.join(destRoot, "mullion-mullion-host", "SKILL.md");
    writeFileSync(skillPath, "stale, hand-edited content");

    installBundleSkills(destRoot);

    expect(readFileSync(skillPath, "utf8")).not.toBe("stale, hand-edited content");
    expect(readFileSync(skillPath, "utf8")).toContain("mullion-host");
  });

  it("uninstall removes every mullion-<name>/ directory it would have installed", () => {
    installBundleSkills(destRoot);
    expect(existsSync(path.join(destRoot, "mullion-mullion-host"))).toBe(true);

    uninstallBundleSkills(destRoot);

    expect(existsSync(path.join(destRoot, "mullion-mullion-host"))).toBe(false);
  });

  // Hermes review, PR #891 — the prefix alone is a naming convention, not
  // proof of ownership: a user could plausibly have their own skill named
  // e.g. `mullion-helper`, parallel to Mullion's own `mullion-host`. Only a
  // directory carrying the ownership marker installBundleSkills writes may
  // ever be removed.
  it("uninstall never removes a mullion-prefixed directory that isn't Mullion's own — no ownership marker, no delete", () => {
    const lookalikeDir = path.join(destRoot, "mullion-helper");
    mkdirSync(lookalikeDir, { recursive: true });
    writeFileSync(path.join(lookalikeDir, "SKILL.md"), "not mine to touch");
    installBundleSkills(destRoot);

    uninstallBundleSkills(destRoot);

    expect(existsSync(path.join(lookalikeDir, "SKILL.md"))).toBe(true);
    // The real install is still removed correctly — this isn't uninstall
    // going inert, just correctly discriminating.
    expect(existsSync(path.join(destRoot, "mullion-mullion-host"))).toBe(false);
  });

  // Hermes review, PR #891 round 2 — install was asymmetric with uninstall:
  // uninstall correctly refuses an unmarked mullion-prefixed dir, but
  // install would happily sync files into one (and then claim it by
  // writing the marker), silently absorbing a colliding user-owned
  // directory. Names the double-prefixed collision explicitly
  // (`mullion-mullion-host`, this bundle's actual install target) rather
  // than a name that would never collide in practice.
  it("install never overwrites or claims a pre-existing directory at its own target path that has no ownership marker", () => {
    const collisionDir = path.join(destRoot, "mullion-mullion-host");
    mkdirSync(collisionDir, { recursive: true });
    writeFileSync(path.join(collisionDir, "SKILL.md"), "not mine to overwrite");

    installBundleSkills(destRoot);

    expect(readFileSync(path.join(collisionDir, "SKILL.md"), "utf8")).toBe("not mine to overwrite");
    expect(existsSync(path.join(collisionDir, ".mullion-managed"))).toBe(false);
  });

  it("installs a marker file inside each installed skill directory", () => {
    installBundleSkills(destRoot);
    expect(existsSync(path.join(destRoot, "mullion-mullion-host", ".mullion-managed"))).toBe(true);
  });

  it("uninstall never touches a directory without the mullion- prefix", () => {
    const userSkillDir = path.join(destRoot, "my-own-skill");
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(path.join(userSkillDir, "SKILL.md"), "mine");
    installBundleSkills(destRoot);

    uninstallBundleSkills(destRoot);

    expect(existsSync(path.join(userSkillDir, "SKILL.md"))).toBe(true);
  });

  it("uninstall is a no-op (not a throw) when destRoot doesn't exist at all", () => {
    rmSync(destRoot, { recursive: true, force: true });
    expect(() => uninstallBundleSkills(destRoot)).not.toThrow();
  });

  it("install is a no-op when MULLION_HOME points at a location shipping no bundle", () => {
    const originalMullionHome = process.env.MULLION_HOME;
    process.env.MULLION_HOME = "/nonexistent/mullion/home";
    try {
      expect(() => installBundleSkills(destRoot)).not.toThrow();
      expect(existsSync(path.join(destRoot, "mullion-mullion-host"))).toBe(false);
    } finally {
      if (originalMullionHome === undefined) delete process.env.MULLION_HOME;
      else process.env.MULLION_HOME = originalMullionHome;
    }
  });
});

describe("deriveContentName", () => {
  it("returns the frontmatter name for valid skill/reviewer content", () => {
    expect(deriveContentName(VALID_SKILL)).toBe("my-project-skill");
    expect(deriveContentName(VALID_REVIEWER_AGENT)).toBe("my-project-reviewer");
  });

  it("returns null for unparseable frontmatter", () => {
    expect(deriveContentName("not frontmatter at all")).toBeNull();
  });

  it("returns null for a dangerous frontmatter name", () => {
    expect(deriveContentName("---\nname: __proto__\ndescription: nope\n---\nbody")).toBeNull();
  });
});

// composeClaudeSessionBundle — PR-5's per-session --plugin-dir composition:
// the shipped bundle's own tree, verbatim, plus a project's own skill/
// reviewer content under frontmatter-derived names.
describe("composeClaudeSessionBundle", () => {
  it("includes the shipped bundle's own files even with no project content", () => {
    const files = composeClaudeSessionBundle("/session/123.mullion-bundle", {});
    expect(files).not.toBeNull();
    const relPaths = files!.map((f) => f.path);
    expect(relPaths.some((p) => p.endsWith(path.join(".claude-plugin", "plugin.json")))).toBe(true);
    expect(relPaths.some((p) => p.endsWith(path.join("skills", "mullion-host", "SKILL.md")))).toBe(
      true,
    );
  });

  it("adds the project skill under skills/<frontmatter-name>/SKILL.md", () => {
    const files = composeClaudeSessionBundle("/session/123.mullion-bundle", { skill: VALID_SKILL });
    const skillFile = files!.find((f) =>
      f.path.endsWith(path.join("skills", "my-project-skill", "SKILL.md")),
    );
    expect(skillFile).toBeDefined();
    expect(skillFile!.contents).toBe(VALID_SKILL);
  });

  it("adds the reviewer agent under agents/<frontmatter-name>.md, verbatim (Claude Code's own shape)", () => {
    const files = composeClaudeSessionBundle("/session/123.mullion-bundle", {
      reviewerAgent: VALID_REVIEWER_AGENT,
    });
    const agentFile = files!.find((f) =>
      f.path.endsWith(path.join("agents", "my-project-reviewer.md")),
    );
    expect(agentFile).toBeDefined();
    expect(agentFile!.contents).toBe(VALID_REVIEWER_AGENT);
  });

  it("silently skips project content with unparseable frontmatter rather than throwing", () => {
    const withoutProjectContent = composeClaudeSessionBundle("/session/123.mullion-bundle", {});
    const withUnparseableSkill = composeClaudeSessionBundle("/session/123.mullion-bundle", {
      skill: "not a skill",
    });
    expect(withUnparseableSkill).toEqual(withoutProjectContent);
  });

  it("returns null when MULLION_HOME points at a location shipping no bundle", () => {
    const originalMullionHome = process.env.MULLION_HOME;
    process.env.MULLION_HOME = "/nonexistent/mullion/home";
    try {
      expect(composeClaudeSessionBundle("/session/123.mullion-bundle", {})).toBeNull();
    } finally {
      if (originalMullionHome === undefined) delete process.env.MULLION_HOME;
      else process.env.MULLION_HOME = originalMullionHome;
    }
  });
});

// deriveOpenCodeReviewerAgentFile — opencode's agent/<name>.md convention
// hard-rejects Claude Code's tools:/model: frontmatter shape at config-load
// time (verified empirically against installed opencode 1.18.23, see the
// function's own doc comment); this must translate, never pass through.
describe("deriveOpenCodeReviewerAgentFile", () => {
  it("strips the content down to description/mode, dropping tools/model", () => {
    const result = deriveOpenCodeReviewerAgentFile(VALID_REVIEWER_AGENT);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("my-project-reviewer");
    expect(result!.contents).not.toContain("tools:");
    expect(result!.contents).not.toContain("model:");
    expect(result!.contents).toContain("mode: subagent");
    expect(result!.contents).toContain(
      'description: "Reviews diffs for this project\'s own invariants."',
    );
    expect(result!.contents).toContain("You are reviewing a change in this project.");
  });

  it("returns null for unparseable frontmatter", () => {
    expect(deriveOpenCodeReviewerAgentFile("not a subagent file")).toBeNull();
  });

  it("returns null for a dangerous frontmatter name", () => {
    expect(
      deriveOpenCodeReviewerAgentFile("---\nname: __proto__\ndescription: nope\n---\nbody"),
    ).toBeNull();
  });
});
