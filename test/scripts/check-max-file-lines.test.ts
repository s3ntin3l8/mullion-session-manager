// scripts/check-max-file-lines.mjs is the guard that stops the codebase's
// largest files from growing further. The code-health audit found 14
// production files over 1,200 code lines, the largest of them holding 59
// route handlers in a single 4,485-line function — and every one of those
// files still absorbing feature commits, because a file that size does not
// fail loudly, it just gets slower to change safely.
//
// The guard is a RATCHET: a file that is already over the ceiling is recorded
// in scripts/max-file-lines.baseline.json at its current size, and fails when
// it grows past the size it had at the reference commit. So a new file over
// the ceiling fails, and a file this change made bigger fails — while the
// existing offenders pass, and the ratchet turns over one ceiling at a time.
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
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { gitEnv } from "../../src/services/git-env.js";
import {
  AUDIT_ROOTS,
  SOURCE_EXTENSIONS,
  countFileLines,
  collectSourceFiles,
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

  it("is well-formed: a limit, and positive integers for relative paths", () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as {
      limit: number;
      files: Record<string, number>;
    };
    expect(baseline.limit).toBe(LIMIT);
    expect(Object.keys(baseline.files).length).toBeGreaterThan(0);
    for (const [file, size] of Object.entries(baseline.files)) {
      expect(Number.isInteger(size)).toBe(true);
      expect(size).toBeGreaterThan(0);
      // A repo-relative path — not an absolute one, and not one that escapes.
      expect(file.startsWith("/")).toBe(false);
      expect(file).not.toContain("..");
    }
  });

  // The baseline is a SNAPSHOT, so it drifts from the tree as soon as anyone
  // edits one of the files it names — and `main` edits these files all the
  // time. Asserting that the snapshot still matches the tree exactly would
  // make this test fail for every pull request that did not touch the
  // baseline at all, which is the opposite of what a guard should do.
  //
  // What must hold is that the baseline is a well-formed RECORD: it names
  // the giants, its counts block agrees with its entries, and every entry is
  // a path the guard actually scans. What it must NOT hold is that the
  // snapshot still matches the tree — the guard's judgement comes from the
  // reference commit, not from these numbers.
  it("is a well-formed record of the files it names", () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as {
      limit: number;
      counts: { production: number; test: number; tooling: number; total: number };
      files: Record<string, number>;
    };
    const names = Object.keys(baseline.files);
    expect(names.length).toBe(baseline.counts.total);
    expect(baseline.counts.production + baseline.counts.test + baseline.counts.tooling).toBe(
      baseline.counts.total,
    );
    for (const file of names) {
      // Every entry names a source file the guard scans, under one of the
      // audited roots.
      expect(AUDIT_ROOTS.some((root) => file.startsWith(`${root}/`))).toBe(true);
      expect(SOURCE_EXTENSIONS.has(path.extname(file))).toBe(true);
    }

    // And the split itself, classified the way the audit classifies it — so
    // the counts the report quotes are pinned, and a block claiming "57
    // production, 0 test" cannot pass.
    const split = { production: 0, test: 0, tooling: 0 };
    for (const file of names) {
      if (file.startsWith("test/") || /\.test\.tsx?$/.test(file)) split.test += 1;
      else if (file.startsWith("scripts/")) split.tooling += 1;
      else split.production += 1;
    }
    expect(split.production).toBe(baseline.counts.production);
    expect(split.test).toBe(baseline.counts.test);
    expect(split.tooling).toBe(baseline.counts.tooling);
  });

  it("names the commit its sizes were measured from", () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as {
      recordedAt: string;
      files: Record<string, number>;
    };
    expect(baseline.recordedAt).toMatch(/^[0-9a-f]{7,40}$/);
    // Every recorded size is the size that file had at that commit — the
    // label has to name the tree the numbers actually came from, or it is
    // decoration.
    for (const [file, size] of Object.entries(baseline.files)) {
      let content: string;
      try {
        content = execFileSync("git", ["show", `${baseline.recordedAt}:${file}`], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: gitEnv(),
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        throw new Error(`${file} does not exist at ${baseline.recordedAt}`);
      }
      expect(countFileLines(content, file).code).toBe(size);
    }
  });
});

