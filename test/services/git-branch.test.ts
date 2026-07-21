import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readGitBranch } from "../../src/services/git-branch.js";

function writeHead(gitDir: string, content: string) {
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), content);
}

describe("readGitBranch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-branch-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a branch name off a symbolic HEAD", () => {
    writeHead(path.join(tmpDir, ".git"), "ref: refs/heads/main\n");
    expect(readGitBranch(tmpDir)).toBe("main");
  });

  it("reads a slashed branch name (e.g. feature/foo)", () => {
    writeHead(path.join(tmpDir, ".git"), "ref: refs/heads/feature/foo\n");
    expect(readGitBranch(tmpDir)).toBe("feature/foo");
  });

  it("returns a short SHA for a detached HEAD", () => {
    writeHead(path.join(tmpDir, ".git"), "abcdef0123456789abcdef0123456789abcdef01\n");
    expect(readGitBranch(tmpDir)).toBe("abcdef0");
  });

  it("returns null for unrecognized HEAD content", () => {
    writeHead(path.join(tmpDir, ".git"), "not a real HEAD file\n");
    expect(readGitBranch(tmpDir)).toBeNull();
  });

  it("returns null when .git/HEAD doesn't exist", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    expect(readGitBranch(tmpDir)).toBeNull();
  });

  it("returns null when cwd isn't a git repo at all", () => {
    expect(readGitBranch(tmpDir)).toBeNull();
  });

  it("returns null for a relative cwd, even one that would otherwise resolve correctly", () => {
    writeHead(path.join(tmpDir, ".git"), "ref: refs/heads/main\n");
    expect(readGitBranch(path.relative(process.cwd(), tmpDir))).toBeNull();
  });

  it("returns null for a worktree checkout, rather than following its .git file's redirect (CodeQL: path-injection)", () => {
    // A `git worktree` checkout's `.git` is a *file* (not a directory)
    // containing `gitdir: <path>` — deliberately not followed (see
    // git-branch.ts's own doc comment): that path is untrusted file
    // content, not something PROJECTS_ROOTS/resolveWithinRoots constrains,
    // so trusting it would let a crafted `.git` file redirect reads
    // anywhere on disk. `<cwd>/.git/HEAD` simply doesn't exist for a
    // worktree checkout, so this degrades to the same "no branch info"
    // result as a plain non-repo directory — issue #100 will resolve a
    // worktree session's branch some other way.
    const worktreeGitDir = path.join(tmpDir, "main-repo", ".git", "worktrees", "feature");
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature-branch\n");

    const worktreeCheckout = path.join(tmpDir, "feature-checkout");
    fs.mkdirSync(worktreeCheckout, { recursive: true });
    fs.writeFileSync(path.join(worktreeCheckout, ".git"), `gitdir: ${worktreeGitDir}\n`);

    expect(readGitBranch(worktreeCheckout)).toBeNull();
  });
});
