import { describe, it, expect, vi } from "vitest";
import {
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  taskPromoteMocks,
  fakeSessionBackend,
  git,
  gitOutput,
  createGitRepo,
  createGitRepoWithRemote,
  connectPat,
  setupTasksRouteTestLifecycle,
} from "../helpers/tasks-routes-harness.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn as childProcessSpawn } from "node:child_process";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", () => mockTaskPromoteFactory());

const { buildApp } = await import("../../src/app.js");

describe("approve/reject (6.2/#215, promotion added in 6.7/#220)", () => {
  setupTasksRouteTestLifecycle("tasks-approve-reject-route-test");

  async function createProjectAndReviewingTask(app: Awaited<ReturnType<typeof buildApp>>) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "approve-reject-p",
        cwd: "/tmp/approve-reject",
      },
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
    expect(taskPromoteMocks.promoteTaskToPR).toHaveBeenCalledTimes(1);

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
    taskPromoteMocks.promoteTaskToPR.mockResolvedValue({
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

  it("POST /api/tasks/:id/approve maps a held workflow change to a 409 with a machine-readable code", async () => {
    const app = await buildApp();
    const task = await createProjectAndReviewingTask(app);
    taskPromoteMocks.promoteTaskToPR.mockResolvedValue({
      ok: false,
      reason: "workflow-approval-required",
      detail:
        "This branch changes .github/workflows/ci.yml — approve the workflow change to push it",
    });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: "workflow-approval-required",
      message: expect.stringContaining("ci.yml"),
    });
    const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(check.json().status).toBe("reviewing");

    await app.close();
  });

  describe("POST /api/tasks/:id/approve-workflow-change", () => {
    const SHA = "a".repeat(40);
    const post = (app: Awaited<ReturnType<typeof buildApp>>, id: number, body: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/tasks/${id}/approve-workflow-change`,
        payload: body as object,
      });

    it("rejects a body whose sha is not a full commit id", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);
      expect((await post(app, task.id, { sha: "abc" })).statusCode).toBe(400);
      expect((await post(app, task.id, {})).statusCode).toBe(400);
      await app.close();
    });

    it("404s for an unknown task", async () => {
      const app = await buildApp();
      expect((await post(app, 999999, { sha: SHA })).statusCode).toBe(404);
      await app.close();
    });

    it("409s when no workflow change is waiting", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);
      const res = await post(app, task.id, { sha: SHA });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toContain("No workflow change");
      await app.close();
    });

    it("approves the head commit the operator was shown, and refuses once the branch moves", async () => {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);
      const { tasks } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");

      const wt = fs.mkdtempSync(path.join(os.tmpdir(), "approve-wf-wt-"));
      git(wt, ["init", "-b", "main"]);
      fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
      git(wt, ["add", "-A"]);
      git(wt, ["commit", "-m", "initial", "--no-verify"]);
      git(wt, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      git(wt, ["checkout", "-b", "mullion/task-wf"]);
      fs.mkdirSync(path.join(wt, ".github", "workflows"), { recursive: true });
      fs.writeFileSync(path.join(wt, ".github", "workflows", "ci.yml"), "name: ci\n");
      git(wt, ["add", "-A"]);
      git(wt, ["commit", "-m", "touch ci", "--no-verify"]);
      const head = gitOutput(wt, ["rev-parse", "HEAD"]).trim();

      app.db
        .update(tasks)
        .set({
          worktreePath: wt,
          workflowChange: JSON.stringify({ sha: head, files: [".github/workflows/ci.yml"] }),
        })
        .where(eq(tasks.id, task.id))
        .run();

      // A sha other than the current head is refused as stale.
      const stale = await post(app, task.id, { sha: SHA });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "workflow-change-stale" });

      const ok = await post(app, task.id, { sha: head });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true, sha: head });
      const row = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
      expect(row.workflowApprovedSha).toBe(head);
      expect(row.workflowChange).toBeNull();

      fs.rmSync(wt, { recursive: true, force: true });
      await app.close();
    });
  });

  it("POST /api/tasks/:id/approve maps push-failed to a 502, task stays reviewing", async () => {
    const app = await buildApp();
    const task = await createProjectAndReviewingTask(app);
    taskPromoteMocks.promoteTaskToPR.mockResolvedValue({
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
      taskPromoteMocks.promoteTaskToPR.mockResolvedValue({
        ok: false,
        reason,
        detail: `stub: ${reason}`,
      });

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
    taskPromoteMocks.promoteTaskToPR.mockImplementation(async () => {
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
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "not-reviewing-p",
        cwd: "/tmp/not-reviewing",
      },
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

  // #1020 — advisory-only tracking-epic guard. A tracking epic
  // (subIssueTotal > 0) with outstanding OPEN children (total - completed
  // > 0) used to close silently on Approve, leaving its children still
  // open. The fix warns before closing, but does NOT hard-block — a
  // human who wants to close a deprioritized epic should still be able
  // to (the route returns 409, the UI confirms, and the second call uses
  // ?force=true to bypass the warning).
  it("POST /api/tasks/:id/approve 409s with a tracking-epic warning when the underlying issue is a tracking epic with open sub-issues, and posts a heads-up comment on the issue", async () => {
    const cwd = createGitRepoWithRemote("acme", "widgets-1020-warn");
    const app = await buildApp();
    await connectPat(app, "ghp_1020_warn");
    const projectId = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "epic-warn-p", cwd },
      })
    ).json().id;
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 1020,
        title: "Big epic",
        htmlUrl: "https://github.com/acme/widgets-1020-warn/issues/1020",
        status: "reviewing",
        subIssueTotal: 5,
        subIssueCompleted: 2,
      })
      .returning()
      .all();

    const githubWrite = await import("../../src/services/github-write.js");
    const createCommentSpy = vi.spyOn(githubWrite, "createComment").mockResolvedValue({
      id: 1,
      htmlUrl: "https://github.com/acme/widgets-1020-warn/issues/1020#issuecomment-1",
    });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe("tracking-epic-with-open-sub-issues");
    expect(body.subIssueStatus).toBe("5 sub-issues, 2 completed, 3 open");
    expect(createCommentSpy).toHaveBeenCalledTimes(1);
    const commentArgs = createCommentSpy.mock.calls[0];
    expect(commentArgs[3]).toBe(1020);
    expect(commentArgs[4]).toMatch(/5 sub-issues/);
    expect(commentArgs[4]).toMatch(/2 completed/);
    expect(commentArgs[4]).toMatch(/3 open/);
    expect(taskPromoteMocks.promoteTaskToPR).not.toHaveBeenCalled();
    // Task stayed in reviewing.
    const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(check.json().status).toBe("reviewing");

    createCommentSpy.mockRestore();
    await app.close();
  });

  it("POST /api/tasks/:id/approve?force=true proceeds with the close when the human confirms despite the tracking-epic warning", async () => {
    const cwd = createGitRepoWithRemote("acme", "widgets-1020-force");
    const app = await buildApp();
    await connectPat(app, "ghp_1020_force");
    const projectId = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "epic-force-p", cwd },
      })
    ).json().id;
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 1021,
        title: "Big epic (force-confirmed)",
        htmlUrl: "https://github.com/acme/widgets-1020-force/issues/1021",
        status: "reviewing",
        subIssueTotal: 5,
        subIssueCompleted: 2,
      })
      .returning()
      .all();

    const githubWrite = await import("../../src/services/github-write.js");
    const createCommentSpy = vi
      .spyOn(githubWrite, "createComment")
      .mockResolvedValue({ id: 1, htmlUrl: "x" });

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/approve?force=true`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("done");
    expect(taskPromoteMocks.promoteTaskToPR).toHaveBeenCalledTimes(1);
    // No warning comment on the force path — the warning's purpose is to
    // prompt a confirmation, and the human just confirmed. A second
    // comment would just clutter the issue.
    expect(createCommentSpy).not.toHaveBeenCalled();

    createCommentSpy.mockRestore();
    await app.close();
  });

  it("POST /api/tasks/:id/approve does not warn when subIssueTotal is zero (a leaf task)", async () => {
    const cwd = createGitRepoWithRemote("acme", "widgets-1020-leaf");
    const app = await buildApp();
    await connectPat(app, "ghp_1020_leaf");
    const projectId = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "epic-leaf-p", cwd },
      })
    ).json().id;
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 1022,
        title: "Leaf task",
        htmlUrl: "https://github.com/acme/widgets-1020-leaf/issues/1022",
        status: "reviewing",
        subIssueTotal: 0,
        subIssueCompleted: 0,
      })
      .returning()
      .all();

    const githubWrite = await import("../../src/services/github-write.js");
    const createCommentSpy = vi
      .spyOn(githubWrite, "createComment")
      .mockResolvedValue({ id: 1, htmlUrl: "x" });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });

    expect(res.statusCode).toBe(200);
    expect(taskPromoteMocks.promoteTaskToPR).toHaveBeenCalledTimes(1);
    expect(createCommentSpy).not.toHaveBeenCalled();

    createCommentSpy.mockRestore();
    await app.close();
  });

  it("POST /api/tasks/:id/approve treats null subIssueTotal as 0 (untracked legacy row)", async () => {
    const cwd = createGitRepoWithRemote("acme", "widgets-1020-null");
    const app = await buildApp();
    await connectPat(app, "ghp_1020_null");
    const projectId = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "epic-null-p", cwd },
      })
    ).json().id;
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 1023,
        title: "Legacy task with no sub-issue counts",
        htmlUrl: "https://github.com/acme/widgets-1020-null/issues/1023",
        status: "reviewing",
        subIssueTotal: null,
        subIssueCompleted: null,
      })
      .returning()
      .all();

    const githubWrite = await import("../../src/services/github-write.js");
    const createCommentSpy = vi
      .spyOn(githubWrite, "createComment")
      .mockResolvedValue({ id: 1, htmlUrl: "x" });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/approve` });

    expect(res.statusCode).toBe(200);
    expect(taskPromoteMocks.promoteTaskToPR).toHaveBeenCalledTimes(1);
    expect(createCommentSpy).not.toHaveBeenCalled();

    createCommentSpy.mockRestore();
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

  // Issue #1038 — Reject is the escape hatch a capped, genuinely
  // parked task relies on; it must clear autoReturnCapAnnouncedAt in the
  // same write, or the board would keep claiming "needs a human" on a
  // task a human has, in fact, just acted on.
  it("POST /api/tasks/:id/reject clears a stale cap-announced marker", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "reject-clears-cap-p",
        cwd: "/tmp",
      },
    });
    const { tasks } = await import("../../src/db/schema.js");
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "capped and announced",
        status: "reviewing",
        autoReturnRounds: 2,
        autoReturnCapAnnouncedAt: new Date(),
      })
      .returning()
      .all();

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${row.id}/reject`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "in_progress", autoReturnCapAnnouncedAt: null });

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
      expect(taskPromoteMocks.promoteTaskToPR).not.toHaveBeenCalled();

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
      payload: { allowDuplicate: true, createDir: true, name: "reject-reseed-p", cwd },
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
      payload: { allowDuplicate: true, createDir: true, name: "reject-reseed-content-p", cwd },
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

  it("POST /api/tasks/:id/reject fails the task explicitly when the re-seed spawn fails (issue #987)", async () => {
    // The re-seed's prompt is now delivered as spawn-time initialPrompt
    // argv, not a separate post-spawn stashSeed call (see task-claim.ts's
    // own doc comment) — there's no longer a "spawn already succeeded,
    // then a follow-up delivery step failed" window to test for a local
    // host. What replaces it: createSessionRecord/spawn itself failing
    // outright means the OLD session is confirmed dead and re-seeding it
    // failed too — leaving the task at "in_progress" would strand it
    // forever (issue #987), so this now fails the task explicitly instead,
    // 200ing with the OLD (unreseeded) sessionId left in place as an
    // honest record of which session actually ran.
    const app = await buildApp();
    const cwd = createGitRepo();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "reject-spawn-fail-p", cwd },
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
    expect(res.json().status).toBe("failed");
    expect(res.json().failureReason).toBe("re-seed spawn failed after reject");
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
    const fakeBackend = fakeSessionBackend({
      spawn: vi.fn().mockResolvedValue({}),
      liveStatus: vi.fn().mockResolvedValue({}),
      liveness: vi.fn().mockResolvedValue({}),
      compareWorktreePaths: vi.fn().mockResolvedValue([]),
      terminate: vi.fn().mockResolvedValue(undefined),
      getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      getRenderedScrollback: vi.fn().mockResolvedValue(""),
      getTranscript: vi.fn().mockResolvedValue({ ok: false, status: 404, error: "not running" }),
      uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
      resolveReviewGate: vi.fn().mockResolvedValue(false),
      acknowledgeAttention: vi.fn().mockResolvedValue(true),
      prompt: vi.fn().mockResolvedValue({ ok: true, outputOffset: 0 }),
      waitOutput: vi.fn().mockResolvedValue({ notRunning: true }),
      createWorktree: vi.fn().mockResolvedValue(null),
      checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
      resumeTaskWorktree: vi.fn().mockResolvedValue(null),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      resolvePendingPromote: vi.fn().mockResolvedValue(false),
      removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
      pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    });
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
      payload: { allowDuplicate: true, name: "reject-skew-p", cwd: "/remote/project", hostId },
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
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "approve-cleanup-p",
        cwd: "/tmp/approve-cleanup",
      },
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
    taskPromoteMocks.promoteTaskToPR.mockResolvedValueOnce({
      ok: false,
      reason: "dirty-tree",
      detail: "x",
    });
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
