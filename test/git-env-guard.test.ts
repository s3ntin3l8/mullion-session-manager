// Issue #1602: a `git init` / `git config` spawned without gitEnv() inherits a
// GIT_DIR leaked from an outer git hook (pre-push runs this very suite) and
// rewrites *that* repo's config — e.g. flipping a real checkout to
// core.bare = true. Every git child process in src/, test/ and scripts/ must
// scrub it (issue #1649 extended this to scripts/).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GIT_ENV_KEYS_TO_STRIP } from "../src/services/git-env.js";

const ROOT = path.resolve(__dirname, "..");
// \w* on both sides also catches promisified wrappers (execFileAsync("git", …)).
const GIT_SPAWN = /\b\w*(execFile|exec|spawn)\w*\(\s*["']git["']/;

describe("git child processes scrub the ambient git environment", () => {
  // test/setup.ts strips the hook env (pre-push exports GIT_DIR in a linked
  // worktree) before any test runs, so even a spawn that copies process.env
  // can't reach the real checkout.
  it("runs every test file with the hook's git env already scrubbed", () => {
    expect(GIT_ENV_KEYS_TO_STRIP.filter((key) => key in process.env)).toEqual([]);
  });

  it("passes env: gitEnv() (or an explicit env not spread from process.env) at every git spawn in src/, test/ and scripts/", () => {
    const files = execFileSync("git", ["ls-files", "src", "test", "scripts"], { cwd: ROOT })
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
        // An explicit env that spreads process.env passes a leaked GIT_DIR
        // straight through; it must start from gitEnv() instead.
        if (!/\benv\s*:/.test(call) || /\.\.\.process\.env\b/.test(call))
          offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  // Issue #1649: a fixture's `git config user.*` that escapes its temp repo
  // pollutes the real checkout; commit identity comes from test/setup.ts's
  // GIT_AUTHOR_*/GIT_COMMITTER_* env instead, which never writes a config file.
  it("never writes user.name / user.email into a repo's config", () => {
    const files = execFileSync("git", ["ls-files", "test", "scripts"], { cwd: ROOT })
      .toString()
      .split("\n")
      .filter((f) => /\.(ts|mjs|js)$/.test(f) && f !== "test/git-env-guard.test.ts");
    // File-level and quote-agnostic, so `git('config', 'user.name', …)`, a
    // template literal, a single string or `-c user.name=…` can't dodge it.
    // Comments are stripped first: they may legitimately mention the keys.
    const IDENTITY_WRITE = /(config|-c)[\s\S]{0,40}?user\.(name|email)/;
    const offenders = files.filter((f) => {
      const code = readFileSync(path.join(ROOT, f), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      return IDENTITY_WRITE.test(code);
    });
    expect(offenders).toEqual([]);
  });
});
