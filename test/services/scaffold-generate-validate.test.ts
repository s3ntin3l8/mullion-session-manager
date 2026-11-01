import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { validateGenerationOutput } from "../../src/services/scaffold-generate.js";

describe("validateGenerationOutput", () => {
  // A scratch worktree holding a few real files, so cited paths can resolve.
  let work: string;
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "validate-gen-"));
    for (const f of [
      "src/services/scaffold-generate.ts",
      "test/routes/internal.test.ts",
      "src/config.ts",
      "docs/README.md",
      "src/services/app.ts",
      "src/util.ts",
    ]) {
      fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
      fs.writeFileSync(path.join(work, f), "");
    }
  });
  afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

  const content = (text: string) => ({
    skill: text,
    reviewer: "",
    scaffoldRegion: "",
    sandboxed: true,
  });

  it("returns possiblyGeneric: false when no file paths are referenced", () => {
    const result = validateGenerationOutput(
      content("This is a pure prose description with no file references."),
      work,
    );
    expect(result.possiblyGeneric).toBe(false);
    expect(result.referencedPaths).toEqual([]);
  });

  it("flags content with only bare filenames as possiblyGeneric", () => {
    const result = validateGenerationOutput(
      content("Create index.ts and util.js for the scaffold."),
      work,
    );
    expect(result.possiblyGeneric).toBe(true);
    expect(result.referencedPaths).toEqual([]);
  });

  it("passes content with deep multi-segment paths", () => {
    const result = validateGenerationOutput(
      content("Edit src/services/scaffold-generate.ts and test/routes/internal.test.ts."),
      work,
    );
    expect(result.possiblyGeneric).toBe(false);
    expect(result.referencedPaths).toEqual(
      expect.arrayContaining(["src/services/scaffold-generate.ts", "test/routes/internal.test.ts"]),
    );
  });

  it("passes two-segment paths under standard directories", () => {
    const result = validateGenerationOutput(
      content("Update src/config.ts and docs/README.md."),
      work,
    );
    expect(result.possiblyGeneric).toBe(false);
    expect(result.referencedPaths).toEqual(
      expect.arrayContaining(["src/config.ts", "docs/README.md"]),
    );
  });

  it("filters out absolute paths", () => {
    const result = validateGenerationOutput(
      content("Referenced /etc/passwd and src/services/app.ts."),
      work,
    );
    expect(result.referencedPaths).not.toContain("/etc/passwd");
    expect(result.referencedPaths).toContain("src/services/app.ts");
  });

  it("filters out paths with parent-directory traversal", () => {
    const result = validateGenerationOutput(content("Used ../secret.ts and src/util.ts."), work);
    expect(result.referencedPaths).not.toContain("../secret.ts");
    expect(result.referencedPaths).toContain("src/util.ts");
  });

  it("filters out bare filenames", () => {
    const result = validateGenerationOutput(content("Used index.ts in the description."), work);
    expect(result.referencedPaths).toEqual([]);
    expect(result.possiblyGeneric).toBe(true);
  });

  it("filters out paths with generic placeholder segments", () => {
    const result = validateGenerationOutput(
      content("Created src/example/foo.ts and lib/sample/bar.js."),
      work,
    );
    expect(result.referencedPaths).toEqual([]);
    expect(result.possiblyGeneric).toBe(true);
  });

  it("filters out src/example/ prefixed paths", () => {
    const result = validateGenerationOutput(
      content("Copied src/example/scaffold.ts to the project."),
      work,
    );
    expect(result.referencedPaths).toEqual([]);
    expect(result.possiblyGeneric).toBe(true);
  });

  it("marks possiblyGeneric false when at least one plausible path survives filtering", () => {
    const result = validateGenerationOutput(
      content(
        "The file src/services/app.ts references config.json, and also mentions placeholder.ts.",
      ),
      work,
    );
    expect(result.possiblyGeneric).toBe(false);
    expect(result.referencedPaths).toContain("src/services/app.ts");
    // config.json and placeholder.ts are bare filenames — filtered out
    expect(result.referencedPaths).not.toContain("config.json");
    expect(result.referencedPaths).not.toContain("placeholder.ts");
  });

  it("does not flag content whose cited paths all exist", () => {
    const r = validateGenerationOutput(content("Edit src/util.ts and src/config.ts."), work);
    expect(r.possiblyGeneric).toBe(false);
    expect(r.missingCitedPaths).toBeUndefined();
  });

  it("flags content where fewer than half of the cited paths exist, with the count", () => {
    const r = validateGenerationOutput(
      content("Edit src/util.ts, src/nope/a.ts, src/nope/b.ts and src/nope/c.ts."),
      work,
    );
    expect(r.possiblyGeneric).toBe(true);
    expect(r.missingCitedPaths).toEqual({ missing: 3, cited: 4 });
  });

  it("does not flag when exactly half of the cited paths exist", () => {
    const r = validateGenerationOutput(content("Edit src/util.ts and src/nope/a.ts."), work);
    expect(r.possiblyGeneric).toBe(false);
    expect(r.missingCitedPaths).toEqual({ missing: 1, cited: 2 });
  });

  it("flags content where none of the cited paths exist", () => {
    const r = validateGenerationOutput(content("Edit src/nope/a.ts and src/nope/b.ts."), work);
    expect(r.possiblyGeneric).toBe(true);
    expect(r.missingCitedPaths).toEqual({ missing: 2, cited: 2 });
  });

  it("does not count the skill and reviewer files the scaffold itself writes", () => {
    const r = validateGenerationOutput(
      content("See .claude/skills/x/SKILL.md, .claude/agents/x-reviewer.md and src/util.ts."),
      work,
    );
    expect(r.possiblyGeneric).toBe(false);
    expect(r.missingCitedPaths).toBeUndefined();
  });
});
