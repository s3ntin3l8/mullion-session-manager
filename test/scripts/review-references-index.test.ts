// The per-area review references are only useful if the index that picks them
// stays true: a renamed file, a reference nobody lists, or a glob that no
// longer matches anything would silently stop a reviewer from reading the note
// that was written for that diff. This checks the REAL index against the real
// tree (the script's own behaviour is in review-references.test.ts, against
// fixtures).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../../src/services/git-env.js";
import { INDEX_PATH, loadIndex, matchReferences } from "../../scripts/review-references.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skillDir = path.join(root, ".claude/skills/mullion-review-invariants");
const referencesDir = path.join(skillDir, "references");

const index = loadIndex(root);
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  env: gitEnv(),
})
  .split("\0")
  .filter(Boolean);

describe("mullion-review-invariants reference index", () => {
  it("is valid and non-empty", () => {
    expect(index.length).toBeGreaterThan(0);
    expect(INDEX_PATH).toBe(".claude/skills/mullion-review-invariants/references.json");
  });

  it("lists no reference twice", () => {
    const refs = index.map((e: { ref: string }) => e.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("points every entry at a file that exists under references/", () => {
    for (const { ref } of index) {
      // The index stores POSIX paths; compare against a POSIX form of the
      // directory so the check holds on Windows too.
      expect(path.posix.dirname(ref), ref).toBe(
        path.relative(root, referencesDir).split(path.sep).join("/"),
      );
      expect(fs.existsSync(path.join(root, ref)), ref).toBe(true);
    }
  });

  it("lists every file in references/ (no orphan)", () => {
    const listed = new Set(index.map((e: { ref: string }) => path.basename(e.ref)));
    const onDisk = fs.readdirSync(referencesDir).filter((f) => f.endsWith(".md"));
    expect(onDisk.filter((f) => !listed.has(f))).toEqual([]);
  });

  it("has a glob that matches at least one tracked file, for every glob", () => {
    // A glob that matches nothing means a path was renamed or removed and the
    // reference is no longer reachable from the files it was written for.
    const dead: string[] = [];
    for (const { ref, paths } of index) {
      for (const glob of paths) {
        if (!tracked.some((f) => path.matchesGlob(f, glob)))
          dead.push(`${path.basename(ref)}: ${glob}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("is named by SKILL.md, so a reader of the checklist can find each area", () => {
    const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    for (const { ref } of index) expect(skill, ref).toContain(path.basename(ref));
  });

  it("gives every reference a title and no line-number citations (they rot on the next edit)", () => {
    for (const { ref } of index) {
      const text = fs.readFileSync(path.join(root, ref), "utf8");
      expect(text.startsWith("# "), ref).toBe(true);
      expect(text, ref).not.toMatch(/\.(ts|tsx|mjs):\d+/);
    }
  });

  it("names only code symbols that still exist (a rename must update the note)", () => {
    // Line numbers are not cited, so the other way a note rots is a renamed or
    // removed symbol that it keeps describing. Every identifier-shaped
    // backticked token (camelCase, UPPER_CASE or snake_case, an optional `()`
    // dropped) has to appear in the code, with the same loudness as a dead glob.
    const symbols = new Set<string>();
    for (const { ref } of index) {
      const text = fs.readFileSync(path.join(root, ref), "utf8");
      for (const m of text.matchAll(/`([^`\n]+)`/g)) {
        const token = m[1].trim().replace(/\(\)$/, "");
        if (/^[A-Za-z_]\w*$/.test(token) && (/[A-Z]/.test(token.slice(1)) || token.includes("_"))) {
          symbols.add(token);
        }
      }
    }
    let found = "";
    try {
      found = execFileSync(
        "git",
        [
          "grep",
          "-h",
          "-o",
          "-w",
          "-F",
          ...[...symbols].flatMap((s) => ["-e", s]),
          "--",
          "src",
          "scripts",
          "test",
          "frontend/src",
          "drizzle",
        ],
        { cwd: root, encoding: "utf8", env: gitEnv(), maxBuffer: 64 * 1024 * 1024 },
      );
    } catch {
      // git grep exits 1 when nothing matched; every symbol is then missing.
    }
    const present = new Set(found.split("\n"));
    expect([...symbols].filter((s) => !present.has(s)).sort()).toEqual([]);
  });

  it("answers a task-reconciler diff with the task-loop references and an unrelated diff with none", () => {
    const hit = matchReferences(index, ["src/services/task-reconciler.ts"]).map(
      (m: { ref: string }) => path.basename(m.ref),
    );
    expect(hit).toEqual(
      expect.arrayContaining(["task-reconcile-loop.md", "task-review-ingest-and-handle.md"]),
    );
    expect(matchReferences(index, ["README.md", "docs/cli.md"])).toEqual([]);
  });
});
