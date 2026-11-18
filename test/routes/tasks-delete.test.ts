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
import fs from "node:fs";
import { deriveWorktreePath } from "../../src/services/git-worktree.js";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", () => mockTaskPromoteFactory());

const { buildApp } = await import("../../src/app.js");

describe("local task DELETE (#729, #1014, #746)", () => {
  setupTasksRouteTestLifecycle("tasks-delete-route-test");

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
        .mockResolvedValue({ state: "closed", labels: ["mullion-task"], isPullRequest: false });

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
        .mockResolvedValue({ state: "closed", labels: [], isPullRequest: false });

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
        .mockResolvedValue({ state: "open", labels: ["bug"], isPullRequest: false });

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
        .mockResolvedValue({ state: "open", labels: ["mullion-task"], isPullRequest: false });

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

  // #1014 (Abandon) — `?force=true` is the escape hatch past both #729
  // refusals (the preserved-branch guard and the isIssueStillTrackable
  // round-trip), for a task the user has decided against rather than one
  // they intend to Retry. Real git worktrees/branches (not just DB
  // columns) so these tests can assert the actual filesystem cleanup, the
  // same "git subprocesses are left real" posture this file's top-level
  // node-pty/child_process mocks already establish.
  describe("DELETE ?force=true (Abandon, #1014)", () => {
    function createTaskWorktree(cwd: string, branchName: string): string {
      const worktreePath = deriveWorktreePath(cwd, branchName);
      git(cwd, ["worktree", "add", "-b", branchName, worktreePath]);
      return worktreePath;
    }

    function branchExists(cwd: string, branchName: string): boolean {
      try {
        gitOutput(cwd, ["rev-parse", "--verify", `refs/heads/${branchName}`]);
        return true;
      } catch {
        return false;
      }
    }

    it("unlabels the issue, deletes the row, and removes the worktree and branch", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-1014");
      const branchName = "mullion/task-9001";
      const worktreePath = createTaskWorktree(cwd, branchName);
      const app = await buildApp();
      await connectPat(app, "ghp_abandon_ok");
      const githubWrite = await import("../../src/services/github-write.js");
      const removeLabelSpy = vi.spyOn(githubWrite, "removeLabel").mockResolvedValue(undefined);

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 901,
          title: "abandon me",
          htmlUrl: "https://github.com/acme/widgets-1014/issues/901",
          status: "failed",
          failureReason: "session exited unexpectedly",
          worktreePath,
          branchName,
        })
        .returning()
        .all();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
      expect(res.statusCode).toBe(204);
      expect(removeLabelSpy).toHaveBeenCalledWith(
        "ghp_abandon_ok",
        "acme",
        "widgets-1014",
        901,
        "mullion-task",
      );

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(false);
      expect(fs.existsSync(worktreePath)).toBe(false);
      expect(branchExists(cwd, branchName)).toBe(false);

      removeLabelSpy.mockRestore();
      await app.close();
    });

    it("leaves the row, worktree, and branch untouched when the unlabel fails", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-1014-unlabel-fail");
      const branchName = "mullion/task-9002";
      const worktreePath = createTaskWorktree(cwd, branchName);
      const app = await buildApp();
      await connectPat(app, "ghp_abandon_fail");
      const githubWrite = await import("../../src/services/github-write.js");
      const removeLabelSpy = vi
        .spyOn(githubWrite, "removeLabel")
        .mockRejectedValue(new Error("GitHub is down"));

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 902,
          title: "abandon me but GitHub is down",
          htmlUrl: "https://github.com/acme/widgets-1014-unlabel-fail/issues/902",
          status: "failed",
          failureReason: "session exited unexpectedly",
          worktreePath,
          branchName,
        })
        .returning()
        .all();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
      expect(res.statusCode).toBe(502);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(true);
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(branchExists(cwd, branchName)).toBe(true);

      removeLabelSpy.mockRestore();
      await app.close();
    });

    it("force-deletes a local failed task, which has no Delete route access at all without force", async () => {
      const cwd = createGitRepo();
      const branchName = "mullion/task-9003";
      const worktreePath = createTaskWorktree(cwd, branchName);
      const app = await buildApp();

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "local task, no issue",
          status: "failed",
          failureReason: "session exited unexpectedly",
          worktreePath,
          branchName,
        })
        .returning()
        .all();

      // No force: local `failed` is not in LOCAL_CREATABLE_STATUSES/"done",
      // same refusal as before this feature existed.
      const refused = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
      expect(refused.statusCode).toBe(409);

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
      expect(res.statusCode).toBe(204);
      expect(fs.existsSync(worktreePath)).toBe(false);
      expect(branchExists(cwd, branchName)).toBe(false);

      await app.close();
    });

    it("still deletes the row when the worktree/branch cleanup itself fails", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-1014-cleanup-fail");
      const branchName = "mullion/task-9004";
      // Deliberately no real worktree/branch created — removeWorktree and
      // deleteBranch will both fail to find anything to act on. Abandon's
      // whole point is that cleanup failures are reported, not fatal: the
      // row (and the GitHub label) are already gone by the time this runs.
      const app = await buildApp();
      await connectPat(app, "ghp_abandon_cleanup_fail");
      const githubWrite = await import("../../src/services/github-write.js");
      const removeLabelSpy = vi.spyOn(githubWrite, "removeLabel").mockResolvedValue(undefined);

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 903,
          title: "abandon me, no real worktree",
          htmlUrl: "https://github.com/acme/widgets-1014-cleanup-fail/issues/903",
          status: "failed",
          failureReason: "session exited unexpectedly",
          worktreePath: `${cwd}/.mullion-worktrees/does-not-exist`,
          branchName,
        })
        .returning()
        .all();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
      expect(res.statusCode).toBe(204);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(false);

      removeLabelSpy.mockRestore();
      await app.close();
    });

    // Review fix — if the row's status changes between checkTaskDeletable's
    // read and the CAS delete (a concurrent Retry, the reconciler, a second
    // concurrent force-delete), the unlabel above already succeeded but the
    // delete then fails: the label is gone, but the row survives. The
    // response must say so rather than the generic "refresh and try again",
    // which reads as "nothing happened yet." Simulated by having the
    // removeLabel mock itself mutate the row's status mid-request — the
    // only await point between the read and the CAS write.
    it("says the label was already removed when a concurrent status change beats the delete", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-1014-race");
      const branchName = "mullion/task-9005";
      const worktreePath = createTaskWorktree(cwd, branchName);
      const app = await buildApp();
      await connectPat(app, "ghp_abandon_race");
      const githubWrite = await import("../../src/services/github-write.js");

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 904,
          title: "abandon me, but I race",
          htmlUrl: "https://github.com/acme/widgets-1014-race/issues/904",
          status: "failed",
          failureReason: "session exited unexpectedly",
          worktreePath,
          branchName,
        })
        .returning()
        .all();

      const removeLabelSpy = vi.spyOn(githubWrite, "removeLabel").mockImplementation(async () => {
        app.db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, row.id)).run();
      });

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ message: expect.stringContaining("already removed") });

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(true);

      removeLabelSpy.mockRestore();
      await app.close();
    });
  });

  // #746 — `done` widens the same DELETE handler #729 already exercises
  // above. Local done tasks need no GitHub round-trip at all; GitHub-linked
  // done tasks reuse isIssueStillTrackable exactly like the failed case
  // does, including its tri-state contract (undefined "couldn't confirm"
  // must never be treated as "confirmed untrackable").
  describe("DELETE of a done task (#746)", () => {
    it("deletes a done local task", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-done-1");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "finished local", status: "done" })
        .returning()
        .all();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
      expect(res.statusCode).toBe(204);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(false);

      await app.close();
    });

    it("deletes a done GitHub-linked task once its issue is confirmed closed", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-746-done");
      const app = await buildApp();
      await connectPat(app, "ghp_delete_done_closed");
      const githubWrite = await import("../../src/services/github-write.js");
      const getIssueStateSpy = vi
        .spyOn(githubWrite, "getIssueState")
        .mockResolvedValue({ state: "closed", labels: ["mullion-done"], isPullRequest: false });

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 701,
          title: "shipped",
          htmlUrl: "https://github.com/acme/widgets-746-done/issues/701",
          status: "done",
          worktreePath: null,
          branchName: "mullion/task-701",
        })
        .returning()
        .all();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
      expect(res.statusCode).toBe(204);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(false);

      getIssueStateSpy.mockRestore();
      await app.close();
    });

    // The regression test that justifies keeping the round-trip rather
    // than trusting local status alone (#746's own "Decisions (resolved)"
    // argues the watcher won't re-ingest a done-and-closed issue — true,
    // but doesn't cover a maintainer reopening and re-labeling it after
    // the task finished).
    it("refuses a done GitHub-linked task whose issue was reopened and relabeled", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-746-reopened");
      const app = await buildApp();
      await connectPat(app, "ghp_delete_done_reopened");
      const githubWrite = await import("../../src/services/github-write.js");
      const getIssueStateSpy = vi
        .spyOn(githubWrite, "getIssueState")
        .mockResolvedValue({ state: "open", labels: ["mullion-task"], isPullRequest: false });

      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 702,
          title: "reopened after shipping",
          htmlUrl: "https://github.com/acme/widgets-746-reopened/issues/702",
          status: "done",
          branchName: "mullion/task-702",
        })
        .returning()
        .all();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
      expect(res.statusCode).toBe(409);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      expect((listed.json() as { id: number }[]).some((t) => t.id === row.id)).toBe(true);

      getIssueStateSpy.mockRestore();
      await app.close();
    });

    it("refuses when a done task's issue state can't be confirmed (no GitHub connection)", async () => {
      const cwd = createGitRepoWithRemote("acme", "widgets-746-noauth");
      const app = await buildApp();
      const projectId = await createProject(app, cwd);
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 703,
          title: "unconfirmable",
          htmlUrl: "https://github.com/acme/widgets-746-noauth/issues/703",
          status: "done",
          branchName: "mullion/task-703",
        })
        .returning()
        .all();

      const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
      expect(res.statusCode).toBe(409);
      await app.close();
    });
  });

  // #746 — the bulk companion to DELETE /api/tasks/:id, sharing its
  // deletability rules via checkTaskDeletable. Branch-delete cases use a
  // real local git repo/branch (same convention
  // test/routes/projects.test.ts's own git-branch-delete tests use) rather
  // than mocking deleteBranch itself — only the GitHub merge-state read
  // (getPullRequestByNumber) is mocked, since that's the one real network
  // call in the path.
});
