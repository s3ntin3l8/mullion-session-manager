import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitEnv } from "../../src/services/git-env.js";
import {
  inspectDevWorktrees,
  pruneDevWorktrees,
  type DevWorktreeOptions,
  type DevWorktreeProject,
} from "../../src/services/dev-worktrees.js";
import { clearGitStatusCacheForTests } from "../../src/services/git-status.js";

const DAY = 24 * 60 * 60 * 1000;

let base: string;
let origin: string;
let repo: string;
let project: DevWorktreeProject;

// Commit identity comes from test/setup.ts's GIT_AUTHOR_*/GIT_COMMITTER_* env.
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString();
}

function commit(cwd: string, file: string, message: string) {
  fs.writeFileSync(path.join(cwd, file), message);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message, "--no-verify"]);
}

/** A worktree whose HEAD last moved `ageMs` ago, as its reflog says. */
function age(worktree: string, ageMs: number) {
  const gitdir = fs
    .readFileSync(path.join(worktree, ".git"), "utf8")
    .replace(/^gitdir:\s*/, "")
    .trim();
  const t = new Date(Date.now() - ageMs);
  for (const file of [path.join("logs", "HEAD"), "HEAD"]) {
    const target = path.join(gitdir, file);
    if (fs.existsSync(target)) fs.utimesSync(target, t, t);
  }
}

/**
 * A worktree for `branch` under `root` (default `.wt`), made old enough to
 * count. `pushed` publishes the branch first, so it has an upstream to lose.
 */
function addWorktree(
  slug: string,
  opts: { root?: string; branch?: string; pushed?: boolean; track?: boolean } = {},
): string {
  const dir = path.join(repo, opts.root ?? ".wt", slug);
  const branch = opts.branch ?? slug;
  git(repo, [
    "worktree",
    "add",
    ...(opts.track === false ? ["--no-track"] : []),
    "-b",
    branch,
    dir,
    "origin/main",
  ]);
  if (opts.pushed) {
    commit(dir, `${slug.replace(/\//g, "-")}.txt`, `work on ${slug}`);
    git(dir, ["push", "-u", "origin", branch]);
  }
  age(dir, 3 * DAY);
  return dir;
}

/** The remote branch disappears (a merged PR's branch auto-deleted), then a fetch notices. */
function deleteRemoteBranch(branch: string, { fetch = true } = {}) {
  git(origin, ["branch", "-D", branch]);
  if (fetch) git(repo, ["fetch", "--prune"]);
}

const exists = (p: string) => fs.existsSync(p);
const branches = () =>
  git(repo, ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean);

const opts = (extra: Partial<DevWorktreeOptions> = {}): DevWorktreeOptions => ({
  projects: [project],
  ...extra,
});

