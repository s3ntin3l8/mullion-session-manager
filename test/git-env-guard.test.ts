// Issue #1602: a `git init` / `git config` spawned without gitEnv() inherits a
// GIT_DIR leaked from an outer git hook (pre-push runs this very suite) and
// rewrites *that* repo's config — e.g. flipping a real checkout to
// core.bare = true. Every git child process in src/, test/ and scripts/ must
// scrub it (issue #1649 extended this to scripts/).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GIT_ENV_KEYS_TO_STRIP, gitEnv } from "../src/services/git-env.js";

const ROOT = path.resolve(__dirname, "..");
// \w* on both sides also catches promisified wrappers (execFileAsync("git", …)).
// Two forms on purpose: the non-global one is a plain "does this line start a
// spawn-ish call" test (a /g regex carries `lastIndex` between calls, so
// using it for `.test()` would skip lines), and the global one is for
// `matchAll` over a statement.
const SPAWN_CALL = /\b\w*(execFile|exec|spawn)\w*\s*\(/;
const SPAWN_CALL_G = /\b\w*(execFile|exec|spawn)\w*\s*\(/g;
// A backtick counts too: a future `spawnChild(`git`, …)` would otherwise
// slip past the scan, and `seen >= 30` would still pass with a new site
// added alongside.
const GIT_LITERAL = /^\s*["'`]git["'`]\s*$/;

/**
 * The first argument of the call that starts at `from` — up to the next
 * top-level comma.
 */
function firstArgument(statement: string, open: number): string {
  let depth = 0;
  for (let i = open + 1; i < statement.length; i++) {
    const ch = statement[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      // The call's own closing bracket ends the argument list.
      if (depth === 0) return statement.slice(open + 1, i);
      depth--;
    } else if (ch === "," && depth === 0) return statement.slice(open + 1, i);
  }
  return statement.slice(open + 1);
}

/**
 * Whether this statement spawns git — i.e. whether one of its spawn-ish
 * calls has the LITERAL "git" as its first argument.
 *
 * Two things this gets right that a line-anchored match did not:
 *
 * - the command is looked for in the whole STATEMENT, not the line the call
 *   starts on. Many call sites put it on its own line
 *   (`spawnChild(\n  "git",\n  [...]`), and the old line-anchored match
 *   never saw those — it silently skipped 9 of the 30 git spawns in src/ and
 *   scripts/, three of which had no `env: gitEnv()` and no gc override.
 * - the command must be the LITERAL "git". A test double that forwards
 *   (`actual.spawn(command, args, options)`) takes the command from a
 *   variable, and the real spawn's env and argv come from the src/ caller
 *   this guard already checks.
 */
function spawnsGit(statement: string): boolean {
  for (const match of statement.matchAll(SPAWN_CALL_G)) {
    const open = match.index + match[0].length - 1;
    if (GIT_LITERAL.test(firstArgument(statement, open))) return true;
  }
  return false;
}

describe("git child processes scrub the ambient git environment", () => {
  // test/setup.ts strips the hook env (pre-push exports GIT_DIR in a linked
  // worktree) before any test runs, so even a spawn that copies process.env
  // can't reach the real checkout.
  // Vacuous on its own in CI, which has no ambient GIT_* to find; the two
  // tests below prove the scrub with a leaked GIT_DIR actually present.
  it("runs every test file with the hook's git env already scrubbed", () => {
    expect(GIT_ENV_KEYS_TO_STRIP.filter((key) => key in process.env)).toEqual([]);
  });

  it("test/setup.ts scrubs the hook env before any test runs", () => {
    const setup = readFileSync(path.join(ROOT, "test/setup.ts"), "utf8");
    expect(setup).toMatch(/^scrubGitHookEnv\(\);$/m);
  });

  it("scrubGitHookEnv strips a hook's GIT_DIR in a fresh process", () => {
    const leaked = Object.fromEntries(GIT_ENV_KEYS_TO_STRIP.map((key) => [key, "/leaked"]));
    const script =
      'const { scrubGitHookEnv } = await import("./test/helpers/git-hook-env.ts");' +
      'const before = Object.keys(process.env).filter((k) => k.startsWith("GIT_"));' +
      "scrubGitHookEnv();" +
      'const after = Object.keys(process.env).filter((k) => k.startsWith("GIT_"));' +
      "console.log(JSON.stringify({ before, after }));";
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: ROOT, env: { ...gitEnv(), ...leaked }, encoding: "utf8" },
    );
    const { before, after } = JSON.parse(out.trim().split("\n").pop()!);
    expect(before).toEqual(expect.arrayContaining(["GIT_DIR", "GIT_INDEX_FILE"]));
    expect(after.filter((k: string) => k in leaked)).toEqual([]);
  });

  it("passes env: gitEnv() (or an explicit env not built from process.env) at every git spawn in src/, test/ and scripts/", () => {
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
        if (!SPAWN_CALL.test(line)) return;
        // Just this call's own statement: up to the first line ending in `);`.
        let end = i;
        while (end < lines.length - 1 && !/\)\s*;?\s*$/.test(lines[end].trimEnd())) end++;
        const call = lines.slice(i, end + 1).join("\n");
        // Not every spawn is a git one.
        if (!spawnsGit(call)) return;
        // An explicit env built from process.env (spread or passed as is)
        // hands a leaked GIT_DIR straight through; start from gitEnv() instead.
        if (!/\benv\s*:/.test(call) || /(\.\.\.|\benv\s*:\s*)process\.env\b/.test(call))
          offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  // Issue #1851 — Mullion's own git commands must never trigger the
  // background `git gc` that can delete a loose object a CONCURRENT write
  // is creating (#1836). The fix is `-c gc.auto=0` on every git invocation.
  //
  // The same scan as the rule above: every git spawn in src/, test/ and
  // scripts/ must carry the override, so the invariant holds by construction
  // — including for a call site added later.
  it("carries -c gc.auto=0 at every git spawn in src/ and scripts/", () => {
    // src/ and scripts/ only: those run git in a REAL repo — the user's
    // clone, or this repo's shared clone. A test fixture runs git in a
    // throwaway temp repo, where a background gc can do no harm.
    const files = execFileSync("git", ["ls-files", "src", "scripts"], { cwd: ROOT })
      .toString()
      .split("\n")
      .filter((f) => /\.(ts|mjs|js)$/.test(f) && f !== "test/git-env-guard.test.ts");

    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      const lines = readFileSync(path.join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (!SPAWN_CALL.test(line)) return;
        // Just this call's own statement: up to the first line ending in `);`.
        let end = i;
        while (end < lines.length - 1 && !/\)\s*;?\s*$/.test(lines[end].trimEnd())) end++;
        const call = lines.slice(i, end + 1).join("\n");
        // Not every spawn is a git one.
        if (!spawnsGit(call)) return;
        seen++;
        if (!call.includes("GIT_NO_AUTO_GC")) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
    // The scan must still SEE the git spawns. An earlier, line-anchored version
    // of this scan silently skipped 9 of the 30, so the rules above were
    // passing over sites that had neither the env scrub nor the gc override.
    // If this fails, either a git spawn was removed (lower it deliberately) or
    // the scan stopped matching (fix the scan).
    //
    // 28, not 30: the doctor used to have its own git spawn, and now that it
    // lives in src/ (src/services/git-doctor.ts) all of its git calls go
    // through ONE spawn helper — `runGit` — so the doctor contributes a single
    // site rather than two.
    expect(seen).toBeGreaterThanOrEqual(28);
  });

  // The override lives in three places — the TypeScript source of truth, the
  // plain-JS twin the scripts use, and the CLI's and the worktree hook's own copies (they are copied into
  // dist/ verbatim and cannot import the TypeScript module). They must agree.
  it("defines GIT_NO_AUTO_GC identically everywhere it appears", () => {
    const sources = [
      "src/services/git-env.ts",
      "scripts/git-env.mjs",
      "src/cli/core.mjs",
      "src/hooks/worktree-hook.mjs",
    ];
    const values = sources.map((file) => {
      const code = readFileSync(path.join(ROOT, file), "utf8");
      const match = /GIT_NO_AUTO_GC\s*=\s*\[([^\]]*)\]/.exec(code);
      expect(match, `${file} does not define GIT_NO_AUTO_GC as an array`).not.toBeNull();
      return match![1].replace(/\s+/g, "");
    });
    expect(new Set(values).size).toBe(1);
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
