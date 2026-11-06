// The batch git refs and diff routes.
//
// Moved out of test/routes/projects.test.ts (issue #2475), alongside the
// routes themselves: src/routes/project-git.ts. The Git route block left
// projects.ts, and the test tree mirrors the source tree.
//
// The batch routes take `?ids=` and answer one entry per project, so the
// sidebar can refresh many projects' branches and diffs in one request.

import type { FastifyInstance } from "fastify";
import { describe, it, expect, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment for
// the empirically confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as HermesReview from "../../src/services/hermes-review.js";
import type * as TaskReconciler from "../../src/services/task-reconciler.js";

// The relay's landed-check memo (issue #1630) — cleared per test so one
// test's answer is not the next one's.
import { gitEnv } from "../../src/services/git-env.js";

import { PR_REVIEW_DEFAULTS } from "../helpers/pr-review-defaults.js";

// Session creation spawns a real OS process (systemd-run, bootstrapping a
// dtach master) via PtyManager — faked here the same way as
// test/services/pty-manager.test.ts and test/routes/sessions.test.ts, so
// this file exercises the route/DB layer without depending on a real
// `systemd --user` session existing in CI. This file is the one place
// `POST /api/sessions` was still hitting a real spawn: CI's runner can't
// complete `systemd-run --user --scope` (`master bootstrap exited with
// code 1`), and the failed session's app instance then fails to release
// its `hooks.sock` listener cleanly, which cascades into
// `SocketAlreadyListeningError` for every later test in this file that
// builds its own `buildApp()`.
//
// Unlike sessions.test.ts (which fakes every non-`git` command), this file
// also exercises real `docker` (docker-service-detect.ts, via the dock
// route) and real `git`/shell subprocesses well beyond worktree setup —
// faking anything broader than the one command that's actually
// CI-unreliable would either skip real coverage these tests are meant to
// exercise, or (as `docker-service-detect.ts`'s `child.kill()` timeout
// found out the hard way) break code that expects a real ChildProcess
// shape from `spawn`. So only `systemd-run` itself is faked; `systemctl`
// (pty-manager.ts's stopScope/isMasterAlive — never actually reaches a
// real scope once systemd-run is faked, and doesn't `.kill()` its child)
// and everything else passes through to the real `spawn`.
vi.mock("node-pty", () => plainNodePtyMock());

// Passthrough wrapper so a test can assert which token scopes a route asks
// for, while every other test still gets the real resolver.
vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubIntegration>();
  return { ...actual, resolveGitHubToken: vi.fn(actual.resolveGitHubToken) };
});

// The same trick for the review relay's run lookup (issue #1630): the route
// asks "does this Mullion know a review run for this PR?", and a test can
// answer that without dispatching a real run.
vi.mock("../../src/services/hermes-review.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HermesReview>();
  return {
    ...actual,
    getReviewRunForPr: vi.fn(actual.getReviewRunForPr),
    // Epic #1965 A6 — the issue list/detail ask the same index for a triage run.
    getRunForTarget: vi.fn(actual.getRunForTarget),
    // #1790 — the re-review route's dispatch, so a test can hand back a result
    // without a real Hermes.
    assertReviewerConfigured: vi.fn(actual.assertReviewerConfigured),
    requestHermesReview: vi.fn(actual.requestHermesReview),
  };
});

// Passthrough wrapper so a test can make the sidebar merge's task bookkeeping
// throw without touching the real implementation for every other test.
vi.mock("../../src/services/task-reconciler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TaskReconciler>();
  return { ...actual, finishTaskForMergedPr: vi.fn(actual.finishTaskForMergedPr) };
});

// Marker substring a target cwd can contain to make runGitInit's own `git
// init` spawn fail deterministically (real `git init` essentially never
// fails on a fresh, writable directory) — Hermes review, PR #620: the
// route-level gitInit-failure wiring (`gitInitialized = result.success`)
// was only covered at the service level (git-init.test.ts's own mocked
// spawn), not through POST/PATCH /api/projects itself. Everything else
// still passes through to the real `git` binary — see this file's own
// `execFileSync("git", ["init", ...])` fixture setup elsewhere, unaffected
// since that's a different child_process API than the mocked `spawn`.
const GIT_INIT_FAIL_MARKER = "route-git-init-fail";

// Not converted to mock-spawn.ts's mockChildProcessSpawn — that helper's
// own header deliberately excludes files needing command-specific
// conditional behavior beyond a static fake/passthrough command list
// (e.g. this file's GIT_INIT_FAIL_MARKER, which fakes a `git init` failure
// only for one specific target path, while every other `git` invocation
// passes through to the real binary). Forcing this into the shared helper
// would need a per-args predicate the helper doesn't support.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (
        command === "git" &&
        args?.includes("init") &&
        args?.some((a) => a.includes(GIT_INIT_FAIL_MARKER))
      ) {
        const ee = new EventEmitter();
        setImmediate(() => ee.emit("close", 1));
        return ee;
      }
      if (command !== "systemd-run") return actual.spawn(command, args, options);
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");