beforeEach(() => {
  clearGitStatusCacheForTests();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-worktrees-test-")));
  origin = path.join(base, "origin.git");
  repo = path.join(base, "repo");
  fs.mkdirSync(origin);
  git(origin, ["init", "--bare", "-b", "main"]);
  git(base, ["clone", origin, repo]);
  git(repo, ["checkout", "-b", "main"]);
  commit(repo, "README.md", "init");
  git(repo, ["push", "-u", "origin", "main"]);
  git(repo, ["remote", "set-head", "origin", "main"]);
  project = { id: 1, name: "proj", cwd: repo };
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("dev-worktrees", () => {
  describe("what counts as stale", () => {
    it("offers a worktree whose branch was deleted on the remote, and sizes it", async () => {
      const dir = addWorktree("fix-thing", { pushed: true });
      fs.writeFileSync(path.join(dir, "big.bin"), "x".repeat(50_000));
      expect((await inspectDevWorktrees(opts())).candidates).toEqual([]);
      deleteRemoteBranch("fix-thing");
      const status = await inspectDevWorktrees(opts());
      expect(status.available).toBe(true);
      // The file is untracked, so the tree is not clean: not offered yet.
      expect(status.candidates).toEqual([]);
      fs.rmSync(path.join(dir, "big.bin"));
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
      git(dir, ["add", ".gitignore"]);
      git(dir, ["commit", "-m", "ignore", "--no-verify"]);
      age(dir, 3 * DAY);
      fs.writeFileSync(path.join(dir, "node_modules", "pkg.js"), "y".repeat(50_000));
      const cleanStatus = await inspectDevWorktrees(opts());
      expect(cleanStatus.candidates).toHaveLength(1);
      expect(cleanStatus.candidates[0]).toMatchObject({
        projectId: 1,
        projectName: "proj",
        repoCwd: repo,
        path: dir,
        slug: "fix-thing",
        branch: "fix-thing",
        kind: "wt",
        reason: "gone",
      });
      expect(cleanStatus.candidates[0].bytes).toBeGreaterThan(50_000);
      expect(cleanStatus.totalBytes).toBe(cleanStatus.candidates[0].bytes);
    });

    it("also finds Claude Code's agent worktrees, and nested slugs", async () => {
      addWorktree("agent-abc", { root: path.join(".claude", "worktrees"), pushed: true });
      addWorktree("feat/nested", { pushed: true, branch: "feat-nested" });
      deleteRemoteBranch("agent-abc", { fetch: false });
      deleteRemoteBranch("feat-nested");
      const found = (await inspectDevWorktrees(opts())).candidates;
      expect(found.map((c) => [c.kind, c.slug]).sort()).toEqual([
        ["claude-agent", "agent-abc"],
        ["wt", path.join("feat", "nested")],
      ]);
    });

    it("offers a branch whose PR GitHub reports as merged at exactly this commit", async () => {
      const dir = addWorktree("squashed", { pushed: true });
      const tip = git(dir, ["rev-parse", "HEAD"]).trim();
      const mergedPr = vi.fn(
        async (_p: DevWorktreeProject, _b: string, sha: string, _base: string) =>
          sha === tip ? 7 : null,
      );
      const found = (await inspectDevWorktrees(opts({ mergedPr }))).candidates;
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ reason: "merged", detail: "#7", branch: "squashed" });
      // Asked about merges into the default branch, not just any base.
      expect(mergedPr).toHaveBeenCalledWith(project, "squashed", tip, "main");
    });

    it("also checks a branch pushed without tracking, which has no upstream to lose", async () => {
      const dir = addWorktree("untracked", { track: false });
      commit(dir, "u.txt", "work");
      git(dir, ["push", "origin", "untracked"]);
      age(dir, 3 * DAY);
      const tip = git(dir, ["rev-parse", "HEAD"]).trim();
      const found = (
        await inspectDevWorktrees(
          opts({ mergedPr: async (_p, _b, sha) => (sha === tip ? 9 : null) }),
        )
      ).candidates;
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ reason: "merged", detail: "#9" });
    });

    it("offers a detached HEAD that is already in the default branch", async () => {
      const dir = path.join(repo, ".wt", "detached");
      git(repo, ["worktree", "add", "--detach", dir, "origin/main"]);
      age(dir, 3 * DAY);
      const found = (await inspectDevWorktrees(opts())).candidates;
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ reason: "detached-merged", branch: null, slug: "detached" });
    });
  });

  describe("what is never offered", () => {
    it("skips a worktree with uncommitted changes, staged or not", async () => {
      const dir = addWorktree("dirty", { pushed: true });
      deleteRemoteBranch("dirty");
      fs.writeFileSync(path.join(dir, "wip.txt"), "unsaved");
      expect((await inspectDevWorktrees(opts())).candidates).toEqual([]);
      git(dir, ["add", "wip.txt"]);
      clearGitStatusCacheForTests();
      expect((await inspectDevWorktrees(opts())).candidates).toEqual([]);
    });

    it("skips a branch that was never pushed, or whose upstream still exists, unless GitHub says it merged", async () => {
      addWorktree("local-only", { track: false });
      addWorktree("alive", { pushed: true });
      const mergedPr = vi.fn(async () => null);
      expect((await inspectDevWorktrees(opts({ mergedPr }))).candidates).toEqual([]);
      expect(mergedPr).toHaveBeenCalledTimes(2);
      // Without a lookup at all (no GitHub) neither is ever offered.
      expect((await inspectDevWorktrees(opts())).candidates).toEqual([]);
    });

    it("never asks about a merge when the default branch can't be determined", async () => {
      addWorktree("nobase", { pushed: true });
      git(repo, ["remote", "remove", "origin"]);
      const mergedPr = vi.fn(async () => 5);
      expect((await inspectDevWorktrees(opts({ mergedPr }))).candidates).toEqual([]);
      expect(mergedPr).not.toHaveBeenCalled();
    });

    it("skips a merged PR whose lookup fails, and a detached HEAD with work of its own", async () => {
      addWorktree("flaky", { pushed: true });
      const dir = path.join(repo, ".wt", "detached-work");
      git(repo, ["worktree", "add", "--detach", dir, "origin/main"]);
      commit(dir, "mine.txt", "unpublished");
      age(dir, 3 * DAY);
      const mergedPr = vi.fn(async () => {
        throw new Error("rate limited");
      });
      expect((await inspectDevWorktrees(opts({ mergedPr }))).candidates).toEqual([]);
    });

    it("skips a worktree that moved within the last day", async () => {
      const dir = addWorktree("fresh", { pushed: true });
      deleteRemoteBranch("fresh");
      age(dir, 60 * 60 * 1000);
      expect((await inspectDevWorktrees(opts())).candidates).toEqual([]);
      expect(
        (await inspectDevWorktrees(opts({ minAgeMs: 30 * 60 * 1000 }))).candidates,
      ).toHaveLength(1);
    });

    it("skips worktrees outside .wt and .claude/worktrees, and the main checkout", async () => {
      const outside = path.join(base, "elsewhere");
      git(repo, ["worktree", "add", "-b", "outside", outside, "origin/main"]);
      git(outside, ["push", "-u", "origin", "outside"]);
      age(outside, 3 * DAY);
      deleteRemoteBranch("outside");
      // The main checkout's own upstream is gone too, once main disappears remotely.
      git(origin, ["update-ref", "-d", "refs/heads/main"]);
      git(repo, ["fetch", "--prune"]);
      expect(git(repo, ["branch", "-vv"])).toContain("gone");
      expect((await inspectDevWorktrees(opts())).candidates).toEqual([]);
    });

    it("skips a worktree something is using", async () => {
      const dir = addWorktree("busy", { pushed: true });
      deleteRemoteBranch("busy");
      const inUse = vi.fn((_p: DevWorktreeProject, wt: string) => wt === dir);
      expect((await inspectDevWorktrees(opts({ inUse }))).candidates).toEqual([]);
      expect(inUse).toHaveBeenCalledWith(project, dir);
    });

    it("finds worktrees when the project is registered through a symlink", async () => {
      addWorktree("via-link", { pushed: true });
      deleteRemoteBranch("via-link");
      // git prints real paths, so the project's own path has to be resolved too.
      const link = path.join(base, "repo-link");
      fs.symlinkSync(repo, link);
      const viaLink = { ...project, cwd: link };
      const status = await inspectDevWorktrees({ projects: [viaLink] });
      expect(status.candidates.map((c) => c.slug)).toEqual(["via-link"]);
      const result = await pruneDevWorktrees({ projects: [viaLink] });
      expect(result.output).toBe("Removed 1 stale developer worktree.");
    });

    it("tolerates a project that isn't a repo or a path that doesn't exist", async () => {
      addWorktree("ok", { pushed: true });
      deleteRemoteBranch("ok");
      const status = await inspectDevWorktrees({
        projects: [
          { id: 2, name: "none", cwd: path.join(base, "missing") },
          { id: 3, name: "plain", cwd: base },
          project,
        ],
      });
      expect(status.available).toBe(true);
      expect(status.candidates.map((c) => c.slug)).toEqual(["ok"]);
    });
  });

  describe("prune", () => {
    it("removes stale worktrees, keeps their branches and everything else", async () => {
      const gone = addWorktree("gone-one", { pushed: true });
      const alive = addWorktree("alive-one", { pushed: true });
      const agent = addWorktree("agent-1", {
        root: path.join(".claude", "worktrees"),
        pushed: true,
      });
      deleteRemoteBranch("gone-one", { fetch: false });
      deleteRemoteBranch("agent-1", { fetch: false });
      // No fetch happened locally: prune has to do it to see them as gone.
      expect((await inspectDevWorktrees(opts())).candidates).toEqual([]);
      const result = await pruneDevWorktrees(opts());
      expect(result.output).toBe("Removed 2 stale developer worktrees.");
      expect(result.error).toBeUndefined();
      expect(result.reclaimedBytes).toBeGreaterThan(0);
      expect(exists(gone)).toBe(false);
      expect(exists(agent)).toBe(false);
      expect(exists(alive)).toBe(true);
      expect(branches()).toEqual(expect.arrayContaining(["gone-one", "agent-1", "alive-one"]));
      // Git no longer lists the removed ones.
      expect(git(repo, ["worktree", "list"])).not.toContain("gone-one");
    });

    it("says so when there is nothing to remove", async () => {
      expect((await pruneDevWorktrees(opts())).output).toBe("Removed 0 stale developer worktrees.");
      addWorktree("one", { pushed: true });
      deleteRemoteBranch("one");
      expect((await pruneDevWorktrees(opts())).output).toBe("Removed 1 stale developer worktree.");
    });

    it("leaves a worktree alone that gained uncommitted work before the cleanup got to it", async () => {
      const dir = addWorktree("racy", { pushed: true });
      deleteRemoteBranch("racy");
      const result = await pruneDevWorktrees(
        opts({
          // The fetch comes before the first look at each worktree.
          fetch: async () => {
            fs.writeFileSync(path.join(dir, "late.txt"), "just saved");
          },
        }),
      );
      expect(result.output).toBe("Removed 0 stale developer worktrees.");
      expect(exists(path.join(dir, "late.txt"))).toBe(true);
    });

    it("refuses to remove a worktree that gained a commit since it was listed", async () => {
      const dir = addWorktree("moved", { pushed: true });
      deleteRemoteBranch("moved");
      let calls = 0;
      const inUse = vi.fn(() => {
        // First look lists it; by the re-check a commit has landed on it.
        if (++calls === 2) commit(dir, "new.txt", "one more");
        return false;
      });
      const result = await pruneDevWorktrees(opts({ inUse }));
      expect(result.output).toBe("Removed 0 stale developer worktrees.");
      expect(exists(dir)).toBe(true);
    });

    it("keeps going when the fetch fails, and past a project that can't be read", async () => {
      addWorktree("a", { pushed: true });
      deleteRemoteBranch("a");
      const result = await pruneDevWorktrees({
        projects: [{ id: 2, name: "missing", cwd: path.join(base, "missing") }, project],
        fetch: async () => {
          throw new Error("offline");
        },
      });
      expect(result.output).toBe("Removed 1 stale developer worktree.");
    });

    it("reports a worktree it couldn't remove without stopping", async () => {
      const dir = addWorktree("stuck", { pushed: true });
      deleteRemoteBranch("stuck");
      const other = addWorktree("fine", { pushed: true });
      deleteRemoteBranch("fine");
      // A locked worktree makes `git worktree remove` fail without --force.
      git(repo, ["worktree", "lock", dir]);
      const result = await pruneDevWorktrees(opts());
      expect(result.output).toBe("Removed 1 stale developer worktree.");
      expect(result.error).toContain("stuck");
      expect(exists(dir)).toBe(true);
      expect(exists(other)).toBe(false);
    });

    it("refuses a second prune while one is running", async () => {
      addWorktree("slow", { pushed: true });
      deleteRemoteBranch("slow");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = pruneDevWorktrees(
        opts({
          fetch: async () => {
            await gate;
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      await expect(pruneDevWorktrees(opts())).rejects.toThrow("DEV_WORKTREE_PRUNE_IN_PROGRESS");
      release();
      await first;
    });
  });
});
