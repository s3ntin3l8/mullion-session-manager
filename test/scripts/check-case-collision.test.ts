// Issue #1803 — the frontend could not be built on macOS, because
// frontend/src/UnifiedBoard.tsx and frontend/src/unifiedBoard.ts sat side by
// side and their names differ only in case. On a case-insensitive
// filesystem (macOS's default APFS volume) the import specifier
// "./UnifiedBoard.js" cannot tell them apart, and TypeScript fails the build
// with TS1149.
//
// scripts/check-case-collision.mjs is the guard: it fails when the tree
// grows a pair like that again. This exercises it against per-test fixture
// directories (precedent: test/scripts/check-scaffold-region-sync.test.ts,
// which drives its script through execFile the same way).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(new URL("../../scripts/check-case-collision.mjs", import.meta.url));

describe("check-case-collision.mjs", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "case-collision-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relPath: string): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  }

  // True when the two paths are the SAME file on disk — which is what a
  // case-insensitive filesystem does with two names that differ only in
  // case: the second one collapses into the first.
  function sameFile(a: string, b: string): boolean {
    try {
      return fs.statSync(path.join(root, a)).ino === fs.statSync(path.join(root, b)).ino;
    } catch {
      return false;
    }
  }

  it("passes on a tree with no case-only pair", async () => {
    write("src/Board.tsx");
    write("src/boardLanes.ts");
    write("src/other/Board.tsx"); // a different directory is fine

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, root]);

    expect(stdout).toContain("no two file names in a directory differ only in case");
  });

  it("fails on a pair that differs only in case (the pair that broke the build)", async () => {
    write("frontend/src/UnifiedBoard.tsx");
    write("frontend/src/unifiedBoard.ts");

    let failed = false;
    let output = "";
    try {
      await execFileAsync(process.execPath, [SCRIPT, root]);
    } catch (err) {
      failed = true;
      const e = err as { code?: number; stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      expect(e.code).toBe(1);
    }
    expect(failed).toBe(true);
    expect(output).toContain("UnifiedBoard.tsx");
    expect(output).toContain("unifiedBoard.ts");
  });
  it("fails on a case-only pair of ASSETS (they cannot coexist on a Mac)", async (ctx) => {
    // The point of the rule: "favicon.svg" and "Favicon.svg" are two files
    // in the index, and on a case-insensitive filesystem (macOS) a checkout
    // collapses one into the other — the tree silently diverges from the
    // index. The pair CANNOT BE CREATED on such a filesystem, which is why
    // the check has to run on Linux, where it can.
    write("frontend/public/favicon.svg");
    write("frontend/public/Favicon.svg");
    if (sameFile("frontend/public/favicon.svg", "frontend/public/Favicon.svg")) {
      // The filesystem collapsed the pair into one file — it cannot
      // represent the fixture, so there is nothing to check here (CI, on
      // Linux, can).
      ctx.skip();
      return;
    }

    let failed = false;
    let output = "";
    try {
      await execFileAsync(process.execPath, [SCRIPT, root]);
    } catch (err) {
      failed = true;
      output = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
    }
    expect(failed).toBe(true);
    // The failure must NAME the files, not just fail.
    expect(output).toContain("favicon.svg");
    expect(output).toContain("Favicon.svg");
  });

  it("fails on a case-only pair of DIRECTORIES", async (ctx) => {
    fs.mkdirSync(path.join(root, "src", "UnifiedBoard"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "unifiedBoard"), { recursive: true });
    if (sameFile("src/UnifiedBoard", "src/unifiedBoard")) {
      ctx.skip();
      return;
    }

    let failed = false;
    let output = "";
    try {
      await execFileAsync(process.execPath, [SCRIPT, root]);
    } catch (err) {
      failed = true;
      output = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
    }
    expect(failed).toBe(true);
    expect(output).toContain("UnifiedBoard/");
    expect(output).toContain("unifiedBoard/");
  });

  it("reports a case-only pair with the SAME extension once, and names it", async (ctx) => {
    // "Board.ts" and "BOARD.ts" match BOTH rules (same stem, same full
    // name) — the report must not list the pair twice, and must not claim
    // "different extensions" when the extensions are identical.
    write("src/Board.ts");
    write("src/BOARD.ts");
    if (sameFile("src/Board.ts", "src/BOARD.ts")) {
      ctx.skip();
      return;
    }

    let failed = false;
    let output = "";
    try {
      await execFileAsync(process.execPath, [SCRIPT, root]);
    } catch (err) {
      failed = true;
      output = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
    }
    expect(failed).toBe(true);
    expect(output).toContain("Board.ts");
    expect(output).toContain("BOARD.ts");
    expect(output).not.toContain("different extensions");
    // The pair is reported once, not once per rule.
    const occurrences = output.split("Board.ts  and  BOARD.ts").length - 1;
    expect(occurrences).toBe(1);
  });

  it("ignores assets that share a stem but not their name (favicon.ico, favicon.svg)", async () => {
    // Different full names: unambiguous, and they coexist on a Mac.
    write("frontend/public/favicon.ico");
    write("frontend/public/favicon.svg");
    write("docs/assets/logo.png");
    write("docs/assets/logo.svg");

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, root]);

    expect(stdout).toContain("no two file names in a directory differ only in case");
  });

  it("ignores node_modules and other build directories", async () => {
    write("node_modules/pkg/UnifiedBoard.tsx");
    write("node_modules/pkg/unifiedBoard.ts");
    write("dist/UnifiedBoard.tsx");
    write("dist/unifiedBoard.ts");

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, root]);

    expect(stdout).toContain("no two file names in a directory differ only in case");
  });

  it("passes on this repository's own tree", async () => {
    // The tree the guard is protecting.
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT]);

    expect(stdout).toContain("no two file names in a directory differ only in case");
  });
});
