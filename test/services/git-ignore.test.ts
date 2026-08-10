import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { isPathGitIgnored, isPathGitIgnoredCached } from "../../src/services/git-ignore.js";
import { gitEnv } from "../../src/services/git-env.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function initRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
}

describe("isPathGitIgnored", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ignore-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false for a directory that isn't a git repo", async () => {
    expect(await isPathGitIgnored(tmpDir, "some-file.txt")).toBe(false);
  });

  it("returns true for a path matched by .gitignore, given an absolute path", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored-dir/\n");
    fs.mkdirSync(path.join(tmpDir, "ignored-dir"));
    fs.writeFileSync(path.join(tmpDir, "ignored-dir", "plan.md"), "hi");

    expect(await isPathGitIgnored(tmpDir, path.join(tmpDir, "ignored-dir", "plan.md"))).toBe(true);
  });

  it("returns true for a path matched by .gitignore, given a path relative to root", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored-dir/\n");
    fs.mkdirSync(path.join(tmpDir, "ignored-dir"));
    fs.writeFileSync(path.join(tmpDir, "ignored-dir", "plan.md"), "hi");

    expect(await isPathGitIgnored(tmpDir, "ignored-dir/plan.md")).toBe(true);
  });

  it("returns false for a tracked (non-ignored) file", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored-dir/\n");
    fs.writeFileSync(path.join(tmpDir, "tracked.ts"), "export {}");

    expect(await isPathGitIgnored(tmpDir, path.join(tmpDir, "tracked.ts"))).toBe(false);
  });

  it("returns false for a relative root, even one that would otherwise resolve correctly", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored-dir/\n");
    fs.mkdirSync(path.join(tmpDir, "ignored-dir"));
    fs.writeFileSync(path.join(tmpDir, "ignored-dir", "plan.md"), "hi");

    const relRoot = path.relative(process.cwd(), tmpDir);
    expect(await isPathGitIgnored(relRoot, "ignored-dir/plan.md")).toBe(false);
  });

  it("rejects a relative or path-traversing root, same guard as isGitRepo", async () => {
    initRepo(tmpDir);
    expect(await isPathGitIgnored("relative/path", "x")).toBe(false);
    expect(await isPathGitIgnored(path.join(tmpDir, "..", "escape"), "x")).toBe(false);
  });
});

