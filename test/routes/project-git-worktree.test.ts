// The worktree remove and prune routes.
//
// Moved out of test/routes/projects.test.ts (issue #2475), alongside the
// routes themselves: src/routes/project-git-writes.ts. The Git route block
// left projects.ts, and the test tree mirrors the source tree.
//
// Remove deletes a listed worktree; prune clears administrative metadata
// for worktrees whose directory is already gone. Neither removes a
// worktree that still exists on disk.

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
import type { SessionBackend } from "../../src/services/session-backend.js";
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
  describe("POST /api/projects/:id/git-worktree-remove (issue #442)", () => {
    async function makeProjectWithWorktree(app: FastifyInstance) {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-worktree-remove-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      const worktreePath = path.join(projectCwd, ".mullion-worktrees", "hand-made");
      run(["worktree", "add", "-b", "hand-made-branch", worktreePath, "main"]);

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "worktree-remove-repo",
          cwd: projectCwd,
        },
      });
      return { projectCwd, worktreePath, projectId: created.json().id as number };
    }

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/999999/git-worktree-remove",
        payload: { worktreePath: "/tmp/x" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    // Hermes review on PR #505 — schema-level defense-in-depth.
    it("400s for a worktreePath exceeding the schema's maxLength", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithWorktree(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath: `/${"x".repeat(4096)}` },
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("200s and removes a clean, hand-made worktree", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("200s with reason is-main for the project's own cwd, never sessions-active", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      // An active session under the project's own cwd — if the live-session
      // guard ran unconditionally, this would report "sessions-active"
      // instead of the more specific "is-main" the service itself reports.
      app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run();

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath: projectCwd },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: false, reason: "is-main" });
      expect(fs.existsSync(projectCwd)).toBe(true);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("refuses with reason sessions-active when a live session's cwd is under the worktree, and force overrides it", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const sessionInsert = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: worktreePath })
        .run();
      const sessionId = Number(sessionInsert.lastInsertRowid);

      const refused = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath },
      });
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toEqual({
        removed: false,
        reason: "sessions-active",
        detail: String(sessionId),
      });
      expect(fs.existsSync(worktreePath)).toBe(true);

      const forced = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath, force: true },
      });
      expect(forced.statusCode).toBe(200);
      expect(forced.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it.each(["active", "alive", "unknown"] as const)(
      "guards a cross-project session that is %s, with a force override",
      async (state) => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const { projects, sessions } = await import("../../src/db/schema.js");
        const otherProjectId = Number(
          app.db
            .insert(projects)
            .values({
              name: "other-worktree-project",
              cwd: worktreePath,
            })
            .run().lastInsertRowid,
        );
        const sessionId = Number(
          app.db
            .insert(sessions)
            .values({
              projectId: otherProjectId,
              command: "bash",
              cwd: worktreePath,
              status: state === "active" ? "active" : "killed",
            })
            .run().lastInsertRowid,
        );
        const liveness = vi.spyOn(app.pty, "isMasterAliveStateBatch").mockResolvedValue({
          [String(sessionId)]: state === "active" ? "dead" : state,
        });
        try {
          const refused = await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/git-worktree-remove`,
            payload: { worktreePath },
          });
          expect(refused.json()).toEqual({
            removed: false,
            reason: "sessions-active",
            detail: String(sessionId),
          });
          expect(fs.existsSync(worktreePath)).toBe(true);
          const forced = await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/git-worktree-remove`,
            payload: { worktreePath, force: true },
          });
          expect(forced.json()).toEqual({ removed: true });
        } finally {
          liveness.mockRestore();
          fs.rmSync(projectCwd, { recursive: true, force: true });
          await app.close();
        }
      },
    );

    it("guards a session using a symlink alias to the worktree", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const alias = path.join(projectCwd, "alias");
      fs.symlinkSync(worktreePath, alias);
      const { projects, sessions } = await import("../../src/db/schema.js");
      const otherId = Number(
        app.db.insert(projects).values({ name: "alias-project", cwd: alias }).run().lastInsertRowid,
      );
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId: otherId, command: "bash", cwd: alias }).run()
          .lastInsertRowid,
      );
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(sessionId),
        });
        expect(fs.existsSync(worktreePath)).toBe(true);
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("reports an unresolvable session path and permits force", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const loop = path.join(projectCwd, "loop");
      fs.symlinkSync(loop, loop);
      const { projects, sessions } = await import("../../src/db/schema.js");
      const otherId = Number(
        app.db.insert(projects).values({ name: "unknown-path-project", cwd: loop }).run()
          .lastInsertRowid,
      );
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId: otherId, command: "bash", cwd: loop }).run()
          .lastInsertRowid,
      );
      try {
        const refused = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(refused.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(sessionId),
        });
        const forced = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, force: true },
        });
        expect(forced.json()).toEqual({ removed: true });
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("does not block on a session in a sibling with the same path prefix", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const sibling = `${worktreePath}-other`;
      fs.mkdirSync(sibling);
      const { sessions } = await import("../../src/db/schema.js");
      app.db.insert(sessions).values({ projectId, command: "bash", cwd: sibling }).run();
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.json()).toEqual({ removed: true });
        expect(fs.existsSync(sibling)).toBe(true);
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("detects a session started while paths are being resolved", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run();
      let addedId = 0;
      const realpath = fs.promises.realpath.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, "realpath").mockImplementation(async (p, options) => {
        if (p === projectCwd && !addedId) {
          addedId = Number(
            app.db.insert(sessions).values({ projectId, command: "bash", cwd: worktreePath }).run()
              .lastInsertRowid,
          );
        }
        return realpath(p, options as never) as Promise<string>;
      });
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(addedId).toBeGreaterThan(0);
        expect(res.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(addedId),
        });
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("reports a host rejection from the session liveness check accurately", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const { HostRequestError } = await import("../../src/services/remote-host-client.js");
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: worktreePath, status: "killed" })
        .run();
      const spy = vi
        .spyOn(app.pty, "isMasterAliveStateBatch")
        .mockRejectedValue(new HostRequestError("local", 401, ""));
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.statusCode).toBe(503);
        expect(res.json().message).toContain("agent token");
        expect(fs.existsSync(worktreePath)).toBe(true);
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("treats a changing live cwd as an uncertain session instead of failing the request", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run()
          .lastInsertRowid,
      );
      const spy = vi.spyOn(app.pty, "list");
      spy
        .mockReturnValue([{ id: String(sessionId), liveCwd: worktreePath }] as ReturnType<
          typeof app.pty.list
        >)
        .mockReturnValueOnce([]);
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(sessionId),
        });
        expect(fs.existsSync(worktreePath)).toBe(true);
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("treats a live cwd that keeps changing as uncertain", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run()
          .lastInsertRowid,
      );
      let calls = 0;
      const spy = vi
        .spyOn(app.pty, "list")
        .mockImplementation(
          () =>
            [
              { id: String(sessionId), liveCwd: ++calls % 2 ? projectCwd : worktreePath },
            ] as ReturnType<typeof app.pty.list>,
        );
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(sessionId),
        });
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("does not retain a live cwd after its PTY exits during the check", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run()
          .lastInsertRowid,
      );
      const spy = vi
        .spyOn(app.pty, "list")
        .mockReturnValue([])
        .mockReturnValueOnce([{ id: String(sessionId), liveCwd: worktreePath }] as ReturnType<
          typeof app.pty.list
        >);
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.json()).toEqual({ removed: true });
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("does not block for a changed live cwd outside the worktree", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run()
          .lastInsertRowid,
      );
      const spy = vi.spyOn(app.pty, "list");
      spy
        .mockReturnValue([{ id: String(sessionId), liveCwd: projectCwd }] as ReturnType<
          typeof app.pty.list
        >)
        .mockReturnValueOnce([]);
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.json(), JSON.stringify(res.json())).toEqual({ removed: true });
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("does not report sessions-active for a done task's stale worktreePath reference (independent review, PR #505)", async () => {
      // sessionsUnderWorktree's task-row match must share the same
      // RESUMABLE_TASK_STATUSES scope branchClaimedByResumableTask already
      // has — tasks.worktreePath is never nulled on a done/cancelled
      // transition, so without this scope a long-finished task would
      // forever misreport an exited session as "active" here.
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { tasks, sessions } = await import("../../src/db/schema.js");
      const sessionInsert = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: projectCwd, status: "exited" })
        .run();
      const sessionId = Number(sessionInsert.lastInsertRowid);
      app.db
        .insert(tasks)
        .values({
          projectId,
          title: "finished task",
          status: "done",
          worktreePath,
          sessionId,
        })
        .run();

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "worktree-remove-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-worktree-remove",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-worktree-remove`,
        payload: { worktreePath: "/x/.mullion-worktrees/foo" },
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    // Issue #2026 — Settings → Storage's "Kept session worktrees": removal of
    // an ended session's own worktree, which may be on another host and was
    // cut from `worktreeRepoCwd`, not necessarily `project.cwd`.
    describe("with a sessionId", () => {
      async function insertOwner(
        app: FastifyInstance,
        values: {
          projectId: number;
          cwd: string;
          repoCwd: string;
          hostId?: string | null;
          status?: "active" | "killed" | "exited";
        },
      ) {
        const { sessions } = await import("../../src/db/schema.js");
        const inserted = app.db
          .insert(sessions)
          .values({
            projectId: values.projectId,
            command: "bash",
            cwd: values.cwd,
            hostId: values.hostId ?? null,
            status: values.status ?? "exited",
            worktreeBranch: "mullion/session-x",
            worktreeRepoCwd: values.repoCwd,
            worktreeKeptReason: "unpushed",
          })
          .run();
        return Number(inserted.lastInsertRowid);
      }

      async function readOwner(app: FastifyInstance, id: number) {
        const { sessions } = await import("../../src/db/schema.js");
        const { eq } = await import("drizzle-orm");
        return app.db.select().from(sessions).where(eq(sessions.id, id)).all()[0];
      }

      it("removes the session's local worktree and marks it reclaimed", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        vi.spyOn(app.pty, "isMasterAliveStateBatch").mockResolvedValue({
          [String(ownerId)]: "dead",
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(res.json()).toEqual({ removed: true });
        expect(fs.existsSync(worktreePath)).toBe(false);
        const row = await readOwner(app, ownerId);
        expect(row.worktreeReclaimedAt).toBeInstanceOf(Date);
        expect(row.worktreeKeptReason).toBeNull();

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("refuses while the owning session's process is still alive, and force overrides it", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
          status: "killed",
        });
        vi.spyOn(app.pty, "isMasterAliveStateBatch").mockResolvedValue({
          [String(ownerId)]: "alive",
        });

        const refused = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(refused.json()).toEqual({
          removed: false,
          reason: "still-running",
          detail: "alive",
        });
        expect(fs.existsSync(worktreePath)).toBe(true);
        expect((await readOwner(app, ownerId)).worktreeReclaimedAt).toBeNull();

        const forced = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId, force: true },
        });
        expect(forced.json()).toEqual({ removed: true });
        expect((await readOwner(app, ownerId)).worktreeReclaimedAt).toBeInstanceOf(Date);

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("runs on the session's host against worktreeRepoCwd, with the live-session guard", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "kept-worktree-remote", baseUrl: "http://127.0.0.1:1", token: "t" },
        });
        const remoteHostId = host.json().id as string;
        // A LOCAL project whose session was placed on the remote host.
        const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-kept-remote-"));
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { allowDuplicate: true, name: "kept-remote", cwd: projectCwd },
        });
        const projectId = project.json().id as number;
        const repoCwd = "/remote/checkout";
        const worktreePath = "/remote/checkout/.mullion-worktrees/mullion-session-x";
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd,
          hostId: remoteHostId,
        });

        const removeListedWorktree = vi.fn().mockResolvedValue({ removed: true });
        const liveness = vi.fn(async (ids: string[]) =>
          Object.fromEntries(ids.map((id) => [id, "dead"])),
        );
        const compareWorktreePaths = vi.fn(
          async (_target: string, candidates: { cwd: string | null }[]) =>
            candidates.map((candidate) =>
              candidate.cwd === "/remote/alias" ? "inside" : "outside",
            ),
        );
        const resolveBackendSpy = vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
          removeListedWorktree,
          liveness,
          compareWorktreePaths,
        } as unknown as SessionBackend);

        // Another session still active inside the worktree, through an alias on that host.
        const { sessions } = await import("../../src/db/schema.js");
        const sibling = app.db
          .insert(sessions)
          .values({ projectId, command: "bash", cwd: "/remote/alias", hostId: remoteHostId })
          .run();
        const guarded = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(guarded.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(sibling.lastInsertRowid),
        });
        expect(removeListedWorktree).not.toHaveBeenCalled();

        const { eq } = await import("drizzle-orm");
        app.db
          .update(sessions)
          .set({ status: "exited" })
          .where(eq(sessions.id, Number(sibling.lastInsertRowid)))
          .run();
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(res.json()).toEqual({ removed: true });
        expect(resolveBackendSpy).toHaveBeenCalledWith(expect.anything(), remoteHostId);
        expect(removeListedWorktree).toHaveBeenCalledWith(repoCwd, worktreePath, {
          force: undefined,
        });
        expect((await readOwner(app, ownerId)).worktreeReclaimedAt).toBeInstanceOf(Date);

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("refuses when the owning session's process cannot be confirmed gone", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        vi.spyOn(app.pty, "isMasterAliveStateBatch").mockResolvedValue({
          [String(ownerId)]: "unknown",
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(res.json()).toEqual({
          removed: false,
          reason: "still-running",
          detail: "unknown",
        });
        expect(fs.existsSync(worktreePath)).toBe(true);

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("503s when the session's host cannot be asked, and frees the reclaim slot", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        vi.spyOn(app.pty, "isMasterAliveStateBatch").mockRejectedValue(new Error("down"));
        const { claimReclaimSlot, releaseReclaimSlot } =
          await import("../../src/services/session-worktree-reclaim.js");

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(res.statusCode).toBe(503);
        expect(claimReclaimSlot(ownerId)).toBe(true);
        releaseReclaimSlot(ownerId);

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("409s while the reclaim sweep holds the session, and 400s for an active owner", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        const { claimReclaimSlot, releaseReclaimSlot } =
          await import("../../src/services/session-worktree-reclaim.js");

        expect(claimReclaimSlot(ownerId)).toBe(true);
        try {
          const busy = await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/git-worktree-remove`,
            payload: { worktreePath, sessionId: ownerId },
          });
          expect(busy.statusCode).toBe(409);
        } finally {
          releaseReclaimSlot(ownerId);
        }

        const activeId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
          status: "active",
        });

        const active = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: activeId, force: true },
        });
        expect(active.statusCode).toBe(400);
        expect(fs.existsSync(worktreePath)).toBe(true);

        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("rejects a session from another project, one without a worktree, or a mismatched path", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const other = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { allowDuplicate: true, name: "kept-other", cwd: projectCwd },
        });
        const foreignId = await insertOwner(app, {
          projectId: other.json().id,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        const { sessions } = await import("../../src/db/schema.js");
        const plainId = Number(
          app.db
            .insert(sessions)
            .values({ projectId, command: "bash", cwd: worktreePath, status: "exited" })
            .run().lastInsertRowid,
        );
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        const post = (payload: object) =>
          app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/git-worktree-remove`,
            payload,
          });

        expect((await post({ worktreePath, sessionId: foreignId })).statusCode).toBe(404);
        expect((await post({ worktreePath, sessionId: 999999 })).statusCode).toBe(404);
        expect((await post({ worktreePath, sessionId: plainId })).statusCode).toBe(400);
        expect((await post({ worktreePath: projectCwd, sessionId: ownerId })).statusCode).toBe(400);
        expect(fs.existsSync(worktreePath)).toBe(true);

        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("marks a worktree git no longer lists as reclaimed, so its row drops off", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const notAWorktree = path.join(projectCwd, "plain-dir");
        fs.mkdirSync(notAWorktree);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: notAWorktree,
          repoCwd: projectCwd,
        });
        vi.spyOn(app.pty, "isMasterAliveStateBatch").mockResolvedValue({
          [String(ownerId)]: "dead",
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath: notAWorktree, sessionId: ownerId },
        });
        expect(res.json()).toEqual({ removed: false, reason: "not-listed" });
        expect((await readOwner(app, ownerId)).worktreeReclaimedAt).toBeInstanceOf(Date);
        expect(fs.existsSync(worktreePath)).toBe(true);

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("reports an already-reclaimed worktree without touching the host", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        const { sessions } = await import("../../src/db/schema.js");
        const { eq } = await import("drizzle-orm");
        app.db
          .update(sessions)
          .set({ worktreeReclaimedAt: new Date() })
          .where(eq(sessions.id, ownerId))
          .run();

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(res.json()).toEqual({ removed: false, reason: "not-listed" });
        expect(fs.existsSync(worktreePath)).toBe(true);

        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });
    });
  });

  describe("POST /api/projects/:id/git-worktree-prune (issue #442)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/999999/git-worktree-prune",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("200s and clears stale worktree metadata for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-worktree-prune-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      const worktreePath = path.join(projectCwd, ".mullion-worktrees", "oob-removed");
      run(["worktree", "add", "-b", "oob-branch", worktreePath, "main"]);
      fs.rmSync(worktreePath, { recursive: true, force: true });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "worktree-prune-repo",
          cwd: projectCwd,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${created.json().id}/git-worktree-prune`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pruned: true });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "worktree-prune-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-worktree-prune",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-worktree-prune`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });
});
