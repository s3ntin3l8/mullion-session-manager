import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  checkoutBranchWorktree,
  createWorktree,
  isDockPreviewWorktree,
  removeWorktree,
  syncWorktree,
} from "../../src/services/git-worktree.js";
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

describe("createWorktree (issue #271)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a non-git-repo directory", async () => {
    expect(await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "s1" })).toBeNull();
  });

  it("returns null for a relative cwd, even one that would otherwise resolve correctly", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const relative = path.relative(process.cwd(), tmpDir);
    expect(await createWorktree({ cwd: relative, baseRef: "main", seed: "s1" })).toBeNull();
  });

  it("returns null when baseRef does not resolve", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    expect(await createWorktree({ cwd: tmpDir, baseRef: "no-such-ref", seed: "s1" })).toBeNull();
  });

  it("rejects a baseRef starting with '-' — argument injection hardening, Hermes review on PR #277", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    // No real branch ever starts with "-"; `git worktree add`'s argv would
    // otherwise reinterpret a leading-dash baseRef as a flag rather than a
    // ref (e.g. "--force"), regardless of its argument position — this
    // matters because baseRef can originate as a model-authored
    // suggestedBaseRef (the promote_to_worktree MCP tool) that reaches this
    // function unchanged if a human submits the promote dialog without
    // editing the pre-filled picker.
    expect(await createWorktree({ cwd: tmpDir, baseRef: "--force", seed: "s1" })).toBeNull();
    expect(await createWorktree({ cwd: tmpDir, baseRef: "-x", seed: "s1" })).toBeNull();
  });

  it("creates a worktree under .mullion-worktrees, branched off baseRef, on a fresh branch", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const result = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "my-feature" });
    expect(result).not.toBeNull();
    expect(result?.path).toBe(path.join(tmpDir, ".mullion-worktrees", "my-feature"));
    expect(result?.branch).toBe("mullion/my-feature");
    expect(fs.existsSync(result?.path ?? "")).toBe(true);

    // -b, never --detach — the branch must survive a future `worktree remove`.
    const branchListOutput = execFileSync(
      "git",
      ["-C", tmpDir, "branch", "--list", "mullion/my-feature"],
      {
        env: gitEnv(),
      },
    ).toString();
    expect(branchListOutput).toContain("mullion/my-feature");
  });

  it("branches off the given baseRef, not just HEAD", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["checkout", "-b", "other-branch"]);
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    commitAll(tmpDir, "second");
    git(tmpDir, ["checkout", "main"]);

    const result = await createWorktree({
      cwd: tmpDir,
      baseRef: "other-branch",
      seed: "off-other",
    });
    expect(result).not.toBeNull();
    expect(fs.existsSync(path.join(result?.path ?? "", "b.txt"))).toBe(true);
  });

  it("honors an explicit branchName override, sanitizing each path segment", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const result = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: "seed-1",
      branchName: "feature/my cool branch!",
    });
    expect(result?.branch).toBe("feature/my-cool-branch");
  });

  it("adds the base directory to .git/info/exclude so the parent repo's status stays clean", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "s1" });
    const exclude = fs.readFileSync(path.join(tmpDir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.mullion-worktrees/");

    const status = execFileSync("git", ["-C", tmpDir, "status", "--porcelain"], {
      env: gitEnv(),
    }).toString();
    expect(status.trim()).toBe("");
  });

  it("routes every git call through gitEnv() — a leaked GIT_DIR must not redirect it (issue #205)", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-other-repo-"));
    initRepo(otherRepo);

    const originalEnv = { ...process.env };
    try {
      process.env.GIT_DIR = path.join(otherRepo, ".git");
      const result = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "env-leak-guard" });
      expect(result).not.toBeNull();
      expect(result?.path).toBe(path.join(tmpDir, ".mullion-worktrees", "env-leak-guard"));
    } finally {
      process.env = originalEnv;
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });
});

