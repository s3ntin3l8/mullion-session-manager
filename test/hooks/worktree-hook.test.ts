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

  it("leaves a worktree with uncommitted or untracked work, and its branch, alone", () => {
    const dirty = createWorktree({ cwd: repo, name: "dirty" });
    fs.writeFileSync(path.join(dirty, "uncommitted.txt"), "x");
    removeWorktree({ worktree_path: dirty });
    expect(fs.existsSync(path.join(dirty, "uncommitted.txt"))).toBe(true);
    expect(git(repo, ["branch", "--list", "worktree-dirty"])).toContain("worktree-dirty");
  });

  it("picks a new name when the branch was kept or the directory is not a worktree", () => {
    const kept = createWorktree({ cwd: repo, name: "kept" });
    fs.writeFileSync(path.join(kept, "b.txt"), "b");
    git(kept, ["add", "b.txt"]);
    git(kept, ["commit", "-m", "work", "--no-verify"]);
    removeWorktree({ worktree_path: kept });
    expect(createWorktree({ cwd: repo, name: "kept" })).toBe(path.join(repo, ".wt", "kept-2"));

    fs.mkdirSync(path.join(repo, ".wt", "squat"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".wt", "squat", "marker.txt"), "keep");
    const dest = createWorktree({ cwd: repo, name: "squat" });
    expect(dest).toBe(path.join(repo, ".wt", "squat-2"));
    expect(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("worktree-squat-2");
    expect(fs.readFileSync(path.join(repo, ".wt", "squat", "marker.txt"), "utf8")).toBe("keep");
  });

  it("reuses an empty squat directory and will not share a busy or foreign tree", () => {
    const empty = path.join(repo, ".wt", "empty-squat");
    fs.mkdirSync(empty, { recursive: true });
    const reused = createWorktree({ cwd: repo, name: "empty-squat" });
    expect(reused).toBe(empty);
    expect(git(reused, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("worktree-empty-squat");

    fs.writeFileSync(path.join(reused, "busy.txt"), "x");
    const other = createWorktree({ cwd: repo, name: "empty-squat" });
    expect(other).toBe(path.join(repo, ".wt", "empty-squat-2"));
    expect(fs.existsSync(path.join(reused, "busy.txt"))).toBe(true);

    git(other, ["checkout", "-b", "not-ours"]);
    const third = createWorktree({ cwd: repo, name: "empty-squat" });
    expect(third).toBe(path.join(repo, ".wt", "empty-squat-3"));
  });

  it("does not copy a symlinked .worktreeinclude entry", () => {
    const outside = path.join(tmp, "outside.txt");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(repo, "link.txt"));
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "link.txt\n");
    const dest = createWorktree({ cwd: repo, name: "sym" });
    expect(fs.existsSync(path.join(dest, "link.txt"))).toBe(false);
  });

  it("runs as a script, also when reached through a symlinked directory", () => {
    const real = path.join(tmp, "releases", "1.0.0", "dist", "hooks");
    fs.mkdirSync(real, { recursive: true });
    fs.copyFileSync(
      path.resolve("src/hooks/worktree-hook.mjs"),
      path.join(real, "worktree-hook.mjs"),
    );
    fs.symlinkSync(path.join(tmp, "releases", "1.0.0"), path.join(tmp, "current"));
    const script = path.join(tmp, "current", "dist", "hooks", "worktree-hook.mjs");
    const run = (mode: string, payload: object) =>
      execFileSync(process.execPath, [script, mode], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: gitEnv(),
      });
    const out = run("create", { cwd: repo, name: "viascript" }).trim();
    expect(out).toBe(path.join(repo, ".wt", "viascript"));
    expect(fs.existsSync(out)).toBe(true);
    run("remove", { worktree_path: out });
    expect(fs.existsSync(out)).toBe(false);
  });

  it("refuses to remove a path outside .wt", () => {
    const other = path.join(tmp, "other");
    git(repo, ["worktree", "add", other, "-b", "other"]);
    removeWorktree({ worktree_path: other });
    expect(fs.existsSync(other)).toBe(true);
  });
});
