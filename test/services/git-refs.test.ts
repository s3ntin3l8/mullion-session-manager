import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  listBranches,
  listRemoteBranches,
  listWorktrees,
  resolveDefaultBaseRef,
} from "../../src/services/git-refs.js";
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
  // --no-verify: this is a throwaway fixture repo, no hooks should run.
  git(cwd, ["commit", "-m", message, "--no-verify"]);
}

describe("listBranches", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-branches-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a non-git-repo directory", async () => {
    expect(await listBranches(tmpDir)).toBeNull();
  });

  it("returns null for a relative cwd, even one that would otherwise resolve correctly", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    expect(await listBranches(path.relative(process.cwd(), tmpDir))).toBeNull();
  });

  it("lists the single branch on a fresh repo, marked current", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const branches = await listBranches(tmpDir);
    expect(branches).toEqual([{ name: "main", isCurrent: true }]);
  });

  it("lists multiple branches, marking only the checked-out one current", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["branch", "feature/foo"]);
    git(tmpDir, ["branch", "feature/bar"]);

    const branches = await listBranches(tmpDir);
    expect(branches).toHaveLength(3);
    expect(branches).toContainEqual({ name: "main", isCurrent: true });
    expect(branches).toContainEqual({ name: "feature/foo", isCurrent: false });
    expect(branches).toContainEqual({ name: "feature/bar", isCurrent: false });
  });

  it("reflects a branch switch", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["checkout", "-b", "feature/foo"]);

    const branches = await listBranches(tmpDir);
    expect(branches).toContainEqual({ name: "main", isCurrent: false });
    expect(branches).toContainEqual({ name: "feature/foo", isCurrent: true });
  });
});

describe("listRemoteBranches (issue #271)", () => {
  let tmpDir: string;
  let remoteDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-remote-branches-test-"));
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-remote-origin-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it("returns null for a non-git-repo directory", async () => {
    expect(await listRemoteBranches(tmpDir)).toBeNull();
  });

  it("returns an empty list for a repo with no remote configured", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    expect(await listRemoteBranches(tmpDir)).toEqual([]);
  });

  it("lists remote-tracking branches, stripping the symbolic origin/HEAD entry", async () => {
    git(remoteDir, ["init", "--bare", "-b", "main"]);

    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["remote", "add", "origin", remoteDir]);
    git(tmpDir, ["push", "origin", "main"]);
    git(tmpDir, ["checkout", "-b", "feature/x"]);
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    commitAll(tmpDir, "second");
    git(tmpDir, ["push", "origin", "feature/x"]);
    git(tmpDir, ["fetch", "origin"]);
    git(tmpDir, ["remote", "set-head", "origin", "main"]);

    const remoteBranches = await listRemoteBranches(tmpDir);
    expect(remoteBranches).toContain("origin/main");
    expect(remoteBranches).toContain("origin/feature/x");
    expect(remoteBranches).not.toContain("origin/HEAD");
  });
});

describe("resolveDefaultBaseRef (issue #216)", () => {
  let tmpDir: string;
  let remoteDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-default-base-ref-test-"));
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-default-base-ref-origin-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it("returns HEAD for a non-git-repo directory", async () => {
    expect(await resolveDefaultBaseRef(tmpDir)).toBe("HEAD");
  });

  it("falls back to HEAD for a repo with no origin remote configured", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    expect(await resolveDefaultBaseRef(tmpDir)).toBe("HEAD");
  });

  it("resolves origin/main when origin/HEAD's symbolic ref is set", async () => {
    git(remoteDir, ["init", "--bare", "-b", "main"]);

    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["remote", "add", "origin", remoteDir]);
    git(tmpDir, ["push", "origin", "main"]);
    git(tmpDir, ["remote", "set-head", "origin", "main"]);

    expect(await resolveDefaultBaseRef(tmpDir)).toBe("origin/main");
  });

  it("falls back to origin/main when origin/HEAD isn't set but origin/main exists", async () => {
    git(remoteDir, ["init", "--bare", "-b", "main"]);

    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["remote", "add", "origin", remoteDir]);
    git(tmpDir, ["push", "origin", "main"]);
    // Deliberately no `git remote set-head` — origin/HEAD stays unresolved.

    expect(await resolveDefaultBaseRef(tmpDir)).toBe("origin/main");
  });

  it("falls back to origin/master when only origin/master exists", async () => {
    git(remoteDir, ["init", "--bare", "-b", "master"]);

    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["remote", "add", "origin", remoteDir]);
    git(tmpDir, ["push", "origin", "main:master"]);

    expect(await resolveDefaultBaseRef(tmpDir)).toBe("origin/master");
  });
});

describe("listWorktrees", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-worktrees-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a non-git-repo directory", async () => {
    expect(await listWorktrees(tmpDir)).toBeNull();
  });

  it("lists just the main worktree on a fresh repo", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const worktrees = await listWorktrees(tmpDir);
    expect(worktrees).toEqual([{ path: tmpDir, branch: "main", isMain: true }]);
  });

  it("lists a linked worktree, whoever created it — this is the 'awareness' half of issue #162", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const linkedPath = `${tmpDir}-linked-worktree`;
    git(tmpDir, ["worktree", "add", "-b", "agent/task-1", linkedPath]);

    const worktrees = await listWorktrees(tmpDir);
    expect(worktrees).toHaveLength(2);
    expect(worktrees?.[0]).toMatchObject({ isMain: true, branch: "main" });
    const linked = worktrees?.find((w) => w.isMain === false);
    expect(linked?.branch).toBe("agent/task-1");
    expect(fs.realpathSync(linked?.path ?? "")).toBe(fs.realpathSync(linkedPath));

    fs.rmSync(linkedPath, { recursive: true, force: true });
  });

  it("reports a detached-HEAD worktree with a null branch", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const linkedPath = `${tmpDir}-detached-worktree`;
    git(tmpDir, ["worktree", "add", "--detach", linkedPath]);

    const worktrees = await listWorktrees(tmpDir);
    const linked = worktrees?.find((w) => w.isMain === false);
    expect(linked?.branch).toBeNull();

    fs.rmSync(linkedPath, { recursive: true, force: true });
  });
});
