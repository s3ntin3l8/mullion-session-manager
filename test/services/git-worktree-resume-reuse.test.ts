import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createWorktree, resumeTaskWorktree } from "../../src/services/git-worktree.js";
import { gitEnv } from "../../src/services/git-env.js";
import { buildWorkerPrompt } from "../../src/services/task-prompt.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

// A failed task whose worktree was dirty keeps it on disk (removeWorktreeIfClean
// never discards work), so Retry must adopt that checkout rather than collide
// with it on `git worktree add`.
describe("resumeTaskWorktree adopting a leftover worktree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-reuse-"));
    git(tmpDir, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    git(tmpDir, ["add", "-A"]);
    git(tmpDir, ["commit", "-m", "initial", "--no-verify"]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the existing worktree as reused, keeping its uncommitted changes", async () => {
    const branch = "mullion/task-8-test";
    const created = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: branch,
      branchName: branch,
    });
    expect(created.created).toBe(true);
    const worktreePath = created.path as string;
    fs.writeFileSync(path.join(worktreePath, "wip.txt"), "uncommitted");

    const result = await resumeTaskWorktree(tmpDir, branch);

    expect(result).toEqual({ path: worktreePath, branch, reused: true });
    expect(fs.readFileSync(path.join(result!.path, "wip.txt"), "utf8")).toBe("uncommitted");
  });
});

describe("buildWorkerPrompt reusedWorktree", () => {
  const base = {
    task: { id: 1, title: "T", body: null, issueNumber: null, comments: [] },
    branchName: "mullion/task-1-t",
    worktreePath: "/tmp/wt",
    budgetMinutes: 0,
  } as unknown as Parameters<typeof buildWorkerPrompt>[0];

  it("mentions uncommitted changes only when the retry adopted a leftover worktree", () => {
    const reused = buildWorkerPrompt({ ...base, mode: "retry", reusedWorktree: true });
    const fresh = buildWorkerPrompt({ ...base, mode: "retry" });
    expect(reused).toContain("left uncommitted changes in this worktree");
    expect(fresh).not.toContain("uncommitted changes in this worktree");
  });
});
