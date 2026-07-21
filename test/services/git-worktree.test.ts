import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createWorktree, removeWorktree, pruneOrphans } from "../../src/services/git-worktree.js";
import { clearGitStatusCacheForTests } from "../../src/services/git-status.js";

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

describe("git-worktree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-test-"));
    clearGitStatusCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearGitStatusCacheForTests();
  });

  describe("createWorktree", () => {
    it("returns null for a non-git-repo directory", async () => {
      const result = await createWorktree({
        cwd: tmpDir,
        projectName: "myrepo",
        sessionId: "1",
        prefix: "tessera/{project}-{id}",
      });
      expect(result).toBeNull();
    });

    it("creates a worktree on a new branch and returns its path/branch", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const result = await createWorktree({
        cwd: tmpDir,
        projectName: "myrepo",
        sessionId: "42",
        prefix: "tessera/{project}-{id}",
      });

      expect(result).not.toBeNull();
      expect(result?.branch).toBe("tessera/myrepo-42");
      expect(fs.existsSync(result!.path)).toBe(true);
      expect(fs.existsSync(path.join(result!.path, "a.txt"))).toBe(true);

      // The branch is a real ref distinct from the checked-out worktree —
      // confirms this isn't a detached HEAD (the locked "branch, not
      // --detach" decision).
      const branches = execFileSync("git", ["branch"], { cwd: tmpDir, encoding: "utf8" });
      expect(branches).toContain("tessera/myrepo-42");
    });

    it("defaults the worktree under <cwd>/.tessera-worktrees when baseDir is omitted", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const result = await createWorktree({
        cwd: tmpDir,
        projectName: "myrepo",
        sessionId: "7",
        prefix: "tessera/{project}-{id}",
      });

      expect(result?.path).toBe(path.join(tmpDir, ".tessera-worktrees", "7"));
    });

    it("appends the nested base dir to .git/info/exclude so it never dirties the parent repo", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      await createWorktree({
        cwd: tmpDir,
        projectName: "myrepo",
        sessionId: "1",
        prefix: "tessera/{project}-{id}",
      });

      const exclude = fs.readFileSync(path.join(tmpDir, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain("/.tessera-worktrees/");

      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      expect(status.trim()).toBe("");
    });

    it("is idempotent about the exclude entry across repeated creates", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      await createWorktree({
        cwd: tmpDir,
        projectName: "myrepo",
        sessionId: "1",
        prefix: "tessera/{project}-{id}",
      });
      await createWorktree({
        cwd: tmpDir,
        projectName: "myrepo",
        sessionId: "2",
        prefix: "tessera/{project}-{id}",
      });

      const exclude = fs.readFileSync(path.join(tmpDir, ".git", "info", "exclude"), "utf8");
      expect(exclude.split("/.tessera-worktrees/").length - 1).toBe(1);
    });

    it("sanitizes an unsafe project name into a valid branch component", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const result = await createWorktree({
        cwd: tmpDir,
        projectName: "my repo?? weird/name",
        sessionId: "1",
        prefix: "tessera/{project}-{id}",
      });

      expect(result).not.toBeNull();
      expect(result?.branch).not.toContain("?");
      expect(result?.branch).not.toContain(" ");
    });

    it("truncates an absurdly long project name rather than choking on it (CodeQL alert #45)", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const result = await createWorktree({
        cwd: tmpDir,
        projectName: "a".repeat(10_000),
        sessionId: "1",
        prefix: "tessera/{project}-{id}",
      });

      expect(result).not.toBeNull();
      expect(result!.branch.length).toBeLessThan(300);
    });

    it("returns null for a relative cwd", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const result = await createWorktree({
        cwd: path.relative(process.cwd(), tmpDir),
        projectName: "myrepo",
        sessionId: "1",
        prefix: "tessera/{project}-{id}",
      });
      expect(result).toBeNull();
    });
  });

  describe("removeWorktree", () => {
    it("removes a clean worktree, keeping its branch ref", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const worktree = await createWorktree({
        cwd: tmpDir,
        projectName: "myrepo",
        sessionId: "1",
        prefix: "tessera/{project}-{id}",
      });
      expect(worktree).not.toBeNull();
      clearGitStatusCacheForTests();

      await removeWorktree({ cwd: tmpDir, worktreePath: worktree!.path });

      expect(fs.existsSync(worktree!.path)).toBe(false);
      const branches = execFileSync("git", ["branch"], { cwd: tmpDir, encoding: "utf8" });
      expect(branches).toContain(worktree!.branch);
    });

    it("leaves a dirty worktree (uncommitted changes) in place", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const worktree = await createWorktree({
        cwd: tmpDir,
        projectName: "myrepo",
        sessionId: "1",
        prefix: "tessera/{project}-{id}",
      });
      fs.writeFileSync(path.join(worktree!.path, "uncommitted.txt"), "wip");
      clearGitStatusCacheForTests();

      await removeWorktree({ cwd: tmpDir, worktreePath: worktree!.path });

      expect(fs.existsSync(worktree!.path)).toBe(true);
      expect(fs.existsSync(path.join(worktree!.path, "uncommitted.txt"))).toBe(true);
    });

    it("leaves a worktree with committed-but-unmerged commits in place if the tree itself is dirty", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const worktree = await createWorktree({
        cwd: tmpDir,
        projectName: "myrepo",
        sessionId: "1",
        prefix: "tessera/{project}-{id}",
      });
      fs.writeFileSync(path.join(worktree!.path, "b.txt"), "b");
      commitAll(worktree!.path, "wip commit");
      // Now dirty the tree again on top of that commit.
      fs.writeFileSync(path.join(worktree!.path, "c.txt"), "c");
      clearGitStatusCacheForTests();

      await removeWorktree({ cwd: tmpDir, worktreePath: worktree!.path });

      expect(fs.existsSync(worktree!.path)).toBe(true);
    });

    it("is a no-op for a worktree path that doesn't exist", async () => {
      initRepo(tmpDir);
      await expect(
        removeWorktree({ cwd: tmpDir, worktreePath: path.join(tmpDir, "nope") }),
      ).resolves.toBeUndefined();
    });
  });

  describe("pruneOrphans", () => {
    it("never throws for a non-git-repo directory", async () => {
      await expect(pruneOrphans(tmpDir)).resolves.toBeUndefined();
    });

    it("clears metadata for a worktree directory removed out-of-band", async () => {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const worktree = await createWorktree({
        cwd: tmpDir,
        projectName: "myrepo",
        sessionId: "1",
        prefix: "tessera/{project}-{id}",
      });
      // Remove the directory directly (not via git worktree remove), leaving
      // stale metadata under .git/worktrees/.
      fs.rmSync(worktree!.path, { recursive: true, force: true });

      const beforePrune = execFileSync("git", ["worktree", "list"], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      expect(beforePrune).toContain(worktree!.path);

      await pruneOrphans(tmpDir);

      const afterPrune = execFileSync("git", ["worktree", "list"], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      expect(afterPrune).not.toContain(worktree!.path);
    });
  });
});
