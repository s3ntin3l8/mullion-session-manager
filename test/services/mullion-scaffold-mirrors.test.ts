import { describe, it, expect } from "vitest";
import {
  computeScaffold,
  PRETTIER_IGNORE_MARKER_START,
  PRETTIER_IGNORE_MARKER_END,
  SCAFFOLD_REGION_START,
  SCAFFOLD_REGION_END,
} from "../../src/services/mullion-scaffold.js";
import { extractMarkedRegion } from "../../src/services/marked-region.js";

describe("computeScaffold — skill mirrors", () => {
  it("falls back to the .claude reviewer path when no codex reviewer mirror is emitted", () => {
    const reviewer = "---\nname: demo-reviewer\ndescription: >\n  folded\n---\nbody\n";
    const entries = computeScaffold(
      { ".claude/agents/demo-reviewer.md": reviewer },
      { slug: "demo" },
    );
    expect(entries.map((e) => e.path)).not.toContain(".agents/skills/demo-reviewer/SKILL.md");
    const region = extractMarkedRegion(
      (entries.find((e) => e.path === "AGENTS.md") as { contents: string }).contents,
      SCAFFOLD_REGION_START,
      SCAFFOLD_REGION_END,
    );
    expect(region).toContain(".agents/skills/demo/SKILL.md");
    expect(region).toContain(".claude/agents/demo-reviewer.md");
  });

  describe(".prettierignore covering only one skill mirror", () => {
    const prettierIgnore = (entries: ReturnType<typeof computeScaffold>) =>
      (entries.find((e) => e.path === ".prettierignore") as { contents: string } | undefined)
        ?.contents;

    it("offers .agents/ when only .claude/ is ignored, idempotently", () => {
      const once = prettierIgnore(
        computeScaffold({ ".prettierignore": "dist/\n.claude/\n" }, { slug: "demo" }),
      ) as string;
      expect(once).toContain("dist/\n.claude/");
      expect(
        extractMarkedRegion(once, PRETTIER_IGNORE_MARKER_START, PRETTIER_IGNORE_MARKER_END),
      ).toBe(".agents/");
      expect(prettierIgnore(computeScaffold({ ".prettierignore": once }, { slug: "demo" }))).toBe(
        once,
      );
    });

    it("offers .claude/ when only .agents/ is ignored", () => {
      const out = prettierIgnore(
        computeScaffold({ ".prettierignore": "/.agents/**\n" }, { slug: "demo" }),
      );
      expect(out).toContain(".claude/");
    });

    it("stays silent when both, neither, no file, a symlinked mirror or no skill", () => {
      for (const text of [".claude/\n.agents/\n", "dist/\n# .claude/\n", "!.claude/\n"]) {
        expect(
          prettierIgnore(computeScaffold({ ".prettierignore": text }, { slug: "demo" })),
        ).toBeUndefined();
      }
      expect(prettierIgnore(computeScaffold({}, { slug: "demo" }))).toBeUndefined();
      const one = { ".prettierignore": ".claude/\n" };
      expect(
        prettierIgnore(computeScaffold(one, { slug: "demo", symlinkAgentsSkills: true })),
      ).toBeUndefined();
      expect(
        prettierIgnore(computeScaffold(one, { slug: "demo", includeSkillAndReviewer: false })),
      ).toBeUndefined();
    });
  });
});