describe("check-max-file-lines.mjs: the ceiling is measured against the default branch", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "max-file-lines-git-"));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function git(args: string[], cwd = repo, extraEnv: NodeJS.ProcessEnv = {}): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...gitEnv(), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function write(relPath: string, lines: number): void {
    const full = path.join(repo, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "const value = 1;\n".repeat(lines));
  }

  function commit(message: string): void {
    git(["add", "-A"]);
    // The identity goes in the ENVIRONMENT, not in `-c user.email=…`:
    // test/git-env-guard.test.ts fails if a git spawn writes user.name or
    // user.email into a repo's config, and `-c` is exactly that shape.
    git(["commit", "-q", "-m", message], repo, {
      GIT_AUTHOR_NAME: "audit",
      GIT_AUTHOR_EMAIL: "audit@example.invalid",
      GIT_COMMITTER_NAME: "audit",
      GIT_COMMITTER_EMAIL: "audit@example.invalid",
    });
  }

  async function runCheck(
    extraArgs: string[] = [],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const baselinePath = path.join(repo, "baseline.json");
    fs.writeFileSync(
      baselinePath,
      JSON.stringify({ limit: LIMIT, files: { "src/big.ts": LIMIT + 100 } }),
    );
    try {
      const { stdout, stderr } = await execFileAsync("node", [
        SCRIPT,
        repo,
        "--baseline",
        baselinePath,
        ...extraArgs,
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

  it("fails a file that grew past its size at the reference commit", async () => {
    git(["init", "-q", "-b", "main"]);
    write("src/big.ts", LIMIT + 100);
    commit("base");
    // The branch forks here and grows the file. The reference commit is the
    // fork point, so the growth is the branch's own.
    git(["checkout", "-q", "-b", "feature"]);
    write("src/big.ts", LIMIT + 200);
    commit("grow");

    const result = await runCheck();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("src/big.ts");
  });

  it("passes when the file did not grow, even though the baseline records it", async () => {
    git(["init", "-q", "-b", "main"]);
    write("src/big.ts", LIMIT + 100);
    commit("base");
    // The branch does NOT touch the file.
    write("src/other.ts", 10);
    commit("unrelated");

    const result = await runCheck();
    expect(result.code).toBe(0);
  });

  it("passes a file that the DEFAULT BRANCH grew, when this branch did not", async () => {
    git(["init", "-q", "-b", "main"]);
    write("src/big.ts", LIMIT + 100);
    commit("base");

    // The branch forks here and leaves the file alone.
    git(["checkout", "-q", "-b", "feature"]);
    write("src/other.ts", 10);
    commit("unrelated");

    // Meanwhile the default branch grows the very same file.
    git(["checkout", "-q", "main"]);
    write("src/big.ts", LIMIT + 300);
    commit("main grew it");
    git(["checkout", "-q", "feature"]);

    // The branch's own file is unchanged, so the guard must not blame it for
    // the default branch's growth — this is what keeps unrelated pull
    // requests green.
    const result = await runCheck();
    expect(result.code).toBe(0);
  });

  // The discriminating case: the default branch grew the file AND this
  // branch grew it. The reference is the FORK POINT, so this branch's own
  // growth is still growth — it fails. Were the reference the default
  // branch's tip instead, the branch's smaller growth would hide behind
  // main's larger one and the check would pass. That is the difference the
  // merge-base reference buys, and it is the one this test exists to pin.
  it("fails when this branch grew a file, even though the default branch grew it more", async () => {
    git(["init", "-q", "-b", "main"]);
    write("src/big.ts", LIMIT + 100);
    commit("base");

    // The branch forks here and grows the file to LIMIT + 200.
    git(["checkout", "-q", "-b", "feature"]);
    write("src/big.ts", LIMIT + 200);
    commit("the branch grew the file");

    // The default branch grows the SAME file, further, to LIMIT + 300.
    git(["checkout", "-q", "main"]);
    write("src/big.ts", LIMIT + 300);
    commit("main grew it more");
    git(["checkout", "-q", "feature"]);

    const result = await runCheck();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("src/big.ts");
  });

  it("fails a new file over the ceiling", async () => {
    git(["init", "-q", "-b", "main"]);
    write("src/small.ts", 10);
    commit("base");
    git(["checkout", "-q", "-b", "feature"]);
    write("src/new.ts", LIMIT + 1);
    commit("add a big new file");

    const result = await runCheck();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("src/new.ts");
  });

  // A pull request's CI checks out the MERGE ref, with a fetch scoped to it —
  // so `origin/main` and every other default-branch name do not exist there.
  // The merge commit's second parent (the base branch's tip) is, and it is
  // the right reference: the size this change should be measured against.
  it("uses the merge commit's base side when no default-branch ref resolves", async () => {
    git(["init", "-q", "-b", "main"]);
    write("src/big.ts", LIMIT + 100);
    commit("base");

    // The branch grows the file, then merges the base branch in — the shape
    // CI's merge ref has: first parent is the branch, second is the base.
    git(["checkout", "-q", "-b", "feature"]);
    write("src/big.ts", LIMIT + 200);
    commit("the branch grew the file");
    git(["checkout", "-q", "main"]);
    write("src/other.ts", 10);
    commit("the base branch moved on");
    git(["checkout", "-q", "feature"]);
    git(["merge", "--no-ff", "-q", "-m", "merge main into the branch", "main"]);

    // No default-branch ref resolves any more — exactly CI's situation.
    git(["branch", "-D", "main"]);

    const result = await runCheck();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("src/big.ts");
  });

  it("abstains, rather than guessing, when there is no reference at all", async () => {
    // A branch called "trunk" is not one of the names the guard looks for, and
    // HEAD is not a merge commit — so there is nothing to measure the change
    // against, and the guard must not blame this tree for a baseline that has
    // since gone stale.
    git(["init", "-q", "-b", "trunk"]);
    write("src/big.ts", LIMIT + 200);
    commit("base");

    const result = await runCheck();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("abstained");
    // The degraded mode says so on stderr — a guard that stops guarding
    // quietly is worse than one that stops guarding loudly.
    expect(result.stderr).toContain("WARNING");
  });

  // On a pull request, "the guard could not determine what this change did"
  // is not "nothing to check" — it is "the guard stopped guarding", and that
  // must fail the build rather than pass it quietly.
  it("fails the abstention under --strict", async () => {
    git(["init", "-q", "-b", "trunk"]);
    write("src/big.ts", LIMIT + 200);
    commit("base");

    const result = await runCheck(["--strict"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("WARNING");
  });
});
