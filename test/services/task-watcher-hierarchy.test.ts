// #701 — fillParentIssueTitles, exercised end to end against a real DB via
// buildApp() (same pattern as task-watcher-dependencies.test.ts), with only
// the GitHub network layer mocked. Complements
// test/services/github-labeled-issues.test.ts's parent_issue_url/
// sub_issues_summary parsing coverage and task-watcher-ingest.test.ts's
// upsertIssueTask three-state-write coverage — this file is specifically
// about the title-fill pass itself (dedup-per-parent, per-sweep cap,
// cross-repo fetch, and the give-up-after-N-failures backoff).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as GitHubIntegrationModule from "../../src/services/github-integration.js";
import type * as GitHubModule from "../../src/services/github.js";

const mockClaimTask = vi.hoisted(() => vi.fn());
const mockResolveRepoRef = vi.hoisted(() => vi.fn());
const mockResolveGitHubToken = vi.hoisted(() => vi.fn());
const mockListLabeledIssues = vi.hoisted(() => vi.fn());
const mockGetIssueState = vi.hoisted(() => vi.fn());
const mockListBlockedByIssues = vi.hoisted(() => vi.fn());
const mockGetIssueTitle = vi.hoisted(() => vi.fn());
const mockBroadcastTaskEvent = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/task-claim.js", () => ({
  claimTask: mockClaimTask,
}));
vi.mock("../../src/services/host-git.js", () => ({
  resolveRepoRef: mockResolveRepoRef,
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubIntegrationModule>();
  return { ...actual, resolveGitHubToken: mockResolveGitHubToken };
});
vi.mock("../../src/services/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return { ...actual, listLabeledIssues: mockListLabeledIssues };
});
vi.mock("../../src/services/github-write.js", () => ({
  getIssueState: mockGetIssueState,
  listBlockedByIssues: mockListBlockedByIssues,
  getIssueTitle: mockGetIssueTitle,
}));
vi.mock("../../src/services/task-events.js", () => ({
  broadcastTaskEvent: mockBroadcastTaskEvent,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { startTaskWatcher } = await import("../../src/services/task-watcher.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-watcher-hierarchy-test-${process.pid}.db`);

describe("fillParentIssueTitles — sub-issue hierarchy (#701)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cleanup: (() => void) | null = null;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    process.env.MULLION_TASK_MAX_CONCURRENT = "5";
    process.env.MULLION_TASK_POLL_INTERVAL = "1";
    process.env.MULLION_TASK_LABEL = "mullion-task";
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
    delete process.env.MULLION_TASK_POLL_INTERVAL;
    delete process.env.MULLION_TASK_LABEL;
  });

  beforeEach(() => {
    mockClaimTask.mockReset();
    mockClaimTask.mockResolvedValue({ ok: true });
    mockResolveRepoRef.mockReset();
    mockResolveRepoRef.mockResolvedValue({ owner: "test-owner", repo: "test-repo" });
    mockResolveGitHubToken.mockReset();
    mockResolveGitHubToken.mockResolvedValue("ghp_token");
    mockListLabeledIssues.mockReset();
    mockListLabeledIssues.mockResolvedValue([]);
    mockGetIssueState.mockReset();
    mockGetIssueState.mockResolvedValue({ state: "open", labels: ["mullion-task"] });
    mockListBlockedByIssues.mockReset();
    mockListBlockedByIssues.mockResolvedValue([]);
    mockGetIssueTitle.mockReset();
    mockBroadcastTaskEvent.mockReset();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    app.db.delete(tasks).run();
    app.db.delete(projects).run();
    vi.useRealTimers();
  });

  async function createProject(): Promise<number> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-watcher-hierarchy-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: `p-${crypto.randomBytes(4).toString("hex")}`, cwd },
    });
    return res.json().id as number;
  }

  // dependencyCount: 0 ("clear") and status: "backlog" keep these tasks out
  // of both autoClaimReadyTasks (ready-only) and resolveStaleTaskBlockers
  // (excludes dependencyCount === 0 rows) — this file is only about the
  // parent-title pass, and a stray listBlockedByIssues/claimTask call would
  // be noise unrelated to what these tests assert.
  function insertChildTask(
    projectId: number,
    overrides: Partial<typeof tasks.$inferInsert> = {},
  ): number {
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 100 + Math.floor(Math.random() * 100_000),
        title: "child",
        status: "backlog",
        boardOrder: 0,
        dependencyCount: 0,
        parentIssueRepo: "test-owner/test-repo",
        ...overrides,
      })
      .returning({ id: tasks.id })
      .all();
    return row.id;
  }

  function getTask(taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  // Calibrated for exactly ONE project in the sweep. startTaskWatcher's
  // real (unmocked) sweepTimer doesn't fire at a flat 10s — it fires at
  // `(rows.length - 1) * STARTUP_STAGGER_MS + margin`, where the staggered
  // per-project initial-fetch dance pushes it later for every additional
  // project (STARTUP_STAGGER_MS = 2s, margin = max(pollIntervalMs*2, 10s)
  // = 10s for this file's env). With 1 project that's exactly 10s; with
  // more, use runOneSweepWithProjectCount below instead, or this silently
  // asserts against a sweep that hasn't actually run yet.
  async function runOneSweep() {
    await runOneSweepWithProjectCount(1);
  }

  async function runOneSweepWithProjectCount(projectCount: number) {
    vi.useFakeTimers();
    cleanup = startTaskWatcher(app);
    const staggerMs = (projectCount - 1) * 2_000;
    await vi.advanceTimersByTimeAsync(staggerMs + 10_000);
  }

  it("fetches once per distinct parent and fills every sibling's title", async () => {
    const projectId = await createProject();
    mockGetIssueTitle.mockResolvedValue("Phase 5 — Tier-1 project introspection");
    const t1 = insertChildTask(projectId, { parentIssueNumber: 30 });
    const t2 = insertChildTask(projectId, { parentIssueNumber: 30 });
    const t3 = insertChildTask(projectId, { parentIssueNumber: 30 });
    const t4 = insertChildTask(projectId, { parentIssueNumber: 30 });

    await runOneSweep();

    expect(mockGetIssueTitle).toHaveBeenCalledTimes(1);
    expect(mockGetIssueTitle).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 30);
    for (const id of [t1, t2, t3, t4]) {
      expect(getTask(id).parentIssueTitle).toBe("Phase 5 — Tier-1 project introspection");
    }
  });

  it("fetches against the PARENT's own repo, not the project's repo, for a cross-repo parent", async () => {
    const projectId = await createProject();
    mockGetIssueTitle.mockResolvedValue("Upstream epic");
    const taskId = insertChildTask(projectId, {
      parentIssueNumber: 7,
      parentIssueRepo: "other-owner/other-repo",
    });

    await runOneSweep();

    expect(mockGetIssueTitle).toHaveBeenCalledWith("ghp_token", "other-owner", "other-repo", 7);
    expect(getTask(taskId).parentIssueTitle).toBe("Upstream epic");
  });

  it("never re-fetches a title that's already filled", async () => {
    const projectId = await createProject();
    mockGetIssueTitle.mockResolvedValue("Phase 1");
    insertChildTask(projectId, { parentIssueNumber: 21 });

    await runOneSweep();
    expect(mockGetIssueTitle).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    // A second sweep tick with nothing new to fill makes zero further calls
    // — the "one cheap SELECT per sweep forever, doing nothing further"
    // behavior the pass's own doc comment describes.
    expect(mockGetIssueTitle).toHaveBeenCalledTimes(1);
  });

  it("broadcasts a kind:'hierarchy' event for every row a filled title covers", async () => {
    const projectId = await createProject();
    mockGetIssueTitle.mockResolvedValue("Phase 9");
    const t1 = insertChildTask(projectId, { parentIssueNumber: 28 });
    const t2 = insertChildTask(projectId, { parentIssueNumber: 28 });

    await runOneSweep();

    expect(mockBroadcastTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: t1, projectId, kind: "hierarchy" }),
    );
    expect(mockBroadcastTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: t2, projectId, kind: "hierarchy" }),
    );
  });

  // Independent review, PR #702 — the token used to fetch a shared parent
  // used to be hard-coded to `group.rows[0]`'s own project. Since a group
  // can span more than one Mullion project, a group whose lowest-id row
  // happened to belong to a project with no working token would silently
  // starve forever even when a sibling project in the same group had one.
  it("falls back to a sibling project's token when the first-grouped row's own project has none", async () => {
    const workingProjectId = await createProject();
    const brokenCwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-watcher-hierarchy-notoken-"));
    const brokenRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        createDir: true,
        name: `p-${crypto.randomBytes(4).toString("hex")}`,
        cwd: brokenCwd,
      },
    });
    const brokenProjectId = brokenRes.json().id as number;

    // Simulates "not a GitHub repo" / "host unreachable" — the real
    // condition that leaves a project absent from githubContext. Matched
    // by substring, not exact equality — routes/projects.ts path.resolve()s
    // a project's cwd on create, and this only needs to identify which of
    // the two temp dirs a call is about, not assert the resolution is a
    // no-op.
    mockResolveRepoRef.mockImplementation(async (_app: unknown, params: { cwd: string }) => {
      if (params.cwd.includes("task-watcher-hierarchy-notoken-")) return null;
      return { owner: "test-owner", repo: "test-repo" };
    });
    mockGetIssueTitle.mockResolvedValue("Shared parent");

    // The broken-project task is inserted FIRST, so it gets the lower id
    // and sorts first in the candidate query's `.orderBy(tasks.id)` —
    // exactly the ordering the fix must not blindly trust as the group's
    // token source.
    const brokenTaskId = insertChildTask(brokenProjectId, { parentIssueNumber: 50 });
    const workingTaskId = insertChildTask(workingProjectId, { parentIssueNumber: 50 });

    // Two projects registered — see runOneSweepWithProjectCount's own
    // comment for why the flat runOneSweep() helper isn't calibrated for
    // this and would assert before the real sweep has actually run.
    await runOneSweepWithProjectCount(2);

    expect(mockGetIssueTitle).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 50);
    expect(getTask(brokenTaskId).parentIssueTitle).toBe("Shared parent");
    expect(getTask(workingTaskId).parentIssueTitle).toBe("Shared parent");
  });

  // Hermes review, PR #702 — the give-up key is shared across every
  // project in a group, so if one project's token happens to be
  // under-scoped for this specific parent (403/404) while a sibling
  // project's own token can see it fine, the group must try that other
  // token too before counting the parent as failed — not stop at the
  // first token it happened to find.
  it("tries every distinct project token in the group before counting a failure", async () => {
    const projectAId = await createProject();
    const bCwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-watcher-hierarchy-projectb-"));
    const bRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: `p-${crypto.randomBytes(4).toString("hex")}`, cwd: bCwd },
    });
    const projectBId = bRes.json().id as number;

    mockResolveRepoRef.mockImplementation(async (_app: unknown, params: { cwd: string }) => {
      if (params.cwd.includes("task-watcher-hierarchy-projectb-")) {
        return { owner: "project-b", repo: "repo-b" };
      }
      return { owner: "project-a", repo: "repo-a" };
    });
    mockResolveGitHubToken.mockImplementation(async (_app: unknown, repoRef: { owner: string }) =>
      repoRef.owner === "project-a" ? "token-a" : "token-b",
    );
    // token-a (project A's own token) can't see the shared parent;
    // token-b (project B's) can — a realistic under-scoped-token scenario.
    mockGetIssueTitle.mockImplementation(async (token: string) => {
      if (token === "token-a") throw new Error("token-a lacks access to this parent");
      return "Shared parent";
    });

    // projectA's task is inserted FIRST, so token-a is the first candidate
    // tried — exactly the ordering that must NOT stop the group at one
    // failure.
    const taskAId = insertChildTask(projectAId, { parentIssueNumber: 70 });
    const taskBId = insertChildTask(projectBId, { parentIssueNumber: 70 });

    await runOneSweepWithProjectCount(2);

    expect(mockGetIssueTitle).toHaveBeenCalledTimes(2);
    expect(mockGetIssueTitle).toHaveBeenCalledWith("token-a", "test-owner", "test-repo", 70);
    expect(mockGetIssueTitle).toHaveBeenCalledWith("token-b", "test-owner", "test-repo", 70);
    expect(getTask(taskAId).parentIssueTitle).toBe("Shared parent");
    expect(getTask(taskBId).parentIssueTitle).toBe("Shared parent");
  });

  it("resets the attempt counter after a successful fetch, not counting a prior failure against a later streak", async () => {
    const projectId = await createProject();
    const taskId = insertChildTask(projectId, { parentIssueNumber: 62 });

    let shouldFail = true;
    mockGetIssueTitle.mockImplementation(async () => {
      if (shouldFail) throw new Error("transient");
      return "Filled";
    });

    await runOneSweep(); // sweep 1: fails once — attempts=1
    expect(getTask(taskId).parentIssueTitle).toBeNull();

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(1_000); // sweep 2: succeeds — attempts reset
    expect(getTask(taskId).parentIssueTitle).toBe("Filled");

    // Simulate a later re-arm (a real re-parenting nulls the title via
    // upsertIssueTask's own CASE WHEN — see task-watcher-ingest.test.ts)
    // and start failing again.
    app.db.update(tasks).set({ parentIssueTitle: null }).where(eq(tasks.id, taskId)).run();
    shouldFail = true;
    mockGetIssueTitle.mockClear();

    await vi.advanceTimersByTimeAsync(1_000); // sweep 3: fail #1 of the new streak
    await vi.advanceTimersByTimeAsync(1_000); // sweep 4: fail #2
    expect(mockGetIssueTitle).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); // sweep 5: fail #3 — gives up
    expect(mockGetIssueTitle).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000); // sweep 6: must NOT attempt a 4th time
    expect(mockGetIssueTitle).toHaveBeenCalledTimes(3);
  });

  it("has no parent-title candidates and makes no call when parentIssueNumber is null", async () => {
    const projectId = await createProject();
    insertChildTask(projectId, { parentIssueNumber: null, parentIssueRepo: null });

    await runOneSweep();

    expect(mockGetIssueTitle).not.toHaveBeenCalled();
  });

  it("respects the per-sweep cap, deferring the remainder to a later sweep", async () => {
    const projectId = await createProject();
    mockGetIssueTitle.mockImplementation(async (_t, _o, _r, n: number) => `Parent ${n}`);
    // MAX_PARENT_TITLE_FETCHES_PER_SWEEP is 20 — 25 distinct parents means
    // 5 must be deferred.
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(insertChildTask(projectId, { parentIssueNumber: 1000 + i }));
    }

    await runOneSweep();
    expect(mockGetIssueTitle).toHaveBeenCalledTimes(20);
    const filledAfterFirstSweep = ids.filter((id) => getTask(id).parentIssueTitle !== null).length;
    expect(filledAfterFirstSweep).toBe(20);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockGetIssueTitle).toHaveBeenCalledTimes(25);
    expect(ids.every((id) => getTask(id).parentIssueTitle !== null)).toBe(true);
  });

  it("gives up on a persistently-failing parent after MAX_PARENT_TITLE_ATTEMPTS, without blocking other parents", async () => {
    const projectId = await createProject();
    const badTask = insertChildTask(projectId, { parentIssueNumber: 404 });
    const goodTask = insertChildTask(projectId, { parentIssueNumber: 200 });
    mockGetIssueTitle.mockImplementation(async (_t, _o, _r, n: number) => {
      if (n === 404) throw new Error("not found");
      return "Good parent";
    });

    await runOneSweep();
    expect(getTask(goodTask).parentIssueTitle).toBe("Good parent");
    expect(getTask(badTask).parentIssueTitle).toBeNull();
    expect(mockGetIssueTitle).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 404);

    mockGetIssueTitle.mockClear();
    await vi.advanceTimersByTimeAsync(1_000); // sweep 2 — 2nd attempt on 404
    await vi.advanceTimersByTimeAsync(1_000); // sweep 3 — 3rd attempt on 404 (MAX_PARENT_TITLE_ATTEMPTS)
    await vi.advanceTimersByTimeAsync(1_000); // sweep 4 — must NOT attempt a 4th time

    const attemptsOn404 = mockGetIssueTitle.mock.calls.filter((c) => c[3] === 404).length;
    expect(attemptsOn404).toBe(2); // sweeps 2 and 3 only — capped at MAX_PARENT_TITLE_ATTEMPTS total (1 + 2)
    expect(getTask(badTask).parentIssueTitle).toBeNull();
  });
});
