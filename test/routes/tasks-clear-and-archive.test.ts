import { describe, it, expect, vi } from "vitest";
import {
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  git,
  gitOutput,
  createGitRepo,
  createGitRepoWithRemote,
  connectPat,
  createTaskProject as createProject,
  setupTasksRouteTestLifecycle,
} from "../helpers/tasks-routes-harness.js";
import { tasks } from "../../src/db/schema.js";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", () => mockTaskPromoteFactory());

const { buildApp } = await import("../../src/app.js");

describe("local task clear-done & archive (#746, #1015)", () => {
  setupTasksRouteTestLifecycle("tasks-clear-and-archive-route-test");

  describe("POST /api/tasks/clear-done (#746)", () => {
    it("deletes only done tasks scoped to the requested projectIds", async () => {
      const app = await buildApp();
      const projectA = await createProject(app, "/tmp/clear-done-scope-a");
      const projectB = await createProject(app, "/tmp/clear-done-scope-b");
      const [rowA] = app.db
        .insert(tasks)
        .values({ projectId: projectA, title: "done in A", status: "done" })
        .returning()
        .all();
      const [rowB] = app.db
        .insert(tasks)
        .values({ projectId: projectB, title: "done in B", status: "done" })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/clear-done",
        payload: { projectIds: [projectA] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ deleted: [rowA.id], failed: [], remaining: 0 });

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const ids = (listed.json() as { id: number }[]).map((t) => t.id);
      expect(ids).not.toContain(rowA.id);
      expect(ids).toContain(rowB.id);

      await app.close();
    });

    it("deletes every done task across all projects when projectIds is omitted", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/clear-done-all");
      const otherProjectId = await createProject(app, "/tmp/clear-done-all-other");
      const [row1] = app.db
        .insert(tasks)
        .values({ projectId, title: "done 1", status: "done" })
        .returning()
        .all();
      const [row2] = app.db
        .insert(tasks)
        .values({ projectId, title: "done 2", status: "done" })
        .returning()
        .all();
      const [otherDone] = app.db
        .insert(tasks)
        .values({ projectId: otherProjectId, title: "other project done", status: "done" })
        .returning()
        .all();
      const [stillOpen] = app.db
        .insert(tasks)
        .values({ projectId, title: "still open", status: "ready" })
        .returning()
        .all();

      const res = await app.inject({ method: "POST", url: "/api/tasks/clear-done", payload: {} });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Membership is asserted for every project's done rows, including the
      // second project's row swept when projectIds is omitted.
      expect(body.deleted).toEqual(expect.arrayContaining([row1.id, row2.id, otherDone.id]));
      expect(body.deleted).not.toContain(stillOpen.id);

      await app.close();
    });

    it("reports non-deletable rows in `failed`, not silently skipped", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-clear-done-failed");
      const app = await buildApp();
      await connectPat(app, "ghp_clear_done_failed");
      const githubWrite = await import("../../src/services/github-write.js");
      const getIssueStateSpy = vi
        .spyOn(githubWrite, "getIssueState")
        .mockResolvedValue({ state: "open", labels: ["mullion-task"], isPullRequest: false });

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 801,
          title: "still tracked",
          htmlUrl: "https://github.com/acme/widgets-clear-done-failed/issues/801",
          status: "done",
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/clear-done",
        payload: { projectIds: [projectId] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.deleted).toEqual([]);
      expect(body.failed).toEqual([
        {
          id: row.id,
          error: expect.stringContaining("still open and labeled"),
        },
      ]);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(true);

      getIssueStateSpy.mockRestore();
      await app.close();
    });

    it("caps the batch and reports the remainder as un-attempted, not silently dropped", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/clear-done-batch-cap");
      const rows = Array.from({ length: 22 }, (_, i) =>
        app.db
          .insert(tasks)
          .values({ projectId, title: `done ${i}`, status: "done" })
          .returning()
          .all(),
      ).map(([row]) => row);
      expect(rows).toHaveLength(22);

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/clear-done",
        payload: { projectIds: [projectId] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.deleted).toHaveLength(20);
      expect(body.remaining).toBe(2);

      await app.close();
    });

    it("fails GitHub-linked candidates with a rate-limit reason, and leaves local ones unaffected, when the install-wide budget is in effect", async () => {
      const projectId1Cwd = createGitRepoWithRemote("acme", "widgets-clear-done-ratelimit");
      const app = await buildApp();
      const { resetGitHubRateLimitForTests, recordGitHubRateLimit } =
        await import("../../src/services/github-fetch.js");
      resetGitHubRateLimitForTests();

      const projectId = await createProject(app, projectId1Cwd);
      const [linkedRow] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 802,
          title: "linked, rate limited",
          htmlUrl: "https://github.com/acme/widgets-clear-done-ratelimit/issues/802",
          status: "done",
        })
        .returning()
        .all();
      const [localRow] = app.db
        .insert(tasks)
        .values({ projectId, title: "local, unaffected", status: "done" })
        .returning()
        .all();

      // A 429 response header (Retry-After) is what actually arms the
      // module-level budget in production; this test file has no live
      // GitHub call to trigger that naturally, so it's armed directly via
      // the same test helper github-write.test.ts uses.
      recordGitHubRateLimit(Date.now() + 60_000);

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/clear-done",
        payload: { projectIds: [projectId] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.deleted).toEqual([localRow.id]);
      expect(body.failed).toEqual([
        { id: linkedRow.id, error: expect.stringContaining("rate limit") },
      ]);

      resetGitHubRateLimitForTests();
      await app.close();
    });

    it("leaves the branch untouched when deleteBranches is off", async () => {
      const cwd = createGitRepo();
      git(cwd, ["branch", "mullion/task-branch-off"]);
      const app = await buildApp();
      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "done, branch preserved by default",
          status: "done",
          branchName: "mullion/task-branch-off",
          prNumber: 1,
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/clear-done",
        payload: { projectIds: [projectId] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toEqual([row.id]);
      expect(res.json().branches).toEqual([]);

      const branches = gitOutput(cwd, ["branch", "--list", "mullion/task-branch-off"]);
      expect(branches).toContain("mullion/task-branch-off");

      await app.close();
    });

    it("force-deletes the branch when deleteBranches is on and the PR is confirmed merged", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-clear-done-merged");
      git(cwd, ["branch", "mullion/task-branch-merged"]);
      const app = await buildApp();
      await connectPat(app, "ghp_clear_done_merged_branch");
      const githubWrite = await import("../../src/services/github-write.js");
      const getPrSpy = vi
        .spyOn(githubWrite, "getPullRequestByNumber")
        .mockResolvedValue({ merged: true } as never);

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "done, PR merged",
          status: "done",
          branchName: "mullion/task-branch-merged",
          prNumber: 5,
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/clear-done",
        payload: { projectIds: [projectId], deleteBranches: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toEqual([row.id]);
      expect(res.json().branches).toEqual([
        { id: row.id, branch: "mullion/task-branch-merged", deleted: true },
      ]);

      const branches = gitOutput(cwd, ["branch", "--list", "mullion/task-branch-merged"]);
      expect(branches).not.toContain("mullion/task-branch-merged");

      getPrSpy.mockRestore();
      await app.close();
    });

    it("reports the branch skipped (not deleted, row still gone) when the PR is not merged", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-clear-done-unmerged");
      git(cwd, ["branch", "mullion/task-branch-unmerged"]);
      const app = await buildApp();
      await connectPat(app, "ghp_clear_done_unmerged_branch");
      const githubWrite = await import("../../src/services/github-write.js");
      const getPrSpy = vi
        .spyOn(githubWrite, "getPullRequestByNumber")
        .mockResolvedValue({ merged: false } as never);

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "done, PR still open",
          status: "done",
          branchName: "mullion/task-branch-unmerged",
          prNumber: 6,
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/clear-done",
        payload: { projectIds: [projectId], deleteBranches: true },
      });
      expect(res.statusCode).toBe(200);
      // The row deletion is not blocked by the branch outcome.
      expect(res.json().deleted).toEqual([row.id]);
      expect(res.json().branches).toEqual([
        {
          id: row.id,
          branch: "mullion/task-branch-unmerged",
          deleted: false,
          reason: "not-merged",
        },
      ]);

      const branches = gitOutput(cwd, ["branch", "--list", "mullion/task-branch-unmerged"]);
      expect(branches).toContain("mullion/task-branch-unmerged");

      getPrSpy.mockRestore();
      await app.close();
    });

    it("a branch-delete failure (merge-check throws) still leaves the row deleted", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-clear-done-checkfail");
      git(cwd, ["branch", "mullion/task-branch-checkfail"]);
      const app = await buildApp();
      await connectPat(app, "ghp_clear_done_checkfail");
      const githubWrite = await import("../../src/services/github-write.js");
      const getPrSpy = vi
        .spyOn(githubWrite, "getPullRequestByNumber")
        .mockRejectedValue(new Error("HTTP 500"));

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "done, merge-check fails",
          status: "done",
          branchName: "mullion/task-branch-checkfail",
          prNumber: 7,
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/clear-done",
        payload: { projectIds: [projectId], deleteBranches: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toEqual([row.id]);
      expect(res.json().branches).toEqual([
        {
          id: row.id,
          branch: "mullion/task-branch-checkfail",
          deleted: false,
          reason: "merge-check-failed",
        },
      ]);

      getPrSpy.mockRestore();
      await app.close();
    });
  });

  describe("archive (#1015)", () => {
    it("archives a done task and returns the updated row", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/archive-done");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "shipped", status: "done" })
        .returning()
        .all();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${row.id}/archive` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: row.id, archivedAt: expect.any(String) });

      // Review-worthy: a GET-path assertion, not just the POST's own
      // .returning() — TASK_ROW_COLUMNS has twice silently dropped a new
      // column before (#816/#818), typechecking clean while the GET
      // response quietly omitted it.
      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const found = (listed.json() as { id: number; archivedAt: string | null }[]).find(
        (t) => t.id === row.id,
      );
      expect(found?.archivedAt).not.toBeNull();

      await app.close();
    });

    it("archives a failed task", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/archive-failed");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "gave up on this one", status: "failed" })
        .returning()
        .all();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${row.id}/archive` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ archivedAt: expect.any(String) });

      await app.close();
    });

    it("refuses to archive a task that hasn't finished", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/archive-in-progress");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "still working", status: "in_progress" })
        .returning()
        .all();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${row.id}/archive` });
      expect(res.statusCode).toBe(409);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const found = (listed.json() as { id: number; archivedAt: string | null }[]).find(
        (t) => t.id === row.id,
      );
      expect(found?.archivedAt).toBeNull();

      await app.close();
    });

    it("unarchives, clearing archivedAt but leaving mergedAt alone", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/unarchive");
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "merged and archived",
          status: "done",
          mergedAt: new Date(),
          archivedAt: new Date(),
        })
        .returning()
        .all();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}/archive` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.archivedAt).toBeNull();
      expect(body.mergedAt).not.toBeNull();

      await app.close();
    });

    it("404s archiving/unarchiving an unknown task", async () => {
      const app = await buildApp();
      const archiveRes = await app.inject({ method: "POST", url: "/api/tasks/999999/archive" });
      expect(archiveRes.statusCode).toBe(404);
      const unarchiveRes = await app.inject({
        method: "DELETE",
        url: "/api/tasks/999999/archive",
      });
      expect(unarchiveRes.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("POST /api/tasks/archive-merged (#1015)", () => {
    it("archives a done task once its PR is confirmed merged", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-archive-merged");
      const app = await buildApp();
      await connectPat(app, "ghp_archive_merged_ok");
      const githubWrite = await import("../../src/services/github-write.js");
      const getPrSpy = vi
        .spyOn(githubWrite, "getPullRequestByNumber")
        .mockResolvedValue({ merged: true } as Awaited<
          ReturnType<typeof githubWrite.getPullRequestByNumber>
        >);

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "backfill me",
          status: "done",
          prNumber: 55,
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/archive-merged",
        payload: { projectIds: [projectId] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ archived: [row.id], failed: [], remaining: 0 });

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const found = (listed.json() as { id: number; mergedAt: string | null }[]).find(
        (t) => t.id === row.id,
      );
      expect(found?.mergedAt).not.toBeNull();

      getPrSpy.mockRestore();
      await app.close();
    });

    it("reports (not archives) a done task whose PR isn't actually merged", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-archive-not-merged");
      const app = await buildApp();
      await connectPat(app, "ghp_archive_not_merged");
      const githubWrite = await import("../../src/services/github-write.js");
      const getPrSpy = vi
        .spyOn(githubWrite, "getPullRequestByNumber")
        .mockResolvedValue({ merged: false } as Awaited<
          ReturnType<typeof githubWrite.getPullRequestByNumber>
        >);

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "not merged yet", status: "done", prNumber: 56 })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/archive-merged",
        payload: { projectIds: [projectId] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        archived: [],
        failed: [{ id: row.id, error: "PR is not merged" }],
      });

      getPrSpy.mockRestore();
      await app.close();
    });

    // Review fix — the candidate filter must gate on mergedAt, not
    // archivedAt. Unarchive (DELETE /api/tasks/:id/archive) deliberately
    // clears only archivedAt, leaving mergedAt set; without this the
    // route (meant to be re-run periodically) would re-confirm the same
    // already-known merge and silently re-archive a task the user just
    // asked to bring back.
    it("does not re-archive a task the user manually unarchived", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/archive-merged-no-reunarchive");
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "merged, then manually unarchived",
          status: "done",
          prNumber: 57,
          mergedAt: new Date(),
          archivedAt: new Date(),
        })
        .returning()
        .all();

      const unarchiveRes = await app.inject({
        method: "DELETE",
        url: `/api/tasks/${row.id}/archive`,
      });
      expect(unarchiveRes.statusCode).toBe(200);
      expect(unarchiveRes.json().archivedAt).toBeNull();

      const githubWrite = await import("../../src/services/github-write.js");
      const getPrSpy = vi.spyOn(githubWrite, "getPullRequestByNumber");

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/archive-merged",
        payload: { projectIds: [projectId] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ archived: [], failed: [], remaining: 0 });
      // The task never matched the candidate query at all — no GitHub
      // round-trip should have happened.
      expect(getPrSpy).not.toHaveBeenCalled();

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const found = (listed.json() as { id: number; archivedAt: string | null }[]).find(
        (t) => t.id === row.id,
      );
      expect(found?.archivedAt).toBeNull();

      getPrSpy.mockRestore();
      await app.close();
    });

    // Review fix — was registered with no body schema at all, unlike its
    // sibling /api/tasks/clear-done; a malformed body fell through to
    // drizzle's inArray and would 500 instead of 400.
    it("400s a malformed body instead of 500ing", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/archive-merged",
        payload: { projectIds: "not-an-array" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("reports (not archives) when the PR lookup throws", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-archive-pr-error");
      const app = await buildApp();
      await connectPat(app, "ghp_archive_pr_error");
      const githubWrite = await import("../../src/services/github-write.js");
      const getPrSpy = vi
        .spyOn(githubWrite, "getPullRequestByNumber")
        .mockRejectedValue(new Error(" network timeout"));

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "will fail", status: "done", prNumber: 99 })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/archive-merged",
        payload: { projectIds: [projectId] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        archived: [],
        failed: [{ id: row.id, error: "Could not confirm PR merge state" }],
      });

      getPrSpy.mockRestore();
      await app.close();
    });
  });
});
