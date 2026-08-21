import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { runGitPull } from "../../src/services/git-pull.js";
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

describe("runGitPull (issue #745)", () => {
  let tmpDir: string;
  let remoteDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-pull-local-"));
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-pull-remote-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it("returns not-a-repo for a non-git-repo directory", async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "git-pull-non-repo-"));
    try {
      expect(await runGitPull(nonGit)).toEqual({ pulled: false, reason: "not-a-repo" });
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("returns not-a-repo for a relative cwd", async () => {
    initRepo(tmpDir);
    expect(await runGitPull(path.relative(process.cwd(), tmpDir))).toEqual({
      pulled: false,
      reason: "not-a-repo",
    });
  });

  it("returns unborn-head for a repository with no commits", async () => {
    initRepo(tmpDir);
    const result = await runGitPull(tmpDir);
    expect(result).toEqual({
      pulled: false,
      reason: "unborn-head",
      detail: "Current branch has no commits",
    });
  });

  it("returns detached-head when HEAD is detached", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
    commitAll(tmpDir, "commit 1");
    git(tmpDir, ["checkout", "--detach"]);

    const result = await runGitPull(tmpDir);
    expect(result).toEqual({
      pulled: false,
      reason: "detached-head",
      detail: "Cannot pull with detached HEAD",
    });
  });

  it("returns dirty-tree when working tree has uncommitted modifications", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
    commitAll(tmpDir, "commit 1");
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "modified");

    const result = await runGitPull(tmpDir);
    expect(result).toEqual({
      pulled: false,
      reason: "dirty-tree",
      detail: "Worktree has uncommitted changes",
    });
  });

  it("returns dirty-tree when working tree has untracked files", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
    commitAll(tmpDir, "commit 1");
    fs.writeFileSync(path.join(tmpDir, "untracked.txt"), "new file");

    const result = await runGitPull(tmpDir);
    expect(result).toEqual({
      pulled: false,
      reason: "dirty-tree",
      detail: "Worktree has uncommitted changes",
    });
  });

  it("returns no-upstream when current branch has no tracking branch configured", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
    commitAll(tmpDir, "commit 1");

    const result = await runGitPull(tmpDir);
    expect(result).toEqual({
      pulled: false,
      reason: "no-upstream",
      detail: "No upstream tracking branch configured",
    });
  });

  it("returns already-up-to-date when local and upstream are at the same commit", async () => {
    // Set up a bare remote
    initRepo(remoteDir);
    fs.writeFileSync(path.join(remoteDir, "file.txt"), "remote v1");
    commitAll(remoteDir, "commit 1");

    // Clone into tmpDir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    git(os.tmpdir(), ["clone", remoteDir, path.basename(tmpDir)]);

    const result = await runGitPull(tmpDir);
    expect(result).toEqual({
      pulled: true,
      reason: "already-up-to-date",
    });
  });

  it("fast-forwards successfully when upstream has new commits", async () => {
    // Set up remote repo
    initRepo(remoteDir);
    fs.writeFileSync(path.join(remoteDir, "file.txt"), "remote v1");
    commitAll(remoteDir, "commit 1");

    // Clone into tmpDir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    git(os.tmpdir(), ["clone", remoteDir, path.basename(tmpDir)]);

    // Push new commit to remote
    fs.writeFileSync(path.join(remoteDir, "file.txt"), "remote v2");
    commitAll(remoteDir, "commit 2");

    const result = await runGitPull(tmpDir);
    expect(result).toEqual({ pulled: true });

    // Verify local file content updated
    expect(fs.readFileSync(path.join(tmpDir, "file.txt"), "utf8")).toBe("remote v2");
  });

  it("refuses with not-fast-forward when local and upstream have diverged", async () => {
    // Set up remote repo
    initRepo(remoteDir);
    fs.writeFileSync(path.join(remoteDir, "file.txt"), "base");
    commitAll(remoteDir, "base commit");

    // Clone into tmpDir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    git(os.tmpdir(), ["clone", remoteDir, path.basename(tmpDir)]);
    git(tmpDir, ["config", "user.email", "test@example.com"]);
    git(tmpDir, ["config", "user.name", "Test"]);

    // Create local commit
    fs.writeFileSync(path.join(tmpDir, "local.txt"), "local commit");
    commitAll(tmpDir, "local commit");

    // Create different upstream commit
    fs.writeFileSync(path.join(remoteDir, "remote.txt"), "remote commit");
    commitAll(remoteDir, "remote commit");

    const result = await runGitPull(tmpDir);
    expect(result).toEqual({
      pulled: false,
      reason: "not-fast-forward",
      detail: "Branch has diverged from upstream",
    });
  });
});
