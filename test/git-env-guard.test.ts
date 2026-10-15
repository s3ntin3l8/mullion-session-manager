// Issue #1602: a `git init` / `git config` spawned without gitEnv() inherits a
// GIT_DIR leaked from an outer git hook (pre-push runs this very suite) and
// rewrites *that* repo's config — e.g. flipping a real checkout to
// core.bare = true. Every git child process in src/ and test/ must scrub it.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const GIT_SPAWN = /\b(execFileSync|execFile|spawnSync|spawn)\(\s*["']git["']/;

describe("git child processes scrub the ambient git environment", () => {
  it("passes env: gitEnv() (or an explicit env) at every git spawn in src/ and test/", () => {
    const files = execFileSync("git", ["ls-files", "src", "test"], { cwd: ROOT })
      .toString()
      .split("\n")
      .filter((f) => /\.(ts|mjs|js)$/.test(f) && f !== "test/git-env-guard.test.ts");

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(path.join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (!GIT_SPAWN.test(line)) return;
        // Just this call's own statement: up to the first line ending in `);`.
        let end = i;
        while (end < lines.length - 1 && !/\)\s*;?\s*$/.test(lines[end].trimEnd())) end++;
        const call = lines.slice(i, end + 1).join("\n");
        if (!/\benv\s*:/.test(call)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
