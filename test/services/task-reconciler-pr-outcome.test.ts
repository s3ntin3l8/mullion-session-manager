// #2865 — an approved (`done`) task's PR can end without Mullion's own merge:
// closed WITHOUT merging, or merged by hand with no webhook delivered. The
// `→ done` sync leaves the issue open until the merge, so both must be caught
// by the reconciler: the merge sweep's `already-done` arm, and the re-poll
// behind it for tasks nobody asked Mullion to merge. Driven through
// reconcileTasks, the real entry point. Small harness on purpose: the
// reconciler's own test file is at its file-size ceiling.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  resolveRepoRef: vi.fn(),
  resolveGitHubToken: vi.fn(),
  resolveMullionReviewLogins: vi.fn(),
  getPullRequestByNumber: vi.fn(),
  mergePullRequest: vi.fn(),
  removeLabel: vi.fn(),
  createComment: vi.fn(),
  closeIssue: vi.fn(),
  getIssueState: vi.fn(),
  getMergedClosingPullRequest: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRepoRef: mocks.resolveRepoRef,
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mocks.resolveGitHubToken,
  resolveMullionReviewLogins: mocks.resolveMullionReviewLogins,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mocks.getPullRequestByNumber,
  mergePullRequest: mocks.mergePullRequest,
  removeLabel: mocks.removeLabel,
  createComment: mocks.createComment,
  closeIssue: mocks.closeIssue,
  getIssueState: mocks.getIssueState,
  getMergedClosingPullRequest: mocks.getMergedClosingPullRequest,
}));
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));
// Never let a real systemd-run fire (test/global-setup.ts, issue #2003).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb, getDb } = await import("../../src/db/client.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { resetRepollLedgerForTests, REPOLL_GRACE_MS } =
  await import("../../src/services/task-merge-repoll.js");
