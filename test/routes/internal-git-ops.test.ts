import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  createInternalAgentEnv,
  INTERNAL_TEST_TOKEN,
} from "../helpers/internal-routes.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const ptyHarness = createInternalPtyHarness();
const childProcessHarness = createInternalChildProcessHarness();
const bundleSyncHarness = createBundleSyncHarness();

vi.mock("node-pty", () => ptyHarness.mockModule());
vi.mock("node:child_process", async (importOriginal) =>
  childProcessHarness.mockModule(await importOriginal()),
);
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncHarness.mockModule());
const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");
const { gitEnv } = await import("../../src/services/git-env.js");

const TOKEN = INTERNAL_TEST_TOKEN;

describe("internal routes: git worktree and branch operations", () => {
  const env = createInternalAgentEnv();
  beforeAll(() => {
    env.setup();
  });
  afterAll(() => {
    env.teardown();
  });
  beforeEach(() => {
    ptyHarness.reset();
    childProcessHarness.reset();
    bundleSyncHarness.reset();
    clearAgentsCacheForTests();
  });

  describe("POST /internal/git-worktree/remove, /clear-orphan, and /prune (issue #283)", () => {
    async function makeTaskWorktreeRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-worktree-remove-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      // Branch uses the new descriptive shape (mullion/task-<id>-<slug>) —
      // task-claim.ts's TASK_BRANCH_NAME_RE only accepts the slugged form
      // now, so a leftover branch left in this shape is the only one
      // clearOrphanedTaskWorktree / resumeTaskWorktree will recognize.
      const branch = "mullion/task-1-test";
      const worktreePath = path.join(cwd, ".mullion-worktrees", "mullion-task-1-test");
      run(["worktree", "add", "-b", branch, worktreePath, "main"]);
      return { repoRoot, cwd, worktreePath, run, branch };
    }

    it("removes a clean task worktree, but refuses (and leaves in place) a dirty one", async () => {
      const { repoRoot, cwd, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      // Dirty first — refused, still on disk.
      fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "uncommitted");
      const dirtyRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: cwd },
      });
      expect(dirtyRes.statusCode).toBe(200);
      expect(dirtyRes.json()).toEqual({ removed: false, reason: "dirty" });
      expect(fs.existsSync(worktreePath)).toBe(true);

      fs.unlinkSync(path.join(worktreePath, "dirty.txt"));
      const cleanRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: cwd },
      });
      expect(cleanRes.statusCode).toBe(200);
      expect(cleanRes.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a worktreePath or parentCwd outside this agent's own PROJECTS_ROOTS", async () => {
      const { repoRoot, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const outsidePath = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath: "/etc/not-a-project" },
      });
      expect(outsidePath.statusCode).toBe(400);

      const outsideParent = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: "/etc" },
      });
      expect(outsideParent.statusCode).toBe(400);
      // Untouched by the rejected request.
      expect(fs.existsSync(worktreePath)).toBe(true);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("prunes an explicitly-named orphan but skips a dirty one, and rejects an orphanPaths entry outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const pruneRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, orphanPaths: [worktreePath] },
      });
      expect(pruneRes.statusCode).toBe(200);
      expect(pruneRes.json()).toEqual({ removed: [worktreePath], skipped: [] });
      expect(fs.existsSync(worktreePath)).toBe(false);

      const outsideRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, orphanPaths: ["/etc/not-a-project"] },
      });
      expect(outsideRes.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("clear-orphan removes a clean worktree AND its branch ref, so a fresh worktree add -b at the same path/branch succeeds", async () => {
      const { repoRoot, cwd, worktreePath, run, branch } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/clear-orphan",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath, branchName: branch },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ cleared: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      // The branch is gone too — re-adding a worktree with the same -b
      // branch name at the same path no longer collides.
      expect(() => run(["worktree", "add", "-b", branch, worktreePath, "main"])).not.toThrow();
      expect(fs.existsSync(worktreePath)).toBe(true);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("clear-orphan refuses (leaving worktree and branch in place) when the worktree is dirty, and rejects a cwd/worktreePath outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd, worktreePath, branch } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "uncommitted");
      const dirtyRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/clear-orphan",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath, branchName: branch },
      });
      expect(dirtyRes.statusCode).toBe(200);
      expect(dirtyRes.json()).toEqual({ cleared: false, reason: "dirty" });
      expect(fs.existsSync(worktreePath)).toBe(true);

      const outsideRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/clear-orphan",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath: "/etc/not-a-project", branchName: branch },
      });
      expect(outsideRes.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("POST /internal/git-worktree/checkout, /force-remove, and /sync (issue #345)", () => {
    async function makeDockPreviewRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-worktree-345-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      return { repoRoot, cwd, run };
    }

    it("checks out an existing branch into a fresh detached-HEAD worktree", async () => {
      const { repoRoot, cwd } = await makeDockPreviewRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/checkout",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branch: "main" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.branch).toBe("main");
      expect(path.basename(body.path)).toMatch(/^dock-preview-main-/);
      expect(fs.existsSync(body.path)).toBe(true);
      // Detached HEAD: `git symbolic-ref HEAD` exits non-zero (throws) —
      // exactly what makes the sync tick's `reset --hard` safe alongside
      // `main` checked out elsewhere (see syncWorktree's doc comment).
      const { execFileSync } = await import("node:child_process");
      expect(() =>
        execFileSync("git", ["symbolic-ref", "-q", "HEAD"], {
          cwd: body.path,
          stdio: "pipe",
          env: gitEnv(),
        }),
      ).toThrow();

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("returns null (200) for a nonexistent branch, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd } = await makeDockPreviewRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const badBranch = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/checkout",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branch: "no-such-branch" },
      });
      expect(badBranch.statusCode).toBe(200);
      expect(badBranch.json()).toBeNull();

      const outsideCwd = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/checkout",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: "/etc", branch: "main" },
      });
      expect(outsideCwd.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("force-removes a dirty preview worktree, and rejects a worktreePath/parentCwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd } = await makeDockPreviewRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/checkout",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branch: "main" },
      });
      const { path: worktreePath } = checkoutRes.json();
      // Dirty the worktree — force-remove must succeed anyway (unlike
      // /internal/git-worktree/remove's removeWorktreeIfClean).
      fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "uncommitted");

      const outsidePath = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/force-remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath: "/etc/not-a-project" },
      });
      expect(outsidePath.statusCode).toBe(400);

      const outsideParent = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/force-remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: "/etc" },
      });
      expect(outsideParent.statusCode).toBe(400);
      expect(fs.existsSync(worktreePath)).toBe(true);

      const removeRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/force-remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: cwd },
      });
      expect(removeRes.statusCode).toBe(200);
      expect(removeRes.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("syncs a preview worktree to the branch's local tip, and rejects a worktreePath outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd, run } = await makeDockPreviewRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/checkout",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branch: "main" },
      });
      const { path: worktreePath } = checkoutRes.json();

      // A new commit on main in the primary checkout, not yet reflected in
      // the (detached-HEAD) preview worktree.
      fs.writeFileSync(path.join(cwd, "b.txt"), "b\n");
      run(["add", "-A"]);
      run(["commit", "-m", "second", "--no-verify"]);
      expect(fs.existsSync(path.join(worktreePath, "b.txt"))).toBe(false);

      const outsidePath = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/sync",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath: "/etc/not-a-project", branch: "main" },
      });
      expect(outsidePath.statusCode).toBe(400);

      const syncRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/sync",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, branch: "main" },
      });
      expect(syncRes.statusCode).toBe(200);
      expect(syncRes.json()).toEqual({ synced: true });
      expect(fs.existsSync(path.join(worktreePath, "b.txt"))).toBe(true);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("POST /internal/git-branch-delete, /git-worktree/remove-listed, and /prune-metadata (issue #442)", () => {
    async function makeRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-442-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      return { repoRoot, cwd, run };
    }

    it("deletes a branch on this host's own filesystem", async () => {
      const { repoRoot, cwd, run } = await makeRepo();
      run(["branch", "feature-x"]);
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-branch-delete",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, name: "feature-x" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: true });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/name body for git-branch-delete, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-branch-delete",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-branch-delete",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: "/etc/not-a-project", name: "main" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("removes any worktree git worktree list reports, not just a mullion-task-prefixed one", async () => {
      const { repoRoot, cwd, run } = await makeRepo();
      const worktreePath = path.join(cwd, ".mullion-worktrees", "hand-made");
      run(["worktree", "add", "-b", "hand-made-branch", worktreePath, "main"]);
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove-listed",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/worktreePath body for remove-listed, and rejects a worktreePath outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove-listed",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove-listed",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath: "/etc/not-a-project" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("prunes stale worktree administrative metadata on this host's own filesystem", async () => {
      const { repoRoot, cwd, run } = await makeRepo();
      const worktreePath = path.join(cwd, ".mullion-worktrees", "oob-removed");
      run(["worktree", "add", "-b", "oob-branch", worktreePath, "main"]);
      fs.rmSync(worktreePath, { recursive: true, force: true });
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune-metadata",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pruned: true });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd body for prune-metadata, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune-metadata",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune-metadata",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: "/etc" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("POST /internal/git-pull (issue #745)", () => {
    async function makeRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-pull-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      return { repoRoot, cwd, run };
    }

    it("runs git pull on this host's own filesystem and returns GitPullResult", async () => {
      const { repoRoot, cwd } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-pull",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({ pulled: expect.any(Boolean) as boolean }),
      );

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd body and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-pull",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-pull",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: "/etc" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("POST /internal/git-checkout, /git-branch-create, /git-rebase (issue #1672)", () => {
    async function withRepo(fn: (cwd: string, run: (args: string[]) => void) => Promise<void>) {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-1672-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[]) => {
        execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
      };
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      try {
        await fn(cwd, run);
      } finally {
        process.env.PROJECTS_ROOTS = previousRoots;
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    }

    const post = (app: Awaited<ReturnType<typeof buildApp>>, url: string, payload: object) =>
      app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload,
      });

    it("creates, checks out and rebases on this host's own filesystem", async () => {
      await withRepo(async (cwd) => {
        const app = await buildApp();
        try {
          const created = await post(app, "/internal/git-branch-create", {
            cwd,
            name: "topic",
            startPoint: "main",
          });
          expect(created.json()).toEqual({ ok: true });

          const checkedOut = await post(app, "/internal/git-checkout", { cwd, branch: "topic" });
          expect(checkedOut.json()).toEqual({ ok: true });

          const rebased = await post(app, "/internal/git-rebase", { cwd, onto: "main" });
          expect(rebased.json()).toEqual({
            ok: true,
            reason: "already-up-to-date",
            detail: "main",
          });
        } finally {
          await app.close();
        }
      });
    });

    // Issue #3068 — the per-branch Pull, on the agent's own filesystem.
    it("pulls one branch, comparing the checkout the primary guarded", async () => {
      await withRepo(async (cwd, run) => {
        run(["branch", "--track", "follower", "main"]);
        const app = await buildApp();
        try {
          expect(
            (
              await post(app, "/internal/git-branch-pull", {
                cwd,
                branch: "follower",
                expectedWorktree: null,
              })
            ).json(),
          ).toEqual({ ok: true, reason: "already-up-to-date", detail: "main" });
          // The primary thought it was checked out nowhere; it is the checkout.
          expect(
            (
              await post(app, "/internal/git-branch-pull", {
                cwd,
                branch: "main",
                expectedWorktree: null,
              })
            ).json(),
          ).toMatchObject({ ok: false, reason: "failed" });
          expect(
            (await post(app, "/internal/git-branch-pull", { cwd: "/etc", branch: "main" }))
              .statusCode,
          ).toBe(400);
        } finally {
          await app.close();
        }
      });
    });

    it("refuses while the clone is claimed by another git operation", async () => {
      await withRepo(async (cwd) => {
        const { markCloneBusy, releaseClone } =
          await import("../../src/services/git-clone-busy.js");
        const app = await buildApp();
        markCloneBusy("local", cwd);
        try {
          const res = await post(app, "/internal/git-checkout", { cwd, branch: "main" });
          expect(res.json()).toMatchObject({ ok: false, reason: "busy" });
        } finally {
          releaseClone("local", cwd);
          await app.close();
        }
      });
    });

    it("validates the body and rejects a cwd outside PROJECTS_ROOTS", async () => {
      await withRepo(async () => {
        const app = await buildApp();
        try {
          expect((await post(app, "/internal/git-checkout", {})).statusCode).toBe(400);
          expect(
            (await post(app, "/internal/git-branch-create", { cwd: "/etc", name: "x" })).statusCode,
          ).toBe(400);
          expect((await post(app, "/internal/git-rebase", { cwd: "/etc" })).statusCode).toBe(400);
          expect(
            (
              await post(app, "/internal/git-branch-create", {
                cwd: "/etc",
                name: "x",
                startPoint: "main",
              })
            ).statusCode,
          ).toBe(400);
        } finally {
          await app.close();
        }
      });
    });
  });
});
