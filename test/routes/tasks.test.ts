import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync, spawn as childProcessSpawn } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

// Claiming a task spawns a real session (routes/tasks.ts's claim endpoint
// reuses session-lifecycle.ts's createSessionRecord) — faked the same way
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
const mockPromoteTaskToPR = vi.fn().mockResolvedValue({
  ok: true,
  prUrl: "https://github.com/test-owner/test-repo/pull/1",
  prNumber: 1,
});
// Give-up's own draft-PR cleanup (task-promote.ts's closeDraftPRForTask) —
// fire-and-forget from the route's point of view, so a resolved (not
// rejected) no-op default is enough for every test that doesn't care about
// it specifically.
const mockCloseDraftPRForTask = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/task-promote.js", () => ({
  promoteTaskToPR: mockPromoteTaskToPR,
  closeDraftPRForTask: mockCloseDraftPRForTask,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
// Task-claim queueing (rate-limit-storm fix) — claim now only ENQUEUES
// (202, no session yet); dispatchClaimedTask is the exported primitive
// that actually spawns one. In production this runs off task-dispatch.ts's
// fire-and-forget hook shortly after; tests call it directly and awaited,
// for determinism.
const { dispatchClaimedTask } = await import("../../src/services/task-claim.js");

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

// #729 — same shape as webhooks.test.ts's own createMatchingGitRepo: an
// `origin` remote pointing at owner/repo, so `resolveRepoRef` (parseGitRemote
// under the hood) resolves this project to a real repo the DELETE route's
// isIssueStillTrackable check can query.
function createGitRepoWithRemote(owner: string, repo: string): string {
  const cwd = createGitRepo();
  git(cwd, ["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
  return cwd;
}

// #729 — a stubbed PAT connection (real network call spied out), same
// pattern as webhooks.test.ts's own connectPat, so resolveGitHubToken has
// something to hand back before isIssueStillTrackable's getIssueState spy
// takes over.
async function connectPat(app: Awaited<ReturnType<typeof buildApp>>, token: string) {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(JSON.stringify({ login: "octocat" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const { setPat } = await import("../../src/services/github-integration.js");
  await setPat(app, token);
  global.fetch = originalFetch;
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
      payload: { createDir: true, name: "demo", cwd: "/tmp/demo" },
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

  // #701 — sub-issue hierarchy columns, on both GET /api/tasks and
  // GET /api/tasks/:id (TASK_ROW_COLUMNS is shared between the two, but
  // this pins both endpoints so a future column added to only one of them
  // is caught here rather than at the frontend).
  it("exposes the sub-issue hierarchy columns on GET /api/tasks and GET /api/tasks/:id", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "demo-hierarchy", cwd: "/tmp/demo-hierarchy" },
    });
    const projectId = project.json().id;

    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 44,
        title: "A child issue",
        status: "backlog",
        parentIssueNumber: 30,
        parentIssueRepo: "s3ntin3l8/branchdam",
        parentIssueTitle: "Phase 5 — Tier-1 project introspection",
        subIssueTotal: 4,
        subIssueCompleted: 1,
      })
      .returning({ id: tasks.id })
      .all();

    const listRes = await app.inject({ method: "GET", url: "/api/tasks" });
    const listed = (listRes.json() as { id: number }[]).find((t) => t.id === row.id);
    expect(listed).toMatchObject({
      parentIssueNumber: 30,
      parentIssueRepo: "s3ntin3l8/branchdam",
      parentIssueTitle: "Phase 5 — Tier-1 project introspection",
      subIssueTotal: 4,
      subIssueCompleted: 1,
    });

    const singleRes = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
    expect(singleRes.json()).toMatchObject({
      parentIssueNumber: 30,
      parentIssueRepo: "s3ntin3l8/branchdam",
      parentIssueTitle: "Phase 5 — Tier-1 project introspection",
      subIssueTotal: 4,
      subIssueCompleted: 1,
    });

    await app.close();
  });

  it("lists a locally-created task with a null issue link", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "demo-local", cwd: "/tmp/demo-local" },
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
      payload: { createDir: true, name: "demo-multi-local", cwd: "/tmp/demo-multi-local" },
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
        payload: { createDir: true, name: "claim-p", cwd },
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

    it("queues the task, then dispatch creates a worktree, spawns a session there, and marks the task in_progress", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const task = insertTask(app, projectId, 42);

      // Task-claim queueing (rate-limit-storm fix) — claim itself only
      // enqueues (202, no session yet); the worktree/session-spawn side
      // effects the old single-phase claim asserted here now belong to
      // dispatchClaimedTask, called explicitly below for determinism (in
      // production it runs off task-dispatch.ts's fire-and-forget hook).
      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(res.statusCode).toBe(202);
      const queued = res.json();
      expect(queued.status).toBe("claimed");
      expect(queued.sessionId).toBeNull();
      expect(queued.queuedAt).not.toBeNull();
      expect(queued.claimedAt).toBeNull();
      // Branch/worktree dir is derived from task.id, not issueNumber
      // (Hermes review, PR #471) — issueNumber is nullable now (6.9), so
      // branching on it would collide every local task onto the same dir.
      const predictedCwd = path.join(cwd, ".mullion-worktrees", `mullion-task-${task.id}`);
      expect(queued.worktreePath).toBe(predictedCwd);
      // Predicted, not yet real — nothing on disk until dispatch runs.
      expect(fs.existsSync(predictedCwd)).toBe(false);

      const outcome = await dispatchClaimedTask(app, task.id);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      const session = outcome.session;
      expect(session.projectId).toBe(projectId);
      expect(session.cwd).toBe(predictedCwd);
      expect(fs.existsSync(session.cwd)).toBe(true);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const dispatched = (
        listed.json() as {
          id: number;
          status: string;
          sessionId: number;
          worktreePath: string | null;
          branchName: string | null;
        }[]
      ).find((t) => t.id === task.id);
      expect(dispatched).toMatchObject({
        status: "in_progress",
        sessionId: session.id,
        worktreePath: session.cwd,
        branchName: `mullion/task-${task.id}`,
      });
      expect((dispatched as { claimedAt: string | null }).claimedAt).not.toBeNull();

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

      // Exactly one request wins (202), always cleanly — the reservation
      // (task-claim.ts's enqueueTask) happens inside one atomic transaction
      // gated on status === "ready", so the loser fails the reservation
      // itself and 409s immediately, never racing a worktree/git operation
      // at all (enqueue never touches disk — see enqueueTask's own doc
      // comment).
      const winner = first.statusCode === 202 ? first : second;
      const loser = first.statusCode === 202 ? second : first;
      expect(winner.statusCode).toBe(202);
      expect(loser.statusCode).toBe(409);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const claimed = (listed.json() as { id: number; status: string }[]).find(
        (t) => t.id === task.id,
      );
      expect(claimed?.status).toBe("claimed");

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
      expect(first.statusCode).toBe(202);

      const second = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(second.statusCode).toBe(409);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // Task-claim queueing (rate-limit-storm fix) — enqueue never touches the
    // host at all anymore (that's dispatch's job), so a remote-hosted
    // project's claim ALWAYS 202s regardless of reachability; the old "no
    // longer hard-rejects... 502s from the proxy attempt itself" behavior
    // now lives entirely inside dispatchClaimedTask, called explicitly here.
    it("queues unconditionally on a remote-hosted project; dispatch is what discovers the host is unreachable and releases back to claimed, not ready", async () => {
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
      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe("claimed");

      const outcome = await dispatchClaimedTask(app, task.id);
      expect(outcome.ok).toBe(false);

      // Released back to "claimed" (its queue position), not "ready" —
      // dispatchClaimedTask's own doc comment: an enqueue was a real,
      // unconditional commitment; a transient dispatch failure shouldn't
      // cost the task its place in line. task-dispatch.ts's backoff is what
      // keeps this from being retried in a tight loop in production.
      const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(check.json().status).toBe("claimed");

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

    // Task-claim queueing (rate-limit-storm fix) — this is the deliverable:
    // a manual claim past the concurrency cap used to 429 (the two tests
    // this replaces, "429s once MULLION_TASK_MAX_CONCURRENT is reached" and
    // "...settings.taskMaster.maxConcurrent..."). Now it queues
    // unconditionally regardless of capacity — the cap only applies at
    // dispatch, which is never on this route's own call stack. See
    // test/services/task-claim.test.ts for dispatchClaimedTask's own "cap"
    // outcome coverage (the thing that replaced this route ever seeing 429).
    it("queues past MULLION_TASK_MAX_CONCURRENT instead of 429ing — the cap no longer applies to claim at all", async () => {
      process.env.MULLION_TASK_MAX_CONCURRENT = "1";
      try {
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const first = insertTask(app, projectId, 50);
        const second = insertTask(app, projectId, 51);

        const firstRes = await app.inject({ method: "POST", url: `/api/tasks/${first.id}/claim` });
        expect(firstRes.statusCode).toBe(202);

        const secondRes = await app.inject({
          method: "POST",
          url: `/api/tasks/${second.id}/claim`,
        });
        expect(secondRes.statusCode).toBe(202);
        expect(secondRes.json().status).toBe("claimed");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      } finally {
        process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
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
      expect(res.statusCode).toBe(202);

      // agentCommand is stamped at DISPATCH, not enqueue (task-claim
      // queueing, rate-limit-storm fix) — enqueue only checks resolution
      // succeeds enough to decide no-seed-channel for an auto claim; it
      // never persists the result.
      const outcome = await dispatchClaimedTask(app, row.id);
      expect(outcome.ok).toBe(true);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const claimed = (listed.json() as { id: number; agentCommand: string | null }[]).find(
        (t) => t.id === row.id,
      );
      expect(claimed?.agentCommand).toBe("codex");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("still claims manually with an agent that has no seed channel, marking seedDelivered false once dispatched", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        // gemini has no hook adapter at all, so no seed channel — see
        // task-agent-resolve.test.ts's commandSupportsSeed coverage.
        // opencode used to be this test's example too, but it gained
        // `initialPromptArgs` — see hook-adapters/opencode.ts.
        payload: { defaultAgent: "gemini" },
      });
      const task = insertTask(app, projectId, 53);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(res.statusCode).toBe(202);
      // seedDelivered isn't known until dispatch actually spawns something
      // — enqueue's own no-seed-channel refusal only applies to `auto`
      // claims (task-claim.ts's enqueueTask), and this is a manual one, so
      // it queues fine with a still-null seedDelivered.
      expect(res.json().seedDelivered).toBeNull();

      const outcome = await dispatchClaimedTask(app, task.id);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.seedDelivered).toBe(false);

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
        payload: { createDir: true, name: "retry-p", cwd },
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
      // Task-claim queueing (rate-limit-storm fix) — a successful retry now
      // lands directly on "in_progress", not "claimed" (see task-claim.ts's
      // retryTask — a "claimed" row is defined everywhere else as
      // session-less/queued, and a retry already has a real, running
      // session by this point).
      expect(check.json()).toMatchObject({
        status: "in_progress",
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

    it("applies agent override from request body", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 82);

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/retry`,
        payload: { agent: "codex", reviewAgent: "none" },
      });
      expect(res.statusCode).toBe(201);

      const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(check.json()).toMatchObject({
        status: "in_progress",
        agent: "codex",
        reviewAgent: "none",
        agentCommand: "codex",
      });

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("approve/reject (6.2/#215, promotion added in 6.7/#220)", () => {
    afterEach(() => {
      mockPromoteTaskToPR.mockClear();
      mockPromoteTaskToPR.mockResolvedValue({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/1",
        prNumber: 1,
      });
    });

    async function createProjectAndReviewingTask(app: Awaited<ReturnType<typeof buildApp>>) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "approve-reject-p", cwd: "/tmp/approve-reject" },
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

    it("POST /api/tasks/:id/approve leaves mergeRequestedAt null when the project's mergeOnApprove is off (default)", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });
      expect(res.statusCode).toBe(200);
      expect(res.json().mergeRequestedAt).toBeNull();

      await app.close();
    });

    it("POST /api/tasks/:id/approve sets mergeRequestedAt when the project's mergeOnApprove is on", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${task.projectId}`,
        payload: { mergeOnApprove: true },
      });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });
      expect(res.statusCode).toBe(200);
      expect(res.json().mergeRequestedAt).not.toBeNull();

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
        return { ok: true, prUrl: "https://github.com/test-owner/test-repo/pull/2", prNumber: 2 };
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
        payload: { createDir: true, name: "not-reviewing-p", cwd: "/tmp/not-reviewing" },
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
        payload: { createDir: true, name: "reject-reseed-p", cwd },
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

    it("re-seeds with the worker preamble and the task spec, and never states a stale budget deadline", async () => {
      // Unlike the other reject-reseed tests in this block, this one uses a
      // seed-capable command ("claude", not "bash") specifically so the
      // spawned argv actually carries an initial prompt to inspect —
      // buildRejectPrompt's output was previously asserted nowhere at this
      // call site (routes/tasks.ts), the one place where branchName and
      // worktreePath are two independently-typed strings a future edit
      // could silently swap.
      const app = await buildApp();
      const cwd = createGitRepo();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "reject-reseed-content-p", cwd },
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

      const staleClaimedAt = new Date(Date.now() - 200 * 60_000);
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "under review",
          body: "the widget explodes",
          status: "reviewing",
          sessionId: oldSessionId,
          worktreePath: cwd,
          branchName: "mullion/task-reject-content",
          agentCommand: "claude",
          claimedAt: staleClaimedAt,
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/reject`,
        payload: { feedback: "please fix the tests" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().sessionId).not.toBe(oldSessionId);

      const call = vi
        .mocked(childProcessSpawn)
        .mock.calls.findLast(([command]) => command === "systemd-run");
      const args = call?.[1] as string[];
      const spawnedArg = args[args.length - 1];
      expect(spawnedArg).toContain("as a Mullion Task Master worker");
      expect(spawnedArg).toContain(cwd);
      expect(spawnedArg).toContain("mullion/task-reject-content");
      expect(spawnedArg).toContain("please fix the tests");
      expect(spawnedArg).toContain("the widget explodes");
      // Not resolveTaskMasterConfig(app).budgetMinutes's default (120) —
      // the point is that SOME budget line is present at all, proving
      // claimedAt was reset rather than left stale.
      expect(spawnedArg).toMatch(/Budget: \d+ minutes/);

      const [reloaded] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      // The regression this test guards: reject moves reviewing ->
      // in_progress, which re-enters the reconciler's budget-enforced pool
      // (task-reconciler.ts measures the deadline from claimedAt). Leaving
      // the original claim time would let the reconciler kill this session
      // using a deadline that predates however long the task already sat
      // in review, while the prompt above claims a fresh window.
      expect(reloaded.claimedAt).not.toBeNull();
      expect(reloaded.claimedAt!.getTime()).toBeGreaterThan(staleClaimedAt.getTime());

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("POST /api/tasks/:id/reject does NOT re-seed when the previous session is still active", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "reject-no-reseed-p", cwd },
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

    it("POST /api/tasks/:id/reject still records the new sessionId and 200s even when the re-seed spawn fails", async () => {
      // The re-seed's prompt is now delivered as spawn-time initialPrompt
      // argv, not a separate post-spawn stashSeed call (see task-claim.ts's
      // own doc comment) — there's no longer a "spawn already succeeded,
      // then a follow-up delivery step failed" window to test for a local
      // host. What replaces it: createSessionRecord/spawn itself failing
      // outright must still 200 with the OLD (unreseeded) sessionId
      // untouched, not 500 the whole reject request.
      const app = await buildApp();
      const cwd = createGitRepo();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "reject-spawn-fail-p", cwd },
      });
      const projectId = project.json().id;

      // The initial (source) session must actually spawn for real — only
      // installed AFTER it exists does the mock start failing `spawn`, or
      // it would break session creation itself, not just the re-seed.
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "claude" },
      });
      const oldSessionId = sessionRes.json().id;
      const { sessions } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");
      app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, oldSessionId)).run();

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "spawn") {
                return () => Promise.reject(new Error("host unreachable"));
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

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
      // Re-seed spawn failed — the OLD sessionId is left in place, not
      // silently nulled or 500ing the whole reject request.
      expect(res.json().sessionId).toBe(oldSessionId);

      resolveBackendSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // Independent post-Hermes review, PR #538 — the reject-flow re-seed
    // shares the exact version-skew risk claimTask/retryTask already cover
    // (test/services/task-claim.test.ts): a remote agent build too old to
    // know about `initialPrompt` silently strips it, so `seedDelivered`
    // must not be trusted as `true` just because the resolved agent's
    // adapter supports it locally.
    it("does not trust seedDelivered:true for a remote host that never confirms the re-seed prompt was applied (version skew)", async () => {
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        spawn: vi.fn().mockResolvedValue({}),
        liveStatus: vi.fn().mockResolvedValue({}),
        isMasterAlive: vi.fn().mockResolvedValue({}),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
      };
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      const app = await buildApp();
      const warnSpy = vi.spyOn(app.log, "warn");

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "reject-skew-p", cwd: "/remote/project", hostId },
      });
      const projectId = project.json().id;

      // A real (FK-valid) but non-"active" prior session — reseedIfSessionExited
      // only checks its status, never spawns through it directly.
      const { sessions } = await import("../../src/db/schema.js");
      const [oldSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "claude", status: "exited" })
        .returning()
        .all();

      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "under review",
          status: "reviewing",
          sessionId: oldSession.id,
          worktreePath: "/remote/project/.mullion-worktrees/mullion-task-x",
          branchName: "mullion/task-x",
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
      expect(res.json().sessionId).not.toBeNull();
      // command "claude" is seed-capable — a naive seedDelivered:seedCapable
      // would have reported true here despite the remote host never
      // confirming it applied the prompt.
      expect(res.json().seedDelivered).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, hostId }),
        expect.stringContaining("possible version skew"),
      );

      resolveBackendSpy.mockRestore();
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
        payload: { createDir: true, name: "approve-cleanup-p", cwd: "/tmp/approve-cleanup" },
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

  describe("POST /api/tasks/:id/merge", () => {
    async function createDoneTaskWithPR(
      app: Awaited<ReturnType<typeof buildApp>>,
      prNumber: number | null = 1,
    ) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: `merge-endpoint-p-${Math.random()}`, cwd: "/tmp" },
      });
      const projectId = project.json().id;
      const { tasks } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "done task",
          status: "done",
          completedAt: new Date(),
          prNumber,
          prUrl: prNumber !== null ? `https://github.com/o/r/pull/${prNumber}` : null,
        })
        .returning()
        .all();
      return row;
    }

    it("sets mergeRequestedAt and clears mergeError for a done task with a linked PR", async () => {
      const app = await buildApp();
      const task = await createDoneTaskWithPR(app);
      app.db
        .update(tasks)
        .set({ mergeError: "stale error from a prior attempt" })
        .where(eq(tasks.id, task.id))
        .run();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/merge` });
      expect(res.statusCode).toBe(200);
      expect(res.json().mergeRequestedAt).not.toBeNull();
      expect(res.json().mergeError).toBeNull();

      await app.close();
    });

    it("409s for a task not in status 'done'", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "merge-endpoint-not-done", cwd: "/tmp" },
      });
      const { tasks } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId: project.json().id, title: "still reviewing", status: "reviewing" })
        .returning()
        .all();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${row.id}/merge` });
      expect(res.statusCode).toBe(409);

      await app.close();
    });

    it("409s for a done task with no linked pull request", async () => {
      const app = await buildApp();
      const task = await createDoneTaskWithPR(app, null);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/merge` });
      expect(res.statusCode).toBe(409);

      await app.close();
    });

    it("404s for a task that doesn't exist", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/tasks/999999/merge" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("403s while Task Master is disabled", async () => {
      const app = await buildApp();
      try {
        const task = await createDoneTaskWithPR(app);
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });

        const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/merge` });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });
  });

  describe("POST /api/tasks/:id/give-up (#483)", () => {
    async function createProjectAndReviewingTask(app: Awaited<ReturnType<typeof buildApp>>) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "give-up-p", cwd: "/tmp/give-up" },
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
        payload: { createDir: true, name: "give-up-not-reviewing-p", cwd: "/tmp/give-up-2" },
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
        payload: { createDir: true, name: "give-up-cleanup-p", cwd: "/tmp/give-up-cleanup" },
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

    // #772 — nothing terminated a task's sessions on give-up either; both
    // lingered indefinitely once the task reached "failed".
    it("kills both the worker and review sessions on give-up", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "give-up-sessions-p", cwd: "/tmp/give-up-sessions" },
      });
      const projectId = project.json().id;
      const worker = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const reviewer = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "under review",
          status: "reviewing",
          sessionId: worker.json().id,
          reviewSessionId: reviewer.json().id,
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/give-up`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      const { sessions } = await import("../../src/db/schema.js");
      const [workerRow] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, worker.json().id))
        .all();
      const [reviewRow] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, reviewer.json().id))
        .all();
      expect(workerRow.status).toBe("killed");
      expect(reviewRow.status).toBe("killed");

      await app.close();
    });
  });

  describe("GET /api/tasks filters (6.2/#215)", () => {
    it("filters by status", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "filter-status-p", cwd: "/tmp/filter-status" },
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
          payload: { createDir: true, name: "filter-project-a", cwd: "/tmp/filter-project-a" },
        })
      ).json().id;
      const projectB = (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { createDir: true, name: "filter-project-b", cwd: "/tmp/filter-project-b" },
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
        payload: { createDir: true, name: "get-one-p", cwd: "/tmp/get-one" },
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
        payload: { createDir: true, name: "local-crud-p", cwd },
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

    it("POST /api/tasks creates a task with explicit agent and reviewAgent", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-agent-1");

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          projectId,
          title: "Task with agents",
          agent: "codex",
          reviewAgent: "agy",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        projectId,
        title: "Task with agents",
        agent: "codex",
        reviewAgent: "agy",
      });

      await app.close();
    });

    it("PATCH /api/tasks/:id updates agent and reviewAgent on backlog/ready tasks", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-agent-2");
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { projectId, title: "Task to patch agent" },
        })
      ).json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${created.id}`,
        payload: { agent: "opencode", reviewAgent: "none" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({
        agent: "opencode",
        reviewAgent: "none",
      });

      await app.close();
    });

    it("PATCH /api/tasks/:id 400s on invalid agent name", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-agent-3");
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { projectId, title: "Task to test bad agent" },
        })
      ).json();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${created.id}`,
        payload: { agent: "not-a-real-agent" },
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("PATCH /api/tasks/:id 409s attempting to edit agent once past backlog/ready", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-agent-4");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "in progress task", status: "in_progress" })
        .returning()
        .all();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${row.id}`,
        payload: { agent: "codex" },
      });
      expect(res.statusCode).toBe(409);

      await app.close();
    });

    it("PATCH /api/tasks/:id allows editing agent and reviewAgent on a failed task", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-agent-failed");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "failed task", status: "failed", agent: "claude" })
        .returning()
        .all();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${row.id}`,
        payload: { agent: "codex", reviewAgent: "none" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ agent: "codex", reviewAgent: "none" });

      await app.close();
    });

    it("POST /api/tasks/:id/claim applies agent override from request body", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProject(app, cwd);
      const [task] = app.db
        .insert(tasks)
        .values({ projectId, title: "Claim with override", status: "ready" })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/claim`,
        payload: { agent: "codex", reviewAgent: "none" },
      });
      expect(res.statusCode).toBe(202);

      // agentCommand is stamped at dispatch, not enqueue — called directly
      // and awaited for determinism (see the claim describe block above).
      const outcome = await dispatchClaimedTask(app, task.id);
      expect(outcome.ok).toBe(true);

      const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(check.json()).toMatchObject({
        agent: "codex",
        reviewAgent: "none",
        agentCommand: "codex",
      });

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

    // #729 — a GitHub-linked task auto-failed by a lost tracking label
    // (syncUnlabeledIssueToLocal) previously had no way out: not local
    // (issueNumber !== null) and past backlog/ready (failed), so it hit
    // both refusals above forever. These cases match isIssueStillTrackable's
    // own contract (task-github-sync.test.ts) at the route layer — confirmed
    // closed or unlabeled deletes a never-claimed (`branchName === null`)
    // task; still tracked, or unconfirmable, refuses — plus the separate
    // `branchName !== null` guard for a task that WAS claimed and has a
    // real branch Retry can resume, regardless of what its issue is doing.
    describe("DELETE of a failed GitHub-linked task (#729)", () => {
      async function createLinkedFailedTask(
        app: Awaited<ReturnType<typeof buildApp>>,
        cwd: string,
        issueNumber: number,
      ) {
        const projectId = await createProject(app, cwd);
        const [row] = app.db
          .insert(tasks)
          .values({
            projectId,
            issueNumber,
            title: "label-lost",
            htmlUrl: `https://github.com/acme/widgets-729/issues/${issueNumber}`,
            status: "failed",
            failureReason: "GitHub issue lost its tracking label",
          })
          .returning()
          .all();
        return row;
      }

      it("deletes once the linked issue is confirmed closed", async () => {
        const cwd = createGitRepoWithRemote("acme", "widgets-729");
        const app = await buildApp();
        await connectPat(app, "ghp_delete_closed");
        const githubWrite = await import("../../src/services/github-write.js");
        const getIssueStateSpy = vi
          .spyOn(githubWrite, "getIssueState")
          .mockResolvedValue({ state: "closed", labels: ["mullion-task"] });

        const row = await createLinkedFailedTask(app, cwd, 601);
        const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
        expect(res.statusCode).toBe(204);

        const listed = await app.inject({ method: "GET", url: "/api/tasks" });
        expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(false);

        getIssueStateSpy.mockRestore();
        await app.close();
      });

      // #729 (Hermes review) — the earlier version of this fix gated only on
      // `status === "failed"`, which also admitted a task that WAS claimed:
      // real worktree/branch behind it, Retry-recoverable, and its issue can
      // independently end up closed/unlabeled later (at promote time, a
      // maintainer tidying labels, ...). Deleting that row would silently
      // discard recoverable work — there's no cascade that cleans up
      // `worktreePath`/`branchName` on a task delete. `branchName !== null`
      // refuses it outright, before any GitHub call, regardless of what the
      // linked issue's current state is (this test's own mocked
      // getIssueState says "closed" and the delete must still be refused).
      it("refuses a claimed-then-failed task with a preserved branch, even if its issue is untrackable", async () => {
        const cwd = createGitRepoWithRemote("acme", "widgets-729-branch");
        const app = await buildApp();
        await connectPat(app, "ghp_delete_branch");
        const githubWrite = await import("../../src/services/github-write.js");
        const getIssueStateSpy = vi
          .spyOn(githubWrite, "getIssueState")
          .mockResolvedValue({ state: "closed", labels: [] });

        const projectId = await createProject(app, cwd);
        const [row] = app.db
          .insert(tasks)
          .values({
            projectId,
            issueNumber: 605,
            title: "claimed then died",
            htmlUrl: "https://github.com/acme/widgets-729-branch/issues/605",
            status: "failed",
            failureReason: "session exited unexpectedly",
            worktreePath: `${cwd}/.mullion-worktrees/mullion-task-605`,
            branchName: "mullion/task-605",
          })
          .returning()
          .all();

        const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
        expect(res.statusCode).toBe(409);
        expect(getIssueStateSpy).not.toHaveBeenCalled();

        const listed = await app.inject({ method: "GET", url: "/api/tasks" });
        expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(true);

        getIssueStateSpy.mockRestore();
        await app.close();
      });

      it("deletes once the linked issue is confirmed open but unlabeled", async () => {
        const cwd = createGitRepoWithRemote("acme", "widgets-729");
        const app = await buildApp();
        await connectPat(app, "ghp_delete_unlabeled");
        const githubWrite = await import("../../src/services/github-write.js");
        const getIssueStateSpy = vi
          .spyOn(githubWrite, "getIssueState")
          .mockResolvedValue({ state: "open", labels: ["bug"] });

        const row = await createLinkedFailedTask(app, cwd, 602);
        const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
        expect(res.statusCode).toBe(204);

        getIssueStateSpy.mockRestore();
        await app.close();
      });

      it("refuses when the linked issue is still open and labeled", async () => {
        const cwd = createGitRepoWithRemote("acme", "widgets-729");
        const app = await buildApp();
        await connectPat(app, "ghp_delete_still_tracked");
        const githubWrite = await import("../../src/services/github-write.js");
        const getIssueStateSpy = vi
          .spyOn(githubWrite, "getIssueState")
          .mockResolvedValue({ state: "open", labels: ["mullion-task"] });

        const row = await createLinkedFailedTask(app, cwd, 603);
        const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
        expect(res.statusCode).toBe(409);

        const listed = await app.inject({ method: "GET", url: "/api/tasks" });
        expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(true);

        getIssueStateSpy.mockRestore();
        await app.close();
      });

      it("refuses when the linked issue's state can't be confirmed (no GitHub connection)", async () => {
        // No connectPat call — resolveGitHubToken has nothing to hand back,
        // so isIssueStillTrackable returns undefined rather than false.
        const cwd = createGitRepoWithRemote("acme", "widgets-729-noauth");
        const app = await buildApp();

        const row = await createLinkedFailedTask(app, cwd, 604);
        const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
        expect(res.statusCode).toBe(409);
        await app.close();
      });
    });
  });
});