// Perf audit finding B8(3) — isPathGitIgnoredCached memoizes check-ignore
// results at two levels: a real, direct check against the DIRECTORY path
// itself (trustworthy either way, per gitignore(5)'s "can't re-include a
// file under an excluded directory" guarantee — see that function's own
// doc comment), and, only when the directory isn't excluded, a per-FILE
// check (a targeted pattern like a bare `.env` can ignore one file without
// its directory being excluded at all — inferring "sibling file is ignored
// too" from that would be wrong, which is exactly what an earlier,
// directory-dirname-only version of this cache got wrong). These tests
// deliberately avoid spying on child_process.spawn directly (git-ignore.ts
// imports it as a bound named import, an awkward spy target) and instead
// prove behavior black-box via cache.size and targeted .gitignore mutations
// between calls.
describe("isPathGitIgnoredCached", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ignore-cached-test-"));
    initRepo(tmpDir);
    fs.mkdirSync(path.join(tmpDir, "some-dir"));
    fs.writeFileSync(path.join(tmpDir, "some-dir", "a.md"), "a");
    fs.writeFileSync(path.join(tmpDir, "some-dir", "b.md"), "b");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the fresh answer on a cold cache, matching isPathGitIgnored", async () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "some-dir/\n");
    const cache = new Map<string, boolean>();
    const filePath = path.join(tmpDir, "some-dir", "a.md");

    expect(await isPathGitIgnoredCached(tmpDir, filePath, cache)).toBe(true);
  });

  it("a whole excluded directory is served for EVERY file under it from one directory-level check, never falling through to a per-file check", async () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "some-dir/\n");
    const cache = new Map<string, boolean>();
    const fileA = path.join(tmpDir, "some-dir", "a.md");
    const fileB = path.join(tmpDir, "some-dir", "b.md");

    expect(await isPathGitIgnoredCached(tmpDir, fileA, cache)).toBe(true);
    // Only the directory-level entry exists — fileB (never individually
    // checked) still correctly reports ignored purely from that ONE entry.
    expect(cache.size).toBe(1);

    expect(await isPathGitIgnoredCached(tmpDir, fileB, cache)).toBe(true);
    // Still just the one directory-level entry — no per-file entry was
    // ever needed for either file.
    expect(cache.size).toBe(1);
  });

  it("does NOT infer a sibling file is ignored from one file's own targeted ignore rule (the directory itself stays un-excluded)", async () => {
    // Ignores exactly a.md, not the whole directory.
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "some-dir/a.md\n");
    const cache = new Map<string, boolean>();
    const fileA = path.join(tmpDir, "some-dir", "a.md");
    const fileB = path.join(tmpDir, "some-dir", "b.md");

    expect(await isPathGitIgnoredCached(tmpDir, fileA, cache)).toBe(true);
    // b.md must still be checked (and found NOT ignored) on its own — the
    // exact bug a naive directory-dirname-only cache would get wrong.
    expect(await isPathGitIgnoredCached(tmpDir, fileB, cache)).toBe(false);
  });

  it("a genuinely new file gets a correct, fresh answer after the directory becomes excluded — even though an earlier check of a sibling in that directory was cached as 'not excluded'", async () => {
    const cache = new Map<string, boolean>();
    const fileA = path.join(tmpDir, "some-dir", "a.md");
    const fileB = path.join(tmpDir, "some-dir", "b.md");

    // Directory not excluded yet — caches the directory-level entry as false.
    expect(await isPathGitIgnoredCached(tmpDir, fileA, cache)).toBe(false);

    // Now exclude the whole directory.
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "some-dir/\n");

    // fileB was never individually checked before, so it still gets a
    // real, correct check here (falling through past the stale
    // directory-level "false" to a genuine per-file check) — this is the
    // exact scenario an earlier, dirname-only version of this cache got
    // wrong by returning the stale "not ignored" answer instead.
    expect(await isPathGitIgnoredCached(tmpDir, fileB, cache)).toBe(true);
  });

  it("reuses the cached per-file answer for the SAME file across repeated checks — accepted staleness for a file that WAS actually, individually checked", async () => {
    const cache = new Map<string, boolean>();
    const fileA = path.join(tmpDir, "some-dir", "a.md");

    expect(await isPathGitIgnoredCached(tmpDir, fileA, cache)).toBe(false);

    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "some-dir/\n");
    // Re-checking the exact same file, same cache instance, serves the
    // memoized answer rather than re-spawning `git check-ignore` — a
    // deliberate session-lifetime cache tradeoff, not a correctness bug
    // (unlike serving a DIFFERENT, never-checked file's answer).
    expect(await isPathGitIgnoredCached(tmpDir, fileA, cache)).toBe(false);
  });

  it("checks each directory independently — a sibling directory's cached answer never leaks into a different one", async () => {
    fs.mkdirSync(path.join(tmpDir, "other-dir"));
    fs.writeFileSync(path.join(tmpDir, "other-dir", "c.md"), "c");
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "some-dir/\n");
    const cache = new Map<string, boolean>();

    expect(await isPathGitIgnoredCached(tmpDir, path.join(tmpDir, "some-dir", "a.md"), cache)).toBe(
      true,
    );
    expect(
      await isPathGitIgnoredCached(tmpDir, path.join(tmpDir, "other-dir", "c.md"), cache),
    ).toBe(false);
  });

  it("a fresh cache instance is unaffected by another cache's stale entry (per-session isolation)", async () => {
    const cacheA = new Map<string, boolean>();
    const fileB = path.join(tmpDir, "some-dir", "b.md");

    await isPathGitIgnoredCached(tmpDir, path.join(tmpDir, "some-dir", "a.md"), cacheA);
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "some-dir/\n");

    // A brand-new cache (e.g. a different session's own gitIgnoreDirCache)
    // has no stale entry to serve and correctly reflects the mutation.
    const cacheB = new Map<string, boolean>();
    expect(await isPathGitIgnoredCached(tmpDir, fileB, cacheB)).toBe(true);
  });

  it("resolves a relative filePath against root before computing the cache key, same as isPathGitIgnored", async () => {
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "some-dir/\n");
    const cache = new Map<string, boolean>();

    expect(await isPathGitIgnoredCached(tmpDir, "some-dir/a.md", cache)).toBe(true);
    // Second call, absolute-path form of the same file — must hit the same
    // directory-level cache entry (one, not two).
    expect(await isPathGitIgnoredCached(tmpDir, path.join(tmpDir, "some-dir", "a.md"), cache)).toBe(
      true,
    );
    expect(cache.size).toBe(1);
  });
});
