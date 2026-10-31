// scripts/check-max-file-lines.mjs is the guard that stops the codebase's
// largest files from growing further. The code-health audit found 16
// production files over 1,200 code lines, the largest of them holding 59
// route handlers in a single 4,466-line function — and every one of those
// files still absorbing feature commits, because a file that size does not
// fail loudly, it just gets slower to change safely.
//
// The guard is a RATCHET: a file that is already over the ceiling is recorded
// in scripts/max-file-lines.baseline.json at its current size, and fails only
// when it grows past ITS OWN number. So a new file over the ceiling fails,
// and a baselined file over its own ceiling fails — while the existing
// offenders pass, and the ratchet turns over one ceiling at a time.
//
// That makes the boundary logic the whole of the guard's behaviour, and it is
// exactly the part that is easy to get subtly wrong: a baseline that is
// ignored, applied to the wrong file, or compared with the wrong operator
// would either block every commit or protect nothing. So this suite drives
// the real script against fixture trees (precedent:
// test/scripts/check-case-collision.test.ts, which drives its script through
// execFile the same way) and pins each side of the boundary.
//
// It also pins the COUNTING, because the ceiling is only as meaningful as the
// number it is compared against: a comment line counted as code would push a
// file over the ceiling for the wrong reason, and a blank line counted as
// code would do the same.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  countFileLines,
  collectSourceFiles,
  countSourceFiles,
} from "../../scripts/lib/audit-loc-core.mjs";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-max-file-lines.mjs");
const BASELINE = path.join(REPO_ROOT, "scripts", "max-file-lines.baseline.json");

const LIMIT = 1200;

describe("audit-loc-core: countFileLines", () => {
  it("counts code, blank and comment lines separately", () => {
    const counts = countFileLines(
      ["const a = 1;", "", "// a comment", "const b = 2;"].join("\n"),
      "x.ts",
    );
    expect(counts.code).toBe(2);
    expect(counts.blank).toBe(1);
    expect(counts.comment).toBe(1);
    expect(counts.total).toBe(4);
  });

  it("does not count a file's trailing newline as a line", () => {
    const counts = countFileLines("const a = 1;\n", "x.ts");
    expect(counts.total).toBe(1);
    expect(counts.code).toBe(1);
  });

  it("counts a file with no trailing newline the same as one with", () => {
    const withNewline = countFileLines("const a = 1;\n", "x.ts");
    const without = countFileLines("const a = 1;", "x.ts");
    expect(without.code).toBe(withNewline.code);
    expect(without.total).toBe(withNewline.total);
  });

  it("counts an empty file as zero lines", () => {
    expect(countFileLines("", "x.ts").total).toBe(0);
  });

  it("does not count a block comment's lines as code", () => {
    const counts = countFileLines(["/*", " * a block", " */", "const a = 1;"].join("\n"), "x.ts");
    expect(counts.code).toBe(1);
    expect(counts.comment).toBe(3);
  });

  it("counts code that follows a one-line block comment as code", () => {
    const counts = countFileLines("/* note */ const a = 1;", "x.ts");
    expect(counts.code).toBe(1);
    expect(counts.comment).toBe(1);
  });

  it("counts code after a multi-line block comment closes as code", () => {
    const counts = countFileLines(["/*", " */ const a = 1;"].join("\n"), "x.ts");
    expect(counts.code).toBe(1);
  });

  it("treats an indented comment as a comment, not as code", () => {
    const counts = countFileLines("    // indented comment", "x.ts");
    expect(counts.code).toBe(0);
    expect(counts.comment).toBe(1);
  });
});

describe("audit-loc-core: collectSourceFiles", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-loc-collect-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds nested source files and skips non-source extensions", () => {
    fs.mkdirSync(path.join(root, "src", "deep", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;");
    fs.writeFileSync(path.join(root, "src", "deep", "deeper", "b.tsx"), "const b = 1;");
    fs.writeFileSync(path.join(root, "src", "style.css"), "a { color: red; }");
    const found = collectSourceFiles(root, ["src"]);
    expect(found).toEqual(["src/a.ts", "src/deep/deeper/b.tsx"]);
  });

  it("skips the worktree and build directories", () => {
    for (const dir of [".wt", ".mullion-worktrees", ".claude", "node_modules", "dist"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, "big.ts"), "const a = 1;");
    }
    expect(collectSourceFiles(root, ["."])).toEqual([]);
  });
});

