import { describe, it, expect, vi } from "vitest";
import {
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  createGitRepo,
  setupTasksRouteTestLifecycle,
} from "../helpers/tasks-routes-harness.js";
import fs from "node:fs";
import { deriveTaskBranchName, deriveWorktreePath } from "../../src/services/git-worktree.js";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", () => mockTaskPromoteFactory());

const { buildApp } = await import("../../src/app.js");
const { dispatchClaimedTask } = await import("../../src/services/task-claim.js");

describe("POST /api/tasks/:id/claim (issue #216)", () => {
  setupTasksRouteTestLifecycle("tasks-claim-route-test");

  async function createProjectWithGitRepo(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "claim-p", cwd },
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
    // Branch/worktree dir is derived from task.id (for uniqueness — see
    // deriveTaskBranchName's own doc comment on why the id is in the
    // name) plus a sanitized title slug, not issueNumber (Hermes review,
    // PR #471) — issueNumber is nullable now (6.9), so branching on it
    // would collide every local task onto the same dir.
    const branchName = deriveTaskBranchName(task);
    const predictedCwd = deriveWorktreePath(cwd, branchName);
    expect(queued.worktreePath).toBe(predictedCwd);
    // Predicted, not yet real — nothing on disk until dispatch runs.
    expect(fs.existsSync(predictedCwd)).toBe(false);

    const outcome = await dispatchClaimedTask(app, task.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    const session = outcome.session;
    expect(session.projectId).toBe(projectId);
    expect(session.cwd).toBe(predictedCwd);
    expect(fs.existsSync(session.cwd!)).toBe(true);

    const listed = await app.inject({ method: "GET", url: "/api/tasks" });
    const dispatched = (
      listed.json() as {
        id: number;
        status: string;
        sessionId: number;
        worktreePath: string | null;
        branchName: string | null;
        claimedAt: string | null;
      }[]
    ).find((t) => t.id === task.id);
    expect(dispatched).toMatchObject({
      status: "in_progress",
      sessionId: session.id,
      worktreePath: session.cwd,
      branchName,
    });
    expect(dispatched!.claimedAt).not.toBeNull();

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

  it("409s when the task is archived", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProjectWithGitRepo(app, cwd);
    const task = insertTask(app, projectId, 44);
    app.db.update(tasks).set({ archivedAt: new Date() }).where(eq(tasks.id, task.id)).run();

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("archived");

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
      payload: { allowDuplicate: true, name: "remote-p", cwd: "/tmp/remote", hostId },
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
