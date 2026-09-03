import { describe, it, expect } from "vitest";
import {
  computeScaffold,
  isValidScaffoldSlug,
  InvalidScaffoldSlugError,
  POINTER_MARKER_START,
  POINTER_MARKER_END,
} from "../../src/services/mullion-scaffold.js";
import { extractMarkedRegion } from "../../src/services/marked-region.js";
import { MARKER_START, MARKER_END } from "../../src/services/project-briefing.js";
import { parseSkillFrontmatter } from "../../src/services/skills.js";

describe("isValidScaffoldSlug", () => {
  it("accepts an ordinary slug", () => {
    expect(isValidScaffoldSlug("my-project")).toBe(true);
  });

  it("rejects an empty slug", () => {
    expect(isValidScaffoldSlug("")).toBe(false);
  });

  it("rejects a path-traversal slug", () => {
    expect(isValidScaffoldSlug("../../etc")).toBe(false);
    expect(isValidScaffoldSlug("a/b")).toBe(false);
  });

  it("rejects a dangerous property name", () => {
    expect(isValidScaffoldSlug("__proto__")).toBe(false);
  });
});

describe("computeScaffold", () => {
  it("throws InvalidScaffoldSlugError for an unsafe slug rather than emitting an unsafe path", () => {
    expect(() => computeScaffold({}, { slug: "../evil" })).toThrow(InvalidScaffoldSlugError);
  });

  it("always includes AGENTS.md, CLAUDE.md, the two .claude/ starter files, and .agents/skills", () => {
    const entries = computeScaffold({}, { slug: "demo" });
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("claude/skills/demo/SKILL.md".replace("claude", ".claude"));
    expect(paths).toContain("claude/agents/demo-reviewer.md".replace("claude", ".claude"));
    expect(paths).toContain("agents/skills/demo/SKILL.md".replace("agents", ".agents"));
  });

  it("creates a fresh AGENTS.md with just the briefing region when the file doesn't exist yet", () => {
    const entries = computeScaffold({}, { slug: "demo" });
    const agentsMd = entries.find((e) => e.path === "AGENTS.md");
    expect(agentsMd).toBeDefined();
    expect(agentsMd!.kind).toBe("file");
    const region = extractMarkedRegion(
      (agentsMd as { contents: string }).contents,
      MARKER_START,
      MARKER_END,
    );
    expect(region).toContain("demo");
    expect(region).toContain(".claude/skills/demo/SKILL.md");
  });

  it("upserts the region in place when AGENTS.md already has other content", () => {
    const existing = `# My Project\n\nSome existing prose.\n\n${MARKER_START}\nold region\n${MARKER_END}\n\nmore prose`;
    const entries = computeScaffold({ "AGENTS.md": existing }, { slug: "demo" });
    const agentsMd = entries.find((e) => e.path === "AGENTS.md") as { contents: string };
    expect(agentsMd.contents).toContain("# My Project");
    expect(agentsMd.contents).toContain("more prose");
    expect(agentsMd.contents).not.toContain("old region");
  });

  it("the scaffolded skill's frontmatter parses under skills.ts's own parseSkillFrontmatter", () => {
    const entries = computeScaffold({}, { slug: "demo" });
    const skill = entries.find((e) => e.path === ".claude/skills/demo/SKILL.md") as {
      contents: string;
    };
    const parsed = parseSkillFrontmatter(skill.contents);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("demo");
  });

  it("the scaffolded reviewer's frontmatter also parses (name/description) and names itself <slug>-reviewer", () => {
    const entries = computeScaffold({}, { slug: "demo" });
    const reviewer = entries.find((e) => e.path === ".claude/agents/demo-reviewer.md") as {
      contents: string;
    };
    const parsed = parseSkillFrontmatter(reviewer.contents);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("demo-reviewer");
  });

  // Hermes review, PR #896 round 2 — computeScaffold used to emit the
  // starter skill/reviewer/dock-config unconditionally, silently
  // clobbering a target repo's own hand-edited (or previously-scaffolded-
  // and-since-customized) content on every re-run.
  describe("never clobbers content that already exists", () => {
    const existingSkill =
      "---\nname: demo\ndescription: my own hand-edited skill\n---\ncustom body";
    const existingReviewer =
      "---\nname: demo-reviewer\ndescription: my own hand-edited reviewer\n---\ncustom body";

    it("does not emit an entry for an already-existing skill file", () => {
      const entries = computeScaffold(
        { ".claude/skills/demo/SKILL.md": existingSkill },
        { slug: "demo" },
      );
      expect(entries.some((e) => e.path === ".claude/skills/demo/SKILL.md")).toBe(false);
    });

    it("does not emit an entry for an already-existing reviewer file", () => {
      const entries = computeScaffold(
        { ".claude/agents/demo-reviewer.md": existingReviewer },
        { slug: "demo" },
      );
      expect(entries.some((e) => e.path === ".claude/agents/demo-reviewer.md")).toBe(false);
    });

    it("does not emit an entry for an already-existing .crs/dock.json", () => {
      const entries = computeScaffold(
        { ".crs/dock.json": '{"controls":[{"id":"x","title":"t","command":"c"}]}' },
        { slug: "demo", includeDockConfig: true },
      );
      expect(entries.some((e) => e.path === ".crs/dock.json")).toBe(false);
    });

    it("the .agents/skills file mirror still carries the PRESERVED skill content, not a freshly-regenerated starter", () => {
      const entries = computeScaffold(
        { ".claude/skills/demo/SKILL.md": existingSkill },
        { slug: "demo" },
      );
      const mirror = entries.find((e) => e.path === ".agents/skills/demo/SKILL.md") as {
        contents: string;
      };
      expect(mirror).toBeDefined();
      expect(mirror.contents).toBe(existingSkill);
    });

    it("existence sentinel (empty string) is still treated as 'already exists', not overwritten", () => {
      // routes/project-setup.ts's readExistingFiles uses "" as an
      // existence-only sentinel for paths it can't read as text (a
      // directory, or a symlink to one) — computeScaffold must treat that
      // the same as real content, never as "absent, generate fresh".
      const entries = computeScaffold({ ".claude/skills/demo/SKILL.md": "" }, { slug: "demo" });
      expect(entries.some((e) => e.path === ".claude/skills/demo/SKILL.md")).toBe(false);
    });
  });

  it("no GEMINI.md, no AGENTS.override.md, no CONTRIBUTING.md pointer, no dock config, no symlink by default", () => {
    const entries = computeScaffold({}, { slug: "demo" });
    expect(entries.some((e) => e.path === "GEMINI.md")).toBe(false);
    expect(entries.some((e) => e.path === "AGENTS.override.md")).toBe(false);
    expect(entries.some((e) => e.path === "CONTRIBUTING.md")).toBe(false);
    expect(entries.some((e) => e.path === ".crs/dock.json")).toBe(false);
    const agentsSkills = entries.find((e) => e.path === ".agents/skills/demo/SKILL.md");
    expect(agentsSkills?.kind).toBe("file");
  });

  // Issue #942 (this restructure) — CLAUDE.md is unconditional, like
  // AGENTS.md, not opt-in like CONTRIBUTING.md's pointer:
  // without it, Claude Code (which does not read AGENTS.md natively) gets
  // nothing from this scaffold at all.
  describe("CLAUDE.md @AGENTS.md import (issue #942)", () => {
    it("creates a fresh CLAUDE.md containing the @AGENTS.md import when none exists", () => {
      const entries = computeScaffold({}, { slug: "demo" });
      const claudeMd = entries.find((e) => e.path === "CLAUDE.md") as { contents: string };
      expect(claudeMd).toBeDefined();
      const region = extractMarkedRegion(
        claudeMd.contents,
        POINTER_MARKER_START,
        POINTER_MARKER_END,
      );
      expect(region).toContain("@AGENTS.md");
    });

    // The regression guard for the highest-risk line in this change: every
    // existing pointer body in this module wraps filenames in backticks
    // (contributingPointerBody's "See `AGENTS.md`'s Workflow Conventions
    // ..."). Following that convention here would put the import inside a
    // Markdown code span,
    // which Claude Code's importer SKIPS — a silent no-op that would still
    // pass every other assertion in this file and look correct in review.
    it("the import line is bare — no backticks, no fence, alone on its own line", () => {
      const entries = computeScaffold({}, { slug: "demo" });
      const claudeMd = entries.find((e) => e.path === "CLAUDE.md") as { contents: string };
      expect(/^@AGENTS\.md$/m.test(claudeMd.contents)).toBe(true);
      expect(claudeMd.contents).not.toContain("`@AGENTS.md`");
      expect(claudeMd.contents).not.toContain("```");
    });

    it("upserts the region into an existing multi-section CLAUDE.md without disturbing the rest", () => {
      const existing =
        "# CLAUDE.md — My Project\n\n## Architecture\n\nSome hand-written architecture notes.\n";
      const entries = computeScaffold({ "CLAUDE.md": existing }, { slug: "demo" });
      const claudeMd = entries.find((e) => e.path === "CLAUDE.md") as { contents: string };
      expect(claudeMd.contents).toContain("## Architecture");
      expect(claudeMd.contents).toContain("Some hand-written architecture notes.");
      expect(claudeMd.contents).toContain("@AGENTS.md");
    });

    it("replaces a stale import region on a re-run rather than duplicating it", () => {
      const existingClaude = `${POINTER_MARKER_START}\nstale import text\n${POINTER_MARKER_END}`;
      const entries = computeScaffold({ "CLAUDE.md": existingClaude }, { slug: "demo" });
      const claudeMd = entries.find((e) => e.path === "CLAUDE.md") as { contents: string };
      expect(claudeMd.contents).not.toContain("stale import text");
    });

    it("strips a pre-#942 byte-identical mirror region before writing the import", () => {
      const preExistingMirror = `# CLAUDE.md\n\n${MARKER_START}\nold mirrored briefing content\n${MARKER_END}\n`;
      const entries = computeScaffold({ "CLAUDE.md": preExistingMirror }, { slug: "demo" });
      const claudeMd = entries.find((e) => e.path === "CLAUDE.md") as { contents: string };
      expect(claudeMd.contents).not.toContain("old mirrored briefing content");
      expect(extractMarkedRegion(claudeMd.contents, MARKER_START, MARKER_END)).toBeNull();
      expect(
        extractMarkedRegion(claudeMd.contents, POINTER_MARKER_START, POINTER_MARKER_END),
      ).toContain("@AGENTS.md");
    });

    it("never writes a mullion:briefing region into CLAUDE.md, only the pointer region", () => {
      const entries = computeScaffold({}, { slug: "demo" });
      const claudeMd = entries.find((e) => e.path === "CLAUDE.md") as { contents: string };
      expect(extractMarkedRegion(claudeMd.contents, MARKER_START, MARKER_END)).toBeNull();
    });
  });

  // Issue #942 — new, optional, opt-in-only scaffold target.
  describe("CONTRIBUTING.md pointer (issue #942)", () => {
    it("creates a fresh, pointer-only CONTRIBUTING.md when the option is on and none exists", () => {
      const entries = computeScaffold({}, { slug: "demo", includeContributingPointer: true });
      const contributing = entries.find((e) => e.path === "CONTRIBUTING.md") as {
        contents: string;
      };
      expect(contributing).toBeDefined();
      const pointerRegion = extractMarkedRegion(
        contributing.contents,
        POINTER_MARKER_START,
        POINTER_MARKER_END,
      );
      expect(pointerRegion).toContain("AGENTS.md");
    });

    it("upserts just the pointer paragraph into an existing CONTRIBUTING.md, leaving the rest alone", () => {
      const existing = "# Contributing\n\n## Code of Conduct\n\nBe excellent to each other.\n";
      const entries = computeScaffold(
        { "CONTRIBUTING.md": existing },
        { slug: "demo", includeContributingPointer: true },
      );
      const contributing = entries.find((e) => e.path === "CONTRIBUTING.md") as {
        contents: string;
      };
      expect(contributing.contents).toContain("Code of Conduct");
      expect(contributing.contents).toContain("Be excellent to each other.");
      expect(contributing.contents).toContain("AGENTS.md");
    });

    it("never creates or touches CONTRIBUTING.md when the option is off, even if one exists", () => {
      const entries = computeScaffold(
        { "CONTRIBUTING.md": "# Contributing\n\nhand-authored" },
        { slug: "demo" },
      );
      expect(entries.some((e) => e.path === "CONTRIBUTING.md")).toBe(false);
    });
  });

  it("makes .agents/skills/<slug> a symlink into .claude/skills/<slug> when opted in", () => {
    const entries = computeScaffold({}, { slug: "demo", symlinkAgentsSkills: true });
    const link = entries.find((e) => e.path === ".agents/skills/demo");
    expect(link).toBeDefined();
    expect(link!.kind).toBe("symlink");
    expect((link as { target: string }).target).toBe("../../../.claude/skills/demo");
    // No separate regular-file duplicate when symlinked.
    expect(entries.some((e) => e.path === ".agents/skills/demo/SKILL.md")).toBe(false);
  });

  it("includes an empty, valid .crs/dock.json when opted in", () => {
    const entries = computeScaffold({}, { slug: "demo", includeDockConfig: true });
    const dock = entries.find((e) => e.path === ".crs/dock.json") as { contents: string };
    expect(dock).toBeDefined();
    expect(JSON.parse(dock.contents)).toEqual({ controls: [] });
  });

  it("is pure — the same inputs always produce byte-identical output", () => {
    const options = { slug: "demo", includeContributingPointer: true };
    const a = computeScaffold({ "AGENTS.md": "# hi" }, options);
    const b = computeScaffold({ "AGENTS.md": "# hi" }, options);
    expect(a).toEqual(b);
  });
});
