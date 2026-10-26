import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";
import { checkoutBranch, createBranch, rebaseBranch } from "../../src/services/git-branch-ops.js";

// Real repos, not a mocked spawn: what these guard is git's own behavior (a
// dirty tree, a conflicting rebase, a branch held by another worktree).

let root: string;
let origin: string;
let repo: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString().trim();
}

function commit(cwd: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, ["add", "-A"]);
  // The identity comes from test/setup.ts's GIT_AUTHOR_*/GIT_COMMITTER_* env.
  git(cwd, ["commit", "-q", "-m", message, "--no-verify"]);
}

const head = (cwd: string) => git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "git-branch-ops-"));
  origin = path.join(root, "origin.git");
  repo = path.join(root, "repo");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  git(root, ["clone", "-q", origin, repo]);
  git(repo, ["checkout", "-q", "-b", "main"]);
  commit(repo, "a.txt", "one\n", "initial");
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  git(repo, ["remote", "set-head", "origin", "main"]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("checkoutBranch", () => {
  it("refuses a non-repo, a bad name and the current branch", async () => {
    expect(await checkoutBranch(root, "main")).toEqual({ ok: false, reason: "not-a-repo" });
    expect(await checkoutBranch(repo, "-x")).toEqual({ ok: false, reason: "invalid-name" });
    expect(await checkoutBranch(repo, "main")).toEqual({ ok: false, reason: "already-current" });
  });

  it("refuses revision syntax that is not a branch name", async () => {
    for (const ref of ["HEAD", "@", "main@{1}"]) {
      expect(await checkoutBranch(repo, ref)).toEqual({ ok: false, reason: "invalid-name" });
    }
    expect(await createBranch(repo, "x", "main@{0}")).toMatchObject({ reason: "invalid-name" });
    expect(await rebaseBranch(repo, "@")).toMatchObject({ reason: "invalid-name" });
  });

  it("switches to a local branch", async () => {
    git(repo, ["branch", "feature"]);
    expect(await checkoutBranch(repo, "feature")).toEqual({ ok: true });
    expect(head(repo)).toBe("feature");
  });

  it("creates a branch that only exists on origin, tracking it", async () => {
    git(repo, ["push", "-q", "origin", "main:remote-only"]);
    git(repo, ["fetch", "-q"]);
    expect(await checkoutBranch(repo, "remote-only")).toEqual({ ok: true });
    expect(head(repo)).toBe("remote-only");
    expect(git(repo, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("origin/remote-only");
  });

  it("refuses an unknown branch", async () => {
    expect(await checkoutBranch(repo, "nope")).toEqual({ ok: false, reason: "no-such-branch" });
  });

  it("refuses on a dirty tree, untracked files included, and leaves it alone", async () => {
    git(repo, ["branch", "feature"]);
    fs.writeFileSync(path.join(repo, "new.txt"), "x");
    expect(await checkoutBranch(repo, "feature")).toMatchObject({
      ok: false,
      reason: "dirty-tree",
    });
    expect(head(repo)).toBe("main");
    expect(fs.existsSync(path.join(repo, "new.txt"))).toBe(true);
  });

  it("refuses a branch another worktree holds", async () => {
    const wt = path.join(root, "wt");
    git(repo, ["worktree", "add", "-q", "-b", "held", wt]);
    expect(await checkoutBranch(repo, "held")).toEqual({
      ok: false,
      reason: "checked-out",
      detail: fs.realpathSync(wt),
    });
  });
});

describe("createBranch", () => {
  it("creates a branch from a remote-tracking ref without an upstream, leaving HEAD", async () => {
    expect(await createBranch(repo, "topic", "origin/main")).toEqual({ ok: true });
    expect(head(repo)).toBe("main");
    expect(git(repo, ["rev-parse", "topic"])).toBe(git(repo, ["rev-parse", "origin/main"]));
    expect(() => git(repo, ["rev-parse", "--abbrev-ref", "topic@{u}"])).toThrow();
  });

  it("creates on a dirty tree when it does not switch", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    expect(await createBranch(repo, "topic", "main")).toEqual({ ok: true });
  });

  it("switches to the new branch with checkout, and refuses that on a dirty tree", async () => {
    expect(await createBranch(repo, "topic", "main", { checkout: true })).toEqual({ ok: true });
    expect(head(repo)).toBe("topic");

    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    expect(await createBranch(repo, "topic2", "main", { checkout: true })).toMatchObject({
      ok: false,
      reason: "dirty-tree",
    });
    expect(head(repo)).toBe("topic");
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/topic2"])).toThrow();
  });

  it("refuses an existing name, a bad name or start point, and an unknown start point", async () => {
    expect(await createBranch(root, "x", "main")).toEqual({ ok: false, reason: "not-a-repo" });
    expect(await createBranch(repo, "main", "main")).toEqual({
      ok: false,
      reason: "already-exists",
    });
    expect(await createBranch(repo, "a b", "main")).toEqual({ ok: false, reason: "invalid-name" });
    // Passes the cheap validator, fails git's own ref-format rules.
    expect(await createBranch(repo, "x.lock", "main")).toEqual({
      ok: false,
      reason: "invalid-name",
    });
    expect(await createBranch(repo, "x", "HEAD~1")).toMatchObject({ reason: "invalid-name" });
    expect(await createBranch(repo, "x", "nope")).toEqual({
      ok: false,
      reason: "no-such-ref",
      detail: "nope",
    });
  });
});

describe("rebaseBranch", () => {
  // `feature` forks from main; main then moves on in origin.
  function divergeOnOrigin(file: string, mainContent: string) {
    git(repo, ["checkout", "-q", "-b", "feature"]);
    commit(repo, "feature.txt", "f\n", "feature work");
    git(repo, ["checkout", "-q", "main"]);
    commit(repo, file, mainContent, "main moves");
    git(repo, ["push", "-q", "origin", "main"]);
    git(repo, ["reset", "-q", "--hard", "HEAD~1"]);
    git(repo, ["checkout", "-q", "feature"]);
  }

  it("refuses a non-repo, a detached HEAD, a dirty tree and a bad onto", async () => {
    expect(await rebaseBranch(root)).toEqual({ ok: false, reason: "not-a-repo" });
    expect(await rebaseBranch(repo, "a..b")).toMatchObject({ reason: "invalid-name" });
    fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
    expect(await rebaseBranch(repo)).toMatchObject({ ok: false, reason: "dirty-tree" });
    git(repo, ["checkout", "-q", "--", "a.txt"]);
    git(repo, ["checkout", "-q", "--detach"]);
    expect(await rebaseBranch(repo)).toEqual({ ok: false, reason: "detached-head" });
  });

  it("rebases onto origin/<default> when the branch has no upstream", async () => {
    divergeOnOrigin("b.txt", "main\n");
    const result = await rebaseBranch(repo);
    expect(result).toEqual({ ok: true, detail: "origin/main" });
    expect(head(repo)).toBe("feature");
    expect(git(repo, ["merge-base", "--is-ancestor", "origin/main", "HEAD"])).toBe("");
  });

  it("prefers the upstream, and reports a branch already on top of it", async () => {
    expect(await rebaseBranch(repo)).toEqual({
      ok: true,
      reason: "already-up-to-date",
      detail: "origin/main",
    });
  });

  it("aborts a conflicting rebase and returns the conflicting files", async () => {
    git(repo, ["checkout", "-q", "-b", "feature"]);
    commit(repo, "a.txt", "feature side\n", "feature edits a");
    const before = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-q", "main"]);
    commit(repo, "a.txt", "main side\n", "main edits a");
    git(repo, ["checkout", "-q", "feature"]);

    expect(await rebaseBranch(repo, "main")).toEqual({
      ok: false,
      reason: "conflicts",
      detail: "main",
      conflicts: ["a.txt"],
    });
    // Back exactly where it was: same commit, same branch, nothing mid-rebase.
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(head(repo)).toBe("feature");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(fs.existsSync(path.join(repo, ".git", "rebase-merge"))).toBe(false);
  });

  it("falls back to origin/<default> when the upstream branch is gone", async () => {
    git(repo, ["checkout", "-q", "-b", "merged"]);
    commit(repo, "m.txt", "m\n", "merged work");
    git(repo, ["push", "-q", "-u", "origin", "merged"]);
    git(repo, ["push", "-q", "origin", "--delete", "merged"]);
    expect(await rebaseBranch(repo)).toEqual({
      ok: true,
      reason: "already-up-to-date",
      detail: "origin/main",
    });
  });

  it("refuses while a rebase is paused at a break step", async () => {
    git(repo, ["checkout", "-q", "-b", "paused"]);
    commit(repo, "p.txt", "p\n", "paused work");
    execFileSync("git", ["rebase", "-i", "main"], {
      cwd: repo,
      stdio: "pipe",
      env: { ...gitEnv(), GIT_SEQUENCE_EDITOR: "sed -i '1i break'" },
    });
    expect(await rebaseBranch(repo)).toEqual({ ok: false, reason: "operation-in-progress" });
    git(repo, ["rebase", "--abort"]);
  });

  it("refuses while a conflicted rebase of either backend, or a killed one, is stopped", async () => {
    git(repo, ["checkout", "-q", "-b", "feature"]);
    commit(repo, "a.txt", "feature side\n", "feature edits a");
    git(repo, ["checkout", "-q", "main"]);
    commit(repo, "a.txt", "main side\n", "main edits a");
    git(repo, ["checkout", "-q", "feature"]);
    for (const backend of ["--apply", "--merge"]) {
      expect(() => git(repo, ["rebase", backend, "main"])).toThrow();
      expect(await rebaseBranch(repo)).toEqual({ ok: false, reason: "operation-in-progress" });
      git(repo, ["rebase", "--abort"]);
    }
    // Killed mid-way: the state directory survives, REBASE_HEAD does not.
    expect(() => git(repo, ["rebase", "--merge", "main"])).toThrow();
    fs.rmSync(path.join(repo, ".git", "REBASE_HEAD"));
    expect(await checkoutBranch(repo, "main")).toEqual({
      ok: false,
      reason: "operation-in-progress",
    });
    git(repo, ["rebase", "--abort"]);
    expect(await checkoutBranch(repo, "main")).toEqual({ ok: true });
  });

  it("refuses when nothing to rebase onto exists", async () => {
    git(repo, ["checkout", "-q", "-b", "lonely"]);
    git(repo, ["remote", "remove", "origin"]);
    expect(await rebaseBranch(repo)).toEqual({ ok: false, reason: "no-base" });
    expect(await rebaseBranch(repo, "nope")).toEqual({
      ok: false,
      reason: "no-such-ref",
      detail: "nope",
    });
  });

  it("refuses while a merge is stopped mid-way", async () => {
    git(repo, ["checkout", "-q", "-b", "feature"]);
    commit(repo, "a.txt", "feature side\n", "feature edits a");
    git(repo, ["checkout", "-q", "main"]);
    commit(repo, "a.txt", "main side\n", "main edits a");
    try {
      git(repo, ["merge", "feature"]);
    } catch {
      // the conflict is the point
    }
    git(repo, ["add", "-A"]);
    expect(await rebaseBranch(repo)).toEqual({ ok: false, reason: "operation-in-progress" });
    expect(await checkoutBranch(repo, "feature")).toEqual({
      ok: false,
      reason: "operation-in-progress",
    });
  });
});
