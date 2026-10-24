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

  it("ignores assets that share a stem (an asset is imported WITH its extension)", async () => {
    // favicon.ico and favicon.svg are unambiguous: nothing imports them
    // without naming the extension.
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
