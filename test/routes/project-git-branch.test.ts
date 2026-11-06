// The branch, fetch and pull routes.
//
// Moved out of test/routes/projects.test.ts (issue #2475), alongside the
// routes themselves: src/routes/project-git-writes.ts. The Git route block
// left projects.ts, and the test tree mirrors the source tree.
//
// A branch refusal is a 200 with a reason (GitBranchOpResult), never a
// 4xx — the dirty-tree, conflict and branch-state guards live in
// git-branch-ops.ts, and the one that needs the DB runs in the route.

import type { FastifyInstance } from "fastify";
import { describe, it, expect, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment for
// the empirically confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as HermesReview from "../../src/services/hermes-review.js";
import type * as TaskReconciler from "../../src/services/task-reconciler.js";

// The relay's landed-check memo (issue #1630) — cleared per test so one
// test's answer is not the next one's.
import { gitEnv } from "../../src/services/git-env.js";

import { resolveGitHubToken } from "../../src/services/github-integration.js";

import { uniqueSessionsDir } from "../helpers/sessions-dir.js";

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
  describe("POST /api/projects/:id/git-fetch (issue #442 — previously untested)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/projects/999999/git-fetch" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("runs git fetch for a real local repo with no remote configured, reporting success: false", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-fetch-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "fetch-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${created.json().id}/git-fetch`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({ success: expect.any(Boolean) as boolean }),
      );

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-fetch-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-git-fetch",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-fetch`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("POST /api/projects/:id/git-pull (issue #745)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/projects/999999/git-pull" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("runs git pull for a real local repo and returns a GitPullResult", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-pull-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "pull-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${created.json().id}/git-pull`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({ pulled: expect.any(Boolean) as boolean }),
      );

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-pull-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-git-pull",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-pull`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("POST /api/projects/:id/git-branch-delete (issue #442)", () => {
    async function makeProjectWithBranch(app: FastifyInstance) {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-branch-delete-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["branch", "feature-x"]);

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "branch-delete-repo",
          cwd: projectCwd,
        },
      });
      return { projectCwd, projectId: created.json().id as number };
    }

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/999999/git-branch-delete",
        payload: { name: "main" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    // Hermes review on PR #505 — schema-level defense-in-depth.
    it("400s for a name exceeding the schema's maxLength", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithBranch(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-branch-delete`,
        payload: { name: "x".repeat(256) },
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("200s and deletes a branch for a real local git repo", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithBranch(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-branch-delete`,
        payload: { name: "feature-x" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: true });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("200s with a refusal reason (current-branch), not a 4xx, for a git-level refusal", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithBranch(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-branch-delete`,
        payload: { name: "main" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: false, reason: "current-branch" });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("refuses with reason task-branch when a resumable task claims the branch, and force overrides it", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithBranch(app);
      const { tasks } = await import("../../src/db/schema.js");
      app.db
        .insert(tasks)
        .values({
          projectId,
          title: "in-flight task",
          status: "in_progress",
          branchName: "feature-x",
        })
        .run();

      const refused = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-branch-delete`,
        payload: { name: "feature-x" },
      });
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toEqual({
        deleted: false,
        reason: "task-branch",
        detail: expect.stringMatching(/^#\d+$/) as string,
      });

      const forced = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-branch-delete`,
        payload: { name: "feature-x", force: true },
      });
      expect(forced.statusCode).toBe(200);
      expect(forced.json()).toEqual({ deleted: true });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "branch-delete-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-branch-delete",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-branch-delete`,
        payload: { name: "main" },
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    it("deletes a branch on a remote-hosted project via the agent (full round trip)", async () => {
      const { execFileSync } = await import("node:child_process");
      const remoteCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-branch-delete-remote-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: remoteCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(remoteCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["branch", "feature-remote"]);

      const AGENT_TOKEN = "branch-delete-remote-agent-token";
      const prevEnv: Record<string, string | undefined> = {};
      const agentEnv = {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: AGENT_TOKEN,
        PROJECTS_ROOTS: os.tmpdir(),
        SESSIONS_DIR: uniqueSessionsDir("projects"),
      };
      for (const key of Object.keys(agentEnv)) {
        prevEnv[key] = process.env[key];
        process.env[key] = agentEnv[key as keyof typeof agentEnv];
      }
      const agentApp = await buildApp();
      for (const key of Object.keys(agentEnv)) {
        if (prevEnv[key] === undefined) delete process.env[key];
        else process.env[key] = prevEnv[key];
      }
      await agentApp.listen({ port: 0, host: "127.0.0.1" });
      const address = agentApp.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }

      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "branch-delete-remote-success-host",
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: AGENT_TOKEN,
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-branch-delete-success",
          cwd: remoteCwd,
          hostId: host.json().id,
        },
      });

      const res = await primary.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-branch-delete`,
        payload: { name: "feature-remote" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: true });

      fs.rmSync(remoteCwd, { recursive: true, force: true });
      await primary.close();
      await agentApp.close();
    });
  });

  describe("A3 — branch detail, squash-aware merge state and local prune", () => {
    const sh = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env: {
          ...gitEnv(),
          GIT_AUTHOR_NAME: "T",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "T",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      }).trim();
    const realResolve = vi.mocked(resolveGitHubToken).getMockImplementation()!;
    const pr = (number: number, headRef: string, headSha: string, mergedAt: string | null) => ({
      number,
      htmlUrl: `https://github.com/o/r/pull/${number}`,
      headRef,
      headSha,
      headRepo: "o/r",
      baseRef: "main",
      mergedAt,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const commitFile = (dir: string, file: string, message: string) => {
      fs.writeFileSync(path.join(dir, file), file);
      sh(dir, "add", ".");
      sh(dir, "commit", "-q", "-m", message);
    };

    async function setup() {
      const app = await buildApp();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prune-"));
      sh(dir, "init", "-q", "-b", "main");
      commitFile(dir, "a.txt", "initial");
      sh(dir, "remote", "add", "origin", "https://github.com/o/r.git");
      sh(dir, "update-ref", "refs/remotes/origin/main", "main");
      sh(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      sh(dir, "branch", "anc");
      sh(dir, "branch", "claimed");
      sh(dir, "branch", "inwt");
      const wt = `${dir}-wt`;
      sh(dir, "worktree", "add", wt, "inwt");
      // upstream deleted on the remote: tracking config, no remote ref
      sh(dir, "checkout", "-q", "-b", "gone");
      commitFile(dir, "g.txt", "gone work");
      sh(dir, "config", "branch.gone.remote", "origin");
      sh(dir, "config", "branch.gone.merge", "refs/heads/gone");
      // its commit still lives on some other remote ref, so nothing is lost
      sh(dir, "update-ref", "refs/remotes/origin/elsewhere", "gone");
      // upstream gone AND a commit no remote has: must never be a candidate
      sh(dir, "checkout", "-q", "-b", "gone-unpushed", "main");
      commitFile(dir, "u.txt", "unpushed work");
      sh(dir, "config", "branch.gone-unpushed.remote", "origin");
      sh(dir, "config", "branch.gone-unpushed.merge", "refs/heads/gone-unpushed");
      // squash-merged on GitHub: unique commit, PR head sha == tip
      sh(dir, "checkout", "-q", "-b", "squashed", "main");
      commitFile(dir, "s.txt", "squashed work");
      const squashedSha = sh(dir, "rev-parse", "HEAD");
      // name reused after a merge: PR head sha differs from the tip
      sh(dir, "checkout", "-q", "-b", "reused", "main");
      commitFile(dir, "r.txt", "reused work");
      // closed unmerged
      sh(dir, "checkout", "-q", "-b", "abandoned", "main");
      commitFile(dir, "x.txt", "abandoned work");
      const abandonedSha = sh(dir, "rev-parse", "HEAD");
      sh(dir, "checkout", "-q", "main");

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "prune", cwd: dir },
      });
      const id = created.json().id as number;
      const { tasks } = await import("../../src/db/schema.js");
      app.db
        .insert(tasks)
        .values({ projectId: id, title: "t", status: "in_progress", branchName: "claimed" })
        .run();

      vi.mocked(resolveGitHubToken).mockResolvedValue("tok");
      const githubWrite = await import("../../src/services/github-write.js");
      const { clearMergedPrsCacheForTests } =
        await import("../../src/services/github-merged-prs.js");
      clearMergedPrsCacheForTests();
      const list = vi
        .spyOn(githubWrite, "listClosedPullRequests")
        .mockResolvedValue([
          pr(11, "squashed", squashedSha, "2026-01-01T00:00:00Z"),
          pr(12, "reused", "f".repeat(40), "2026-01-01T00:00:00Z"),
          pr(13, "abandoned", abandonedSha, null),
          { ...pr(14, "anc", "e".repeat(40), "2026-01-01T00:00:00Z"), headRepo: "fork/r" },
        ]);
      const cleanup = async () => {
        list.mockRestore();
        vi.mocked(resolveGitHubToken).mockImplementation(realResolve);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(wt, { recursive: true, force: true });
        await app.close();
      };
      return { app, dir, id, wt, list, cleanup };
    }

    it("lists mergeState and pr per branch with one GitHub listing, not one per branch", async () => {
      const { app, id, list, cleanup } = await setup();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${id}/git-branches?detail=1`,
      });
      const byName = Object.fromEntries(
        (res.json().branches as Array<Record<string, unknown>>).map((b) => [b.name as string, b]),
      );
      expect(byName.anc.mergeState).toBe("ancestor");
      expect(byName.gone.mergeState).toBe("upstream-gone");
      expect(byName.squashed).toMatchObject({
        mergeState: "pr-merged",
        pr: { number: 11, state: "merged" },
      });
      expect(byName.abandoned).toMatchObject({ mergeState: "pr-closed", pr: { state: "closed" } });
      // a reused name (sha mismatch) and a fork's head never count
      expect(byName.reused.mergeState).toBeUndefined();
      expect(byName.reused.pr).toBeUndefined();
      expect(byName.anc.pr).toBeUndefined();
      expect(list).toHaveBeenCalledTimes(1);
      await cleanup();
    });

    it("dry-run reports candidates and guarded skips, deleting nothing", async () => {
      const { app, dir, id, cleanup } = await setup();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/git-branch-prune`,
        payload: { dryRun: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.dryRun).toBe(true);
      expect(body.candidates).toEqual(
        expect.arrayContaining([
          { name: "anc", reason: "ancestor" },
          { name: "gone", reason: "upstream-gone" },
          { name: "squashed", reason: "pr-merged" },
        ]),
      );
      const names = body.candidates.map((c: { name: string }) => c.name);
      expect(names).not.toContain("abandoned");
      expect(names).not.toContain("reused");
      expect(names).not.toContain("gone-unpushed");
      expect(body.skipped).toEqual(
        expect.arrayContaining([
          { name: "inwt", why: "worktree" },
          { name: "claimed", why: "task-claimed" },
        ]),
      );
      expect(sh(dir, "branch", "--list", "squashed")).toContain("squashed");
      await cleanup();
    });

    it("confirm deletes candidates locally and refuses every guard", async () => {
      const { app, dir, id, cleanup } = await setup();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/git-branch-prune`,
        payload: {
          confirm: true,
          names: ["anc", "gone", "squashed", "inwt", "claimed", "main", "abandoned", "nope"],
        },
      });
      const body = res.json();
      expect([...body.deleted].sort()).toEqual(["anc", "gone", "squashed"]);
      expect(body.failed).toEqual(
        expect.arrayContaining([
          { name: "inwt", why: "worktree" },
          { name: "claimed", why: "task-claimed" },
          { name: "abandoned", why: "not-prunable" },
          { name: "nope", why: "not-prunable" },
          { name: "main", why: "not-prunable" },
        ]),
      );
      expect(sh(dir, "branch", "--list", "main")).toContain("main");
      expect(sh(dir, "branch", "--list", "inwt")).toContain("inwt");
      expect(sh(dir, "branch", "--list", "squashed")).toBe("");
      await cleanup();
    });

    it("re-validates a pr-merged branch server-side: a GitHub failure leaves it alone", async () => {
      const { app, dir, id, list, cleanup } = await setup();
      list.mockRejectedValue(new Error("boom"));
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/git-branch-prune`,
        payload: { confirm: true, names: ["squashed", "anc"] },
      });
      expect(res.json().deleted).toEqual(["anc"]);
      expect(res.json().failed).toEqual([{ name: "squashed", why: "not-prunable" }]);
      expect(sh(dir, "branch", "--list", "squashed")).toContain("squashed");
      await cleanup();
    });

    it("never deletes without an explicit confirm, even with dryRun:false or names", async () => {
      const { app, dir, id, cleanup } = await setup();
      for (const payload of [
        { dryRun: false, names: ["anc"] },
        { dryRun: true, confirm: true, names: ["anc"] },
      ]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/git-branch-prune`,
          payload,
        });
        expect(res.json()).toMatchObject({ dryRun: true, deleted: [] });
      }
      expect(sh(dir, "branch", "--list", "anc")).toContain("anc");
      const dup = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/git-branch-prune`,
        payload: { confirm: true, names: ["anc", "anc"] },
      });
      expect(dup.statusCode).toBe(400);
      await cleanup();
    });

    it("rejects confirm without names and 404s an unknown project", async () => {
      const { app, id, cleanup } = await setup();
      const bad = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/git-branch-prune`,
        payload: { confirm: true },
      });
      expect(bad.statusCode).toBe(400);
      const missing = await app.inject({
        method: "POST",
        url: "/api/projects/999999/git-branch-prune",
        payload: {},
      });
      expect(missing.statusCode).toBe(404);
      await cleanup();
    });

    it("GET git-branch returns base counts, unique commits, worktree, task and pr", async () => {
      const { app, id, wt, cleanup } = await setup();
      const get = (name: string) =>
        app.inject({
          method: "GET",
          url: `/api/projects/${id}/git-branch?name=${encodeURIComponent(name)}`,
        });
      const squashed = (await get("squashed")).json();
      expect(squashed).toMatchObject({
        name: "squashed",
        base: "origin/main",
        baseAhead: 1,
        baseBehind: 0,
        mergeState: "pr-merged",
        pr: { number: 11 },
        worktreePath: null,
        taskId: null,
      });
      expect(squashed.uniqueCommits).toHaveLength(1);
      expect(squashed.uniqueCommits[0].subject).toBe("squashed work");
      expect(squashed.lastCommit.subject).toBe("squashed work");
      expect((await get("gone")).json()).toMatchObject({ upstreamGone: true });
      expect((await get("inwt")).json().worktreePath).toBe(wt);
      expect((await get("claimed")).json().taskId).toEqual(expect.any(Number));
      expect((await get("main")).json().isCurrent).toBe(true);
      expect((await get("missing")).statusCode).toBe(404);
      expect((await get("-bad")).statusCode).toBe(400);
      const none = await app.inject({ method: "GET", url: `/api/projects/${id}/git-branch` });
      expect(none.statusCode).toBe(400);
      await cleanup();
    });

    it("git-log scope=branch:<name> walks only that branch", async () => {
      const { app, id, cleanup } = await setup();
      const ok = await app.inject({
        method: "GET",
        url: `/api/projects/${id}/git-log?scope=${encodeURIComponent("branch:squashed")}`,
      });
      expect(ok.statusCode).toBe(200);
      const subjects = ok.json().commits.map((c: { subject: string }) => c.subject);
      expect(subjects).toEqual(["squashed work", "initial"]);
      const bad = await app.inject({
        method: "GET",
        url: `/api/projects/${id}/git-log?scope=${encodeURIComponent("branch:--all")}`,
      });
      expect(bad.statusCode).toBe(400);
      await cleanup();
    });
  });

  describe("POST /api/projects/:id/git-checkout, git-branch-create, git-rebase (issue #1672)", () => {
    async function makeProject(app: FastifyInstance) {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-branch-ops-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["branch", "feature"]);
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "branch-ops-repo",
          cwd: projectCwd,
        },
      });
      return { projectCwd, projectId: created.json().id as number, run };
    }

    const post = (app: FastifyInstance, url: string, payload: object) =>
      app.inject({ method: "POST", url, payload });

    it("404s an unknown project and 400s a malformed body", async () => {
      const app = await buildApp();
      try {
        expect(
          (await post(app, "/api/projects/999999/git-checkout", { branch: "main" })).statusCode,
        ).toBe(404);
        expect((await post(app, "/api/projects/1/git-checkout", {})).statusCode).toBe(400);
        expect(
          (await post(app, "/api/projects/1/git-branch-create", { name: "x" })).statusCode,
        ).toBe(400);
        expect(
          (await post(app, "/api/projects/1/git-rebase", { onto: "x".repeat(256) })).statusCode,
        ).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("checks out, creates and rebases on a local project", async () => {
      const app = await buildApp();
      const { projectCwd, projectId, run } = await makeProject(app);
      try {
        const checkout = await post(app, `/api/projects/${projectId}/git-checkout`, {
          branch: "feature",
        });
        expect(checkout.json()).toEqual({ ok: true });

        const created = await post(app, `/api/projects/${projectId}/git-branch-create`, {
          name: "topic",
          from: "main",
          checkout: true,
        });
        expect(created.json()).toEqual({ ok: true });

        const rebased = await post(app, `/api/projects/${projectId}/git-rebase`, { onto: "main" });
        expect(rebased.json()).toEqual({ ok: true, reason: "already-up-to-date", detail: "main" });
        expect(String(run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("topic");
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("refuses while an active session works in the checkout, but not one in a linked worktree", async () => {
      const app = await buildApp();
      const { projectCwd, projectId, run } = await makeProject(app);
      const { sessions } = await import("../../src/db/schema.js");
      try {
        // A session in a linked worktree under the checkout has its own HEAD.
        // Ignored, as a real repo ignores its `.wt/` — or it reads as untracked.
        fs.appendFileSync(path.join(projectCwd, ".git", "info", "exclude"), ".wt/\n");
        const linked = path.join(projectCwd, ".wt", "other");
        run(["worktree", "add", "-q", "-b", "other", linked]);
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: linked }).run();
        expect(
          (
            await post(app, `/api/projects/${projectId}/git-checkout`, { branch: "feature" })
          ).json(),
        ).toEqual({ ok: true });

        // One with no cwd of its own runs in the checkout itself.
        const inCheckout = app.db
          .insert(sessions)
          .values({ projectId, command: "bash", cwd: null })
          .run();
        const sessionId = Number(inCheckout.lastInsertRowid);
        const blocked = { ok: false, reason: "sessions-active", detail: String(sessionId) };
        expect(
          (await post(app, `/api/projects/${projectId}/git-checkout`, { branch: "main" })).json(),
        ).toEqual(blocked);
        expect((await post(app, `/api/projects/${projectId}/git-rebase`, {})).json()).toEqual(
          blocked,
        );
        expect(
          (
            await post(app, `/api/projects/${projectId}/git-branch-create`, {
              name: "t2",
              from: "main",
              checkout: true,
            })
          ).json(),
        ).toEqual(blocked);
        // Creating without switching moves nothing, so it is allowed.
        expect(
          (
            await post(app, `/api/projects/${projectId}/git-branch-create`, {
              name: "t3",
              from: "main",
            })
          ).json(),
        ).toEqual({ ok: true });
        expect(String(run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature");
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("counts a session of another project row on the same checkout", async () => {
      const app = await buildApp();
      const { projectCwd, projectId, run } = await makeProject(app);
      const { sessions } = await import("../../src/db/schema.js");
      try {
        const twin = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { allowDuplicate: true, name: "branch-ops-twin", cwd: projectCwd },
        });
        const twinId = twin.json().id as number;
        const inserted = app.db
          .insert(sessions)
          .values({ projectId: twinId, command: "bash", cwd: null })
          .run();
        expect(
          (
            await post(app, `/api/projects/${projectId}/git-checkout`, { branch: "feature" })
          ).json(),
        ).toEqual({
          ok: false,
          reason: "sessions-active",
          detail: String(Number(inserted.lastInsertRowid)),
        });
        expect(String(run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("guards a project rooted in a linked worktree like any other checkout", async () => {
      const app = await buildApp();
      const { projectCwd, run } = await makeProject(app);
      const { sessions } = await import("../../src/db/schema.js");
      try {
        const linked = path.join(projectCwd, "..", `${path.basename(projectCwd)}-wt`);
        run(["worktree", "add", "-q", "-b", "wt-branch", linked]);
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { allowDuplicate: true, name: "branch-ops-in-worktree", cwd: linked },
        });
        const id = project.json().id as number;
        const inserted = app.db
          .insert(sessions)
          .values({ projectId: id, command: "bash", cwd: linked })
          .run();
        expect(
          (await post(app, `/api/projects/${id}/git-checkout`, { branch: "feature" })).json(),
        ).toEqual({
          ok: false,
          reason: "sessions-active",
          detail: String(Number(inserted.lastInsertRowid)),
        });
        fs.rmSync(linked, { recursive: true, force: true });
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("refuses while another git operation holds the clone", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProject(app);
      const { markCloneBusy, releaseClone } = await import("../../src/services/git-clone-busy.js");
      markCloneBusy("local", projectCwd);
      try {
        const res = await post(app, `/api/projects/${projectId}/git-checkout`, {
          branch: "feature",
        });
        expect(res.json()).toMatchObject({ ok: false, reason: "busy" });
      } finally {
        releaseClone("local", projectCwd);
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    async function remoteProject(app: FastifyInstance, baseUrl: string) {
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: `branch-ops-host-${baseUrl.length}`, baseUrl, token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-branch-ops",
          cwd: "/x",
          hostId: host.json().id,
        },
      });
      return project.json().id as number;
    }

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      try {
        const id = await remoteProject(app, "http://127.0.0.1:1");
        const res = await post(app, `/api/projects/${id}/git-rebase`, {});
        expect(res.statusCode).toBe(503);
      } finally {
        await app.close();
      }
    });

    it("runs on the owning agent for a remote project", async () => {
      const app = await buildApp();
      const calls: Array<[string, unknown]> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          const { pathname } = new URL(url);
          calls.push([pathname, init?.body ? JSON.parse(String(init.body)) : undefined]);
          const body =
            pathname === "/internal/git-branches"
              ? { branches: [], worktrees: [], remoteBranches: [] }
              : { ok: false, reason: "conflicts", detail: "origin/main", conflicts: ["a.txt"] };
          return Promise.resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      );
      try {
        const id = await remoteProject(app, "http://agent.invalid:9");
        const res = await post(app, `/api/projects/${id}/git-rebase`, { onto: "origin/main" });
        expect(res.json()).toEqual({
          ok: false,
          reason: "conflicts",
          detail: "origin/main",
          conflicts: ["a.txt"],
        });
        expect(calls).toContainEqual(["/internal/git-rebase", { cwd: "/x", onto: "origin/main" }]);
      } finally {
        vi.unstubAllGlobals();
        await app.close();
      }
    });
  });
});
