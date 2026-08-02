import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

// Claiming a task spawns a real session (routes/tasks.ts's claim endpoint
// reuses sessions.ts's createSessionRecord) — faked the same way
// test/routes/sessions.test.ts fakes node-pty/systemd-run/dtach for its own
// worktree-isolation tests, so this file exercises the route/DB layer
// without depending on a real systemd --user session existing in CI. `git`
// subprocesses (worktree creation, resolveDefaultBaseRef) are left real.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const listeners: Array<(data: string) => void> = [];
    return {
      onData: (cb: (data: string) => void) => {
        listeners.push(cb);
        return { dispose: () => {} };
      },
      onExit: () => ({ dispose: () => {} }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (command === "git") return actual.spawn(command, args, options);
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

// task-promote.ts's real implementation needs a pushed branch and a
// working GitHub connection — mocked here so the approve/reject route
// tests below exercise routing/status-code logic against a controllable
// outcome, not a real git push + GitHub API round trip. task-promote.test.ts
// covers the real implementation directly.
const mockPromoteTaskToPR = vi
  .fn()
  .mockResolvedValue({ ok: true, prUrl: "https://github.com/test-owner/test-repo/pull/1" });
vi.mock("../../src/services/task-promote.js", () => ({
  promoteTaskToPR: mockPromoteTaskToPR,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `tasks-route-test-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-route-test-repo-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

describe("tasks route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    // Claiming is flag-gated (independent review, PR #471 — see
    // routes/tasks.ts's own comment on POST /api/tasks/:id/claim); on for
    // this suite's claim tests, verified explicitly off in its own test
    // below. Every other route in this file (GET/POST/PATCH/DELETE
    // /api/tasks) is deliberately flag-independent by design, so this has
    // no effect on them.
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    // This suite shares one DB across every test in the file and never
    // terminates a claimed task's session between tests (6.2/#215) — with
    // the real concurrency cap now enforced at claim time, earlier tests'
    // still-"claimed" rows would otherwise exhaust a low default cap and
    // make unrelated later tests fail with 429 instead of the 201 they
    // expect. Raised high here; the cap's own enforcement gets a dedicated
    // test below with its own explicit low value.
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  it("returns [] when no tasks exist", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("lists tasks joined with their project name", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "demo", cwd: "/tmp/demo" },
    });
    const projectId = project.json().id;

    app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 7,
        title: "Add feature",
        body: "some body",
        htmlUrl: "https://github.com/o/r/issues/7",
        // Phase 6 (6.9/#233) changed the column default to "backlog" —
        // pinned explicitly here since this test is asserting the row's
        // status verbatim, not exercising the claim route (which gates on
        // "ready", not "pending" — see routes/tasks.ts).
        status: "pending",
      })
      .run();

    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      projectId,
      projectName: "demo",
      issueNumber: 7,
      title: "Add feature",
      body: "some body",
      htmlUrl: "https://github.com/o/r/issues/7",
      status: "pending",
      sessionId: null,
    });

    await app.close();
  });

  it("lists a locally-created task with a null issue link", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "demo-local", cwd: "/tmp/demo-local" },
    });
    const projectId = project.json().id;

    app.db.insert(tasks).values({ projectId, title: "Local-only task", status: "backlog" }).run();

    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    // GET /api/tasks has no project filter yet (that lands with 6.2's
    // ?projectId= — see routes/tasks.ts's own comment on the GET route),
    // and this suite shares one DB across tests, so filter to this
    // project's own rows rather than asserting the full cross-test list.
    const own = (res.json() as { projectId: number }[]).filter((t) => t.projectId === projectId);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      projectId,
      title: "Local-only task",
      issueNumber: null,
      htmlUrl: null,
      status: "backlog",
    });

    await app.close();
  });

  it("allows multiple locally-created tasks (null issueNumber) in the same project", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "demo-multi-local", cwd: "/tmp/demo-multi-local" },
    });
    const projectId = project.json().id;

    // Verifies the unique index on (projectId, issueNumber) treats NULLs as
    // distinct (6.9) — this would throw a constraint violation if it didn't.
    app.db.insert(tasks).values({ projectId, title: "Local task one" }).run();
    app.db.insert(tasks).values({ projectId, title: "Local task two" }).run();

    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    const own = (res.json() as { projectId: number }[]).filter((t) => t.projectId === projectId);
    expect(own).toHaveLength(2);

    await app.close();
  });

  describe("POST /api/tasks/:id/claim (issue #216)", () => {
    async function createProjectWithGitRepo(
      app: Awaited<ReturnType<typeof buildApp>>,
      cwd: string,
    ) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "claim-p", cwd },
      });
      return res.json().id as number;
    }

    function insertTask(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      issueNumber: number,
    ) {
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber,
          title: "Fix the thing",
          body: "some details",
          htmlUrl: `https://github.com/o/r/issues/${issueNumber}`,
          // The claim route's gate is "ready" (6.9/#233, Hermes review PR
          // #471 — "pending" is a status nothing can produce anymore).
          status: "ready",
        })
        .returning()
        .all();
      return row;
    }

    it("creates a worktree, spawns a session there, and marks the task claimed", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const task = insertTask(app, projectId, 42);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(res.statusCode).toBe(201);
      const session = res.json();
      expect(session.projectId).toBe(projectId);
      // Branch/worktree dir is derived from task.id, not issueNumber
      // (Hermes review, PR #471) — issueNumber is nullable now (6.9), so
      // branching on it would collide every local task onto the same dir.
      expect(session.cwd).toBe(path.join(cwd, ".mullion-worktrees", `mullion-task-${task.id}`));
      expect(fs.existsSync(session.cwd)).toBe(true);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const claimed = (
        listed.json() as {
          id: number;
          status: string;
          sessionId: number;
          worktreePath: string | null;
          branchName: string | null;
        }[]
      ).find((t) => t.id === task.id);
      expect(claimed).toMatchObject({
        status: "claimed",
        sessionId: session.id,
        worktreePath: session.cwd,
        branchName: `mullion/task-${task.id}`,
      });
      expect((claimed as { claimedAt: string | null }).claimedAt).not.toBeNull();

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("only one of two concurrent claims for the same task wins (Hermes review, PR #280)", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const task = insertTask(app, projectId, 45);

      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` }),
        app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` }),
      ]);

      // Exactly one request wins (201), always cleanly — the reservation
      // (task-claim.ts's claimTask, 6.2/#215) happens inside one atomic
      // transaction BEFORE any worktree/git operation runs, so the loser
      // never reaches `git worktree add` at all; it fails the reservation
      // itself and 409s immediately. This is strictly tighter than the
      // thin slice's original race (Hermes review, PR #280), where the
      // loser could get either a 409 from the optimistic-lock UPDATE or a
      // 502 from a git-level branch-name collision depending on timing —
      // reservation-first eliminates that ambiguity entirely.
      const winner = first.statusCode === 201 ? first : second;
      const loser = first.statusCode === 201 ? second : first;
      expect(winner.statusCode).toBe(201);
      expect(loser.statusCode).toBe(409);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const claimed = (listed.json() as { id: number; sessionId: number; status: string }[]).find(
        (t) => t.id === task.id,
      );
      expect(claimed?.status).toBe("claimed");
      expect(claimed?.sessionId).toBe(winner.json().id);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("404s for an unknown task id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/tasks/999999/claim" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("409s when the task is not ready", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const task = insertTask(app, projectId, 43);

      const first = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(second.statusCode).toBe(409);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("no longer hard-rejects a task on a remote-hosted project (6.8/#283) — an unreachable host now 502s from the proxy attempt itself, not an upfront 400", async () => {
      const app = await buildApp();

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-p", cwd: "/tmp/remote", hostId },
      });
      const projectId = project.json().id;
      const task = insertTask(app, projectId, 44);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      // The host itself is unreachable (port 1) — claim now genuinely tries
      // the SessionBackend proxy (clearOrphanedTaskWorktree) instead of
      // refusing before ever attempting it, and surfaces a gateway failure
      // rather than a hard client-side rejection.
      expect(res.statusCode).toBe(502);

      // Released, not stranded.
      const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(check.json().status).toBe("ready");

      await app.close();
    });

    it("403s when MULLION_TASK_MASTER_ENABLED is false (independent review, PR #471)", async () => {
      // The rest of this describe block runs with the flag on (see this
      // file's top-level beforeAll); toggle it off just for this test to
      // prove claim is actually gated, not just documented as gated. This
      // is the exact bypass the independent review found: before this
      // check existed, a task created via the (deliberately un-gated)
      // local board with status: "ready" could reach claim with the flag
      // off.
      process.env.MULLION_TASK_MASTER_ENABLED = "false";
      try {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const task = insertTask(app, projectId, 46);

        const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
        expect(res.statusCode).toBe(403);

        const listed = await app.inject({ method: "GET", url: "/api/tasks" });
        const stillReady = (listed.json() as { id: number; status: string }[]).find(
          (t) => t.id === task.id,
        );
        expect(stillReady?.status).toBe("ready");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      } finally {
        process.env.MULLION_TASK_MASTER_ENABLED = "true";
      }
    });

    // Settings UI follow-up — the claim gate now checks the *resolved*
    // enabled state, so a settings override must be able to block claiming
    // even with the env var on (this suite's own beforeAll default).
    it("403s when settings.taskMaster.enabled overrides an env default of true to off", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { enabled: "off" } },
      });
      try {
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const task = insertTask(app, projectId, 47);

        const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
        expect(res.statusCode).toBe(403);

        fs.rmSync(cwd, { recursive: true, force: true });
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("429s once MULLION_TASK_MAX_CONCURRENT is reached, releasing nothing for the loser (6.2/#215)", async () => {
      // This suite shares one DB across the whole file and never releases
      // a claimed task's session between tests, so earlier tests' still-
      // "claimed" rows already occupy some of the cap by the time this
      // runs — count what's already in flight FIRST (config is read once
      // at buildApp() time, so this has to happen before the env var
      // below is set) and set the cap to exactly "in flight + 1" rather
      // than a fixed low number, so this test is robust to how many prior
      // tests happened to run first.
      const probeApp = await buildApp();
      const before = (await probeApp.inject({ method: "GET", url: "/api/tasks" })).json() as {
        status: string;
      }[];
      await probeApp.close();
      const inFlight = before.filter(
        (t) => t.status === "claimed" || t.status === "in_progress",
      ).length;
      process.env.MULLION_TASK_MAX_CONCURRENT = String(inFlight + 1);
      try {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const first = insertTask(app, projectId, 50);
        const second = insertTask(app, projectId, 51);

        const firstRes = await app.inject({ method: "POST", url: `/api/tasks/${first.id}/claim` });
        expect(firstRes.statusCode).toBe(201);

        const secondRes = await app.inject({
          method: "POST",
          url: `/api/tasks/${second.id}/claim`,
        });
        expect(secondRes.statusCode).toBe(429);
        expect(secondRes.json()).toMatchObject({ error: "concurrency-cap", limit: inFlight + 1 });

        // The capped task is untouched — still ready, not stuck in some
        // half-claimed state.
        const listed = await app.inject({ method: "GET", url: "/api/tasks" });
        const stillReady = (listed.json() as { id: number; status: string }[]).find(
          (t) => t.id === second.id,
        );
        expect(stillReady?.status).toBe("ready");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      } finally {
        process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
      }
    });

    // Independent review, PR #480 — proves the settings override actually
    // reaches task-claim.ts's cap check (task-config.ts's resolver), not
    // just that the pure resolver function returns the right number. The
    // env var stays generous (1000) so only the settings override could be
    // responsible for a 429 here.
    it("429s once settings.taskMaster.maxConcurrent is reached, overriding a generous env default", async () => {
      process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
      const app = await buildApp();
      const before = (await app.inject({ method: "GET", url: "/api/tasks" })).json() as {
        status: string;
      }[];
      const inFlight = before.filter(
        (t) => t.status === "claimed" || t.status === "in_progress",
      ).length;
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { maxConcurrent: inFlight + 1 } },
      });
      try {
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const first = insertTask(app, projectId, 52);
        const second = insertTask(app, projectId, 53);

        const firstRes = await app.inject({ method: "POST", url: `/api/tasks/${first.id}/claim` });
        expect(firstRes.statusCode).toBe(201);

        const secondRes = await app.inject({
          method: "POST",
          url: `/api/tasks/${second.id}/claim`,
        });
        expect(secondRes.statusCode).toBe(429);
        expect(secondRes.json()).toMatchObject({ error: "concurrency-cap", limit: inFlight + 1 });

        fs.rmSync(cwd, { recursive: true, force: true });
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { maxConcurrent: -1 } },
        });
        await app.close();
      }
    });

    it("resolves the worker agent from the issue body's Agent: line over the project/global default (6.2/#215)", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultAgent: "opencode" },
      });
      const [row] = app.db
        .insert((await import("../../src/db/schema.js")).tasks)
        .values({
          projectId,
          issueNumber: 52,
          title: "Fix the thing",
          body: "Some spec.\nAgent: codex\nMore text.",
          htmlUrl: "https://github.com/o/r/issues/52",
          status: "ready",
        })
        .returning()
        .all();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${row.id}/claim` });
      expect(res.statusCode).toBe(201);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const claimed = (listed.json() as { id: number; agentCommand: string | null }[]).find(
        (t) => t.id === row.id,
      );
      expect(claimed?.agentCommand).toBe("codex");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("still claims manually with an agent that has no seed channel, marking seedDelivered false", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        // opencode's hook adapter doesn't declare session_start — see
        // task-agent-resolve.test.ts's commandSupportsSeed coverage.
        payload: { defaultAgent: "opencode" },
      });
      const task = insertTask(app, projectId, 53);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(res.statusCode).toBe(201);
      expect(res.json().seedDelivered).toBe(false);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("POST /api/tasks/:id/retry (#483)", () => {
    async function createProjectWithGitRepo(
      app: Awaited<ReturnType<typeof buildApp>>,
      cwd: string,
    ) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "retry-p", cwd },
      });
      return res.json().id as number;
    }

    /** Same real →failed lifecycle reconstruction as
     * task-claim.test.ts's own insertFailedTaskWithPreservedBranch —
     * inserted first for a real id, then a worktree/branch created and
     * cleanly removed (deliberately leaving the branch), then flipped to
     * "failed" with both still recorded. */
    async function insertFailedTaskWithPreservedBranch(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      cwd: string,
      issueNumber: number,
    ) {
      const [placeholder] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber, title: "t", status: "ready" })
        .returning()
        .all();
      const branchName = `mullion/task-${placeholder.id}`;
      const { createWorktree, removeWorktreeIfClean } =
        await import("../../src/services/git-worktree.js");
      const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
      if (!created) throw new Error("test setup: failed to create worktree");
      fs.writeFileSync(path.join(created.path, "work.txt"), "real committed work");
      git(created.path, ["add", "-A"]);
      git(created.path, ["commit", "-m", "agent did real work", "--no-verify"]);
      const removed = await removeWorktreeIfClean(created.path, cwd);
      if (!removed.removed) throw new Error("test setup: failed to remove worktree");

      const [row] = app.db
        .update(tasks)
        .set({
          status: "failed",
          failureReason: "budget exceeded after 120 minutes",
          completedAt: new Date(),
          worktreePath: created.path,
          branchName,
          sessionId: null,
        })
        .where(eq(tasks.id, placeholder.id))
        .returning()
        .all();
      return row;
    }

    it("resumes a failed task on its preserved branch, clearing failureReason/completedAt", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 80);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });

      expect(res.statusCode).toBe(201);
      const session = res.json();
      expect(fs.readFileSync(path.join(session.cwd, "work.txt"), "utf8")).toBe(
        "real committed work",
      );

      const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(check.json()).toMatchObject({
        status: "claimed",
        branchName: task.branchName,
        failureReason: null,
        completedAt: null,
      });

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("409s a task that isn't failed", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const [task] = app.db
        .insert(tasks)
        .values({ projectId, title: "t", status: "ready" })
        .returning()
        .all();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(res.statusCode).toBe(409);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("400s when the task has no recorded branch to resume", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const [task] = app.db
        .insert(tasks)
        .values({ projectId, title: "t", status: "failed", branchName: null })
        .returning()
        .all();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(res.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("403s when Task Master is disabled — unlike reject/give-up, retry spawns a session", async () => {
      process.env.MULLION_TASK_MASTER_ENABLED = "false";
      try {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 81);

        const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
        expect(res.statusCode).toBe(403);

        const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
        expect(check.json().status).toBe("failed");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      } finally {
        process.env.MULLION_TASK_MASTER_ENABLED = "true";
      }
    });
  });

  describe("approve/reject (6.2/#215, promotion added in 6.7/#220)", () => {
    afterEach(() => {
      mockPromoteTaskToPR.mockClear();
      mockPromoteTaskToPR.mockResolvedValue({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
      });
    });

    async function createProjectAndReviewingTask(app: Awaited<ReturnType<typeof buildApp>>) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "approve-reject-p", cwd: "/tmp/approve-reject" },
      });
      const projectId = project.json().id;
      const { tasks } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "under review", status: "reviewing" })
        .returning()
        .all();
      return row;
    }

    it("POST /api/tasks/:id/approve transitions reviewing -> done and records the promoted PR's url", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "done",
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
      });
      expect(res.json().completedAt).not.toBeNull();
      expect(mockPromoteTaskToPR).toHaveBeenCalledTimes(1);

      await app.close();
    });

    it("POST /api/tasks/:id/approve leaves the task in reviewing (409, no local write) when promotion fails", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);
      mockPromoteTaskToPR.mockResolvedValue({
        ok: false,
        reason: "dirty-tree",
        detail: "Worktree has uncommitted changes",
      });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toContain("uncommitted changes");

      const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(check.json()).toMatchObject({ status: "reviewing", prUrl: null });

      await app.close();
    });

    it("POST /api/tasks/:id/approve maps push-failed to a 502, task stays reviewing", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);
      mockPromoteTaskToPR.mockResolvedValue({
        ok: false,
        reason: "push-failed",
        detail: "git push exited 128",
      });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });
      expect(res.statusCode).toBe(502);

      const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(check.json().status).toBe("reviewing");

      await app.close();
    });

    it.each([
      ["no-worktree", 502],
      ["no-token", 400],
      ["no-repo", 502],
      ["pr-create-failed", 502],
      ["remote-not-supported", 501],
    ] as const)(
      "POST /api/tasks/:id/approve maps promotion reason %s to HTTP %i",
      async (reason, expectedStatus) => {
        const app = await buildApp();
        const task = await createProjectAndReviewingTask(app);
        mockPromoteTaskToPR.mockResolvedValue({ ok: false, reason, detail: `stub: ${reason}` });

        const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });
        expect(res.statusCode).toBe(expectedStatus);

        const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
        expect(check.json().status).toBe("reviewing");

        await app.close();
      },
    );

    it("POST /api/tasks/:id/approve 409s and surfaces the PR url when the task left reviewing between promotion succeeding and the local write", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);
      mockPromoteTaskToPR.mockImplementation(async () => {
        // Simulates a concurrent reject landing after promoteTaskToPR
        // already pushed + opened a real PR but before this handler's own
        // guarded UPDATE runs — the documented "PR opened, status write
        // lost the race" case (task-promote.ts's own accepted-gap comment).
        app.db
          .update(tasks)
          .set({ status: "in_progress", failureReason: "concurrent reject" })
          .where(eq(tasks.id, task.id))
          .run();
        return { ok: true, prUrl: "https://github.com/test-owner/test-repo/pull/2" };
      });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });

      expect(res.statusCode).toBe(409);
      expect(res.json().message).toContain("https://github.com/test-owner/test-repo/pull/2");

      const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(check.json().status).toBe("in_progress");

      await app.close();
    });

    it("POST /api/tasks/:id/approve 409s on a task not in reviewing", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "not-reviewing-p", cwd: "/tmp/not-reviewing" },
      });
      const { tasks } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId: project.json().id, title: "still backlog", status: "backlog" })
        .returning()
        .all();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${row.id}/approve` });
      expect(res.statusCode).toBe(409);

      await app.close();
    });

    it("POST /api/tasks/:id/reject transitions reviewing -> in_progress and records feedback", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/reject`,
        payload: { feedback: "needs another pass" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "in_progress",
        failureReason: "needs another pass",
      });

      await app.close();
    });

    it("POST /api/tasks/:id/reject works with no feedback", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);

      // An empty object, not an entirely absent body — the schema declares
      // a body shape (albeit with no required properties), and Fastify's
      // validator expects some JSON body to validate against when a route
      // declares one, same as every other optional-fields PATCH/POST body
      // in this file.
      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/reject`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "in_progress" });

      await app.close();
    });

    // Independent review, PR #480 — before this, approve/reject had NO
    // server-side gate at all; only the Tasks panel UI disabled the
    // buttons. A scope failure/misconfiguration client-side (or a direct
    // API call) could push a real GitHub write with Task Master
    // effectively off. Matches claim's own existing 403 test.
    it("403s approve when Task Master is disabled (independent review, PR #480)", async () => {
      process.env.MULLION_TASK_MASTER_ENABLED = "false";
      try {
        const app = await buildApp();
        const task = await createProjectAndReviewingTask(app);

        const approve = await app.inject({
          method: "POST",
          url: `/api/tasks/${task.id}/approve`,
        });
        expect(approve.statusCode).toBe(403);
        expect(mockPromoteTaskToPR).not.toHaveBeenCalled();

        const listed = await app.inject({ method: "GET", url: "/api/tasks" });
        const stillReviewing = (listed.json() as { id: number; status: string }[]).find(
          (t) => t.id === task.id,
        );
        expect(stillReviewing?.status).toBe("reviewing");

        await app.close();
      } finally {
        process.env.MULLION_TASK_MASTER_ENABLED = "true";
      }
    });

    it("still resolves a reviewing task via reject when Task Master is disabled — the escape hatch from a stranded reviewing task (Hermes review, PR #480, fourth pass)", async () => {
      process.env.MULLION_TASK_MASTER_ENABLED = "false";
      try {
        const app = await buildApp();
        const task = await createProjectAndReviewingTask(app);

        const reject = await app.inject({
          method: "POST",
          url: `/api/tasks/${task.id}/reject`,
          payload: { feedback: "needs another pass" },
        });
        expect(reject.statusCode).toBe(200);
        expect(reject.json()).toMatchObject({
          status: "in_progress",
          failureReason: "needs another pass",
        });

        await app.close();
      } finally {
        process.env.MULLION_TASK_MASTER_ENABLED = "true";
      }
    });

    it("404s for an unknown task on both approve and reject", async () => {
      const app = await buildApp();
      const approve = await app.inject({ method: "POST", url: "/api/tasks/999999/approve" });
      const reject = await app.inject({
        method: "POST",
        url: "/api/tasks/999999/reject",
        payload: {},
      });
      expect(approve.statusCode).toBe(404);
      expect(reject.statusCode).toBe(404);
      await app.close();
    });

    it("POST /api/tasks/:id/reject re-seeds a fresh session in the same worktree when the previous session already exited", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "reject-reseed-p", cwd },
      });
      const projectId = project.json().id;

      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const oldSessionId = sessionRes.json().id;
      const { sessions } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");
      app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, oldSessionId)).run();

      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "under review",
          status: "reviewing",
          sessionId: oldSessionId,
          worktreePath: cwd,
          branchName: "main",
          agentCommand: "bash",
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/reject`,
        payload: { feedback: "please fix the tests" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("in_progress");
      expect(res.json().sessionId).not.toBe(oldSessionId);
      expect(res.json().sessionId).not.toBeNull();

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("POST /api/tasks/:id/reject does NOT re-seed when the previous session is still active", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "reject-no-reseed-p", cwd },
      });
      const projectId = project.json().id;

      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const activeSessionId = sessionRes.json().id;

      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "under review",
          status: "reviewing",
          sessionId: activeSessionId,
          worktreePath: cwd,
          branchName: "main",
          agentCommand: "bash",
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/reject`,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().sessionId).toBe(activeSessionId);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("POST /api/tasks/:id/reject still records the new sessionId and 200s even when stashing the feedback prompt fails", async () => {
      // Hermes review, PR #475: stashSeed can throw (a misconfigured
      // remote host, a network failure) AFTER the fresh session is already
      // spawned — must not skip the sessionId update or 500 the request.
      // Spawn (called internally by createSessionRecord's re-seed path)
      // must still work — only stashSeed should fail — so this wraps the
      // REAL backend in a Proxy that forwards every other method,
      // overriding just the one call this test needs to fail.
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "stashSeed") {
                return () => Promise.reject(new Error("host unreachable"));
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      const app = await buildApp();
      const cwd = createGitRepo();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "reject-stashseed-fail-p", cwd },
      });
      const projectId = project.json().id;

      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "claude" },
      });
      const oldSessionId = sessionRes.json().id;
      const { sessions } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");
      app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, oldSessionId)).run();

      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "under review",
          status: "reviewing",
          sessionId: oldSessionId,
          worktreePath: cwd,
          branchName: "main",
          agentCommand: "claude",
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/reject`,
        payload: { feedback: "please fix the tests" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("in_progress");
      expect(res.json().sessionId).not.toBe(oldSessionId);
      expect(res.json().sessionId).not.toBeNull();

      resolveBackendSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("POST /api/tasks/:id/approve cleans up the worktree once promotion succeeds (6.8/#283), but not when it fails", async () => {
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const removeWorktreeIfCleanMock = vi.fn().mockResolvedValue({ removed: true });
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "removeWorktreeIfClean") return removeWorktreeIfCleanMock;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "approve-cleanup-p", cwd: "/tmp/approve-cleanup" },
      });
      const projectId = project.json().id;
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "under review",
          status: "reviewing",
          worktreePath: "/tmp/approve-cleanup/.mullion-worktrees/mullion-task-1",
          branchName: "mullion/task-1",
        })
        .returning()
        .all();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });
      expect(res.statusCode).toBe(200);
      expect(removeWorktreeIfCleanMock).toHaveBeenCalledWith(
        "/tmp/approve-cleanup/.mullion-worktrees/mullion-task-1",
        "/tmp/approve-cleanup",
      );

      removeWorktreeIfCleanMock.mockClear();
      mockPromoteTaskToPR.mockResolvedValueOnce({ ok: false, reason: "dirty-tree", detail: "x" });
      const [task2] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "under review 2",
          status: "reviewing",
          worktreePath: "/tmp/approve-cleanup/.mullion-worktrees/mullion-task-2",
          branchName: "mullion/task-2",
        })
        .returning()
        .all();
      const failedRes = await app.inject({ method: "POST", url: `/api/tasks/${task2.id}/approve` });
      expect(failedRes.statusCode).toBe(409);
      expect(removeWorktreeIfCleanMock).not.toHaveBeenCalled();

      resolveBackendSpy.mockRestore();
      await app.close();
    });
  });

  describe("POST /api/tasks/:id/give-up (#483)", () => {
    async function createProjectAndReviewingTask(app: Awaited<ReturnType<typeof buildApp>>) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "give-up-p", cwd: "/tmp/give-up" },
      });
      const projectId = project.json().id;
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "under review", status: "reviewing" })
        .returning()
        .all();
      return row;
    }

    it("transitions reviewing -> failed and records a default reason", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/give-up`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "failed",
        failureReason: "given up during review",
      });
      expect(res.json().completedAt).not.toBeNull();

      await app.close();
    });

    it("records a custom reason when given", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/give-up`,
        payload: { reason: "not the right approach" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "failed",
        failureReason: "not the right approach",
      });

      await app.close();
    });

    it("409s a task not in reviewing", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "give-up-not-reviewing-p", cwd: "/tmp/give-up-2" },
      });
      const [row] = app.db
        .insert(tasks)
        .values({ projectId: project.json().id, title: "still backlog", status: "backlog" })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${row.id}/give-up`,
        payload: {},
      });
      expect(res.statusCode).toBe(409);

      await app.close();
    });

    it("still works when Task Master is disabled — the same escape hatch reject already is", async () => {
      process.env.MULLION_TASK_MASTER_ENABLED = "false";
      try {
        const app = await buildApp();
        const task = await createProjectAndReviewingTask(app);

        const res = await app.inject({
          method: "POST",
          url: `/api/tasks/${task.id}/give-up`,
          payload: {},
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe("failed");

        await app.close();
      } finally {
        process.env.MULLION_TASK_MASTER_ENABLED = "true";
      }
    });

    it("calls cleanupTaskWorktree — leaving reviewing for a terminal state, same as approve", async () => {
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const removeWorktreeIfCleanMock = vi.fn().mockResolvedValue({ removed: true });
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "removeWorktreeIfClean") return removeWorktreeIfCleanMock;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "give-up-cleanup-p", cwd: "/tmp/give-up-cleanup" },
      });
      const projectId = project.json().id;
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "under review",
          status: "reviewing",
          worktreePath: "/tmp/give-up-cleanup/.mullion-worktrees/mullion-task-1",
          branchName: "mullion/task-1",
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/give-up`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(removeWorktreeIfCleanMock).toHaveBeenCalledWith(
        "/tmp/give-up-cleanup/.mullion-worktrees/mullion-task-1",
        "/tmp/give-up-cleanup",
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    });
  });

  describe("GET /api/tasks filters (6.2/#215)", () => {
    it("filters by status", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "filter-status-p", cwd: "/tmp/filter-status" },
      });
      const projectId = project.json().id;
      const { tasks } = await import("../../src/db/schema.js");
      app.db.insert(tasks).values({ projectId, title: "a", status: "backlog" }).run();
      app.db.insert(tasks).values({ projectId, title: "b", status: "ready" }).run();

      const res = await app.inject({ method: "GET", url: "/api/tasks?status=ready" });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as { projectId: number; status: string }[];
      expect(rows.filter((t) => t.projectId === projectId)).toHaveLength(1);
      expect(rows.every((t) => t.status === "ready")).toBe(true);

      await app.close();
    });

    it("filters by projectId", async () => {
      const app = await buildApp();
      const projectA = (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { name: "filter-project-a", cwd: "/tmp/filter-project-a" },
        })
      ).json().id;
      const projectB = (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { name: "filter-project-b", cwd: "/tmp/filter-project-b" },
        })
      ).json().id;
      const { tasks } = await import("../../src/db/schema.js");
      app.db.insert(tasks).values({ projectId: projectA, title: "a" }).run();
      app.db.insert(tasks).values({ projectId: projectB, title: "b" }).run();

      const res = await app.inject({ method: "GET", url: `/api/tasks?projectId=${projectA}` });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as { projectId: number; title: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ projectId: projectA, title: "a" });

      await app.close();
    });

    it("400s on an invalid status filter value", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/tasks?status=not-a-status" });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("GET /api/tasks/:id returns a single task", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "get-one-p", cwd: "/tmp/get-one" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId: project.json().id, title: "single" },
      });

      const res = await app.inject({ method: "GET", url: `/api/tasks/${created.json().id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ title: "single" });

      await app.close();
    });

    it("GET /api/tasks/:id 404s for an unknown id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/tasks/999999" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("local task CRUD (6.9/#233)", () => {
    async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "local-crud-p", cwd },
      });
      return res.json().id as number;
    }

    it("POST /api/tasks creates a local task with no GitHub issue, flag-off included", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-1");

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId, title: "Write the docs" },
      });
      expect(res.statusCode).toBe(201);
      const created = res.json();
      expect(created).toMatchObject({
        projectId,
        title: "Write the docs",
        issueNumber: null,
        htmlUrl: null,
        status: "backlog",
        boardOrder: 0,
      });

      await app.close();
    });

    it("POST /api/tasks 404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId: 999999, title: "orphan" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("POST /api/tasks 400s on an unknown status value", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-2");
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId, title: "bad status", status: "done" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("PATCH /api/tasks/:id edits title/body/boardOrder and toggles backlog<->ready", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-3");
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { projectId, title: "Original title" },
        })
      ).json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${created.id}`,
        payload: { title: "New title", body: "spec", boardOrder: 3, status: "ready" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({
        title: "New title",
        body: "spec",
        boardOrder: 3,
        status: "ready",
      });

      await app.close();
    });

    it("PATCH /api/tasks/:id refuses to edit title/body of a GitHub-linked task (Hermes review, PR #471)", async () => {
      // The watcher's onConflictDoUpdate resyncs title/body/htmlUrl from
      // the issue on every poll, so an edit here would be silently
      // reverted within one poll cycle with no error if this route let it
      // through — see task-watcher.ts.
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-linked-patch");
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 55,
          title: "From the issue",
          htmlUrl: "https://x/55",
          status: "backlog",
        })
        .returning()
        .all();

      const titleEdit = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${row.id}`,
        payload: { title: "Edited locally" },
      });
      expect(titleEdit.statusCode).toBe(409);

      const bodyEdit = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${row.id}`,
        payload: { body: "edited body" },
      });
      expect(bodyEdit.statusCode).toBe(409);

      // boardOrder and status remain editable regardless of the link.
      const orderEdit = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${row.id}`,
        payload: { boardOrder: 5, status: "ready" },
      });
      expect(orderEdit.statusCode).toBe(200);
      expect(orderEdit.json()).toMatchObject({
        title: "From the issue",
        boardOrder: 5,
        status: "ready",
      });

      await app.close();
    });

    it("PATCH /api/tasks/:id 404s for an unknown task", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/tasks/999999",
        payload: { title: "x" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("PATCH /api/tasks/:id 400s on a status outside backlog/ready (needs 6.2's state machine)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-4");
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { projectId, title: "t" },
        })
      ).json();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${created.id}`,
        payload: { status: "claimed" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("PATCH /api/tasks/:id 409s attempting to edit status once a task is already past backlog/ready", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-5");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "already claimed", status: "claimed" })
        .returning()
        .all();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${row.id}`,
        payload: { status: "backlog" },
      });
      expect(res.statusCode).toBe(409);
      await app.close();
    });

    it("DELETE /api/tasks/:id removes a local task", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-6");
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { projectId, title: "to delete" },
        })
      ).json();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${created.id}` });
      expect(res.statusCode).toBe(204);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      expect((listed.json() as { id: number }[]).some((t) => t.id === created.id)).toBe(false);

      await app.close();
    });

    it("DELETE /api/tasks/:id refuses a GitHub-linked task", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-7");
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 99,
          title: "linked",
          htmlUrl: "https://x/99",
          status: "backlog",
        })
        .returning()
        .all();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
      expect(res.statusCode).toBe(409);
      await app.close();
    });

    it("DELETE /api/tasks/:id refuses a task past backlog/ready", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-8");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "claimed local", status: "claimed" })
        .returning()
        .all();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
      expect(res.statusCode).toBe(409);
      await app.close();
    });
  });
});
