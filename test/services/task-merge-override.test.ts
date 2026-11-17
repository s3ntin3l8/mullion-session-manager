// "Merge anyway": a human's override of a merge held only by NON-required checks
// (task-merge-override.ts). The override is bound to one PR head, honoured only
// for GitHub's `unstable` state, and set through POST /api/tasks/:id/merge.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockMergePullRequest,
  mockFetchRunsForHeadChecked,
  mockFetchCheckRunsForHead,
} = vi.hoisted(() => ({
  mockResolveRepoRef: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockMergePullRequest: vi.fn(),
  mockFetchRunsForHeadChecked: vi.fn(),
  mockFetchCheckRunsForHead: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRepoRef: mockResolveRepoRef,
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mockGetPullRequestByNumber,
  mergePullRequest: mockMergePullRequest,
  deleteRemoteBranch: vi.fn().mockResolvedValue(undefined),
  // The `blocked` arm reads GraphQL; reject so nothing reaches the network (the
  // sweep falls back to the generic message, which is all these tests need).
  getPullRequestReviewDecision: vi.fn().mockRejectedValue(new Error("no graphql in tests")),
  fetchPullRequestReviewThreads: vi.fn().mockRejectedValue(new Error("no graphql in tests")),
}));
vi.mock("../../src/services/github.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRunsForHeadChecked: mockFetchRunsForHeadChecked,
  fetchCheckRunsForHead: mockFetchCheckRunsForHead,
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
const { reconcileTasks, resetMergeBackoff } = await import("../../src/services/task-reconciler.js");
const { isMergeOverridable, unstableHeldReason, UNSTABLE_HOLD_PREFIX } =
  await import("../../src/services/task-merge-override.js");
const { tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-merge-override-${process.pid}.db`);
const HEAD = "c".repeat(40);
const OLD_HEAD = "d".repeat(40);
const HELD = unstableHeldReason([{ name: "dependency-audit" }]);

function mockPr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 9,
    htmlUrl: "https://github.com/o/r/pull/9",
    nodeId: "PR_node9",
    draft: false,
    headSha: HEAD,
    headRef: "mullion/task-x",
    baseRef: "main",
    title: "ci: gate the audit",
    state: "open",
    merged: false,
    mergedAt: null,
    mergeable: true,
    mergeableState: "unstable",
    ...overrides,
  };
}

describe("unstableHeldReason / isMergeOverridable", () => {
  it("names the red checks and points at Merge anyway", () => {
    expect(HELD).toContain(UNSTABLE_HOLD_PREFIX);
    expect(HELD).toContain("dependency-audit");
    expect(HELD).toContain('"Merge anyway"');
    expect(unstableHeldReason([{ name: "codecov/patch", detail: "66% of diff hit" }])).toContain(
      "codecov/patch: 66% of diff hit",
    );
  });

  it("falls back to the generic message, which is not overridable, with no named check", () => {
    const generic = unstableHeldReason([]);
    expect(generic).toBe("A non-required check is failing or still running");
    expect(isMergeOverridable({ status: "done", mergeError: generic })).toBe(false);
  });

  it("is overridable only for a done task held by named non-required checks", () => {
    expect(isMergeOverridable({ status: "done", mergeError: HELD })).toBe(true);
    expect(isMergeOverridable({ status: "reviewing", mergeError: HELD })).toBe(false);
    expect(isMergeOverridable({ status: "done", mergeError: "Required checks are red" })).toBe(
      false,
    );
    expect(isMergeOverridable({ status: "done", mergeError: null })).toBe(false);
  });
});

describe("Merge anyway", () => {
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
    mockResolveRepoRef.mockReset().mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockReset().mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockReset().mockResolvedValue(mockPr());
    mockMergePullRequest.mockReset().mockResolvedValue(undefined);
    mockFetchRunsForHeadChecked.mockReset().mockResolvedValue({ ok: true, runs: [] });
    mockFetchCheckRunsForHead
      .mockReset()
      .mockResolvedValue([
        { name: "dependency-audit", conclusion: "failure", status: "completed", url: "" },
      ]);
  });

  afterEach(() => {
    try {
      getDb().delete(tasks).run();
    } catch {
      // No DB yet.
    }
  });

  /** A `done` task whose merge is held by a named non-required check. */
  async function createHeldTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    overrides: Partial<typeof tasks.$inferInsert> = {},
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: `p-override-${Math.random()}`,
        cwd: "/tmp",
      },
    });
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id as number,
        title: "held by an optional check",
        status: "done",
        claimedAt: new Date(),
        completedAt: new Date(),
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
        mergeRequestedAt: new Date(),
        mergeError: HELD,
        branchName: "mullion/task-x",
        agentCommand: "claude",
        ...overrides,
      })
      .returning()
      .all();
    resetMergeBackoff(row.id);
    return row.id;
  }

  const getTask = (app: Awaited<ReturnType<typeof buildApp>>, id: number) =>
    app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  const postMerge = (app: Awaited<ReturnType<typeof buildApp>>, id: number, override = false) =>
    app.inject({
      method: "POST",
      url: `/api/tasks/${id}/merge${override ? "?overrideNonRequiredChecks=true" : ""}`,
    });

  it("the route binds the override to the PR head GitHub reports at click time", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app);

    const res = await postMerge(app, id, true);

    expect(res.statusCode).toBe(200);
    expect(getTask(app, id).mergeOverrideHeadSha).toBe(HEAD);
    await app.close();
  });

  it("a plain Merge now never sets the override, and replaces one that was armed", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app);
    const plain = await createHeldTask(app, { mergeOverrideHeadSha: HEAD });

    expect((await postMerge(app, id)).statusCode).toBe(200);
    expect(getTask(app, id).mergeOverrideHeadSha).toBeNull();
    // A human merge request re-decides: an override armed earlier does not survive it.
    expect((await postMerge(app, plain)).statusCode).toBe(200);
    expect(getTask(app, plain).mergeOverrideHeadSha).toBeNull();
    await app.close();
  });

  it("the route refuses when a DIFFERENT check is red than the one the hold named", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app);
    mockFetchCheckRunsForHead.mockResolvedValue([
      { name: "dependency-audit", conclusion: "failure", status: "completed", url: "" },
      { name: "codecov/patch", conclusion: "failure", status: "completed", url: "" },
    ]);

    const res = await postMerge(app, id, true);

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("codecov/patch");
    expect(getTask(app, id).mergeOverrideHeadSha).toBeNull();
    await app.close();
  });

  it("the route refuses a check whose NAME is a substring of one the hold named", async () => {
    const app = await buildApp();
    // The hold names `test-node / lint-and-test`; `test-node` is a different check.
    const id = await createHeldTask(app, {
      mergeError: unstableHeldReason([{ name: "test-node / lint-and-test" }]),
    });
    mockFetchCheckRunsForHead.mockResolvedValue([
      { name: "test-node", conclusion: "failure", status: "completed", url: "" },
    ]);

    const res = await postMerge(app, id, true);

    expect(res.statusCode).toBe(409);
    expect(getTask(app, id).mergeOverrideHeadSha).toBeNull();
    await app.close();
  });

  it("a recorded hold replaces an armed override, so a stale one cannot merge the next red check", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app, { mergeOverrideHeadSha: HEAD });
    const { recordMergeError } = await import("../../src/services/task-merge-human.js");

    recordMergeError(app, id, "Required checks are red or still pending");

    expect(getTask(app, id).mergeOverrideHeadSha).toBeNull();
    await app.close();
  });

  it("the route refuses when no check is red any more, and 502s when the checks cannot be read", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app);
    mockFetchCheckRunsForHead.mockResolvedValue([
      { name: "dependency-audit", conclusion: "success", status: "completed", url: "" },
    ]);
    expect((await postMerge(app, id, true)).statusCode).toBe(409);

    mockFetchCheckRunsForHead.mockRejectedValue(new Error("boom"));
    expect((await postMerge(app, id, true)).statusCode).toBe(502);
    expect(getTask(app, id).mergeOverrideHeadSha).toBeNull();
    await app.close();
  });

  it("every way of clearing a merge hold clears the override with it", async () => {
    const { CLEARED_MERGE_ERROR, clearedFor } =
      await import("../../src/services/task-merge-human.js");
    expect(CLEARED_MERGE_ERROR.mergeOverrideHeadSha).toBeNull();
    expect(clearedFor(null).mergeOverrideHeadSha).toBeNull();
    // The review-post-failed hold takes its own branch of clearedFor.
    expect(clearedFor("review-post-failed").mergeOverrideHeadSha).toBeNull();
  });

  it("GET /api/tasks and /api/tasks/:id carry mergeOverridable and ciHoldNote", async () => {
    const app = await buildApp();
    const held = await createHeldTask(app);
    const parked = await createHeldTask(app, {
      status: "reviewing",
      mergeError: null,
      needsHumanReason: "ci-unfixable",
      ciHoldNote: "dependency-audit — no patched release",
      autoReturnCapAnnouncedAt: new Date(),
    });

    const one = (await app.inject({ method: "GET", url: `/api/tasks/${held}` })).json();
    expect(one.mergeOverridable).toBe(true);
    expect(one.ciHoldNote).toBeNull();
    const list = (await app.inject({ method: "GET", url: "/api/tasks" })).json() as {
      id: number;
      mergeOverridable: boolean;
      ciHoldNote: string | null;
    }[];
    expect(list.find((t) => t.id === held)?.mergeOverridable).toBe(true);
    const row = list.find((t) => t.id === parked);
    expect(row?.mergeOverridable).toBe(false);
    expect(row?.ciHoldNote).toBe("dependency-audit — no patched release");
    await app.close();
  });

  it("the route refuses when the hold is not named non-required checks", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app, {
      mergeError: "Required checks are red or still pending",
    });

    const res = await postMerge(app, id, true);

    expect(res.statusCode).toBe(409);
    expect(getTask(app, id).mergeOverrideHeadSha).toBeNull();
    await app.close();
  });

  it("the route refuses when GitHub no longer reports the PR unstable (a required check went red)", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));

    const res = await postMerge(app, id, true);

    expect(res.statusCode).toBe(409);
    expect(getTask(app, id).mergeOverrideHeadSha).toBeNull();
    await app.close();
  });

  it("the route answers 502 when GitHub cannot be read, without setting the override", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app);
    mockGetPullRequestByNumber.mockRejectedValue(new Error("boom"));

    const res = await postMerge(app, id, true);

    expect(res.statusCode).toBe(502);
    expect(getTask(app, id).mergeOverrideHeadSha).toBeNull();
    await app.close();
  });

  it("the sweep merges an unstable PR while the override matches the head, with that head as the guard", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app, { mergeOverrideHeadSha: HEAD });

    await reconcileTasks(app);

    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockMergePullRequest).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      9,
      expect.objectContaining({ sha: HEAD }),
    );
    expect(getTask(app, id).mergedAt).not.toBeNull();
    await app.close();
  });

  it("the sweep keeps holding when the override was for an older head (a push voided it)", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app, { mergeOverrideHeadSha: OLD_HEAD });

    await reconcileTasks(app);

    expect(mockMergePullRequest).not.toHaveBeenCalled();
    const row = getTask(app, id);
    expect(row.mergedAt).toBeNull();
    expect(row.mergeError).toContain(UNSTABLE_HOLD_PREFIX);
    await app.close();
  });

  it("the sweep never merges a blocked PR (a required check) on an override", async () => {
    const app = await buildApp();
    const id = await createHeldTask(app, { mergeOverrideHeadSha: HEAD });
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));

    await reconcileTasks(app);

    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(getTask(app, id).mergedAt).toBeNull();
    await app.close();
  });
});
