import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  getDiffStats,
  getDefaultBaseRef,
  clearGitDiffStatsCacheForTests,
} from "../../src/services/git-diff.js";
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

function commitAll(cwd: string, message: string) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message, "--no-verify"]);
}

describe("getDiffStats", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-diff-test-"));
    clearGitDiffStatsCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearGitDiffStatsCacheForTests();
  });

  it("returns null for a non-git-repo directory", async () => {
    expect(await getDiffStats(tmpDir)).toBeNull();
  });

  it("returns null for a relative cwd, even one that would otherwise resolve correctly", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    expect(await getDiffStats(path.relative(process.cwd(), tmpDir))).toBeNull();
  });

  it("returns zero-change stats for a clean repo with nothing to diff against HEAD", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const stats = await getDiffStats(tmpDir);
    expect(stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it("counts insertions/deletions for a modified tracked file (unstaged)", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "one\ntwo\nthree\n");
    commitAll(tmpDir, "initial");

    fs.writeFileSync(path.join(tmpDir, "a.txt"), "one\nTWO\nthree\nfour\n");
    clearGitDiffStatsCacheForTests();

    const stats = await getDiffStats(tmpDir);
    // "two" -> "TWO" is a 1-line delete + 1-line insert; "four" is a pure
    // insert — numstat totals: 2 insertions, 1 deletion, 1 file.
    expect(stats).toEqual({ filesChanged: 1, insertions: 2, deletions: 1 });
  });

  it("counts a staged-but-uncommitted change too (git diff HEAD spans both)", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\n");
    commitAll(tmpDir, "initial");

    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\nb\n");
    git(tmpDir, ["add", "a.txt"]);
    clearGitDiffStatsCacheForTests();

    const stats = await getDiffStats(tmpDir);
    expect(stats).toEqual({ filesChanged: 1, insertions: 1, deletions: 0 });
  });

  it("counts changes across multiple files", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\n");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b\n");
    commitAll(tmpDir, "initial");

    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\na2\n");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "");
    clearGitDiffStatsCacheForTests();

    const stats = await getDiffStats(tmpDir);
    expect(stats).toEqual({ filesChanged: 2, insertions: 1, deletions: 1 });
  });

  it("returns null when there are no commits yet (unborn HEAD)", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");

    expect(await getDiffStats(tmpDir)).toBeNull();
  });

  it("caches results for CACHE_TTL_MS, avoiding a re-spawn on every call", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\n");
    commitAll(tmpDir, "initial");

    const first = await getDiffStats(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\nb\nc\n");
    // No clearGitDiffStatsCacheForTests() here — the cached (zero-change)
    // result should still be served.
    const second = await getDiffStats(tmpDir);
    expect(second).toEqual(first);
    expect(second).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it("counts branch-wide changes when baseRef is set (issue #262)", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "one\ntwo\nthree\n");
    commitAll(tmpDir, "initial on main");

    git(tmpDir, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
    commitAll(tmpDir, "feature commit");
    clearGitDiffStatsCacheForTests();

    // On the feature branch with no uncommitted changes, a no-base call
    // shows zero (nothing to diff against HEAD alone).
    expect(await getDiffStats(tmpDir)).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });

    // With baseRef=main, the diff against the merge-base shows the
    // feature branch's full delta: insertions=3, deletions=0, 1 file.
    expect(await getDiffStats(tmpDir, "main")).toEqual({
      filesChanged: 1,
      insertions: 3,
      deletions: 0,
    });
  });

  it("every git shell-out goes through gitEnv() — no GIT_DIR leakage (issue #205)", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\n");
    commitAll(tmpDir, "initial");

    // A leaked GIT_DIR pointed at a different repo would make `git -C
    // tmpDir diff` silently operate on THAT repo instead, regardless of
    // the explicit -C flag — the exact #205 corruption shape. Point it at a
    // throwaway second repo and confirm getDiffStats still reports tmpDir's
    // own (clean) state, proving gitEnv() stripped it.
    const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-diff-decoy-"));
    initRepo(decoyDir);
    fs.writeFileSync(path.join(decoyDir, "decoy.txt"), "decoy\n");
    commitAll(decoyDir, "decoy initial");
    fs.writeFileSync(path.join(decoyDir, "decoy.txt"), "decoy\nchanged\n");

    const savedGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(decoyDir, ".git");
    try {
      clearGitDiffStatsCacheForTests();
      const stats = await getDiffStats(tmpDir);
      expect(stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedGitDir;
      fs.rmSync(decoyDir, { recursive: true, force: true });
      clearGitDiffStatsCacheForTests();
    }
  });
});

describe("getDefaultBaseRef", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-default-ref-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a non-git-repo directory", () => {
    expect(getDefaultBaseRef(tmpDir)).toBeNull();
  });

  it("returns null when no remote tracking refs exist", () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    expect(getDefaultBaseRef(tmpDir)).toBeNull();
  });

  it("returns origin/main when git symbolic-ref points at it", () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-remote-"));
    execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe", env: gitEnv() });
    git(tmpDir, ["remote", "add", "origin", remoteDir]);
    git(tmpDir, ["push", "origin", "main", "--no-verify"]);
    git(tmpDir, ["remote", "set-head", "origin", "main"]);
    expect(getDefaultBaseRef(tmpDir)).toBe("origin/main");
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it("falls back to origin/main when symbolic-ref fails but the ref exists", () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-remote-"));
    execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe", env: gitEnv() });
    git(tmpDir, ["remote", "add", "origin", remoteDir]);
    git(tmpDir, ["push", "origin", "main", "--no-verify"]);
    // Don't set remote HEAD — the fallback should find origin/main via rev-parse.
    expect(getDefaultBaseRef(tmpDir)).toBe("origin/main");
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });
});
