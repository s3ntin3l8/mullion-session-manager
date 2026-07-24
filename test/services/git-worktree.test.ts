import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createWorktree } from "../../src/services/git-worktree.js";
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
