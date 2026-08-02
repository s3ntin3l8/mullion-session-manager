import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { deleteBranch } from "../../src/services/git-branch-delete.js";
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

describe("deleteBranch (issue #442)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-branch-delete-test-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns not-a-repo for a non-git-repo directory", async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "git-branch-delete-non-repo-"));
    try {
      expect(await deleteBranch(nonGit, "main")).toEqual({ deleted: false, reason: "not-a-repo" });
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("returns not-a-repo for a relative cwd, even one that would otherwise resolve correctly", async () => {
    expect(await deleteBranch(path.relative(process.cwd(), tmpDir), "main")).toEqual({
      deleted: false,
      reason: "not-a-repo",
    });
  });

  it.each([
    ["empty", ""],
    ["starting with a dash", "-x"],
    ["containing whitespace", "foo bar"],
    ["containing ..", "foo..bar"],
    ["containing a control char", "foo\x01bar"],
    // Hermes review on PR #505 — these are glob metacharacters to
    // `for-each-ref`'s pattern argument (the precheck below), even though
    // none can ever appear in a real ref name. See isValidBranchName's own
    // doc comment for the exact bypass this closes.
    ["containing a glob star", "feature-*"],
    ["containing a glob question mark", "feature-?"],
    ["containing a glob character class", "feature-[ab]"],
  ])("rejects a branch name %s as invalid-name", async (_label, name) => {
    expect(await deleteBranch(tmpDir, name)).toEqual({ deleted: false, reason: "invalid-name" });
  });

  // Hermes review on PR #505 — verifies the actual bypass, not just the
  // rejection: before isValidBranchName closed this, `for-each-ref
  // refs/heads/feature-*` would glob-match both real branches below,
  // reading the WRONG ref's %(HEAD) and silently skipping the checked-out
  // guard (listWorktrees only ever compares against a literal branch name,
  // never a pattern) — this asserts a glob name is refused outright rather
  // than being allowed to reach that precheck at all.
  it("does not let a glob pattern bypass the checked-out-elsewhere guard via for-each-ref's own glob-matching", async () => {
    git(tmpDir, ["branch", "feature-one"]);
    git(tmpDir, ["branch", "feature-two"]);
    const linkedPath = path.join(tmpDir, "linked-worktree");
    git(tmpDir, ["worktree", "add", linkedPath, "feature-two"]);

    const result = await deleteBranch(tmpDir, "feature-*");
    expect(result).toEqual({ deleted: false, reason: "invalid-name" });
  });

  it("returns no-such-branch for a name that doesn't exist", async () => {
    expect(await deleteBranch(tmpDir, "does-not-exist")).toEqual({
      deleted: false,
      reason: "no-such-branch",
    });
  });

  it("refuses to delete the current branch", async () => {
    expect(await deleteBranch(tmpDir, "main")).toEqual({
      deleted: false,
      reason: "current-branch",
    });
  });

  it("refuses to delete a branch checked out in another worktree, naming its path", async () => {
    git(tmpDir, ["branch", "feature-x"]);
    const linkedPath = `${tmpDir}-linked-worktree`;
    git(tmpDir, ["worktree", "add", linkedPath, "feature-x"]);
    try {
      const result = await deleteBranch(tmpDir, "feature-x");
      expect(result.deleted).toBe(false);
      expect(result.reason).toBe("checked-out");
      expect(fs.realpathSync(result.detail ?? "")).toBe(fs.realpathSync(linkedPath));
    } finally {
      fs.rmSync(linkedPath, { recursive: true, force: true });
    }
  });

  it("deletes a fully-merged branch", async () => {
    git(tmpDir, ["checkout", "-b", "merged-branch"]);
    git(tmpDir, ["checkout", "main"]);
    git(tmpDir, ["merge", "merged-branch", "--no-edit"]);

    expect(await deleteBranch(tmpDir, "merged-branch")).toEqual({ deleted: true });
    const remaining = execFileSync("git", ["-C", tmpDir, "branch", "--list", "merged-branch"], {
      env: gitEnv(),
    })
      .toString()
      .trim();
    expect(remaining).toBe("");
  });

  it("refuses an unmerged branch without force, classifying the branch -d stderr", async () => {
    git(tmpDir, ["checkout", "-b", "unmerged-branch"]);
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    commitAll(tmpDir, "unmerged work");
    git(tmpDir, ["checkout", "main"]);

    expect(await deleteBranch(tmpDir, "unmerged-branch")).toEqual({
      deleted: false,
      reason: "unmerged",
    });
  });

  it("deletes an unmerged branch under force", async () => {
    git(tmpDir, ["checkout", "-b", "unmerged-branch-2"]);
    fs.writeFileSync(path.join(tmpDir, "c.txt"), "c");
    commitAll(tmpDir, "unmerged work");
    git(tmpDir, ["checkout", "main"]);

    expect(await deleteBranch(tmpDir, "unmerged-branch-2", { force: true })).toEqual({
      deleted: true,
    });
  });

  // Hermes review on PR #505 — an unexpected `git branch -d` failure (not
  // "not fully merged", not current-branch/checked-out, both precheck's
  // job) used to discard stderr entirely, surfacing as an undiagnosable
  // bare "delete-failed". Forces a real, reproducible unexpected failure
  // (a permission-denied ref lock, same technique as a read-only refs/
  // directory) rather than mocking git, per this repo's own test
  // convention, and asserts the detail is populated.
  it("includes a truncated stderr in detail for an unexpected delete failure", async () => {
    git(tmpDir, ["checkout", "-b", "locked-branch"]);
    git(tmpDir, ["checkout", "main"]);
    git(tmpDir, ["merge", "locked-branch", "--no-edit"]);

    const refsHeadsDir = path.join(tmpDir, ".git", "refs", "heads");
    fs.chmodSync(refsHeadsDir, 0o500);
    try {
      const result = await deleteBranch(tmpDir, "locked-branch");
      expect(result.deleted).toBe(false);
      expect(result.reason).toBe("delete-failed");
      expect(result.detail).toBeTruthy();
      expect(result.detail).toMatch(/permission denied/i);
    } finally {
      fs.chmodSync(refsHeadsDir, 0o700);
    }
  });

  it("routes every git call through gitEnv() — a leaked GIT_DIR must not redirect it (issue #205)", async () => {
    git(tmpDir, ["branch", "env-leak-guard"]);
    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), "git-branch-delete-other-repo-"));
    initRepo(otherRepo);

    const originalEnv = { ...process.env };
    try {
      process.env.GIT_DIR = path.join(otherRepo, ".git");
      const result = await deleteBranch(tmpDir, "env-leak-guard");
      expect(result).toEqual({ deleted: true });
    } finally {
      process.env = originalEnv;
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });
});
