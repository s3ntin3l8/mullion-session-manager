import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  getGitStatus,
  isGitRepo,
  clearGitStatusCacheForTests,
} from "../../src/services/git-status.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
}

function commitAll(cwd: string, message: string) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message]);
}

describe("getGitStatus", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-status-test-"));
    clearGitStatusCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearGitStatusCacheForTests();
  });

  it("returns null for a non-git-repo directory", async () => {
    expect(await getGitStatus(tmpDir)).toBeNull();
  });

  describe("isGitRepo", () => {
    it("is false for a directory with no .git entry", () => {
      expect(isGitRepo(tmpDir)).toBe(false);
    });

    it("is true once .git exists, even before getGitStatus has been called", () => {
      initRepo(tmpDir);
      expect(isGitRepo(tmpDir)).toBe(true);
    });

    it("stays true across a transient git-status failure — that's the whole point:", async () => {
      // A caller distinguishing "not a repo" (durable) from "repo exists but
      // git status failed" (transient) needs isGitRepo to stay true here so
      // it doesn't collapse back into the ambiguous getGitStatus-null case.
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const headPath = path.join(tmpDir, ".git", "HEAD");
      fs.unlinkSync(headPath);

      expect(isGitRepo(tmpDir)).toBe(true);
      expect(await getGitStatus(tmpDir)).toBeNull();
    });

    it("rejects a relative or path-traversing cwd, same guard as getGitStatus", () => {
      expect(isGitRepo("relative/path")).toBe(false);
      expect(isGitRepo(path.join(tmpDir, "..", "escape"))).toBe(false);
    });
  });

  it("returns null for a relative cwd, even one that would otherwise resolve correctly", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    expect(await getGitStatus(path.relative(process.cwd(), tmpDir))).toBeNull();
  });

  it("reports a clean repo: branch, short hash, no files", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const status = await getGitStatus(tmpDir);
    expect(status).not.toBeNull();
    expect(status?.branch).toBe("main");
    expect(status?.hash).toMatch(/^[0-9a-f]{7}$/);
    expect(status?.ahead).toBe(0);
    expect(status?.behind).toBe(0);
    expect(status?.files).toEqual([]);
    expect(status?.isClean).toBe(true);
    expect(status?.hasConflicts).toBe(false);
  });

  it("detects a modified tracked file", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    fs.writeFileSync(path.join(tmpDir, "a.txt"), "changed");
    clearGitStatusCacheForTests();

    const status = await getGitStatus(tmpDir);
    expect(status?.isClean).toBe(false);
    expect(status?.files).toEqual([{ path: "a.txt", status: "M" }]);
  });

  it("detects an untracked file", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    fs.writeFileSync(path.join(tmpDir, "new.txt"), "new");
    clearGitStatusCacheForTests();

    const status = await getGitStatus(tmpDir);
    expect(status?.isClean).toBe(false);
    expect(status?.files).toEqual([{ path: "new.txt", status: "?" }]);
  });

  it("detects a staged-added file", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    fs.writeFileSync(path.join(tmpDir, "added.txt"), "added");
    git(tmpDir, ["add", "added.txt"]);
    clearGitStatusCacheForTests();

    const status = await getGitStatus(tmpDir);
    expect(status?.files).toEqual([{ path: "added.txt", status: "A" }]);
  });

  it("reports ahead/behind against an upstream", async () => {
    const source = path.join(tmpDir, "source");
    initRepo(source);
    fs.writeFileSync(path.join(source, "a.txt"), "a");
    commitAll(source, "initial");

    const workdir = path.join(tmpDir, "workdir");
    git(tmpDir, ["clone", source, workdir]);
    git(workdir, ["config", "user.email", "test@example.com"]);
    git(workdir, ["config", "user.name", "Test"]);

    // Ahead by one: a local commit not yet pushed anywhere.
    fs.writeFileSync(path.join(workdir, "b.txt"), "b");
    commitAll(workdir, "local-only");
    clearGitStatusCacheForTests();
    expect((await getGitStatus(workdir))?.ahead).toBe(1);
    expect((await getGitStatus(workdir))?.behind).toBe(0);

    // Also behind by one: a commit landed upstream that a fetch (not merge)
    // has made known locally, but not yet incorporated.
    fs.writeFileSync(path.join(source, "c.txt"), "c");
    commitAll(source, "upstream-only");
    git(workdir, ["fetch"]);
    clearGitStatusCacheForTests();

    const status = await getGitStatus(workdir);
    expect(status?.ahead).toBe(1);
    expect(status?.behind).toBe(1);
  });

  it("caches results for CACHE_TTL_MS, avoiding a re-spawn on every call", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const first = await getGitStatus(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "changed-but-not-yet-visible");
    // No clearGitStatusCacheForTests() here — the cached (clean) result
    // should still be served.
    const second = await getGitStatus(tmpDir);
    expect(second).toEqual(first);
    expect(second?.isClean).toBe(true);
  });

  it("does not cache null results from a transient git failure", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    clearGitStatusCacheForTests();

    // Remove HEAD so git status fails transiently (fatal: not a git
    // repository) — runGitStatus exits non-zero, returns null.
    const headPath = path.join(tmpDir, ".git", "HEAD");
    const savedHead = fs.readFileSync(headPath, "utf8");
    fs.unlinkSync(headPath);

    const first = await getGitStatus(tmpDir);
    expect(first).toBeNull();

    // Restore HEAD
    fs.writeFileSync(headPath, savedHead);

    // Should NOT return cached null — should spawn a fresh git status
    const second = await getGitStatus(tmpDir);
    expect(second).not.toBeNull();
    expect(second?.branch).toBe("main");
  });
});