const { LABEL_DONE } = await import("../../src/services/task-github-sync.js");
const taskApprove = await import("../../src/services/task-approve.js");
const { tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-pr-outcome-${process.pid}.db`);

function mockPr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 9,
    state: "open",
    title: "chore: something",
    baseRef: "main",
    headRef: "mullion/task-x",
    headSha: "sha-head",
    mergeable: true,
    mergeableState: "blocked",
    merged: false,
    mergedAt: null,
    ...overrides,
  };
}
const closedUnmerged = () => mockPr({ state: "closed", merged: false });
const merged = () => mockPr({ state: "closed", merged: true, mergedAt: "2026-11-10T00:00:00Z" });

type App = Awaited<ReturnType<typeof buildApp>>;

describe("#2865 — an approved task's PR ends without Mullion's merge", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  beforeEach(() => {
    resetRepollLedgerForTests();
    mocks.resolveRepoRef.mockReset().mockResolvedValue({ owner: "o", repo: "r" });
    mocks.resolveGitHubToken.mockReset().mockResolvedValue("tok");
    mocks.resolveMullionReviewLogins.mockReset().mockResolvedValue(new Set(["mullion-bot"]));
    mocks.getPullRequestByNumber.mockReset();
    mocks.mergePullRequest.mockReset().mockResolvedValue(undefined);
    mocks.removeLabel.mockReset().mockResolvedValue(undefined);
    mocks.createComment.mockReset().mockResolvedValue(undefined);
    mocks.closeIssue.mockReset().mockResolvedValue(undefined);
    mocks.getIssueState.mockReset().mockResolvedValue({ state: "open", labels: [] });
    mocks.getMergedClosingPullRequest.mockReset().mockResolvedValue(null);
    // The branch cleanup shells out to git; it is not what is under test.
    vi.spyOn(taskApprove, "cleanupMergedTaskBranch").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      getDb().delete(tasks).run();
    } catch {
      // No DB yet (the very first beforeEach runs before any buildApp()).
    }
  });

  /** An approved task with a PR. `mergeRequested` = the project asked Mullion to merge it. */
  async function createTask(
    app: App,
    {
      mergeRequested,
      ...overrides
    }: Partial<typeof tasks.$inferInsert> & { mergeRequested?: boolean },
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: `p-${Math.random()}`, cwd: "/tmp" },
    });
    const projectId = project.json().id as number;
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "approved",
        status: "done",
        issueNumber: 55,
        claimedAt: new Date(),
        completedAt: new Date(Date.now() - REPOLL_GRACE_MS - 60_000),
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
        mergeRequestedAt: mergeRequested ? new Date() : null,
        branchName: "mullion/task-x",
        ...overrides,
      })
      .returning()
      .all();
    return row.id;
  }

  const getTask = (app: App, id: number) =>
    app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  describe("a PR closed without merging", () => {
    it("flags the task, drops the done label, comments once, and keeps the issue open", async () => {
      const app = await buildApp();
      const id = await createTask(app, { mergeRequested: true });
      mocks.getPullRequestByNumber.mockResolvedValue(closedUnmerged());

      await reconcileTasks(app);

      const row = getTask(app, id);
      expect(row.needsHumanReason).toBe("pr-closed");
      expect(row.mergeError).toContain("closed without merging");
      expect(row.mergedAt).toBeNull();
      expect(mocks.removeLabel).toHaveBeenCalledWith("tok", "o", "r", 55, LABEL_DONE);
      expect(mocks.createComment).toHaveBeenCalledTimes(1);
      expect(mocks.createComment).toHaveBeenCalledWith(
        "tok",
        "o",
        "r",
        55,
        expect.stringContaining("closed without merging"),
      );
      expect(mocks.closeIssue).not.toHaveBeenCalled();
      await app.close();
    });

    it("does not announce again when a human re-arms the merge and the PR is still closed", async () => {
      const app = await buildApp();
      const id = await createTask(app, { mergeRequested: true });
      mocks.getPullRequestByNumber.mockResolvedValue(closedUnmerged());
      await reconcileTasks(app);
      expect(mocks.createComment).toHaveBeenCalledTimes(1);

      // "Merge now" on the card re-arms the sweep.
      app.db.update(tasks).set({ mergeRequestedAt: new Date() }).where(eq(tasks.id, id)).run();
      await reconcileTasks(app);

      expect(getTask(app, id).needsHumanReason).toBe("pr-closed");
      expect(mocks.createComment).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("is cleared when the PR is reopened and merged", async () => {
      const app = await buildApp();
      const id = await createTask(app, { mergeRequested: true });
      mocks.getPullRequestByNumber.mockResolvedValue(closedUnmerged());
      await reconcileTasks(app);
      expect(getTask(app, id).needsHumanReason).toBe("pr-closed");

      mocks.getPullRequestByNumber.mockResolvedValue(merged());
      app.db.update(tasks).set({ mergeRequestedAt: new Date() }).where(eq(tasks.id, id)).run();
      await reconcileTasks(app);

      const row = getTask(app, id);
      expect(row.mergedAt).not.toBeNull();
      expect(row.needsHumanReason).toBeNull();
      await app.close();
    });

    it("is found by the re-poll when no merge was ever requested", async () => {
      const app = await buildApp();
      const id = await createTask(app, { mergeRequested: false });
      mocks.getPullRequestByNumber.mockResolvedValue(closedUnmerged());

      await reconcileTasks(app);

      expect(getTask(app, id).needsHumanReason).toBe("pr-closed");
      expect(mocks.createComment).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("flags the task but leaves an issue a human already closed alone", async () => {
      const app = await buildApp();
      const id = await createTask(app, { mergeRequested: true });
      mocks.getIssueState.mockResolvedValue({ state: "closed", labels: [] });
      mocks.getPullRequestByNumber.mockResolvedValue(closedUnmerged());

      await reconcileTasks(app);

      expect(getTask(app, id).needsHumanReason).toBe("pr-closed");
      expect(mocks.removeLabel).not.toHaveBeenCalled();
      expect(mocks.createComment).not.toHaveBeenCalled();
      await app.close();
    });

    it("is still watched once flagged: a PR reopened and hand-merged with no webhook is finished", async () => {
      const app = await buildApp();
      const id = await createTask(app, { mergeRequested: false });
      mocks.getPullRequestByNumber.mockResolvedValue(closedUnmerged());
      await reconcileTasks(app);
      expect(getTask(app, id).needsHumanReason).toBe("pr-closed");

      // A human reopens the PR and merges it on github.com; no webhook arrives.
      resetRepollLedgerForTests(); // stands in for the six-hour flagged interval elapsing
      mocks.getPullRequestByNumber.mockResolvedValue(merged());
      mocks.getIssueState.mockResolvedValue({ state: "open", labels: [] });
      await reconcileTasks(app);

      const row = getTask(app, id);
      expect(row.mergedAt).not.toBeNull();
      expect(row.needsHumanReason).toBeNull();
      await vi.waitFor(() => expect(mocks.closeIssue).toHaveBeenCalledWith("tok", "o", "r", 55));
      await app.close();
    });

    it("looks at a flagged task much less often than an unflagged one, and does not announce again", async () => {
      const app = await buildApp();
      await createTask(app, { mergeRequested: false });
      mocks.getPullRequestByNumber.mockResolvedValue(closedUnmerged());
      await reconcileTasks(app); // polled and flagged
      await reconcileTasks(app); // inside the flagged interval

      expect(mocks.getPullRequestByNumber).toHaveBeenCalledTimes(1);
      expect(mocks.createComment).toHaveBeenCalledTimes(1);

      // Even once polled again, a PR that is still closed is not re-announced.
      resetRepollLedgerForTests();
      await reconcileTasks(app);
      expect(mocks.getPullRequestByNumber).toHaveBeenCalledTimes(2);
      expect(mocks.createComment).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("keeps the explanation when Merge now is clicked on a PR that is still closed", async () => {
      const app = await buildApp();
      const id = await createTask(app, { mergeRequested: true });
      mocks.getPullRequestByNumber.mockResolvedValue(closedUnmerged());
      await reconcileTasks(app);
      const message = getTask(app, id).mergeError;
      expect(message).toContain("Merge now");

      // The route's clear: mergeError blanked, the reason kept, the sweep re-armed.
      app.db
        .update(tasks)
        .set({ mergeError: null, mergeRequestedAt: new Date() })
        .where(eq(tasks.id, id))
        .run();
      await reconcileTasks(app);

      const row = getTask(app, id);
      expect(row.needsHumanReason).toBe("pr-closed");
      expect(row.mergeError).toBe(message);
      expect(mocks.createComment).toHaveBeenCalledTimes(1);
      await app.close();
    });
  });

  describe("the re-poll of an approved task nobody asked Mullion to merge", () => {
    it("marks a hand-merged task merged and closes its issue when no webhook arrived", async () => {
      const app = await buildApp();
      const id = await createTask(app, { mergeRequested: false });
      mocks.getPullRequestByNumber.mockResolvedValue(merged());

      await reconcileTasks(app);

      const row = getTask(app, id);
      expect(row.mergedAt).toEqual(new Date("2026-11-10T00:00:00Z"));
      expect(row.archivedAt).not.toBeNull();
      await vi.waitFor(() => expect(mocks.closeIssue).toHaveBeenCalledWith("tok", "o", "r", 55));
      await app.close();
    });

    it("leaves a still-open PR alone and looks at it at most once per interval", async () => {
      const app = await buildApp();
      const id = await createTask(app, { mergeRequested: false });
      mocks.getPullRequestByNumber.mockResolvedValue(mockPr());

      await reconcileTasks(app);
      await reconcileTasks(app);

      expect(mocks.getPullRequestByNumber).toHaveBeenCalledTimes(1);
      const row = getTask(app, id);
      expect(row.mergedAt).toBeNull();
      expect(row.needsHumanReason).toBeNull();
      expect(mocks.closeIssue).not.toHaveBeenCalled();
      await app.close();
    });

    it("does not poll an archived task", async () => {
      const app = await buildApp();
      await createTask(app, { mergeRequested: false, archivedAt: new Date() });
      mocks.getPullRequestByNumber.mockResolvedValue(merged());

      await reconcileTasks(app);

      expect(mocks.getPullRequestByNumber).not.toHaveBeenCalled();
      await app.close();
    });

    it("does not poll a task approved moments ago (the webhook normally wins that race)", async () => {
      const app = await buildApp();
      await createTask(app, { mergeRequested: false, completedAt: new Date() });
      mocks.getPullRequestByNumber.mockResolvedValue(merged());

      await reconcileTasks(app);

      expect(mocks.getPullRequestByNumber).not.toHaveBeenCalled();
      await app.close();
    });

    it("survives one PR's lookup failing and still handles the next task", async () => {
      const app = await buildApp();
      const failing = await createTask(app, {
        mergeRequested: false,
        issueNumber: 56,
        prNumber: 8,
      });
      const ok = await createTask(app, { mergeRequested: false, issueNumber: 57, prNumber: 9 });
      mocks.getPullRequestByNumber.mockImplementation(
        async (_t: string, _o: string, _r: string, n: number) => {
          if (n === 8) throw new Error("404");
          return merged();
        },
      );

      await reconcileTasks(app);

      expect(getTask(app, failing).mergedAt).toBeNull();
      expect(getTask(app, ok).mergedAt).not.toBeNull();
      await app.close();
    });
  });
});
