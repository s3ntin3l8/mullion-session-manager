import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("always includes AGENTS.md, the two .claude/ starter files, and .agents/skills", () => {
    const entries = computeScaffold({}, { slug: "demo" });
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("AGENTS.md");
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

  it("no mirrors, no CONTRIBUTING.md pointer, no dock config, no symlink by default", () => {
    const entries = computeScaffold({}, { slug: "demo" });
    expect(entries.some((e) => e.path === "GEMINI.md")).toBe(false);
    expect(entries.some((e) => e.path === "AGENTS.override.md")).toBe(false);
    expect(entries.some((e) => e.path === "CONTRIBUTING.md")).toBe(false);
    expect(entries.some((e) => e.path.endsWith("check-briefing-sync.mjs"))).toBe(false);
    expect(entries.some((e) => e.path === ".crs/dock.json")).toBe(false);
    const agentsSkills = entries.find((e) => e.path === ".agents/skills/demo/SKILL.md");
    expect(agentsSkills?.kind).toBe("file");
  });

  // Issue #942 — GEMINI.md is no longer a content mirror; AGENTS.override.md
  // is no longer offered as an option at all.
  describe("GEMINI.md pointer (issue #942)", () => {
    it("writes a one-line pointer to AGENTS.md, not a copy of the briefing region, plus the sync script", () => {
      const entries = computeScaffold({}, { slug: "demo", mirrors: ["GEMINI.md"] });
      const gemini = entries.find((e) => e.path === "GEMINI.md") as { contents: string };
      expect(gemini).toBeDefined();
      const pointerRegion = extractMarkedRegion(
        gemini.contents,
        POINTER_MARKER_START,
        POINTER_MARKER_END,
      );
      expect(pointerRegion).toContain("AGENTS.md");
      // Never a copy of AGENTS.md's own briefing region.
      expect(extractMarkedRegion(gemini.contents, MARKER_START, MARKER_END)).toBeNull();
      expect(entries.some((e) => e.path === "scripts/check-briefing-sync.mjs")).toBe(true);
    });

    it("upserts the pointer in place without disturbing existing GEMINI.md content", () => {
      const existingGemini = "# GEMINI.md\n\nSome existing prose.\n";
      const entries = computeScaffold(
        { "GEMINI.md": existingGemini },
        { slug: "demo", mirrors: ["GEMINI.md"] },
      );
      const gemini = entries.find((e) => e.path === "GEMINI.md") as { contents: string };
      expect(gemini.contents).toContain("Some existing prose.");
      expect(gemini.contents).toContain("AGENTS.md");
    });

    it("replaces a stale pointer region on a re-run rather than duplicating it", () => {
      const existingGemini = `${POINTER_MARKER_START}\nstale pointer text\n${POINTER_MARKER_END}`;
      const entries = computeScaffold(
        { "GEMINI.md": existingGemini },
        { slug: "demo", mirrors: ["GEMINI.md"] },
      );
      const gemini = entries.find((e) => e.path === "GEMINI.md") as { contents: string };
      expect(gemini.contents).not.toContain("stale pointer text");
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
    const options = { slug: "demo", mirrors: ["GEMINI.md"] as const };
    const a = computeScaffold({ "AGENTS.md": "# hi" }, options);
    const b = computeScaffold({ "AGENTS.md": "# hi" }, options);
    expect(a).toEqual(b);
  });

  // The embedded CHECK_BRIEFING_SYNC_SCRIPT is a plain string this module
  // never itself executes — a template-literal escaping mistake would
  // parse fine as TS (it's just a string literal) but produce broken JS at
  // runtime, silently, until someone actually ran the scaffolded script.
  // Actually running it as a real subprocess is the only way to catch that.
  describe("the embedded check-briefing-sync.mjs script actually runs", () => {
    let tmpDir: string;

    function writeScript(entries: ReturnType<typeof computeScaffold>) {
      const script = entries.find((e) => e.path === "scripts/check-briefing-sync.mjs") as {
        contents: string;
      };
      mkdirSync(path.join(tmpDir, "scripts"), { recursive: true });
      writeFileSync(path.join(tmpDir, "scripts", "check-briefing-sync.mjs"), script.contents);
    }

    function runScript(): { status: number; stdout: string; stderr: string } {
      try {
        const stdout = execFileSync(
          "node",
          [path.join(tmpDir, "scripts", "check-briefing-sync.mjs")],
          {
            cwd: tmpDir,
            encoding: "utf8",
          },
        );
        return { status: 0, stdout, stderr: "" };
      } catch (err) {
        const e = err as { status: number; stdout: string; stderr: string };
        return { status: e.status, stdout: e.stdout, stderr: e.stderr };
      }
    }

    it("exits 0 when GEMINI.md carries only the plain pointer (no content-bearing region)", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "briefing-sync-ok-"));
      try {
        const entries = computeScaffold({}, { slug: "demo", mirrors: ["GEMINI.md"] });
        for (const entry of entries) {
          if (entry.path === "AGENTS.md" || entry.path === "GEMINI.md") {
            writeFileSync(path.join(tmpDir, entry.path), (entry as { contents: string }).contents);
          }
        }
        writeScript(entries);
        const result = runScript();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("OK");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("exits 1 when GEMINI.md re-acquires a content-bearing mullion:briefing region", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "briefing-sync-mismatch-"));
      try {
        const entries = computeScaffold({}, { slug: "demo", mirrors: ["GEMINI.md"] });
        for (const entry of entries) {
          if (entry.path === "AGENTS.md") {
            writeFileSync(path.join(tmpDir, entry.path), (entry as { contents: string }).contents);
          }
        }
        writeFileSync(
          path.join(tmpDir, "GEMINI.md"),
          `${MARKER_START}\nsomething copied back in\n${MARKER_END}\n`,
        );
        writeScript(entries);
        const result = runScript();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("single source of truth");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("exits 1 when AGENTS.override.md carries a content-bearing mullion:briefing region", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "briefing-sync-override-"));
      try {
        const entries = computeScaffold({}, { slug: "demo", mirrors: ["GEMINI.md"] });
        for (const entry of entries) {
          if (entry.path === "AGENTS.md" || entry.path === "GEMINI.md") {
            writeFileSync(path.join(tmpDir, entry.path), (entry as { contents: string }).contents);
          }
        }
        writeFileSync(
          path.join(tmpDir, "AGENTS.override.md"),
          `${MARKER_START}\nshadowing AGENTS.md\n${MARKER_END}\n`,
        );
        writeScript(entries);
        const result = runScript();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("AGENTS.override.md");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
