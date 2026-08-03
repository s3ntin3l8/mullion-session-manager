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
  resolveCommitSha,
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
    // toMatchObject, not toEqual — issue #442 adds unconditional
    // `lastCommitRelative` (a "free" enrichment field, always populated on
    // any commit); this test only cares about name/isCurrent.
    expect(branches).toMatchObject([{ name: "main", isCurrent: true }]);
  });

  it("lists multiple branches, marking only the checked-out one current", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["branch", "feature/foo"]);
    git(tmpDir, ["branch", "feature/bar"]);

    const branches = await listBranches(tmpDir);
    expect(branches).toHaveLength(3);
    expect(branches).toContainEqual(expect.objectContaining({ name: "main", isCurrent: true }));
    expect(branches).toContainEqual(
      expect.objectContaining({ name: "feature/foo", isCurrent: false }),
    );
    expect(branches).toContainEqual(
      expect.objectContaining({ name: "feature/bar", isCurrent: false }),
    );
  });

  it("reflects a branch switch", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["checkout", "-b", "feature/foo"]);

    const branches = await listBranches(tmpDir);
    expect(branches).toContainEqual(expect.objectContaining({ name: "main", isCurrent: false }));
    expect(branches).toContainEqual(
      expect.objectContaining({ name: "feature/foo", isCurrent: true }),
    );
  });
});

describe("listBranches enrichment (issue #442)", () => {
  let tmpDir: string;
  let remoteDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-enrich-test-"));
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-enrich-origin-test-"));
    git(remoteDir, ["init", "--bare", "-b", "main"]);
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["remote", "add", "origin", remoteDir]);
    git(tmpDir, ["push", "-u", "origin", "main"]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it("leaves upstream/ahead/behind/upstreamGone/lastCommitRelative unset for a branch with no upstream", async () => {
    git(tmpDir, ["branch", "no-upstream"]);
    const branches = await listBranches(tmpDir);
    const branch = branches?.find((b) => b.name === "no-upstream");
    expect(branch?.upstream).toBeUndefined();
    expect(branch?.ahead).toBeUndefined();
    expect(branch?.behind).toBeUndefined();
    expect(branch?.upstreamGone).toBeUndefined();
    expect(branch?.lastCommitRelative).toBeDefined();
  });

  it("reports ahead and behind counts for a diverged upstream — free, no opts.detail needed", async () => {
    // main is 2 ahead of origin/main after this second local-only commit.
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    commitAll(tmpDir, "second");
    fs.writeFileSync(path.join(tmpDir, "c.txt"), "c");
    commitAll(tmpDir, "third");

    const branches = await listBranches(tmpDir);
    const main = branches?.find((b) => b.name === "main");
    expect(main?.upstream).toBe("origin/main");
    expect(main?.ahead).toBe(2);
    expect(main?.behind).toBeUndefined();
  });

  it("reports upstreamGone once the upstream branch is deleted on the remote", async () => {
    git(tmpDir, ["checkout", "-b", "gone-branch"]);
    git(tmpDir, ["push", "-u", "origin", "gone-branch"]);
    git(tmpDir, ["push", "origin", "--delete", "gone-branch"]);
    git(tmpDir, ["fetch", "--prune", "origin"]);

    const branches = await listBranches(tmpDir);
    const goneBranch = branches?.find((b) => b.name === "gone-branch");
    expect(goneBranch?.upstreamGone).toBe(true);
    expect(goneBranch?.ahead).toBeUndefined();
    expect(goneBranch?.behind).toBeUndefined();
  });

  it("does not compute isMerged when opts.detail is omitted", async () => {
    const branches = await listBranches(tmpDir);
    expect(branches?.every((b) => b.isMerged === undefined)).toBe(true);
  });

  it("marks a fully-merged branch isMerged: true and a diverged one false, under opts.detail", async () => {
    git(tmpDir, ["checkout", "-b", "merged-branch"]);
    git(tmpDir, ["checkout", "main"]);
    git(tmpDir, ["merge", "merged-branch", "--no-edit"]);

    git(tmpDir, ["checkout", "-b", "unmerged-branch"]);
    fs.writeFileSync(path.join(tmpDir, "d.txt"), "d");
    commitAll(tmpDir, "unmerged work");
    git(tmpDir, ["checkout", "main"]);

    const branches = await listBranches(tmpDir, { detail: true });
    expect(branches?.find((b) => b.name === "merged-branch")?.isMerged).toBe(true);
    expect(branches?.find((b) => b.name === "unmerged-branch")?.isMerged).toBe(false);
  });

  it("suppresses isMerged (leaves it undefined) when the base-ref chain falls through to HEAD", async () => {
    const noRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-enrich-no-remote-"));
    try {
      initRepo(noRemoteDir);
      fs.writeFileSync(path.join(noRemoteDir, "a.txt"), "a");
      commitAll(noRemoteDir, "initial");
      git(noRemoteDir, ["branch", "topic"]);

      const branches = await listBranches(noRemoteDir, { detail: true });
      expect(branches?.every((b) => b.isMerged === undefined)).toBe(true);
    } finally {
      fs.rmSync(noRemoteDir, { recursive: true, force: true });
    }
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

describe("resolveCommitSha (issue #491)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-resolve-commit-sha-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a branch name to its commit SHA", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const expected = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
      env: gitEnv(),
    })
      .toString("utf8")
      .trim();

    expect(await resolveCommitSha(tmpDir, "main")).toBe(expected);
  });

  it("returns null for an unresolvable ref", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    expect(await resolveCommitSha(tmpDir, "does-not-exist")).toBeNull();
  });

  it("returns null for a non-git-repo directory", async () => {
    expect(await resolveCommitSha(tmpDir, "HEAD")).toBeNull();
  });

  it("returns null for a repo with no commits yet", async () => {
    initRepo(tmpDir);
    expect(await resolveCommitSha(tmpDir, "HEAD")).toBeNull();
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
