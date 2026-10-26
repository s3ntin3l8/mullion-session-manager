import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  getBranchDetail,
  isPlainBranchName,
  listBranches,
  listRemoteBranches,
  listWorktrees,
  resolveDefaultBaseRef,
  resolveDefaultBaseRefForPicker,
  resolveCommitSha,
  resolveRepoRoot,
} from "../../src/services/git-refs.js";
import { gitEnv } from "../../src/services/git-env.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function initRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
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
    expect(branches?.find((b) => b.name === "main")?.isMerged).toBe(false);
  });

  it("excludes a non-standard default branch (e.g. trunk) from isMerged when origin/HEAD points to it", async () => {
    const trunkRepo = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-trunk-repo-"));
    const trunkRemote = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-trunk-origin-"));
    try {
      git(trunkRemote, ["init", "--bare", "-b", "trunk"]);
      fs.mkdirSync(trunkRepo, { recursive: true });
      git(trunkRepo, ["init", "-b", "trunk"]);
      fs.writeFileSync(path.join(trunkRepo, "a.txt"), "a");
      commitAll(trunkRepo, "initial");
      git(trunkRepo, ["remote", "add", "origin", trunkRemote]);
      git(trunkRepo, ["push", "-u", "origin", "trunk"]);
      git(trunkRepo, ["remote", "set-head", "origin", "trunk"]);
      git(trunkRepo, ["branch", "merged-into-trunk"]);
      git(trunkRepo, ["branch", "main"]);
      git(trunkRepo, ["checkout", "-b", "working-feature"]);

      const branches = await listBranches(trunkRepo, { detail: true });
      expect(branches?.find((b) => b.name === "trunk")?.isMerged).toBe(false);
      expect(branches?.find((b) => b.name === "merged-into-trunk")?.isMerged).toBe(true);
      expect(branches?.find((b) => b.name === "main")?.isMerged).toBe(true);
    } finally {
      fs.rmSync(trunkRepo, { recursive: true, force: true });
      fs.rmSync(trunkRemote, { recursive: true, force: true });
    }
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

describe("resolveDefaultBaseRefForPicker (issue #271 follow-up)", () => {
  // The base-ref pickers' variant: same no-fetch chain as
  // resolveDefaultBaseRef, but "HEAD" (a fine worktree-creation arg, a bad
  // UI default) is normalized to `null` instead of leaking through.
  let tmpDir: string;
  let remoteDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-default-base-ref-picker-test-"));
    remoteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "git-refs-default-base-ref-picker-origin-test-"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  });

  it("returns null for a non-git-repo directory", async () => {
    expect(await resolveDefaultBaseRefForPicker(tmpDir)).toBeNull();
  });

  it("returns null (not the literal 'HEAD') for a repo with no origin remote configured", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    expect(await resolveDefaultBaseRefForPicker(tmpDir)).toBeNull();
  });

  it("resolves origin/main when origin/HEAD's symbolic ref is set", async () => {
    git(remoteDir, ["init", "--bare", "-b", "main"]);

    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["remote", "add", "origin", remoteDir]);
    git(tmpDir, ["push", "origin", "main"]);
    git(tmpDir, ["remote", "set-head", "origin", "main"]);

    expect(await resolveDefaultBaseRefForPicker(tmpDir)).toBe("origin/main");
  });

  // Hermes review, PR #695 — a dangling `refs/remotes/origin/HEAD` (upstream
  // default branch renamed/deleted, or a stale clone whose local
  // remote-tracking ref got pruned) must not be returned unverified: the
  // symbolic ref itself still resolves, but its target commit doesn't.
  // Falls through to the same origin/main|origin/master check every other
  // candidate already gets, same as if origin/HEAD had never been set at
  // all. No-fetch is what makes this reproducible: resolveDefaultBaseRef's
  // own `git fetch origin` would otherwise just re-download the "missing"
  // ref from this test's still-intact bare remote and mask the bug.
  it("falls through to origin/master when origin/HEAD points at a locally-pruned origin/main", async () => {
    git(remoteDir, ["init", "--bare", "-b", "main"]);

    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["remote", "add", "origin", remoteDir]);
    git(tmpDir, ["push", "origin", "main"]);
    git(tmpDir, ["push", "origin", "main:master"]);
    git(tmpDir, ["remote", "set-head", "origin", "main"]);
    // Simulates a stale clone whose local remote-tracking ref for the
    // upstream default branch is gone (pruned, or the branch itself
    // renamed/deleted upstream and never re-fetched): refs/remotes/
    // origin/HEAD still symbolically points at refs/remotes/origin/main,
    // but that ref itself no longer exists locally.
    git(tmpDir, ["update-ref", "-d", "refs/remotes/origin/main"]);

    expect(await resolveDefaultBaseRefForPicker(tmpDir)).toBe("origin/master");
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

describe("resolveRepoRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-root-test-")));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves the root from the root itself, a subdirectory, and a linked worktree's subdirectory", async () => {
    initRepo(tmpDir);
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const linked = path.join(tmpDir, ".wt", "feat-x");
    git(tmpDir, ["worktree", "add", linked, "-b", "feat-x"]);

    expect(await resolveRepoRoot(tmpDir)).toBe(tmpDir);
    expect(await resolveRepoRoot(path.join(tmpDir, "src"))).toBe(tmpDir);
    expect(await resolveRepoRoot(path.join(linked, "src"))).toBe(linked);
  });

  it("resolves a repository nested inside another (a submodule's shape) to its own root", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const nested = path.join(tmpDir, "vendor", "lib");
    initRepo(nested);

    // Its root is not the enclosing repo's, so a worktree-membership check on
    // the root rejects it.
    expect(await resolveRepoRoot(nested)).toBe(nested);
    expect(await resolveRepoRoot(nested)).not.toBe(tmpDir);
  });

  it("is null outside a repo, for a relative path, and for a path with ..", async () => {
    expect(await resolveRepoRoot(tmpDir)).toBeNull();
    expect(await resolveRepoRoot("relative/path")).toBeNull();
    expect(await resolveRepoRoot(`${tmpDir}/../x`)).toBeNull();
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

describe("listBranches mergeState and getBranchDetail", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-refs-mergestate-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["remote", "add", "origin", "https://example.invalid/r.git"]);
    git(tmpDir, ["update-ref", "refs/remotes/origin/main", "main"]);
    git(tmpDir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports sha always and ancestor / upstream-gone only under detail; the default branch gets none", async () => {
    git(tmpDir, ["branch", "anc"]);
    git(tmpDir, ["checkout", "-b", "gone"]);
    fs.writeFileSync(path.join(tmpDir, "g.txt"), "g");
    commitAll(tmpDir, "gone work");
    git(tmpDir, ["config", "branch.gone.remote", "origin"]);
    git(tmpDir, ["config", "branch.gone.merge", "refs/heads/gone"]);
    git(tmpDir, ["update-ref", "refs/remotes/origin/elsewhere", "gone"]);
    // gone upstream but unpushed work: not a done signal
    git(tmpDir, ["checkout", "-b", "gone-unpushed", "main"]);
    fs.writeFileSync(path.join(tmpDir, "u.txt"), "u");
    commitAll(tmpDir, "unpushed work");
    git(tmpDir, ["config", "branch.gone-unpushed.remote", "origin"]);
    git(tmpDir, ["config", "branch.gone-unpushed.merge", "refs/heads/gone-unpushed"]);
    git(tmpDir, ["checkout", "main"]);

    const plain = await listBranches(tmpDir);
    expect(plain?.every((b) => b.sha?.length === 40 && b.mergeState === undefined)).toBe(true);

    const detailed = await listBranches(tmpDir, { detail: true });
    expect(detailed?.find((b) => b.name === "anc")?.mergeState).toBe("ancestor");
    expect(detailed?.find((b) => b.name === "gone")?.mergeState).toBe("upstream-gone");
    expect(detailed?.find((b) => b.name === "gone-unpushed")?.mergeState).toBeUndefined();
    expect(detailed?.find((b) => b.name === "main")?.mergeState).toBeUndefined();
  });

  it("getBranchDetail reports base counts, unique commits and a tracked upstream", async () => {
    git(tmpDir, ["checkout", "-b", "feat"]);
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "f");
    commitAll(tmpDir, "feat work");
    git(tmpDir, ["update-ref", "refs/remotes/origin/feat", "feat"]);
    git(tmpDir, ["config", "branch.feat.remote", "origin"]);
    git(tmpDir, ["config", "branch.feat.merge", "refs/heads/feat"]);
    git(tmpDir, ["checkout", "main"]);
    fs.writeFileSync(path.join(tmpDir, "m.txt"), "m");
    commitAll(tmpDir, "main moves");
    git(tmpDir, ["update-ref", "refs/remotes/origin/main", "main"]);

    const detail = await getBranchDetail(tmpDir, "feat");
    expect(detail).toMatchObject({
      name: "feat",
      upstream: "origin/feat",
      upstreamAhead: 0,
      upstreamBehind: 0,
      base: "origin/main",
      baseAhead: 1,
      baseBehind: 1,
      uniqueTruncated: false,
    });
    expect(detail?.uniqueCommits.map((c) => c.subject)).toEqual(["feat work"]);
    expect(detail?.lastCommit?.author).toBe(detail?.uniqueCommits[0].author);
  });

  it("getBranchDetail caps unique commits at 50 and reports an ahead upstream", async () => {
    git(tmpDir, ["checkout", "-b", "big"]);
    git(tmpDir, ["update-ref", "refs/remotes/origin/big", "big"]);
    git(tmpDir, ["config", "branch.big.remote", "origin"]);
    git(tmpDir, ["config", "branch.big.merge", "refs/heads/big"]);
    for (let i = 0; i < 51; i++)
      git(tmpDir, ["commit", "--allow-empty", "-m", `c${i}`, "--no-verify"]);
    const detail = await getBranchDetail(tmpDir, "big");
    expect(detail?.uniqueCommits).toHaveLength(50);
    expect(detail?.uniqueTruncated).toBe(true);
    expect(detail?.upstreamAhead).toBe(51);
  });

  it("getBranchDetail is null for a missing branch, a flag-like name or a non-repo", async () => {
    expect(await getBranchDetail(tmpDir, "nope")).toBeNull();
    expect(await getBranchDetail(tmpDir, "--all")).toBeNull();
    expect(await getBranchDetail(os.tmpdir(), "main")).toBeNull();
  });

  it("isPlainBranchName rejects flags, globs, revision syntax and control bytes", () => {
    for (const bad of [
      "",
      "-x",
      "a..b",
      "a b",
      "a*",
      "a~1",
      "a^",
      "a:b",
      "a\\b",
      "a\u0001",
      "x".repeat(256),
    ]) {
      expect(isPlainBranchName(bad)).toBe(false);
    }
    expect(isPlainBranchName("feature/foo-1")).toBe(true);
  });
});
