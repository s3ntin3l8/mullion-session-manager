import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";
import { branchCheckoutPath, pullBranch } from "../../src/services/git-branch-ops.js";

// Issue #3068 — the per-branch fast-forward Pull, against real temporary
// repositories (never this repo): what it guards is git's own behaviour.
// Every refusal also asserts the branch did not move.

let root: string;
let origin: string;
let repo: string;
let other: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString().trim();
}

function commit(cwd: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message, "--no-verify"]);
}

const sha = (cwd: string, ref: string) => git(cwd, ["rev-parse", ref]);

/** Pushes one commit to origin's `branch` from the second clone. */
function advanceOrigin(branch: string, file = "up.txt"): string {
  git(other, ["fetch", "-q", "origin"]);
  git(other, ["checkout", "-q", "-B", branch, `origin/${branch}`]);
  commit(other, file, `${Date.now()}-${Math.random()}\n`, `upstream ${branch}`);
  git(other, ["push", "-q", "origin", branch]);
  return sha(other, "HEAD");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "git-branch-pull-"));
  origin = path.join(root, "origin.git");
  repo = path.join(root, "repo");
  other = path.join(root, "other");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  git(root, ["clone", "-q", origin, repo]);
  git(repo, ["checkout", "-q", "-b", "main"]);
  commit(repo, "a.txt", "one\n", "initial");
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  git(repo, ["push", "-q", "origin", "main:feature"]);
  git(repo, ["fetch", "-q", "origin"]);
  git(repo, ["branch", "-q", "--track", "feature", "origin/feature"]);
  git(root, ["clone", "-q", origin, other]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("pullBranch — checked out nowhere", () => {
  it("fast-forwards the ref without touching any working tree", async () => {
    const target = advanceOrigin("feature");
    const status = git(repo, ["status", "--porcelain"]);
    expect(await pullBranch(repo, "feature", null)).toEqual({ ok: true, detail: "origin/feature" });
    expect(sha(repo, "feature")).toBe(target);
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(git(repo, ["status", "--porcelain"])).toBe(status);
  });

  it("follows an upstream whose name differs from the branch", async () => {
    git(repo, ["branch", "-q", "--track", "local-name", "origin/feature"]);
    const target = advanceOrigin("feature");
    expect(await pullBranch(repo, "local-name", null)).toEqual({
      ok: true,
      detail: "origin/feature",
    });
    expect(sha(repo, "local-name")).toBe(target);
  });

  it("reports already-up-to-date and moves nothing", async () => {
    const before = sha(repo, "feature");
    expect(await pullBranch(repo, "feature", null)).toEqual({
      ok: true,
      reason: "already-up-to-date",
      detail: "origin/feature",
    });
    expect(sha(repo, "feature")).toBe(before);
  });

  it("treats a branch that is only ahead as up to date", async () => {
    git(repo, ["checkout", "-q", "feature"]);
    commit(repo, "local.txt", "x\n", "local only");
    git(repo, ["checkout", "-q", "main"]);
    const before = sha(repo, "feature");
    expect(await pullBranch(repo, "feature", null)).toMatchObject({
      ok: true,
      reason: "already-up-to-date",
    });
    expect(sha(repo, "feature")).toBe(before);
  });

  it("refuses a diverged branch, never merging or rebasing", async () => {
    git(repo, ["checkout", "-q", "feature"]);
    commit(repo, "local.txt", "x\n", "local only");
    git(repo, ["checkout", "-q", "main"]);
    const before = sha(repo, "feature");
    advanceOrigin("feature");
    expect(await pullBranch(repo, "feature", null)).toMatchObject({
      ok: false,
      reason: "not-fast-forward",
    });
    expect(sha(repo, "feature")).toBe(before);
  });

  it("refuses a branch with no upstream", async () => {
    git(repo, ["branch", "-q", "--no-track", "lonely", "main"]);
    expect(await pullBranch(repo, "lonely", null)).toMatchObject({
      ok: false,
      reason: "no-upstream",
    });
  });

  it("refuses an upstream that is gone, and a fetch.prune setting cannot delete the branch", async () => {
    git(repo, ["config", "fetch.prune", "true"]);
    git(other, ["push", "-q", "origin", "--delete", "feature"]);
    const before = sha(repo, "feature");
    expect(await pullBranch(repo, "feature", null)).toMatchObject({
      ok: false,
      reason: "no-upstream",
      detail: "The upstream origin/feature no longer exists",
    });
    expect(sha(repo, "feature")).toBe(before);
  });

  it("fast-forwards from a local upstream without fetching", async () => {
    git(repo, ["branch", "-q", "--track", "follower", "main"]);
    git(repo, ["branch", "-q", "-f", "follower", "main"]);
    commit(repo, "b.txt", "two\n", "main moves");
    expect(await pullBranch(repo, "follower", null)).toEqual({ ok: true, detail: "main" });
    expect(sha(repo, "follower")).toBe(sha(repo, "main"));
  });

  it("refuses a bad name, an unknown branch and a non-repo", async () => {
    expect(await pullBranch(repo, "-x", null)).toEqual({ ok: false, reason: "invalid-name" });
    expect(await pullBranch(repo, "HEAD", null)).toEqual({ ok: false, reason: "invalid-name" });
    expect(await pullBranch(repo, "nope", null)).toEqual({ ok: false, reason: "no-such-branch" });
    expect(await pullBranch(root, "main", null)).toEqual({ ok: false, reason: "not-a-repo" });
  });

  it("refuses when the caller believed the branch was checked out nowhere but it is", async () => {
    const wt = path.join(root, "wt");
    git(repo, ["worktree", "add", "-q", wt, "feature"]);
    advanceOrigin("feature");
    const before = sha(repo, "feature");
    expect(await pullBranch(repo, "feature", null)).toMatchObject({ ok: false, reason: "failed" });
    // …and the main checkout counts too.
    advanceOrigin("main");
    const mainBefore = sha(repo, "main");
    expect(await pullBranch(repo, "main", null)).toMatchObject({ ok: false, reason: "failed" });
    expect(sha(repo, "feature")).toBe(before);
    expect(sha(repo, "main")).toBe(mainBefore);
  });

  it("never moves a branch a worktree holds mid-rebase (listed as detached)", async () => {
    const wt = path.join(root, "wt");
    git(repo, ["worktree", "add", "-q", wt, "feature"]);
    // An interactive rebase stopped at a `break`: the branch is untouched and
    // would fast-forward, but the worktree is mid-rebase on it.
    execFileSync("git", ["rebase", "-i", "HEAD"], {
      cwd: wt,
      stdio: "pipe",
      env: { ...gitEnv(), GIT_SEQUENCE_EDITOR: "sh -c 'echo break > \"$1\"' --" },
    });
    // `worktree list` no longer names the branch, so the caller saw "nowhere".
    expect((await branchCheckoutPath(repo, "feature"))?.path).toBeNull();
    advanceOrigin("feature");
    const before = sha(repo, "feature");
    expect(await pullBranch(repo, "feature", null)).toEqual({
      ok: false,
      reason: "checked-out",
      detail: expect.stringContaining("wt"),
    });
    expect(sha(repo, "feature")).toBe(before);
  });
});

describe("pullBranch — checked out in a worktree", () => {
  let wt: string;
  beforeEach(() => {
    wt = path.join(root, "wt");
    git(repo, ["worktree", "add", "-q", wt, "feature"]);
  });

  it("fast-forwards the linked worktree", async () => {
    const target = advanceOrigin("feature");
    expect(await pullBranch(repo, "feature", wt)).toEqual({ ok: true });
    expect(sha(wt, "HEAD")).toBe(target);
    expect(git(wt, ["status", "--porcelain"])).toBe("");
  });

  it("fast-forwards the project checkout's own current branch", async () => {
    const target = advanceOrigin("main");
    expect(await pullBranch(repo, "main", repo)).toEqual({ ok: true });
    expect(sha(repo, "HEAD")).toBe(target);
  });

  it("reports already-up-to-date", async () => {
    expect(await pullBranch(repo, "feature", wt)).toEqual({
      ok: true,
      reason: "already-up-to-date",
      detail: "origin/feature",
    });
  });

  it("refuses a dirty worktree and leaves it alone", async () => {
    advanceOrigin("feature");
    const before = sha(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "scratch.txt"), "wip");
    expect(await pullBranch(repo, "feature", wt)).toMatchObject({
      ok: false,
      reason: "dirty-tree",
    });
    expect(sha(wt, "HEAD")).toBe(before);
    expect(fs.readFileSync(path.join(wt, "scratch.txt"), "utf8")).toBe("wip");
  });

  it("refuses a diverged worktree", async () => {
    commit(wt, "local.txt", "x\n", "local only");
    const before = sha(wt, "HEAD");
    advanceOrigin("feature");
    expect(await pullBranch(repo, "feature", wt)).toMatchObject({
      ok: false,
      reason: "not-fast-forward",
    });
    expect(sha(wt, "HEAD")).toBe(before);
  });

  it("refuses a worktree with no upstream", async () => {
    git(wt, ["branch", "--unset-upstream"]);
    expect(await pullBranch(repo, "feature", wt)).toMatchObject({
      ok: false,
      reason: "no-upstream",
    });
  });

  it("refuses a stopped merge, before calling the tree dirty", async () => {
    commit(wt, "a.txt", "feature side\n", "feature edits a");
    commit(repo, "a.txt", "main side\n", "main edits a");
    expect(() => git(wt, ["merge", "main"])).toThrow();
    expect(await pullBranch(repo, "feature", wt)).toMatchObject({
      ok: false,
      reason: "operation-in-progress",
    });
  });

  it("refuses when the caller guarded another checkout than the one holding the branch", async () => {
    advanceOrigin("feature");
    const before = sha(repo, "feature");
    expect(await pullBranch(repo, "feature", path.join(root, "elsewhere"))).toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(sha(repo, "feature")).toBe(before);
  });
});
