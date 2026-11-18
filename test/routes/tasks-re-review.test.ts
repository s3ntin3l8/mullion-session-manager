import { describe, it, expect, vi } from "vitest";
import {
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  setupTasksRouteTestLifecycle,
} from "../helpers/tasks-routes-harness.js";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", () => mockTaskPromoteFactory());

const { buildApp } = await import("../../src/app.js");

describe("POST /api/tasks/:id/re-review (#1345)", () => {
  setupTasksRouteTestLifecycle("tasks-re-review-route-test");

  async function createInconclusiveReviewingTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    overrides: Partial<{
      lastReviewVerdict: string | null;
      status: "reviewing" | "in_progress" | "done" | "failed";
      inconclusiveReviewRearmCount: number;
      reviewSessionId: number | null;
      reviewFindingsIngestedSessionId: number | null;
    }> = {},
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: `re-review-p-${Math.random()}`,
        cwd: "/tmp",
      },
    });
    const projectId = project.json().id;
    const reviewSession =
      overrides.reviewSessionId === undefined
        ? await app
            .inject({
              method: "POST",
              url: "/api/sessions",
              payload: { projectId, command: "bash" },
            })
            .then((res) => res.json().id as number)
        : overrides.reviewSessionId;
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "stuck on inconclusive",
        status: overrides.status ?? "reviewing",
        // `?? "inconclusive"` would wrongly collapse an explicit
        // `lastReviewVerdict: null` override (the "never reviewed" test
        // below) back to the default — `??` can't distinguish "not
        // provided" from "provided as null".
        lastReviewVerdict:
          "lastReviewVerdict" in overrides ? overrides.lastReviewVerdict : "inconclusive",
        lastReviewVerdictAt: new Date(),
        reviewSessionId: reviewSession,
        reviewFindingsIngestedSessionId:
          "reviewFindingsIngestedSessionId" in overrides
            ? overrides.reviewFindingsIngestedSessionId
            : reviewSession,
        reviewSeedDelivered: true,
        inconclusiveReviewRearmCount: overrides.inconclusiveReviewRearmCount ?? 0,
      })
      .returning()
      .all();
    return { task: row, projectId, reviewSessionId: reviewSession };
  }

  it("re-arms a task stuck on inconclusive: nulls the review columns, kills the stale session, increments the rearm count", async () => {
    const app = await buildApp();
    const { task, reviewSessionId } = await createInconclusiveReviewingTask(app);

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "reviewing",
      reviewSessionId: null,
      reviewFindingsIngestedSessionId: null,
      reviewSeedDelivered: null,
      reviewSpawnClaimedAt: null,
      inconclusiveReviewRearmCount: 1,
    });

    const { sessions } = await import("../../src/db/schema.js");
    const [sessionRow] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, reviewSessionId!))
      .all();
    expect(sessionRow.status).toBe("killed");

    await app.close();
  });

  // The one thing distinguishing this from the automatic sweep — a task
  // already at (or past) the sweep's own inconclusiveReviewRearmCount < 1
  // bound can still re-review here. A human explicitly choosing this is a
  // stronger signal than the automatic sweep's own conservative cap.
  it("has no inconclusiveReviewRearmCount upper bound — re-arms a task already at count 1", async () => {
    const app = await buildApp();
    const { task } = await createInconclusiveReviewingTask(app, {
      inconclusiveReviewRearmCount: 1,
    });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inconclusiveReviewRearmCount: 2 });

    await app.close();
  });

  it("409s when the task's status isn't 'reviewing'", async () => {
    const app = await buildApp();
    const { task } = await createInconclusiveReviewingTask(app, { status: "in_progress" });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('"in_progress"');

    await app.close();
  });

  it("409s when the last review verdict is null — never actually reviewed", async () => {
    const app = await buildApp();
    const { task } = await createInconclusiveReviewingTask(app, { lastReviewVerdict: null });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('"none"');

    await app.close();
  });

  it("409s when there is no review session to re-arm", async () => {
    const app = await buildApp();
    const { task } = await createInconclusiveReviewingTask(app, { reviewSessionId: null });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

    expect(res.statusCode).toBe(409);

    await app.close();
  });

  // #2369 — a review by an external reviewer is a run, not a session: the
  // route has to re-arm it by the run columns, with no session to kill.
  describe("an external reviewer's run (#2369)", () => {
    const run = {
      reviewRunId: "run_stuck",
      reviewRunDispatchedAt: new Date(Date.now() - 2 * 60 * 60_000),
      reviewRunHeadSha: "sha-1",
      reviewRunIngestedId: "run_stuck",
    };

    async function createInconclusiveRunTask(
      app: Awaited<ReturnType<typeof buildApp>>,
      overrides: Partial<typeof tasks.$inferInsert> = {},
    ) {
      const { task } = await createInconclusiveReviewingTask(app, { reviewSessionId: null });
      app.db
        .update(tasks)
        .set({ ...run, ...overrides })
        .where(eq(tasks.id, task.id))
        .run();
      return task;
    }

    it("re-arms a run stuck on inconclusive: clears every run column and counts the re-arm", async () => {
      const app = await buildApp();
      const task = await createInconclusiveRunTask(app);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "reviewing",
        reviewRunId: null,
        reviewRunIngestedId: null,
        reviewRunDispatchedAt: null,
        inconclusiveReviewRearmCount: 1,
      });
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.reviewRunHeadSha).toBeNull();

      await app.close();
    });

    it("409s while the current run's verdict is not in yet, even though the verdict still reads inconclusive from before", async () => {
      const app = await buildApp();
      const task = await createInconclusiveRunTask(app, { reviewRunIngestedId: null });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

      expect(res.statusCode).toBe(409);
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.reviewRunId).toBe("run_stuck");

      await app.close();
    });
  });

  // Hermes review finding — a prior re-review (this route, or the
  // automatic sweep) nulls reviewFindingsIngestedSessionId and kills the
  // stale session; the reconciler later spawns a FRESH review session
  // and sets reviewSessionId to it, but reviewFindingsIngestedSessionId
  // stays null until THAT session's own findings are ingested.
  // lastReviewVerdict, meanwhile, is left over from before and still
  // reads "inconclusive" the whole time. Without this route also
  // checking reviewFindingsIngestedSessionId (mirroring
  // reannounceInconclusiveReviewsAfterGrace's own isNotNull guard), a
  // second click during that window would pass every other check here
  // and kill a legitimately-running, not-yet-stalled review session.
  it("409s when reviewSessionId is fresh (not yet ingested) even though lastReviewVerdict still reads inconclusive from before", async () => {
    const app = await buildApp();
    const { task, reviewSessionId } = await createInconclusiveReviewingTask(app, {
      reviewFindingsIngestedSessionId: null,
    });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

    expect(res.statusCode).toBe(409);
    const { sessions } = await import("../../src/db/schema.js");
    const [sessionRow] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, reviewSessionId!))
      .all();
    // The fresh session must survive — this is the whole point of the
    // guard.
    expect(sessionRow.status).not.toBe("killed");

    await app.close();
  });

  it("404s for an unknown task id", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "POST", url: "/api/tasks/999999/re-review" });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  // A single synchronous app.inject() call can't construct a TRUE race
  // (nothing else runs between this route's own read and its CAS write
  // within one request) — this instead proves the row already having
  // moved on by request time (a give-up/reject/approve, or the automatic
  // sweep, that landed before this request started) is caught, and no
  // session gets killed for a row this call doesn't own. The route's own
  // CAS write (task-reconciler.ts's reannounceInconclusiveReviewsAfterGrace
  // uses the identical shape) is the second, defense-in-depth layer for
  // the narrower window a genuine mid-request race would need — that
  // exact branch isn't independently exercised here, matching this
  // file's own existing reject/give-up tests, which don't test their own
  // analogous CAS-loss branch either.
  it("409s and does not kill the session when the review state already changed before this request", async () => {
    const app = await buildApp();
    const { task, reviewSessionId } = await createInconclusiveReviewingTask(app);
    const { tasks: tasksTable } = await import("../../src/db/schema.js");
    // A give-up (or reject/approve) that already landed before this
    // request started.
    app.db.update(tasksTable).set({ status: "failed" }).where(eq(tasksTable.id, task.id)).run();

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

    expect(res.statusCode).toBe(409);
    const { sessions } = await import("../../src/db/schema.js");
    const [sessionRow] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, reviewSessionId!))
      .all();
    expect(sessionRow.status).not.toBe("killed");

    await app.close();
  });

  // Same "escape hatch, not new autonomous work" carve-out as reject/
  // give-up — a human explicitly re-arming a stuck task must not be
  // blocked by a disabled install, or a disabled install would
  // permanently strand exactly the task this route exists to unstick.
  it("works even when Task Master is disabled", async () => {
    process.env.MULLION_TASK_MASTER_ENABLED = "false";
    try {
      const app = await buildApp();
      const { task } = await createInconclusiveReviewingTask(app);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ reviewSessionId: null });

      await app.close();
    } finally {
      process.env.MULLION_TASK_MASTER_ENABLED = "true";
    }
  });
});