// Each "remote host" test below builds a second, real buildApp() instance in
// `agent` role alongside this file's own primary one — both would otherwise
// default to the SAME SESSIONS_DIR (test/setup.ts sets it once per file), so
// their hooksPlugin listeners (registered for both roles) would collide on
// the same hooks.sock path. Gives each agent instance its own scratch
// directory instead.

describe("projects route", () => {
  describe("GET /api/projects/git-refs (batch, issue #1007)", () => {
    it("returns empty branches/prs maps when no ids are given", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-refs" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ branches: {}, prs: {}, defaultBranchCi: {} });
      await app.close();
    });

    it("returns branches and the warm-cache PR status for a connected local repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-refs-real-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:batch-refs/repo.git"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-git-refs-real",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      // Primed as the poller (github-pr-poller.ts) would — the batch
      // route's PR half is a pure cache read, no token needed.
      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("batch-refs", "repo", {
        prs: [
          {
            number: 3,
            title: "Batch it",
            htmlUrl: "https://github.com/batch-refs/repo/pull/3",
            author: "dev",
            ...PR_REVIEW_DEFAULTS,
            headSha: "abc",
            headBranch: "feature",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-refs?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.branches[String(projectId)]).toMatchObject({
        branches: expect.arrayContaining([expect.objectContaining({ name: "main" })]),
      });
      expect(body.prs[String(projectId)].prs).toHaveLength(1);
      expect(body.prs[String(projectId)].prs[0].number).toBe(3);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("carries the poller's default-branch CI even when the repo has no open PRs", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-refs-ci-"));
      for (const args of [
        ["init", "-b", "main"],
        ["remote", "add", "origin", "git@github.com:batch-ci/repo.git"],
      ]) {
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      }
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-git-refs-ci",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;
      const { setRepoPRsStatus, setDefaultBranchCi } = await import("../../src/services/github.js");

      // Cold cache: the id is omitted so the client keeps its last-known-good.
      let res = await app.inject({
        method: "GET",
        url: `/api/projects/git-refs?ids=${projectId}`,
      });
      expect(String(projectId) in res.json().defaultBranchCi).toBe(false);

      // Zero open PRs collapses `prs` to null — the CI map must not.
      setRepoPRsStatus("batch-ci", "repo", {
        prs: [],
        prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
      });
      setDefaultBranchCi("batch-ci", "repo", "failure");
      res = await app.inject({ method: "GET", url: `/api/projects/git-refs?ids=${projectId}` });
      const body = res.json();
      expect(body.prs[String(projectId)]).toBeNull();
      expect(body.defaultBranchCi[String(projectId)]).toBe("failure");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null branches and null prs for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-refs-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-git-refs-none",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-refs?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.branches[String(projectId)]).toBeNull();
      expect(body.prs[String(projectId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    // Hermes review, PR #1017 — the PRs half used to collapse "host
    // unreachable" and "no GitHub remote configured" into the same `null`
    // (resolveRepoRef's own null-collapse), so a transient outage cleared
    // the frontend's last-known-good open-PR list for that project exactly
    // like a durable "no PRs" would. Fixed to use resolveRepoRefResult
    // directly and omit (not null) on "unreachable" — this test locks that
    // in for both halves of the batch, matching git-statuses' own
    // omit-on-unreachable precedent above.
    it("omits BOTH branches and prs (not null) for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "batch-refs-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "batch-refs-remote",
          cwd: "/x",
          hostId: host.json().id,
        },
      });
      const projectId = project.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-refs?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ branches: {}, prs: {}, defaultBranchCi: {} });

      await app.close();
    });

    it("handles a mix of a connected repo and an unreachable remote-host project independently", async () => {
      const { execFileSync } = await import("node:child_process");
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-refs-mix-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
      fs.writeFileSync(path.join(repoDir, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: repoDir,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const repo = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-git-refs-mix-repo",
          cwd: repoDir,
        },
      });
      const repoId = repo.json().id as number;

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "batch-refs-mix-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remote = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "batch-git-refs-mix-remote",
          cwd: "/x",
          hostId: host.json().id,
        },
      });
      const remoteId = remote.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-refs?ids=${repoId},${remoteId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.branches[String(repoId)]).toMatchObject({
        branches: expect.arrayContaining([expect.objectContaining({ name: "main" })]),
      });
      expect(body.prs[String(repoId)]).toBeNull();
      expect(body.branches[String(remoteId)]).toBeUndefined();
      expect(body.prs[String(remoteId)]).toBeUndefined();

      fs.rmSync(repoDir, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/git-diff-stats (batch, issue #202)", () => {
    it("returns an empty object when no sessionIds are given", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-diff-stats" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
      await app.close();
    });

    it("returns diff stats for a session's cwd with a modified tracked file", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-project-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\nTWO\nthree\nfour\n");

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "diff-stats-project",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body[String(sessionId)]).toEqual({
        filesChanged: 1,
        insertions: 2,
        deletions: 1,
        workflowFiles: [],
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null for a session whose cwd isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-nonrepo-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "diff-stats-nonrepo",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()[String(sessionId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns zero-change stats for a clean repo with no diff against HEAD", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-clean-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "diff-stats-clean",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()[String(sessionId)]).toEqual({
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        workflowFiles: [],
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("omits a session on an unreachable remote host from the response", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "diff-stats-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "diff-stats-remote-project",
          cwd: "/x",
          hostId: host.json().id,
        },
      });
      const projectId = project.json().id as number;

      // Seeded straight into the DB, not via POST /api/sessions — a real
      // spawn attempt against this unreachable host would 502 and roll the
      // row back before this test ever gets to exercise the batch endpoint
      // (see the "detectedDevServerPort" describe block's identical
      // seed-straight-into-the-DB pattern for a remote project).
      const { sessions } = await import("../../src/db/schema.js");
      const [created] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${created.id}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});

      await app.close();
    });

    it("returns branch-wide diff stats when base is set (issue #262)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-base-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      // Create a feature branch with additional commits
      execFileSync("git", ["checkout", "-b", "feature"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "feature commit", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "diff-stats-base-project",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      // Without base param: zero (all changes are committed)
      const resNoBase = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(resNoBase.statusCode).toBe(200);
      expect(resNoBase.json()[String(sessionId)]).toEqual({
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        workflowFiles: [],
      });

      // With base=main: shows feature branch delta
      const resWithBase = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}&base=main`,
      });
      expect(resWithBase.statusCode).toBe(200);
      expect(resWithBase.json()[String(sessionId)]).toEqual({
        filesChanged: 1,
        insertions: 3,
        deletions: 0,
        workflowFiles: [],
      });

      // With an invalid base ref pattern: 400
      const resInvalidBase = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}&base=../escape`,
      });
      expect(resInvalidBase.statusCode).toBe(400);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("auto-derives the base ref when base=AUTO (issue #262 follow-up)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-auto-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      // Create a remote with origin/main to exercise the AUTO resolution path.
      const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-auto-remote-"));
      execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["remote", "add", "origin", remoteDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["push", "origin", "main", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      // Create a feature branch with additional commits.
      execFileSync("git", ["checkout", "-b", "feature"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "feature commit", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "diff-stats-auto-project",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      // With base=AUTO, the backend should resolve origin/main and compute the
      // feature branch delta vs main.
      const resAuto = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}&base=AUTO`,
      });
      expect(resAuto.statusCode).toBe(200);
      expect(resAuto.json()[String(sessionId)]).toEqual({
        filesChanged: 1,
        insertions: 3,
        deletions: 0,
        workflowFiles: [],
      });

      fs.rmSync(remoteDir, { recursive: true, force: true });
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/git-file-diff (issue #433, projectId variant)", () => {
    async function makeRepoProject(app: FastifyInstance, name: string) {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\nTWO\nthree\n");

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name, cwd: projectCwd },
      });
      return { projectId: created.json().id as number, projectCwd };
    }

    it("returns a patch for a project's own working-tree diff", async () => {
      const app = await buildApp();
      const { projectId, projectCwd } = await makeRepoProject(app, "git-file-diff-project");

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-file-diff?projectId=${projectId}&path=a.txt`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().patch).toContain("TWO");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("404s for an unknown projectId", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/git-file-diff?projectId=999999&path=a.txt",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s when neither sessionId nor projectId is given", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/git-file-diff?path=a.txt",
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("400s when both sessionId and projectId are given", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/git-file-diff?sessionId=1&projectId=1&path=a.txt",
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("400s on a path-traversal attempt with projectId", async () => {
      const app = await buildApp();
      const { projectId, projectCwd } = await makeRepoProject(app, "git-file-diff-traversal");

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-file-diff?projectId=${projectId}&path=../../etc/passwd`,
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null patch for a project whose cwd isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "git-file-diff-nonrepo-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "git-file-diff-nonrepo",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-file-diff?projectId=${projectId}&path=a.txt`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().patch).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });
});
