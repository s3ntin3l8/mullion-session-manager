import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitEnv } from "../../src/services/git-env.js";
import {
  inspectDevWorktrees,
  inspectOrphanRecoveries,
  pruneDevWorktrees,
  removeOrphanedDevWorktree,
  type DevWorktreeOptions,
  type DevWorktreeProject,
} from "../../src/services/dev-worktrees.js";
import * as mountBoundaries from "../../src/services/mount-boundaries.js";
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

    it("also finds .worktrees/, and a hook-made worktree-* branch with nothing on it", async () => {
      addWorktree("hooked", { branch: "worktree-hooked" });
      addWorktree("elsewhere", { root: ".worktrees", pushed: true });
      deleteRemoteBranch("elsewhere");
      const found = (await inspectDevWorktrees(opts())).candidates;
      expect(found.map((c) => [c.slug, c.reason]).sort()).toEqual([
        ["elsewhere", "gone"],
        ["hooked", "in-default"],
      ]);
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

  // Issue #1979 — directories git no longer (or never) knew as worktrees.
  describe("orphans", () => {
    it("reports unregistered directories under each root, report-only, and leaves them on prune", async () => {
      const registered = addWorktree("feat/kept", { pushed: true, branch: "feat-kept" });
      const root = fs.realpathSync(repo);
      const orphanTop = path.join(root, ".wt", "stray");
      const orphanNested = path.join(root, ".wt", "feat", "old");
      const orphanWorktrees = path.join(root, ".worktrees", "x");
      const orphanAgent = path.join(root, ".claude", "worktrees", "agent-gone");
      for (const dir of [orphanTop, orphanNested, orphanWorktrees, orphanAgent]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "file.txt"), "z".repeat(10_000));
      }
      // A plain file under a root is not a directory, so not a worktree either.
      fs.writeFileSync(path.join(root, ".wt", "notes.txt"), "hi");

      const status = await inspectDevWorktrees(opts());
      const orphans = status.candidates.filter((c) => c.reason === "orphaned");
      expect(orphans.map((c) => [c.path, c.slug, c.kind]).sort()).toEqual(
        [
          [orphanTop, "stray", "wt"],
          [orphanNested, path.join("feat", "old"), "wt"],
          [orphanWorktrees, "x", "wt"],
          [orphanAgent, "agent-gone", "claude-agent"],
        ].sort(),
      );
      expect(orphans.every((c) => c.bytes >= 10_000 && c.branch === null)).toBe(true);
      // The registered one under the same `feat/` parent is not an orphan.
      expect(status.candidates.map((c) => c.path)).not.toContain(registered);
      // Not something cleanup can free.
      expect(status.totalBytes).toBe(0);

      await pruneDevWorktrees(opts());
      for (const dir of [orphanTop, orphanNested, orphanWorktrees, orphanAgent]) {
        expect(exists(dir)).toBe(true);
      }
    });

    it("doesn't call a registered worktree orphaned when the root is a symlink", async () => {
      const real = path.join(base, "elsewhere");
      fs.mkdirSync(real);
      fs.symlinkSync(real, path.join(repo, ".wt"));
      git(repo, ["worktree", "add", "-b", "via-link", path.join(repo, ".wt", "a"), "origin/main"]);
      fs.mkdirSync(path.join(real, "stray"));
      const orphans = (await inspectDevWorktrees(opts())).candidates.filter(
        (c) => c.reason === "orphaned",
      );
      expect(orphans.map((c) => c.slug)).toEqual(["stray"]);
    });

    it("reports an orphan once when two roots are the same directory", async () => {
      fs.mkdirSync(path.join(repo, ".wt", "stray"), { recursive: true });
      fs.symlinkSync(path.join(repo, ".wt"), path.join(repo, ".worktrees"));
      const orphans = (await inspectDevWorktrees(opts())).candidates.filter(
        (c) => c.reason === "orphaned",
      );
      expect(orphans.map((c) => c.slug)).toEqual(["stray"]);
    });

    it("finds orphans in a project that has no registered developer worktree at all", async () => {
      fs.mkdirSync(path.join(repo, ".wt", "leftover"), { recursive: true });
      const status = await inspectDevWorktrees(opts());
      expect(status.candidates).toEqual([
        expect.objectContaining({ reason: "orphaned", slug: "leftover" }),
      ]);
    });
  });

  describe("confirmed orphan removal", () => {
    const unused = async () => false;
    const removeOrphan = (
      selectedProject: DevWorktreeProject,
      target: string,
      inUse: (path: string) => Promise<boolean>,
    ) => removeOrphanedDevWorktree(selectedProject, target, inUse, path.join(base, "registry"));
    const orphan = (name = "leftover") => {
      const dir = path.join(repo, ".wt", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "work.txt"), "important work");
      return dir;
    };

    it.each([".wt", ".worktrees", ".claude/worktrees"])(
      "removes a confirmed orphan under %s and reports bytes",
      async (root) => {
        const dir = path.join(repo, root, "stray");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "work.txt"), "important work");
        const result = await removeOrphan(project, dir, unused);
        expect(result).toMatchObject({ removed: true, reclaimedBytes: expect.any(Number) });
        if (result.removed) expect(result.reclaimedBytes).toBeGreaterThan(0);
        expect(exists(dir)).toBe(false);
      },
    );

    it("rediscovers a quarantined directory after an interrupted removal", async () => {
      const dir = orphan();
      const stat = fs.statSync(dir);
      const quarantine = fs.mkdtempSync(path.join(repo, ".mullion-orphan-"));
      const registry = path.join(base, "registry");
      fs.mkdirSync(registry);
      const staged = path.join(quarantine, "directory");
      const manifest = path.join(registry, "1234.json");
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          projectId: project.id,
          originalPath: dir,
          recoveryPath: staged,
          phase: "staged",
          dev: stat.dev,
          ino: stat.ino,
        }),
      );
      fs.renameSync(dir, staged);
      expect((await inspectOrphanRecoveries(path.join(base, "registry"))).recoveries).toEqual([
        { projectId: project.id, originalPath: dir, recoveryPath: staged, mayBePartial: false },
      ]);
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          projectId: project.id,
          originalPath: dir,
          recoveryPath: staged,
          phase: "deleting",
          dev: stat.dev,
          ino: stat.ino,
        }),
      );
      expect((await inspectOrphanRecoveries(path.join(base, "registry"))).recoveries).toEqual([
        { projectId: project.id, originalPath: dir, recoveryPath: staged, mayBePartial: true },
      ]);
    });

    it("reports an unverified recovery when the staged path is temporarily inaccessible", async () => {
      const dir = orphan();
      const stat = fs.statSync(dir);
      const quarantine = fs.mkdtempSync(path.join(repo, ".mullion-orphan-"));
      const staged = path.join(quarantine, "directory");
      const registry = path.join(base, "registry");
      fs.mkdirSync(registry);
      fs.writeFileSync(
        path.join(registry, "1234.json"),
        JSON.stringify({
          projectId: project.id,
          originalPath: dir,
          recoveryPath: staged,
          phase: "staged",
          dev: stat.dev,
          ino: stat.ino,
        }),
      );
      fs.renameSync(dir, staged);
      const lstat = fs.promises.lstat.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, "lstat").mockImplementation(async (candidate, options) => {
        if (String(candidate) === staged)
          throw Object.assign(new Error("unavailable"), { code: "EACCES" });
        return lstat(candidate, options as never) as Promise<fs.Stats>;
      });
      try {
        expect((await inspectOrphanRecoveries(registry)).recoveries).toEqual([
          {
            projectId: project.id,
            originalPath: dir,
            recoveryPath: staged,
            mayBePartial: false,
            unverified: true,
          },
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it("rejects outside, traversal, the root itself, files and symlinks", async () => {
      const dir = orphan();
      const link = path.join(repo, ".wt", "link");
      fs.symlinkSync(dir, link);
      const file = path.join(repo, ".wt", "file");
      fs.writeFileSync(file, "x");
      for (const invalid of [
        base,
        path.join(repo, ".wt"),
        file,
        link,
        `${dir}/../leftover`,
        "relative",
      ]) {
        await expect(removeOrphan(project, invalid, unused)).resolves.toEqual({
          removed: false,
          reason: "invalid-path",
        });
      }
      expect(exists(dir)).toBe(true);
    });

    it("rejects an external symlinked root", async () => {
      const external = path.join(base, "external");
      fs.mkdirSync(path.join(external, "leftover"), { recursive: true });
      fs.symlinkSync(external, path.join(repo, ".wt"));
      await expect(removeOrphan(project, path.join(external, "leftover"), unused)).resolves.toEqual(
        { removed: false, reason: "invalid-path" },
      );
      expect(exists(path.join(external, "leftover"))).toBe(true);
    });

    it("rejects a worktree root symlinked to another project directory", async () => {
      const source = path.join(repo, "src", "services");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "important"), "keep");
      fs.symlinkSync(path.join(repo, "src"), path.join(repo, ".wt"));
      await expect(removeOrphan(project, source, unused)).resolves.toEqual({
        removed: false,
        reason: "invalid-path",
      });
      expect(exists(path.join(source, "important"))).toBe(true);
    });

    it("allows one approved root to alias another", async () => {
      const dir = orphan();
      fs.symlinkSync(path.join(repo, ".wt"), path.join(repo, ".worktrees"));
      await expect(removeOrphan(project, dir, unused)).resolves.toMatchObject({
        removed: true,
      });
      expect(exists(dir)).toBe(false);
    });

    it("refuses a registered worktree, its parent and a directory within it", async () => {
      const registered = addWorktree("feat/kept", { branch: "registered" });
      fs.mkdirSync(path.join(registered, "inside"));
      for (const target of [
        registered,
        path.dirname(registered),
        path.join(registered, "inside"),
      ]) {
        await expect(removeOrphan(project, target, unused)).resolves.toEqual({
          removed: false,
          reason: "not-orphan",
        });
      }
      expect(exists(registered)).toBe(true);
    });

    it("rejects a child of a registered worktree through an overlapping root", async () => {
      const registered = addWorktree("registered", { branch: "registered-root" });
      const nested = path.join(registered, "subdir", "source");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "important"), "keep");
      fs.symlinkSync(path.join(registered, "subdir"), path.join(repo, ".worktrees"));
      await expect(removeOrphan(project, nested, unused)).resolves.toEqual({
        removed: false,
        reason: "not-orphan",
      });
      expect(exists(path.join(nested, "important"))).toBe(true);
    });

    it("refuses when in use, including when use begins during measurement", async () => {
      const dir = orphan();
      await expect(removeOrphan(project, dir, async () => true)).resolves.toEqual({
        removed: false,
        reason: "in-use",
      });
      const inUse = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await expect(removeOrphan(project, dir, inUse)).resolves.toEqual({
        removed: false,
        reason: "in-use",
      });
      expect(exists(dir)).toBe(true);
    });

    it("refuses a directory replaced during the check", async () => {
      const dir = orphan();
      const moved = path.join(repo, ".wt", "moved");
      const inUse = vi.fn(async () => {
        fs.renameSync(dir, moved);
        fs.mkdirSync(dir);
        return false;
      });
      await expect(removeOrphan(project, dir, inUse)).resolves.toEqual({
        removed: false,
        reason: "changed",
      });
      expect(exists(dir)).toBe(true);
      expect(exists(path.join(moved, "work.txt"))).toBe(true);
    });

    it("never deletes a different directory substituted at the atomic move", async () => {
      const dir = orphan();
      const original = path.join(repo, ".wt", "original");
      const rename = fs.promises.rename.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (from !== dir) return rename(from, to);
        await rename(from, original);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "new-work"), "preserve");
        await rename(from, to);
      });
      try {
        await expect(removeOrphan(project, dir, unused)).resolves.toEqual({
          removed: false,
          reason: "changed",
        });
        expect(fs.readFileSync(path.join(dir, "new-work"), "utf8")).toBe("preserve");
        expect(exists(path.join(original, "work.txt"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("refuses a staged directory replaced during the final metadata write", async () => {
      const dir = orphan();
      const parked = path.join(repo, "parked");
      const rename = fs.promises.rename.bind(fs.promises);
      let calls = 0;
      const spy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (++calls === 3) {
          const staged = path.join(
            repo,
            fs.readdirSync(repo).find((name) => name.startsWith(".mullion-orphan-"))!,
            "directory",
          );
          await rename(staged, parked);
          fs.mkdirSync(staged);
          fs.writeFileSync(path.join(staged, "other"), "keep");
        }
        await rename(from, to);
      });
      try {
        await expect(removeOrphan(project, dir, unused)).resolves.toEqual({
          removed: false,
          reason: "changed",
        });
        expect(exists(path.join(parked, "work.txt"))).toBe(true);
        expect(exists(path.join(dir, "other"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("restores the directory if usage starts after the atomic move", async () => {
      const dir = orphan();
      let calls = 0;
      await expect(removeOrphan(project, dir, async () => ++calls === 3)).resolves.toEqual({
        removed: false,
        reason: "in-use",
      });
      expect(exists(path.join(dir, "work.txt"))).toBe(true);
    });

    it("restores the directory if usage begins after recording deletion intent", async () => {
      const dir = orphan();
      let calls = 0;
      await expect(removeOrphan(project, dir, async () => ++calls === 5)).resolves.toEqual({
        removed: false,
        reason: "in-use",
      });
      expect(exists(path.join(dir, "work.txt"))).toBe(true);
    });

    it("preserves a recovery path if the original location is occupied", async () => {
      const dir = orphan();
      let calls = 0;
      const result = await removeOrphan(project, dir, async () => {
        if (++calls === 3) {
          fs.mkdirSync(dir);
          fs.writeFileSync(path.join(dir, "other"), "keep");
          return true;
        }
        return false;
      });
      expect(result).toMatchObject({
        removed: false,
        reason: "in-use",
        recoveryPath: expect.any(String),
      });
      if (!result.removed && result.recoveryPath)
        expect(exists(path.join(result.recoveryPath, "work.txt"))).toBe(true);
      expect(exists(path.join(dir, "other"))).toBe(true);
    });

    it("leaves the original untouched when a cross-device move fails", async () => {
      const dir = orphan();
      const rename = fs.promises.rename.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (from === dir) throw Object.assign(new Error("cross device"), { code: "EXDEV" });
        return rename(from, to);
      });
      try {
        await expect(removeOrphan(project, dir, unused)).resolves.toEqual({
          removed: false,
          reason: "cross-device",
        });
        expect(exists(path.join(dir, "work.txt"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("reports unsupported mount detection without touching the directory", async () => {
      const dir = orphan();
      const check = vi
        .spyOn(mountBoundaries, "containsMount")
        .mockRejectedValueOnce(new mountBoundaries.UnsupportedMountPlatformError());
      try {
        await expect(removeOrphan(project, dir, unused)).resolves.toEqual({
          removed: false,
          reason: "unsupported-platform",
        });
        expect(exists(path.join(dir, "work.txt"))).toBe(true);
      } finally {
        check.mockRestore();
      }
    });

    it("keeps the original when writing the initial recovery record fails", async () => {
      const dir = orphan();
      const write = fs.promises.writeFile.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, "writeFile").mockImplementationOnce(async (file) => {
        await write(file, "{");
        throw new Error("interrupted write");
      });
      try {
        await expect(removeOrphan(project, dir, unused)).resolves.toEqual({
          removed: false,
          reason: "unavailable",
        });
        expect(exists(path.join(dir, "work.txt"))).toBe(true);
        expect(await inspectOrphanRecoveries(path.join(base, "registry"))).toEqual({
          recoveries: [],
          warnings: [],
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("reports corrupt recovery records without preventing inspection", async () => {
      const registry = path.join(base, "registry");
      fs.mkdirSync(registry);
      const corrupt = path.join(registry, "deadbeef.json");
      fs.writeFileSync(corrupt, "{");
      expect(await inspectOrphanRecoveries(registry)).toEqual({
        recoveries: [],
        warnings: [expect.stringContaining(corrupt)],
      });
      const dir = orphan();
      await expect(removeOrphan(project, dir, unused)).resolves.toMatchObject({ removed: true });
    });

    it("refuses a nested mount without touching the directory", async () => {
      const dir = orphan();
      const check = vi.spyOn(mountBoundaries, "containsMount").mockResolvedValue(true);
      try {
        await expect(removeOrphan(project, dir, unused)).resolves.toEqual({
          removed: false,
          reason: "contains-mount",
        });
        expect(exists(path.join(dir, "work.txt"))).toBe(true);
      } finally {
        check.mockRestore();
      }
    });

    it("reports partial deletion when a recursive removal fails", async () => {
      const dir = orphan();
      fs.writeFileSync(path.join(dir, "other.txt"), "remaining");
      const remove = vi.spyOn(fs.promises, "rm").mockImplementationOnce(async (staged) => {
        await fs.promises.unlink(path.join(String(staged), "work.txt"));
        throw new Error("permission denied");
      });
      try {
        await expect(removeOrphan(project, dir, unused)).resolves.toEqual({
          removed: false,
          reason: "remove-failed",
          recoveryPath: dir,
        });
        expect(exists(path.join(dir, "work.txt"))).toBe(false);
        expect(exists(path.join(dir, "other.txt"))).toBe(true);
        expect((await inspectOrphanRecoveries(path.join(base, "registry"))).recoveries).toEqual([
          { projectId: project.id, originalPath: dir, recoveryPath: dir, mayBePartial: true },
        ]);
      } finally {
        remove.mockRestore();
      }
    });

    it("refuses a directory replaced during the final usage check", async () => {
      const dir = orphan();
      const moved = path.join(repo, ".wt", "moved-final");
      let calls = 0;
      const inUse = async () => {
        if (++calls === 2) {
          fs.renameSync(dir, moved);
          fs.mkdirSync(dir);
        }
        return false;
      };
      await expect(removeOrphan(project, dir, inUse)).resolves.toEqual({
        removed: false,
        reason: "changed",
      });
      expect(exists(dir)).toBe(true);
      expect(exists(path.join(moved, "work.txt"))).toBe(true);
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