describe("checkoutBranchWorktree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-checkout-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a non-git-repo directory", async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-"));
    try {
      expect(await checkoutBranchWorktree(nonGit, "main")).toBeNull();
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("returns null for a relative cwd", async () => {
    const relative = path.relative(process.cwd(), tmpDir);
    expect(await checkoutBranchWorktree(relative, "main")).toBeNull();
  });

  it("returns null for an empty branch name", async () => {
    expect(await checkoutBranchWorktree(tmpDir, "")).toBeNull();
  });

  it("rejects a branch name starting with '-'", async () => {
    expect(await checkoutBranchWorktree(tmpDir, "-x")).toBeNull();
  });

  it("creates a preview worktree under .mullion-worktrees with hash suffix", async () => {
    const result = await checkoutBranchWorktree(tmpDir, "main");
    expect(result).not.toBeNull();
    expect(result?.branch).toBe("main");
    expect(result?.path).toMatch(/dock-preview-main-[0-9a-f]{6}$/);
    expect(result?.path).toContain(".mullion-worktrees");
    expect(fs.existsSync(result?.path ?? "")).toBe(true);
  });

  it("works for feature branches with slashes", async () => {
    git(tmpDir, ["checkout", "-b", "feature/my-feature"]);
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    commitAll(tmpDir, "feature commit");

    const result = await checkoutBranchWorktree(tmpDir, "feature/my-feature");
    expect(result).not.toBeNull();
    expect(fs.existsSync(result?.path ?? "")).toBe(true);

    // Verify it checked out the right branch content
    expect(fs.existsSync(path.join(result?.path ?? "", "b.txt"))).toBe(true);
  });

  it("produces distinct directories for collision-prone names", async () => {
    git(tmpDir, ["checkout", "-b", "feature/foo"]);
    git(tmpDir, ["checkout", "-b", "feature--foo"]);
    git(tmpDir, ["checkout", "main"]);

    const r1 = await checkoutBranchWorktree(tmpDir, "feature/foo");
    const r2 = await checkoutBranchWorktree(tmpDir, "feature--foo");
    // Both should succeed with different paths (hash suffix disambiguates)
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1?.path).not.toBe(r2?.path);
  });

  it("adds .mullion-worktrees to .git/info/exclude", async () => {
    await checkoutBranchWorktree(tmpDir, "main");
    const exclude = fs.readFileSync(path.join(tmpDir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.mullion-worktrees/");
  });
});

describe("removeWorktree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-remove-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes a preview worktree created by checkoutBranchWorktree", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();

    const removed = await removeWorktree(created!.path, tmpDir);
    expect(removed).toBe(true);
    expect(fs.existsSync(created!.path)).toBe(false);
  });

  it("removes a dirty worktree with --force", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();

    // Dirty the worktree with an uncommitted change
    fs.writeFileSync(path.join(created!.path, "dirty.txt"), "dirty");
    expect(fs.existsSync(path.join(created!.path, "dirty.txt"))).toBe(true);

    // Should succeed even though the worktree is dirty (--force)
    const removed = await removeWorktree(created!.path, tmpDir);
    expect(removed).toBe(true);
    expect(fs.existsSync(created!.path)).toBe(false);
  });

  it("returns false for a non-existent worktree path", async () => {
    const removed = await removeWorktree("/nonexistent/path");
    expect(removed).toBe(false);
  });
});

describe("syncWorktree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-sync-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resets a worktree to match the branch HEAD", async () => {
    // Create a worktree on main
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();

    // Make a change in the parent repo
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    commitAll(tmpDir, "second");
    // git branch has advanced now — sync should reset worktree to it
    // (the worktree has its own branch checkout that's on the old commit)

    const result = await syncWorktree(created!.path, "main");
    expect(result).toBe(true);
    // After reset --hard, the worktree should have the new file
    expect(fs.existsSync(path.join(created!.path, "b.txt"))).toBe(true);
  });

  it("returns false for a non-existent worktree", async () => {
    const result = await syncWorktree("/nonexistent", "main");
    expect(result).toBe(false);
  });
});

describe("isDockPreviewWorktree", () => {
  it("returns true for paths under the dock-preview prefix", () => {
    expect(isDockPreviewWorktree("/tmp/.mullion-worktrees/dock-preview-feature-foo-a1b2c3")).toBe(
      true,
    );
    expect(isDockPreviewWorktree("/tmp/.mullion-worktrees/dock-preview-main-123abc")).toBe(true);
  });

  it("returns false for non-preview worktree paths", () => {
    expect(isDockPreviewWorktree("/tmp/.mullion-worktrees/my-feature")).toBe(false);
    expect(isDockPreviewWorktree("/tmp/.mullion-worktrees/mullion/task-42")).toBe(false);
  });

  it("returns false for paths outside .mullion-worktrees", () => {
    expect(isDockPreviewWorktree("/tmp/other-path")).toBe(false);
  });
});
