import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addBranchDepth,
  addWorktree,
  widenHistory,
  writeDockControl,
} from "../../scripts/demo/git-fixtures.mjs";
import { gitEnv } from "../../scripts/git-env.mjs";

const IDENTITY = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...gitEnv(), ...IDENTITY } })
    .toString()
    .trim();

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

/** A repo with one commit on main and a bare `origin` that holds it. */
function repoWithOrigin() {
  const root = mkdtempSync(path.join(tmpdir(), "demo-fixtures-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const bare = path.join(root, "origin.git");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(root, "clone", "-q", "--bare", repo, bare);
  git(repo, "remote", "add", "origin", bare);
  git(repo, "fetch", "-q", "origin");
  git(repo, "branch", "-q", "--set-upstream-to=origin/main", "main");
  return { root, repo };
}

describe("demo git fixtures", () => {
  it("builds ahead, behind, gone and merged branches", async () => {
    const { repo } = repoWithOrigin();
    await addBranchDepth(repo);
    const status = (b: string) =>
      git(repo, "for-each-ref", "--format=%(upstream:track)", `refs/heads/${b}`);
    expect(status("feat/ahead")).toBe("[ahead 1]");
    expect(status("feat/behind")).toBe("[behind 1]");
    expect(status("feat/gone")).toBe("[gone]");
    // Only feat/merged may be an ancestor of main: any other branch would
    // read as "merged" in the app and hide its ahead/behind/gone state.
    const merged = git(repo, "branch", "--merged", "main", "--format=%(refname:short)").split("\n");
    expect(merged.filter((b) => b.startsWith("feat/")).sort()).toEqual(["feat/merged"]);
    expect(git(repo, "rev-list", "--merges", "--count", "main")).toBe("1");
    expect(status("main")).toBe("");
  });

  it("dates fixture commits apart, so branch order never depends on the clock", async () => {
    const { repo } = repoWithOrigin();
    await addBranchDepth(repo);
    await widenHistory(repo, 3);
    await addWorktree(repo, "feat/x");
    const stamps = git(repo, "log", "--all", "--format=%ct").split("\n");
    // Every commit, the repo's own first one included, has its own second.
    expect(new Set(stamps).size).toBe(stamps.length);
    expect(Math.max(...stamps.map(Number))).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("widens history without duplicating existing branches", async () => {
    const { repo } = repoWithOrigin();
    await widenHistory(repo, 3);
    await widenHistory(repo, 5);
    const names = git(repo, "branch", "--format=%(refname:short)").split("\n");
    expect(names).toContain("feat/1877-sidebar-workspace-scope");
    expect(names.filter((n) => n.startsWith("topic-"))).toHaveLength(4);
  });

  it("adds a worktree under .mullion-worktrees", async () => {
    const { repo } = repoWithOrigin();
    const dir = await addWorktree(repo, "feat/search-filters");
    expect(dir).toBe(path.join(repo, ".mullion-worktrees", "feat-search-filters"));
    expect(git(dir, "branch", "--show-current")).toBe("feat/search-filters");
    // Its own commit: not an ancestor of main, so no "merged" chip.
    expect(git(repo, "branch", "--merged", "main", "--list", "feat/search-filters")).toBe("");
  });

  it("writes a dock control that runs the dev-server script", async () => {
    const { root, repo } = repoWithOrigin();
    await writeDockControl(repo, { port: 3999, scriptDir: root });
    const { controls } = JSON.parse(readFileSync(path.join(repo, ".crs", "dock.json"), "utf8"));
    expect(controls).toHaveLength(1);
    expect(controls[0].command).toContain(path.join(root, "dev-server.mjs"));
    expect(readFileSync(path.join(root, "dev-server.mjs"), "utf8")).toContain("3999");
  });
});
