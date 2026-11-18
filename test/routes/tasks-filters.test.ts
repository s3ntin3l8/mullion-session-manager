import { describe, it, expect, vi } from "vitest";
import {
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  setupTasksRouteTestLifecycle,
} from "../helpers/tasks-routes-harness.js";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", () => mockTaskPromoteFactory());

const { buildApp } = await import("../../src/app.js");

describe("GET /api/tasks filters (6.2/#215)", () => {
  setupTasksRouteTestLifecycle("tasks-filters-route-test");

  it("filters by status", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "filter-status-p",
        cwd: "/tmp/filter-status",
      },
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
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "filter-project-a",
          cwd: "/tmp/filter-project-a",
        },
      })
    ).json().id;
    const projectB = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "filter-project-b",
          cwd: "/tmp/filter-project-b",
        },
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
      payload: { allowDuplicate: true, createDir: true, name: "get-one-p", cwd: "/tmp/get-one" },
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

  // Hermes review, PR #818 — TASK_ROW_COLUMNS (this file) previously
  // omitted mergeRequestedAt/mergeError/releaseRequestedAt/releaseError
  // entirely, so both GET routes silently dropped them from the response
  // even though the reconciler writes and TaskDetail.tsx reads all four.
  // `undefined !== null` reads as true, so the frontend's pending hint
  // rendered unconditionally and a real error could never surface — a
  // regression that shipped invisibly because every test asserting these
  // fields exercised a POST action's own `.returning()` response, never
  // the GET read path. Covers both GET /api/tasks and GET /api/tasks/:id
  // so a future TASK_ROW_COLUMNS edit can't silently drop them again.
  it("GET /api/tasks and GET /api/tasks/:id include mergeRequestedAt/mergeError/releaseRequestedAt/releaseError", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "row-columns-p",
        cwd: "/tmp/row-columns",
      },
    });
    const { tasks } = await import("../../src/db/schema.js");
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "row-columns",
        status: "done",
        mergeRequestedAt: new Date(),
        mergeError: "conflicts with main",
        releaseRequestedAt: new Date(),
        releaseError: "no open release-please PR yet",
      })
      .returning()
      .all();

    const listRes = await app.inject({ method: "GET", url: "/api/tasks" });
    const listed = (
      listRes.json() as Array<{
        id: number;
        mergeRequestedAt: string | null;
        releaseRequestedAt: string | null;
      }>
    ).find((t) => t.id === row.id);
    expect(listed).toMatchObject({
      mergeError: "conflicts with main",
      releaseError: "no open release-please PR yet",
    });
    expect(listed?.mergeRequestedAt).not.toBeNull();
    expect(listed?.releaseRequestedAt).not.toBeNull();

    const detailRes = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
    expect(detailRes.json()).toMatchObject({
      mergeError: "conflicts with main",
      releaseError: "no open release-please PR yet",
    });

    await app.close();
  });

  // #761 — prTitle was written by task-reconciler.ts and read by
  // task-promote.ts, but never added to TASK_ROW_COLUMNS, the exact
  // silent-drop this suite's own comment above records biting #816/#818.
  // Deliberately reads the GET path, not a POST/insert's own row, since
  // TASK_ROW_COLUMNS is what a `.returning()` bypasses entirely.
  it("GET /api/tasks and GET /api/tasks/:id include prTitle", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "pr-title-p",
        cwd: "/tmp/pr-title-columns",
      },
    });
    const { tasks } = await import("../../src/db/schema.js");
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "pr-title-columns",
        status: "reviewing",
        prTitle: "fix(tasks): stop it exploding on Tuesdays",
      })
      .returning()
      .all();

    const listRes = await app.inject({ method: "GET", url: "/api/tasks" });
    const listed = (listRes.json() as Array<{ id: number }>).find((t) => t.id === row.id);
    expect(listed).toMatchObject({ prTitle: "fix(tasks): stop it exploding on Tuesdays" });

    const detailRes = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
    expect(detailRes.json()).toMatchObject({
      prTitle: "fix(tasks): stop it exploding on Tuesdays",
    });

    await app.close();
  });

  // #2234 — withApprovalState (routes/tasks.ts): an approving verdict whose
  // findings are ingested, waiting on a human (or on the auto-approve sweep).
  describe("approvalState", () => {
    async function seed(opts: {
      autoApprove: boolean;
      status?: "reviewing" | "in_progress";
      verdict: string | null;
      ingested: boolean;
      withReviewSession?: boolean;
      prNumber?: number | null;
      taskMasterEnabled?: boolean;
      rebaseStartedAt?: Date;
      // The spawn pass only starts a reviewer for a task with a worktree and
      // a resolvable review agent; reviewPhase promises nothing otherwise.
      worktreePath?: string | null;
      reviewAgent?: string | null;
      reviewRunId?: string | null;
    }) {
      // resolveTaskMasterConfig reads the env at request time; the describe
      // block's default is on (top-level beforeAll), so restore it after.
      if (opts.taskMasterEnabled === false) process.env.MULLION_TASK_MASTER_ENABLED = "false";
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "approval-state",
          cwd: "/tmp/approval-state",
        },
      });
      const projectId = res.json().id as number;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { autoApprove: opts.autoApprove },
      });
      const { tasks, sessions } = await import("../../src/db/schema.js");
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "claude", status: "exited" })
        .returning()
        .all();
      const withReview = opts.withReviewSession !== false;
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "t",
          status: opts.status ?? "reviewing",
          reviewSessionId: withReview ? session.id : null,
          reviewFindingsIngestedSessionId: opts.ingested && withReview ? session.id : null,
          lastReviewVerdict: opts.verdict,
          prNumber: opts.prNumber === undefined ? 12 : opts.prNumber,
          rebaseStartedAt: opts.rebaseStartedAt ?? null,
          rebaseAttempts: opts.rebaseStartedAt ? 1 : 0,
          worktreePath: opts.worktreePath === undefined ? "/tmp/wt-x" : opts.worktreePath,
          reviewAgent: opts.reviewAgent === undefined ? "claude" : opts.reviewAgent,
          reviewRunId: opts.reviewRunId ?? null,
        })
        .returning()
        .all();
      return { app, taskId: row.id };
    }

    it.each([
      ["unsent:1:r0:x0", true],
      ["run_abc", false],
      [null, false],
    ])("derives reviewRunUnsent from run id %s (UI never reads the marker)", async (id, want) => {
      const { app, taskId } = await seed({
        autoApprove: false,
        verdict: null,
        ingested: false,
        withReviewSession: false,
        reviewRunId: id,
      });
      const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
      expect(res.json().reviewRunUnsent).toBe(want);
      await app.close();
    });

    it("reports reviewPhase=rebasing with a re-review time after an auto-rebase cleared the review", async () => {
      // the timestamp column stores whole seconds
      const started = new Date(Math.floor((Date.now() - 5 * 60_000) / 1000) * 1000);
      const { app, taskId } = await seed({
        autoApprove: true,
        verdict: "approved",
        ingested: false,
        withReviewSession: false,
        rebaseStartedAt: started,
      });
      const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
      const body = res.json();
      expect(body.approvalState).toBeNull();
      expect(body.reviewPhase).toBe("rebasing");
      expect(body.reReviewAt).toBe(started.getTime() + 30 * 60_000);
      expect(body.rebaseAttempts).toBe(1);
      // rebaseStartedAt stays in the payload (the PR sidebar reads it); the
      // reviewer-resolution input does not.
      expect(body.rebaseStartedAt).toBe(started.toISOString());
      expect(body).not.toHaveProperty("projectDefaultReviewAgent");
      await app.close();
    });

    it("reports no-reviewer when no review agent resolves, and nothing when Task Master is off", async () => {
      const noReviewer = await seed({
        autoApprove: true,
        verdict: null,
        ingested: false,
        withReviewSession: false,
        reviewAgent: "none",
      });
      const res = await noReviewer.app.inject({
        method: "GET",
        url: `/api/tasks/${noReviewer.taskId}`,
      });
      expect(res.json()).toMatchObject({ reviewPhase: "no-reviewer", reReviewAt: null });
      await noReviewer.app.close();

      try {
        const off = await seed({
          autoApprove: true,
          verdict: null,
          ingested: false,
          withReviewSession: false,
          taskMasterEnabled: false,
        });
        const offRes = await off.app.inject({ method: "GET", url: `/api/tasks/${off.taskId}` });
        expect(offRes.json().reviewPhase).toBeNull();
        await off.app.close();
      } finally {
        process.env.MULLION_TASK_MASTER_ENABLED = "true";
      }
    });

    it("reports reviewPhase=awaiting-review for a reviewing task with no reviewer and no rebase", async () => {
      const { app, taskId } = await seed({
        autoApprove: true,
        verdict: null,
        ingested: false,
        withReviewSession: false,
      });
      const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
      expect(res.json()).toMatchObject({ reviewPhase: "awaiting-review", reReviewAt: null });
      await app.close();
    });

    it("is awaiting-human for an ingested approving verdict on a manual-approve project", async () => {
      const { app, taskId } = await seed({
        autoApprove: false,
        verdict: "approved-with-suggestions",
        ingested: true,
      });
      const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
      expect(res.json().approvalState).toBe("awaiting-human");
      expect(res.json()).not.toHaveProperty("projectAutoApprove");
      const list = await app.inject({ method: "GET", url: "/api/tasks" });
      expect(list.json().find((t: { id: number }) => t.id === taskId).approvalState).toBe(
        "awaiting-human",
      );
      await app.close();
    });

    it("is auto-pending when the project auto-approves", async () => {
      const { app, taskId } = await seed({
        autoApprove: true,
        verdict: "approved",
        ingested: true,
      });
      const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
      expect(res.json().approvalState).toBe("auto-pending");
      await app.close();
    });

    it("is awaiting-human, not auto-pending, when the sweep can't act: no PR yet", async () => {
      const { app, taskId } = await seed({
        autoApprove: true,
        verdict: "approved",
        ingested: true,
        prNumber: null,
      });
      const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
      expect(res.json().approvalState).toBe("awaiting-human");
      await app.close();
    });

    it("is awaiting-human, not auto-pending, when Task Master is off", async () => {
      try {
        const { app, taskId } = await seed({
          autoApprove: true,
          verdict: "approved",
          ingested: true,
          taskMasterEnabled: false,
        });
        const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
        expect(res.json().approvalState).toBe("awaiting-human");
        const list = await app.inject({ method: "GET", url: "/api/tasks" });
        expect(list.json().find((t: { id: number }) => t.id === taskId).approvalState).toBe(
          "awaiting-human",
        );
        await app.close();
      } finally {
        process.env.MULLION_TASK_MASTER_ENABLED = "true";
      }
    });

    it("PATCH returns the same derived shape as GET", async () => {
      const { app, taskId } = await seed({
        autoApprove: false,
        verdict: "approved",
        ingested: true,
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${taskId}`,
        payload: { boardOrder: 3 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ approvalState: "awaiting-human", boardOrder: 3 });
      expect(res.json()).not.toHaveProperty("projectAutoApprove");
      await app.close();
    });

    it.each([
      ["changes-requested", true, "reviewing", true],
      [null, true, "reviewing", true],
      ["approved", false, "reviewing", true],
      ["approved", true, "in_progress", true],
      ["approved", true, "reviewing", false],
    ] as const)(
      "is null for verdict=%s ingested=%s status=%s reviewSession=%s",
      async (verdict, ingested, status, withReviewSession) => {
        const { app, taskId } = await seed({
          autoApprove: false,
          verdict,
          ingested,
          status,
          withReviewSession,
        });
        const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
        expect(res.json().approvalState).toBeNull();
        await app.close();
      },
    );
  });

  // withPrTitleFallback (routes/tasks.ts) — the actual "should a human
  // look at this" signal, deliberately NOT the same as `prTitle === null`
  // (see that function's own doc comment): only true when the project
  // wants Conventional Commits titles, a PR exists, and the title that
  // would actually be used isn't Conventional-Commits-shaped.
  describe("prTitleFallback", () => {
    async function projectWithFlag(
      app: Awaited<ReturnType<typeof buildApp>>,
      cwd: string,
      conventionalCommitTitles: boolean,
    ) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: cwd, cwd: `/tmp/${cwd}` },
      });
      const projectId = res.json().id as number;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { conventionalCommitTitles },
      });
      return projectId;
    }

    it("is true when the flag is on, a PR is open, and neither title is conventional", async () => {
      const app = await buildApp();
      const projectId = await projectWithFlag(app, "pr-title-fallback-true", true);
      const { tasks } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "[T2-7b] OTG: fail stage on BLAKE3 mismatch",
          status: "reviewing",
          prUrl: "https://github.com/o/r/pull/1",
          prTitle: null,
        })
        .returning()
        .all();

      const res = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
      expect(res.json()).toMatchObject({ prTitleFallback: true });

      await app.close();
    });

    it("is false when the issue title is already conventional, even with prTitle null", async () => {
      const app = await buildApp();
      const projectId = await projectWithFlag(app, "pr-title-fallback-issue-ok", true);
      const { tasks } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "fix(tasks): stop it exploding on Tuesdays",
          status: "reviewing",
          prUrl: "https://github.com/o/r/pull/1",
          prTitle: null,
        })
        .returning()
        .all();

      const res = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
      expect(res.json()).toMatchObject({ prTitleFallback: false });

      await app.close();
    });

    it("is false when the worker supplied a usable prTitle", async () => {
      const app = await buildApp();
      const projectId = await projectWithFlag(app, "pr-title-fallback-worker-ok", true);
      const { tasks } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "[T2-7b] OTG: fail stage on BLAKE3 mismatch",
          status: "reviewing",
          prUrl: "https://github.com/o/r/pull/1",
          prTitle: "fix(sync): fail the stage on a BLAKE3 mismatch",
        })
        .returning()
        .all();

      const res = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
      expect(res.json()).toMatchObject({ prTitleFallback: false });

      await app.close();
    });

    it("is false when the project has the flag off", async () => {
      const app = await buildApp();
      const projectId = await projectWithFlag(app, "pr-title-fallback-flag-off", false);
      const { tasks } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "[T2-7b] OTG: fail stage on BLAKE3 mismatch",
          status: "reviewing",
          prUrl: "https://github.com/o/r/pull/1",
          prTitle: null,
        })
        .returning()
        .all();

      const res = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
      expect(res.json()).toMatchObject({ prTitleFallback: false });

      await app.close();
    });

    it("is false when no PR has been opened yet", async () => {
      const app = await buildApp();
      const projectId = await projectWithFlag(app, "pr-title-fallback-no-pr", true);
      const { tasks } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "[T2-7b] OTG: fail stage on BLAKE3 mismatch",
          status: "in_progress",
          prUrl: null,
          prTitle: null,
        })
        .returning()
        .all();

      const res = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
      expect(res.json()).toMatchObject({ prTitleFallback: false });

      await app.close();
    });
  });
});
