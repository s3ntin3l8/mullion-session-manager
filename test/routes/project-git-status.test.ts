// The per-project and batch git status and branch routes.
//
// Moved out of test/routes/projects.test.ts (issue #2475), alongside the
// routes themselves: src/routes/project-git.ts. The Git route block left
// projects.ts, and the test tree mirrors the source tree.
//
// These answer "is this project's checkout a git repo, and what state is
// it in" — the sidebar's live-refresh loop and Source Control's branch
// picker.

import type { FastifyInstance } from "fastify";
import { describe, it, expect, vi, afterEach } from "vitest";
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
  describe("GET /api/projects/git-statuses (batch, issue #166)", () => {
    it("returns empty projects/sessions maps when no ids are given", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-statuses" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {}, problems: {} });
      await app.close();
    });

    it("returns empty projects/sessions maps for an empty ids string", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-statuses?ids=" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {}, problems: {} });
      await app.close();
    });

    it("returns git status for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-real-"));
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
          name: "batch-real-repo",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.projects[String(projectId)]).toMatchObject({
        branch: "main",
        isClean: true,
        hasConflicts: false,
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-not-a-repo",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().projects[String(projectId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("omits a project with a transient git failure from the response", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-transient-"));
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
      // Break HEAD so `git status` fails while `.git` still exists.
      fs.unlinkSync(path.join(projectCwd, ".git", "HEAD"));

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-transiently-broken",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      // Project is omitted from `projects` because git status failed, but the
      // failure is reported (issue #1602).
      const body = res.json();
      expect(body.projects).toEqual({});
      expect(body.problems[String(projectId)]).toMatchObject({ reason: "failed" });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("reports a checkout flipped to core.bare = true as a bare-repo problem (issue #1602)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-bare-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "core.bare", "true"]);

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-bare-flag",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      const body = res.json();
      expect(body.projects[String(projectId)]).toBeUndefined();
      expect(body.problems[String(projectId)].reason).toBe("bare-repo");
      expect(body.problems[String(projectId)].message).toContain("git config core.bare false");

      const single = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/git-status`,
      });
      expect(single.statusCode).toBe(503);
      expect(single.json().message).toContain("core.bare");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("omits a project on an unreachable remote host from the response", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "batch-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, name: "batch-remote", cwd: "/x", hostId: host.json().id },
      });
      const projectId = project.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      // Remote host unreachable — project omitted from response.
      expect(res.json()).toEqual({ projects: {}, sessions: {}, problems: {} });

      await app.close();
    });

    describe("remote host git status problems (issue #1612)", () => {
      async function remoteProject(app: FastifyInstance) {
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "problem-host", baseUrl: "http://127.0.0.1:1", token: "t" },
        });
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            name: "remote-problem",
            cwd: "/x",
            hostId: host.json().id,
          },
        });
        return project.json().id as number;
      }
      const stubAgent = (body: unknown) =>
        vi.stubGlobal(
          "fetch",
          vi.fn().mockImplementation(
            async () =>
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          ),
        );
      const problem = { reason: "bare-repo", message: "core.bare = true on the agent" };

      afterEach(() => vi.unstubAllGlobals());

      it("reports the agent's problem in the batch and the per-project 503", async () => {
        const app = await buildApp();
        const projectId = await remoteProject(app);
        stubAgent({ isRepo: true, status: null, problem });

        const batch = await app.inject({
          method: "GET",
          url: `/api/projects/git-statuses?ids=${projectId}`,
        });
        expect(batch.json()).toEqual({
          projects: {},
          sessions: {},
          problems: { [String(projectId)]: problem },
        });

        const single = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/git-status`,
        });
        expect(single.statusCode).toBe(503);
        expect(single.json().message).toBe(problem.message);
        await app.close();
      });

      it("falls back to the generic text when an older agent sends no problem", async () => {
        const app = await buildApp();
        const projectId = await remoteProject(app);
        stubAgent({ isRepo: true, status: null });

        const batch = await app.inject({
          method: "GET",
          url: `/api/projects/git-statuses?ids=${projectId}`,
        });
        expect(batch.json().problems).toEqual({});

        const single = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/git-status`,
        });
        expect(single.statusCode).toBe(503);
        expect(single.json().message).toBe("git status is temporarily unavailable");
        await app.close();
      });
    });

    it("handles a mix of repo, non-repo, and transient-failure projects", async () => {
      const { execFileSync } = await import("node:child_process");
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-mix-repo-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
      fs.writeFileSync(path.join(repoDir, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: repoDir,
        stdio: "pipe",
        env: gitEnv(),
      });

      const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-mix-nonrepo-"));

      const app = await buildApp();
      const repo = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "batch-mix-repo", cwd: repoDir },
      });
      const nonRepo = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-mix-nonrepo",
          cwd: nonRepoDir,
        },
      });
      const repoId = repo.json().id as number;
      const nonRepoId = nonRepo.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${repoId},${nonRepoId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.projects[String(repoId)]).toMatchObject({ branch: "main", isClean: true });
      expect(body.projects[String(nonRepoId)]).toBeNull();

      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(nonRepoDir, { recursive: true, force: true });
      await app.close();
    });

    it("returns per-session git status for a session's worktree cwd, distinct from its project", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-project-"));
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

      // A real linked worktree on a distinct branch, checked out outside
      // the project's own cwd — exactly the "cwd points outside the
      // project root" shape sessions.cwd allows (see
      // resolveSessionCwdTargets's own doc comment). `git worktree add`
      // requires a path that doesn't exist yet, so the parent (not the
      // worktree dir itself) is what mkdtempSync creates securely —
      // unlike a Date.now()-suffixed path, this isn't guessable/racy
      // (CodeQL js/insecure-temporary-file).
      const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-worktree-"));
      const worktreeDir = path.join(worktreeParent, "wt");
      execFileSync("git", ["worktree", "add", "-b", "feature/x", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(worktreeDir, "b.txt"), "b");

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-session-project",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", cwd: worktreeDir },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}&sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Project-level status (its own cwd) stays clean/main.
      expect(body.projects[String(projectId)]).toMatchObject({ branch: "main", isClean: true });
      // Session-level status (the worktree's cwd) is a distinct branch with
      // an untracked file — not the same as the project's own status.
      expect(body.sessions[String(sessionId)]).toMatchObject({
        branch: "feature/x",
        isClean: false,
      });

      execFileSync("git", ["worktree", "remove", "--force", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.rmSync(worktreeParent, { recursive: true, force: true });
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("prefers a session's live (OSC-7-announced) cwd over its static launch cwd once one arrives", async () => {
      // Issue: sidebar worktree display. Unlike the worktree test above (a
      // session launched WITH a cwd override), this session is launched with
      // NO cwd override at all — session.cwd stays null, spawned at the
      // project's own root. `app.pty.get(id)?.liveCwd` is stubbed rather than
      // driven through a real spawned shell (this test's actual concern is
      // resolveSessionCwdTargets's merge logic, not PtyManager's OSC-7
      // wiring — already covered by test/services/pty-manager.test.ts's own
      // liveCwd tests — and a real spawn depends on a live systemd --user
      // session, which isn't guaranteed in every test environment).
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-livecwd-project-"));
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

      const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-livecwd-wt-"));
      const worktreeDir = path.join(worktreeParent, "wt");
      execFileSync("git", ["worktree", "add", "-b", "feature/live", worktreeDir], {
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
          name: "batch-session-livecwd-project",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      // No `cwd` in the body — session.cwd stays null, spawned at projectCwd.
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const getSpy = vi
        .spyOn(app.pty, "get")
        .mockReturnValue({ liveCwd: worktreeDir } as ReturnType<typeof app.pty.get>);

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions[String(sessionId)]).toMatchObject({ branch: "feature/live" });

      getSpy.mockRestore();
      execFileSync("git", ["worktree", "remove", "--force", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.rmSync(worktreeParent, { recursive: true, force: true });
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("falls back to the static launch cwd when the live cwd isn't a real git repo", async () => {
      // Guards resolveSessionCwdTargets's isGitRepo gate: a `liveCwd` is
      // parsed straight off the PTY byte stream (stale, mid-typo, or a
      // shell-integration bug), so a bogus value must not be trusted as a
      // `git -C` target — it should silently fall back to the session's
      // static cwd instead, same "nothing to show" posture as this
      // endpoint's other gaps, not a crash or a wrong branch.
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-badlive-project-"));
      const { execFileSync } = await import("node:child_process");
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
          name: "batch-session-badlive-project",
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

      const getSpy = vi
        .spyOn(app.pty, "get")
        .mockReturnValue({ liveCwd: "/definitely/not/a/real/repo" } as ReturnType<
          typeof app.pty.get
        >);

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions[String(sessionId)]).toMatchObject({ branch: "main" });

      getSpy.mockRestore();
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null in the sessions map for a session whose cwd isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-nonrepo-project-"));
      const sessionCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-nonrepo-cwd-"));

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-session-nonrepo",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", cwd: sessionCwd },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions[String(sessionId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(sessionCwd, { recursive: true, force: true });
      await app.close();
    });

    it("falls back to the static launch cwd when the live cwd is a real git repo but NOT one of this project's own worktrees", async () => {
      // Issue: worktree/branch detection — a session's live cwd can now be
      // updated by an agent piggybacking its cwd on every hook event (see
      // forwarder-core.mjs's mapClaudeCodeEvent), which means it can wander
      // into ANY repo the agent happens to visit, not just this project's
      // own worktrees. Unlike the "badlive" test above (a bogus, non-repo
      // path), this uses a genuinely separate, unrelated git repository —
      // isGitRepo() alone would accept it, so this guards the additional
      // "is it actually one of THIS project's own worktrees" check.
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-foreign-project-"));
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

      // A completely separate repository — same shape as isGitRepo would
      // accept, but not reachable from `git worktree list` on projectCwd.
      const foreignRepo = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-foreign-repo-"));
      execFileSync("git", ["init", "-b", "unrelated-branch"], {
        cwd: foreignRepo,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(foreignRepo, "c.txt"), "c");
      execFileSync("git", ["add", "-A"], { cwd: foreignRepo, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: foreignRepo,
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
          name: "batch-session-foreign-project",
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

      const getSpy = vi
        .spyOn(app.pty, "get")
        .mockReturnValue({ liveCwd: foreignRepo } as ReturnType<typeof app.pty.get>);

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      // Falls back to the session's static cwd (the project root, "main"),
      // NOT the foreign repo's "unrelated-branch".
      expect(res.json().sessions[String(sessionId)]).toMatchObject({ branch: "main" });

      getSpy.mockRestore();
      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(foreignRepo, { recursive: true, force: true });
      await app.close();
    });

    it("omits a session with no matching row (already deleted) from the sessions map", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/git-statuses?sessionIds=999999",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {}, problems: {} });
      await app.close();
    });
  });

  describe("GET /api/projects/:id/git-status (issue #76)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/git-status" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "not-a-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns branch/hash/isClean for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-real-"));
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
        payload: { createDir: true, allowDuplicate: true, name: "real-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ branch: "main", isClean: true, hasConflicts: false });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    // Hermes review, PR #506 — the sidebar's Source Control section and
    // Source Control both call this route right after a manual "Fetch" to show
    // the result immediately; without a way to bypass git-status.ts's own
    // ~5s in-memory cache, that call would typically just hand back
    // whatever was cached before the fetch ran.
    it("?fresh=1 bypasses the cache and reflects a change made after the first read", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-fresh-"));
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
          name: "fresh-status-repo",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id;

      const clean = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/git-status`,
      });
      expect(clean.json().isClean).toBe(true);

      // Dirties the tree without touching the cache — a plain (no ?fresh)
      // re-read within CACHE_TTL_MS should still report the stale "clean"
      // read, proving the cache is genuinely in play here.
      fs.writeFileSync(path.join(projectCwd, "b.txt"), "b");
      const stillCached = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/git-status`,
      });
      expect(stillCached.json().isClean).toBe(true);

      const fresh = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/git-status?fresh=1`,
      });
      expect(fresh.json().isClean).toBe(false);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-status-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-git-status",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    // Distinguishes "not a repo" (204, durable) from "is a repo but git
    // status itself failed" (503, transient) — the fix for the sidebar/
    // Source Control flicker: a client that treats 503 as "keep my last-known-good"
    // and only clears to empty on 204 stops flickering on a single failed
    // poll tick.
    it("503s (not 204) for a local project that IS a repo but git status fails transiently", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-transient-"));
      const { execFileSync } = await import("node:child_process");
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
      // Break HEAD so `git status` fails while `.git` still exists — the
      // same technique as git-status.test.ts's own transient-failure test.
      fs.unlinkSync(path.join(projectCwd, ".git", "HEAD"));

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "transiently-broken-repo",
          cwd: projectCwd,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(503);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/:id/git-branches (issue #162)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/git-branches" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "not-a-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns branches and worktrees for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-real-"));
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
      execFileSync("git", ["branch", "feature/foo"], {
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
          name: "real-repo-branches",
          cwd: projectCwd,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches`,
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
      expect(body.branches.every((b: { isMerged?: boolean }) => b.isMerged === undefined)).toBe(
        true,
      );
      expect(body.worktrees).toEqual([{ path: projectCwd, branch: "main", isMain: true }]);
      // Issue #271 follow-up — no remote configured, so there's nothing to
      // resolve a default branch from; `null`, never the literal "HEAD".
      expect(body.defaultBranch).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("resolves defaultBranch from origin/HEAD for the promote/launcher base-ref pickers (issue #271 follow-up)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-default-"));
      const remoteDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "projects-git-branches-default-origin-"),
      );
      const run = (cwd: string, args: string[]) =>
        execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });

      run(remoteDir, ["init", "--bare", "-b", "main"]);
      run(projectCwd, ["init", "-b", "main"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(projectCwd, ["add", "-A"]);
      run(projectCwd, ["commit", "-m", "initial", "--no-verify"]);
      run(projectCwd, ["remote", "add", "origin", remoteDir]);
      run(projectCwd, ["push", "origin", "main"]);
      run(projectCwd, ["remote", "set-head", "origin", "main"]);

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "default-branch-repo",
          cwd: projectCwd,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().defaultBranch).toBe("origin/main");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(remoteDir, { recursive: true, force: true });
      await app.close();
    });

    it("resolves isMerged only when ?detail=1 is set (issue #442)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-detail-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["checkout", "-b", "merged-branch"]);
      run(["checkout", "main"]);
      run(["merge", "merged-branch", "--no-edit"]);
      const remoteDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "projects-git-branches-detail-origin-"),
      );
      execFileSync("git", ["init", "--bare", "-b", "main"], {
        cwd: remoteDir,
        stdio: "pipe",
        env: gitEnv(),
      });
      run(["remote", "add", "origin", remoteDir]);
      run(["push", "-u", "origin", "main"]);

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "detail-repo-branches",
          cwd: projectCwd,
        },
      });

      const withoutDetail = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches`,
      });
      expect(
        withoutDetail
          .json()
          .branches.every((b: { isMerged?: boolean }) => b.isMerged === undefined),
      ).toBe(true);

      const withDetail = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches?detail=1`,
      });
      expect(
        withDetail.json().branches.find((b: { name: string }) => b.name === "merged-branch")
          .isMerged,
      ).toBe(true);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(remoteDir, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-branches-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-git-branches",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });
});
