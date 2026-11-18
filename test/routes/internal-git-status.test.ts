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

describe("internal routes: git status, diff, branch, and repo", () => {
  const env = createInternalAgentEnv();
  let projectsRoot: string;
  beforeAll(() => {
    env.setup();
    projectsRoot = env.projectsRoot;
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

  it("resolves a github.com owner/repo from this host's own .git/config (issue #27)", async () => {
    const app = await buildApp();
    const cwd = path.join(projectsRoot, "git-repo");
    const res = await app.inject({
      method: "GET",
      url: `/internal/github-repo?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ owner: "s3ntin3l8", repo: "mullion-session-manager" });
    await app.close();
  });

  it("resolves null for a repo with no github.com origin remote", async () => {
    // A separate root (not projectsRoot) so this bare repo never shows up
    // as an extra candidate in the "discovers candidates" test's exact
    // single-entry assertion above.
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-bare-root-"));
    fs.mkdirSync(path.join(bareRoot, "bare-repo", ".git"), { recursive: true });
    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = bareRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/github-repo?cwd=${encodeURIComponent(path.join(bareRoot, "bare-repo"))}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(bareRoot, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for github-repo, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/github-repo",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-github-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/github-repo?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves the current branch from this host's own HEAD (issue #96)", async () => {
    const app = await buildApp();
    const cwd = path.join(projectsRoot, "git-repo");
    fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");

    const res = await app.inject({
      method: "GET",
      url: `/internal/git-branch?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBe("main");
    await app.close();
  });

  it("requires a cwd query param for git-branch, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-branch",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branch-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-branch?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves git status from this host's own filesystem (issue #76)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-status?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // { isRepo, status } — not a bare GitStatus — so the primary can tell
    // "not a repo" apart from "repo exists but git status failed
    // transiently" for a remote host the same way it already can locally
    // (isGitRepo/getGitStatus).
    expect(res.json()).toMatchObject({
      isRepo: true,
      status: { branch: "main", isClean: true },
    });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("includes a problem when git status fails in a repo, and omits it otherwise (issue #1612)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-problem-"));
    const cwd = path.join(repoRoot, "bare-flagged");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["config", "core.bare", "true"], { cwd, stdio: "pipe", env: gitEnv() });

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;
    const app = await buildApp();
    const get = () =>
      app.inject({
        method: "GET",
        url: `/internal/git-status?cwd=${encodeURIComponent(cwd)}&fresh=1`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

    const broken = (await get()).json();
    expect(broken).toMatchObject({ isRepo: true, status: null, problem: { reason: "bare-repo" } });

    execFileSync("git", ["config", "core.bare", "false"], { cwd, stdio: "pipe", env: gitEnv() });
    const healthy = (await get()).json();
    expect(healthy.status).not.toBeNull();
    expect(healthy).not.toHaveProperty("problem");

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("reports isRepo: false for a directory that isn't a git repo (issue #76)", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-not-a-repo-"));
    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = notARepo;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-status?cwd=${encodeURIComponent(notARepo)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ isRepo: false, status: null });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(notARepo, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for git-status, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-status",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-status?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves diff stats from this host's own filesystem (issue #202)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\ntwo\n");

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-diff?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // { isRepo, stats } — same shape as /internal/git-status's own
    // { isRepo, status }, for the same "durable vs. transient" reason.
    expect(res.json()).toEqual({
      isRepo: true,
      stats: { filesChanged: 1, insertions: 1, deletions: 0, workflowFiles: [] },
    });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("fresh=1 bypasses the diff-stat cache so the workflow-change gate sees a just-made edit", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-fresh-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
    git("init", "-b", "main");
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-m", "initial", "--no-verify");

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;
    const app = await buildApp();
    const get = (qs = "") =>
      app.inject({
        method: "GET",
        url: `/internal/git-diff?cwd=${encodeURIComponent(cwd)}${qs}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

    expect((await get()).json().stats.workflowFiles).toEqual([]);
    fs.mkdirSync(path.join(cwd, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".github", "workflows", "ci.yml"), "name: ci\n");
    git("add", "-A");
    // Cached: the stale, workflow-free answer is still served.
    expect((await get()).json().stats.workflowFiles).toEqual([]);
    expect((await get("&fresh=1")).json().stats.workflowFiles).toEqual([
      ".github/workflows/ci.yml",
    ]);

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("base=AUTO reports baseResolved so a caller can tell 'no base ref' from 'no changes'", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-auto-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
    git("init", "-b", "main");
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-m", "initial", "--no-verify");

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;
    const app = await buildApp();
    const get = (qs: string) =>
      app.inject({
        method: "GET",
        url: `/internal/git-diff?cwd=${encodeURIComponent(cwd)}${qs}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

    // No origin/* ref yet: AUTO resolves to nothing.
    expect((await get("&base=AUTO&fresh=1")).json().baseResolved).toBe(false);
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect((await get("&base=AUTO&fresh=1")).json().baseResolved).toBe(true);
    // An explicit base carries no flag: there was nothing to resolve.
    expect((await get("&base=main&fresh=1")).json()).not.toHaveProperty("baseResolved");

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("reports isRepo: false for a git-diff cwd that isn't a git repo (issue #202)", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-not-a-repo-"));
    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = notARepo;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-diff?cwd=${encodeURIComponent(notARepo)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ isRepo: false, stats: null });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(notARepo, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for git-diff, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-diff",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-diff?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves branches and worktrees from this host's own filesystem (issue #162)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branches-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    execFileSync("git", ["branch", "feature/foo"], { cwd, stdio: "pipe", env: gitEnv() });

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-branches?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // objectContaining, not exact equality — issue #442 adds unconditional
    // enrichment fields (lastCommitRelative etc.) to every branch entry.
    expect(body.branches).toContainEqual(
      expect.objectContaining({ name: "main", isCurrent: true }),
    );
    expect(body.branches).toContainEqual(
      expect.objectContaining({ name: "feature/foo", isCurrent: false }),
    );
    expect(body.branches.every((b: { isMerged?: boolean }) => b.isMerged === undefined)).toBe(true);
    expect(body.worktrees).toEqual([{ path: cwd, branch: "main", isMain: true }]);

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("serves history, commit detail and a commit file diff from this host (issue #1969)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-history-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString().trim();
    git("init", "-b", "main");
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-m", "first", "--no-verify");
    const head = git("rev-parse", "HEAD");
    git("worktree", "add", "-b", "wt-branch", path.join(repoRoot, "wt"));

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;
    const app = await buildApp();
    const get = (url: string) =>
      app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });
    const q = encodeURIComponent(cwd);

    const log = await get(`/internal/git-log?cwd=${q}&limit=5&scope=head`);
    expect(log.statusCode).toBe(200);
    expect(log.json().commits[0]).toEqual(expect.objectContaining({ sha: head, subject: "first" }));

    const wtPath = git("worktree", "list", "--porcelain")
      .split("\n")
      .find((l) => l.endsWith("/wt"))!
      .replace("worktree ", "");
    const inWt = await get(`/internal/git-log?cwd=${q}&worktree=${encodeURIComponent(wtPath)}`);
    expect(inWt.json().commits).toHaveLength(1);

    const forbidden = await get(
      `/internal/git-log?cwd=${q}&worktree=${encodeURIComponent("/tmp")}`,
    );
    expect(forbidden.statusCode).toBe(200);
    expect(forbidden.json()).toEqual({ commits: null, forbidden: true });

    expect((await get(`/internal/git-log?cwd=${q}&skip=-1`)).statusCode).toBe(400);
    expect((await get(`/internal/git-log?cwd=${q}&scope=nope`)).statusCode).toBe(400);
    expect((await get("/internal/git-log")).statusCode).toBe(400);

    const commit = await get(`/internal/git-commit?cwd=${q}&sha=${head}`);
    expect(commit.json().detail).toEqual(
      expect.objectContaining({
        sha: head,
        files: [expect.objectContaining({ path: "a.txt" })],
      }),
    );
    expect((await get(`/internal/git-commit?cwd=${q}&sha=zz`)).statusCode).toBe(400);
    expect((await get(`/internal/git-commit?sha=${head}`)).statusCode).toBe(400);
    const forbiddenCommit = await get(
      `/internal/git-commit?cwd=${q}&sha=${head}&worktree=${encodeURIComponent("/tmp")}`,
    );
    expect(forbiddenCommit.json()).toEqual({ detail: null, forbidden: true });

    const file = await get(`/internal/git-commit-file?cwd=${q}&sha=${head}&path=a.txt`);
    expect(file.json().patch).toContain("+one");
    expect(
      (await get(`/internal/git-commit-file?cwd=${q}&sha=${head}&path=..%2Fx`)).statusCode,
    ).toBe(400);
    expect((await get(`/internal/git-commit-file?sha=${head}&path=a.txt`)).statusCode).toBe(400);
    const forbiddenFile = await get(
      `/internal/git-commit-file?cwd=${q}&sha=${head}&path=a.txt&worktree=${encodeURIComponent("/tmp")}`,
    );
    expect(forbiddenFile.json()).toEqual({ patch: null, forbidden: true });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("resolves isMerged when ?detail=1 is set (issue #442)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branches-detail-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
    run(["init", "-b", "main"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    run(["add", "-A"]);
    run(["commit", "-m", "initial", "--no-verify"]);
    run(["checkout", "-b", "merged-branch"]);
    run(["checkout", "main"]);
    run(["merge", "merged-branch", "--no-edit"]);

    const remoteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "internal-git-branches-detail-origin-"),
    );
    run(["remote", "add", "origin", remoteDir]);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: remoteDir,
      stdio: "pipe",
      env: gitEnv(),
    });
    run(["push", "-u", "origin", "main"]);

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/internal/git-branches?cwd=${encodeURIComponent(cwd)}&detail=1`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branches.find((b: { name: string }) => b.name === "merged-branch").isMerged).toBe(
      true,
    );

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for git-branches, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-branches",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branches-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-branches?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });
});