describe("check-max-file-lines.mjs", () => {
  let root: string;
  let baselinePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "max-file-lines-test-"));
    baselinePath = path.join(root, "baseline.json");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Write a file with exactly `lines` CODE lines. */
  function writeCodeLines(relPath: string, lines: number): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "const value = 1;\n".repeat(lines));
  }

  /** Write the fixture's baseline. */
  function writeBaseline(files: Record<string, number>, limit = LIMIT): void {
    fs.writeFileSync(baselinePath, JSON.stringify({ limit, files }));
  }

  /** Run the guard against the fixture tree. */
  async function runCheck(): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("node", [
        SCRIPT,
        root,
        "--baseline",
        baselinePath,
      ]);
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  }

  it("passes when every file is under the ceiling", async () => {
    writeCodeLines("src/small.ts", 10);
    writeBaseline({});
    const result = await runCheck();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("fails a NEW file over the ceiling, naming it and its size", async () => {
    writeCodeLines("src/huge.ts", LIMIT + 1);
    writeBaseline({});
    const result = await runCheck();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("src/huge.ts");
    expect(result.stderr).toContain(String(LIMIT + 1));
  });

  it("passes a baselined file that is over the global ceiling but within its own", async () => {
    writeCodeLines("src/huge.ts", LIMIT + 500);
    writeBaseline({ "src/huge.ts": LIMIT + 500 });
    const result = await runCheck();
    expect(result.code).toBe(0);
  });

  it("passes a baselined file exactly AT its recorded ceiling", async () => {
    writeCodeLines("src/huge.ts", LIMIT + 500);
    writeBaseline({ "src/huge.ts": LIMIT + 500 });
    const result = await runCheck();
    expect(result.code).toBe(0);
  });

  it("fails a baselined file that grew past its own ceiling", async () => {
    writeCodeLines("src/huge.ts", LIMIT + 501);
    writeBaseline({ "src/huge.ts": LIMIT + 500 });
    const result = await runCheck();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("src/huge.ts");
  });

  it("reports a baselined file that shrank, so the ratchet can turn over", async () => {
    writeCodeLines("src/shrunk.ts", 100);
    writeBaseline({ "src/shrunk.ts": 900 });
    const result = await runCheck();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("src/shrunk.ts");
  });

  it("reports a baseline entry whose file is gone, without failing", async () => {
    writeCodeLines("src/small.ts", 10);
    writeBaseline({ "src/deleted.ts": 1500 });
    const result = await runCheck();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("src/deleted.ts");
  });

  it("does not scan the worktree and build directories", async () => {
    for (const dir of [".wt", ".mullion-worktrees", ".claude", "node_modules", "dist"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, "huge.ts"), "const value = 1;\n".repeat(LIMIT + 1));
    }
    writeBaseline({});
    const result = await runCheck();
    expect(result.code).toBe(0);
  });

  it("scans the frontend and test trees too", async () => {
    fs.mkdirSync(path.join(root, "frontend", "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "frontend", "src", "huge.tsx"),
      "const value = 1;\n".repeat(LIMIT + 1),
    );
    fs.writeFileSync(
      path.join(root, "test", "huge.test.ts"),
      "const value = 1;\n".repeat(LIMIT + 1),
    );
    writeBaseline({});
    const result = await runCheck();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("frontend/src/huge.tsx");
    expect(result.stderr).toContain("test/huge.test.ts");
  });

  it("does not count comment lines toward the ceiling", async () => {
    // 1200 code lines and 500 comment lines: under the ceiling, because the
    // comments are not code.
    const full = path.join(root, "src", "commented.ts");
    fs.writeFileSync(full, "const value = 1;\n".repeat(LIMIT) + "// note\n".repeat(500));
    writeBaseline({});
    const result = await runCheck();
    expect(result.code).toBe(0);
  });
});

describe("check-max-file-lines.mjs: the repository's own baseline", () => {
  it("passes on the current tree", async () => {
    const { stdout } = await execFileAsync("node", [SCRIPT, REPO_ROOT]);
    expect(stdout).toContain("OK");
  });

  it("records every file currently over the ceiling", () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as {
      limit: number;
      files: Record<string, number>;
    };
    expect(baseline.limit).toBe(LIMIT);

    const counts = countSourceFiles(REPO_ROOT);
    const over = counts.filter((c) => c.code > baseline.limit);
    expect(over.length).toBeGreaterThan(0);

    // Every file over the ceiling is baselined, and every baseline entry is a
    // file that exists and is over the ceiling. A missing entry would let the
    // tree grow without the guard noticing.
    for (const c of over) {
      expect(baseline.files[c.path]).toBe(c.code);
    }
    for (const file of Object.keys(baseline.files)) {
      expect(counts.some((c) => c.path === file)).toBe(true);
    }
  });
});
