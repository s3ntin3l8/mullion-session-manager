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
const { taskReviewFindingsPath, taskCommitTitlePath, taskRereviewRequestPath } =
  await import("../../src/services/task-prompt.js");

const TOKEN = INTERNAL_TEST_TOKEN;

describe("internal routes: task master proxy and task artifacts", () => {
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

  describe("Task Master remote-hosted proxy routes (#484)", () => {
    async function makeTaskWorktreeRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-484-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      // Same descriptive shape as the other makeTaskWorktreeRepo — see
      // that function's own comment for why.
      const branch = "mullion/task-1-test";
      const worktreePath = path.join(cwd, ".mullion-worktrees", "mullion-task-1-test");
      run(["worktree", "add", "-b", branch, worktreePath, "main"]);
      return { repoRoot, cwd, worktreePath, run, branch };
    }

    it("GET /internal/git-status?fresh=1 bypasses the cache — a change made just before the request is reflected immediately", async () => {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-fresh-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      // Prime the 5s cache with a "clean" read.
      const cached = await app.inject({
        method: "GET",
        url: `/internal/git-status?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(cached.json()).toMatchObject({ status: { isClean: true } });

      // Dirty the tree — the plain (non-fresh) route would still report the
      // stale cached "clean" result here.
      fs.writeFileSync(path.join(cwd, "b.txt"), "uncommitted");
      const freshRes = await app.inject({
        method: "GET",
        url: `/internal/git-status?cwd=${encodeURIComponent(cwd)}&fresh=1`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(freshRes.statusCode).toBe(200);
      expect(freshRes.json()).toMatchObject({ isRepo: true, status: { isClean: false } });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("GET /internal/git-base-ref resolves the default base ref and its pinned SHA on this host's own filesystem", async () => {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-base-ref-root-"));
      const remote = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-base-ref-remote-"));
      execFileSync("git", ["init", "--bare", "-b", "main"], {
        cwd: remote,
        stdio: "pipe",
        env: gitEnv(),
      });
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["remote", "add", "origin", remote]);
      run(["push", "origin", "main"]);
      const expectedSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { env: gitEnv() })
        .toString("utf8")
        .trim();

      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/internal/git-base-ref?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ baseRef: "origin/main", sha: expectedSha, fetched: true });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
      await app.close();
    });

    it("GET /internal/git-base-ref resolves { baseRef: 'HEAD', sha: null } for a non-repo cwd — the same last-resort fallback the local path uses", async () => {
      const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-base-ref-not-a-repo-"));
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = notARepo;
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/internal/git-base-ref?cwd=${encodeURIComponent(notARepo)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ baseRef: "HEAD", sha: null, fetched: true });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(notARepo, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd query param for git-base-ref, and rejects one outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "GET",
        url: "/internal/git-base-ref",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-base-ref-outside-"));
      const outside = await app.inject({
        method: "GET",
        url: `/internal/git-base-ref?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("POST /internal/git-push pushes a branch to origin on this host's own filesystem", async () => {
      const { repoRoot, worktreePath, branch } = await makeTaskWorktreeRepo();
      const remote = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-push-remote-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "--bare", "-b", "main"], {
        cwd: remote,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["remote", "add", "origin", remote], {
        cwd: worktreePath,
        stdio: "pipe",
        env: gitEnv(),
      });
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-push",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: worktreePath, branch, token: "ghp_supersecrettoken" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      // The push actually landed — a real bare-repo remote doesn't need the
      // http.extraHeader token at all (that's an https-transport mechanism,
      // see git-push.ts's own header comment), so this confirms the route
      // really runs `git push`, not just plumbing through a mock.
      const branches = execFileSync("git", ["-C", remote, "branch"], { env: gitEnv() }).toString();
      expect(branches).toContain(branch);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
      await app.close();
    });

    it("POST /internal/git-push relays a git-level failure's redacted detail (redaction itself is git-push.test.ts's own coverage) and never echoes the token", async () => {
      const { repoRoot, worktreePath } = await makeTaskWorktreeRepo();
      const remote = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-push-remote-fail-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "--bare", "-b", "main"], {
        cwd: remote,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["remote", "add", "origin", remote], {
        cwd: worktreePath,
        stdio: "pipe",
        env: gitEnv(),
      });
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-push",
        headers: { authorization: `Bearer ${TOKEN}` },
        // A branch that doesn't exist locally — a deterministic git-level
        // failure with no network involved.
        payload: {
          cwd: worktreePath,
          branch: "mullion/task-does-not-exist",
          token: "ghp_supersecrettoken",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.detail).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain("ghp_supersecrettoken");

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/branch/token body for git-push, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-push",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-push-outside-"));
      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-push",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: outsideRoots, branch: "main", token: "x" },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("GET /internal/git-worktree/task-dirs lists this host's own on-disk task-worktree directories", async () => {
      const { repoRoot, cwd, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/internal/git-worktree/task-dirs?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        dirs: [worktreePath],
      });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd query param for git-worktree/task-dirs, and rejects one outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "GET",
        url: "/internal/git-worktree/task-dirs",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-task-dirs-outside-"));
      const outside = await app.inject({
        method: "GET",
        url: `/internal/git-worktree/task-dirs?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("POST /internal/git-worktree/resume checks out an EXISTING branch (not -b, not --detach) into a fresh worktree at the deterministic path", async () => {
      const { repoRoot, cwd, worktreePath, run, branch } = await makeTaskWorktreeRepo();
      // Remove the worktree directory but leave the branch — reproduces the
      // exact state `→ failed` cleanup leaves behind (removeWorktreeIfClean
      // never deletes the branch).
      run(["worktree", "remove", "--force", worktreePath]);
      expect(fs.existsSync(worktreePath)).toBe(false);

      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/resume",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branchName: branch },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ path: worktreePath, branch });
      expect(fs.existsSync(worktreePath)).toBe(true);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("resume resolves null (200, not an error) when the branch no longer exists — restricted to the closed mullion/task-<id> namespace", async () => {
      const { repoRoot, cwd } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const noBranch = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/resume",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branchName: "mullion/task-999" },
      });
      expect(noBranch.statusCode).toBe(200);
      expect(noBranch.json()).toBeNull();

      const notTaskShaped = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/resume",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branchName: "main" },
      });
      expect(notTaskShaped.statusCode).toBe(200);
      expect(notTaskShaped.json()).toBeNull();

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/branchName body for git-worktree/resume, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/resume",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-resume-outside-"));
      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/resume",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: outsideRoots, branchName: "mullion/task-1-test" },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET/DELETE /internal/task-review-findings (#760)", () => {
    it("GET returns { content: null } (200, not 404) for a genuinely absent file", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/task-review-findings?taskId=999&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ content: null });
      await app.close();
    });

    it("GET returns the trimmed file content when present", async () => {
      const app = await buildApp();
      const findingsPath = taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), 7, 0);
      fs.writeFileSync(findingsPath, "  ## Round 0\n\nLooks good.  \n");

      const res = await app.inject({
        method: "GET",
        url: "/internal/task-review-findings?taskId=7&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ content: "## Round 0\n\nLooks good." });

      fs.rmSync(findingsPath, { force: true });
      await app.close();
    });

    it("GET returns { content: null } for a present-but-empty file, same as absent", async () => {
      const app = await buildApp();
      const findingsPath = taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), 8, 0);
      fs.writeFileSync(findingsPath, "   \n");

      const res = await app.inject({
        method: "GET",
        url: "/internal/task-review-findings?taskId=8&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json()).toEqual({ content: null });

      fs.rmSync(findingsPath, { force: true });
      await app.close();
    });

    it("GET rejects non-integer taskId/round with 400, not a crash", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/task-review-findings?taskId=abc&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("DELETE removes the file when present, and is a no-op (still 204) when absent", async () => {
      const app = await buildApp();
      const findingsPath = taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), 9, 0);
      fs.writeFileSync(findingsPath, "content");

      const res = await app.inject({
        method: "DELETE",
        url: "/internal/task-review-findings?taskId=9&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(204);
      expect(fs.existsSync(findingsPath)).toBe(false);

      // Already gone — deleting again must still succeed, not throw.
      const again = await app.inject({
        method: "DELETE",
        url: "/internal/task-review-findings?taskId=9&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(again.statusCode).toBe(204);

      await app.close();
    });

    // Safety property this route exists to preserve (session-backend.ts's
    // SessionBackend.readTaskReviewFindings doc comment): the path is
    // derived ENTIRELY from this agent's own hookSocketPath plus two
    // numeric identifiers — no cwd, no caller-supplied path fragment at
    // all — so there's nothing here for a traversal attempt to reach.
    it("never accepts a path fragment — taskId/round are the only inputs, both numeric", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/internal/task-review-findings?taskId=${encodeURIComponent("../../etc/passwd")}&round=0`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  // #778 — mirrors GET /internal/task-review-findings's own shape/tests
  // exactly (no DELETE counterpart: the commit-title file isn't
  // round-suffixed and is meant to persist across rounds).

  describe("GET /internal/task-commit-title (#778)", () => {
    it("returns { content: null } (200, not 404) for a genuinely absent file", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/task-commit-title?taskId=999",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ content: null });
      await app.close();
    });

    it("returns the trimmed file content when present", async () => {
      const app = await buildApp();
      const titlePath = taskCommitTitlePath(path.dirname(app.pty.hookSocketPath), 7);
      fs.writeFileSync(titlePath, "  fix: handle the edge case  \n");

      const res = await app.inject({
        method: "GET",
        url: "/internal/task-commit-title?taskId=7",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ content: "fix: handle the edge case" });

      fs.rmSync(titlePath, { force: true });
      await app.close();
    });

    it("returns { content: null } for a present-but-empty file, same as absent", async () => {
      const app = await buildApp();
      const titlePath = taskCommitTitlePath(path.dirname(app.pty.hookSocketPath), 8);
      fs.writeFileSync(titlePath, "   \n");

      const res = await app.inject({
        method: "GET",
        url: "/internal/task-commit-title?taskId=8",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json()).toEqual({ content: null });

      fs.rmSync(titlePath, { force: true });
      await app.close();
    });

    it("rejects a non-integer taskId with 400, not a crash", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/task-commit-title?taskId=abc",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("never accepts a path fragment — taskId is the only input, numeric", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/internal/task-commit-title?taskId=${encodeURIComponent("../../etc/passwd")}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("GET /internal/task-rereview-request", () => {
    it("returns { content: null } (200, not 404) for an absent file", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/task-rereview-request?taskId=999&key=1",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ content: null });
      await app.close();
    });

    it("returns the worker's reason, and a placeholder for an empty file (existence is the request)", async () => {
      const app = await buildApp();
      const dir = path.dirname(app.pty.hookSocketPath);
      const withReason = taskRereviewRequestPath(dir, 7, 100);
      const empty = taskRereviewRequestPath(dir, 7, 101);
      fs.writeFileSync(withReason, "  grew into a refactor \n");
      fs.writeFileSync(empty, "  \n");

      const a = await app.inject({
        method: "GET",
        url: "/internal/task-rereview-request?taskId=7&key=100",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const b = await app.inject({
        method: "GET",
        url: "/internal/task-rereview-request?taskId=7&key=101",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(a.json()).toEqual({ content: "grew into a refactor" });
      expect(b.json()).toEqual({ content: "(no reason given)" });

      fs.rmSync(withReason, { force: true });
      fs.rmSync(empty, { force: true });
      await app.close();
    });

    it("rejects a non-integer taskId or key with 400, and never accepts a path fragment", async () => {
      const app = await buildApp();
      for (const url of [
        "/internal/task-rereview-request?taskId=abc&key=1",
        "/internal/task-rereview-request?taskId=1&key=abc",
        `/internal/task-rereview-request?taskId=1&key=${encodeURIComponent("../../etc/passwd")}`,
      ]) {
        const res = await app.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(400);
      }
      await app.close();
    });
  });
});
