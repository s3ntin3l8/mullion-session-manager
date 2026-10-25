import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";
import { createWorktree, removeWorktree, slugify } from "../../src/hooks/worktree-hook.mjs";

// gitEnv() so a hook-supplied GIT_DIR can never point these at the real checkout.
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
}

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-hook-")));
  const origin = path.join(tmp, "origin.git");
  repo = path.join(tmp, "repo");
  git(tmp, ["init", "--bare", "-b", "main", origin]);
  git(tmp, ["clone", origin, repo]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n.wt/\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init", "--no-verify"]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(repo, ["remote", "set-head", "origin", "main"]);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("worktree-hook", () => {
  it("slugifies names safely", () => {
    expect(slugify("feat/x y")).toBe("feat-x-y");
    expect(slugify("../..")).toMatch(/^agent-/);
  });

  it("creates under .wt on a worktree-* branch, copies .worktreeinclude, and is idempotent", () => {
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1");
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "# c\n.env\n../escape\n");
    const dest = createWorktree({ cwd: repo, name: "agent-1" });
    expect(dest).toBe(path.join(repo, ".wt", "agent-1"));
    expect(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("worktree-agent-1");
    expect(fs.readFileSync(path.join(dest, ".env"), "utf8")).toBe("SECRET=1");
    expect(fs.existsSync(path.join(tmp, "escape"))).toBe(false);
    expect(createWorktree({ cwd: dest, name: "agent-1" })).toBe(dest);
  });

  it("removes an empty worktree and its branch, but keeps a branch with commits", () => {
    const empty = createWorktree({ cwd: repo, name: "empty" });
    removeWorktree({ worktree_path: empty });
    expect(fs.existsSync(empty)).toBe(false);
    expect(git(repo, ["branch", "--list", "worktree-empty"])).toBe("");

    const busy = createWorktree({ cwd: repo, name: "busy" });
    fs.writeFileSync(path.join(busy, "b.txt"), "b");
    git(busy, ["add", "b.txt"]);
    git(busy, ["commit", "-m", "work", "--no-verify"]);
    removeWorktree({ worktree_path: busy });
    expect(fs.existsSync(busy)).toBe(false);
    expect(git(repo, ["branch", "--list", "worktree-busy"])).toContain("worktree-busy");
  });

  it("refuses to remove a path outside .wt", () => {
    const other = path.join(tmp, "other");
    git(repo, ["worktree", "add", other, "-b", "other"]);
    removeWorktree({ worktree_path: other });
    expect(fs.existsSync(other)).toBe(true);
  });
});
