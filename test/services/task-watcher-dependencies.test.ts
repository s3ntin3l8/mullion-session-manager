// #667 — dependency-aware auto-claim, exercised end to end against a real
// DB via buildApp() (same pattern as task-claim.test.ts), with only the
// GitHub network layer and the claim spawn itself mocked. Complements
// task-dependencies.test.ts's pure dependencyGate/parseBlockedBy unit
// coverage and task-watcher.test.ts's hand-mocked ingest/read-back coverage
// — this file is specifically about autoClaimReadyTasks's lazy, bounded
// dependency check (capacity pre-count, re-check TTL, per-sweep cap,
// boardOrder ordering).
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
// Neutralizes the unlabel read-back for every pre-inserted task below (see
// this file's own beforeEach): mocked to always report open+labeled so
// syncProjectTasks never fails a task out from under these tests, which
// only care about autoClaimReadyTasks's own gating.
vi.mock("../../src/services/github-write.js", () => ({
  getIssueState: mockGetIssueState,
  listBlockedByIssues: mockListBlockedByIssues,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { startTaskWatcher } = await import("../../src/services/task-watcher.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-watcher-deps-test-${process.pid}.db`);

describe("autoClaimReadyTasks — dependency-aware claiming (#667)", () => {
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
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    app.db.delete(tasks).run();
    app.db.delete(projects).run();
    vi.useRealTimers();
  });

  async function createProject(): Promise<number> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-watcher-deps-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: `p-${crypto.randomBytes(4).toString("hex")}`, cwd },
    });
    return res.json().id as number;
  }

  function insertTask(
    projectId: number,
    overrides: Partial<typeof tasks.$inferInsert> = {},
  ): number {
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: null,
        title: "t",
        status: "ready",
        boardOrder: 0,
        dependencyCount: null,
        blockedBy: null,
        blockedByCheckedAt: null,
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

  // Deliberately not `toHaveBeenCalledWith(app, taskId, {...})` — Vitest's
  // equality check would structurally walk the real FastifyInstance `app`
  // arg, including its `listeningOrigin` getter, which throws on an app
  // that was never `.listen()`'d (these tests only ever `app.inject()`).
  // Checking the non-`app` args is both sufficient and avoids that getter
  // entirely.
  function expectClaimedWith(taskId: number) {
    expect(mockClaimTask).toHaveBeenCalledWith(expect.anything(), taskId, { auto: true });
  }

  // The one sweep tick every test below drives — see the file header for
  // why: MULLION_TASK_POLL_INTERVAL=1 makes pollOnce's own sweepTimer fire
  // at max(pollIntervalMs*2, 10_000) = 10_000ms regardless, the same margin
  // floor task-watcher.ts's own startup logic uses.
  async function runOneSweep() {
    vi.useFakeTimers();
    cleanup = startTaskWatcher(app);
    await vi.advanceTimersByTimeAsync(10_000);
  }

  it("a zero-dependency task claims with no listBlockedByIssues call at all (AC #3)", async () => {
    const projectId = await createProject();
    const taskId = insertTask(projectId, { issueNumber: 1, dependencyCount: 0 });

    await runOneSweep();

    expect(mockListBlockedByIssues).not.toHaveBeenCalled();
    expectClaimedWith(taskId);
  });

  it("a local task (no issueNumber, dependencyCount null) claims with no call and no token needed", async () => {
    const projectId = await createProject();
    mockResolveGitHubToken.mockResolvedValue(null);
    const taskId = insertTask(projectId, { issueNumber: null, dependencyCount: null });

    await runOneSweep();

    expect(mockListBlockedByIssues).not.toHaveBeenCalled();
    expectClaimedWith(taskId);
  });

  it("at capacity, skips the sweep entirely — zero dependency calls, zero claim attempts", async () => {
    const projectId = await createProject();
    // MULLION_TASK_MAX_CONCURRENT=5 for this file — fill it exactly.
    for (let i = 0; i < 5; i++) {
      insertTask(projectId, { status: "claimed", issueNumber: null });
    }
    insertTask(projectId, {
      issueNumber: 2,
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });

    await runOneSweep();

    expect(mockListBlockedByIssues).not.toHaveBeenCalled();
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  it("a fresh (within-TTL) unresolved check is skipped with no new call", async () => {
    const projectId = await createProject();
    const taskId = insertTask(projectId, {
      issueNumber: 3,
      dependencyCount: 1,
      blockedBy: null,
      // Fresh — inside BLOCKER_RECHECK_TTL_MS (5 minutes).
      blockedByCheckedAt: new Date(),
    });

    await runOneSweep();

    expect(mockListBlockedByIssues).not.toHaveBeenCalled();
    expect(mockClaimTask).not.toHaveBeenCalled();
    expect(getTask(taskId).status).toBe("ready");
  });

  it("a stale check with an open blocker resolves, is recorded, and is not claimed", async () => {
    const projectId = await createProject();
    mockListBlockedByIssues.mockResolvedValue([
      {
        owner: "test-owner",
        repo: "test-repo",
        number: 99,
        title: "Blocker",
        htmlUrl: "https://x/99",
        state: "open",
      },
    ]);
    const taskId = insertTask(projectId, {
      issueNumber: 4,
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });

    await runOneSweep();

    expect(mockListBlockedByIssues).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 4);
    expect(mockClaimTask).not.toHaveBeenCalled();
    const row = getTask(taskId);
    expect(row.status).toBe("ready");
    expect(JSON.parse(row.blockedBy!)).toEqual([
      {
        owner: "test-owner",
        repo: "test-repo",
        number: 99,
        title: "Blocker",
        htmlUrl: "https://x/99",
      },
    ]);
    expect(row.blockedByCheckedAt).not.toBeNull();
  });

  it("a stale check whose blocker is closed resolves to clear and claims", async () => {
    const projectId = await createProject();
    mockListBlockedByIssues.mockResolvedValue([
      {
        owner: "test-owner",
        repo: "test-repo",
        number: 99,
        title: "Blocker",
        htmlUrl: "https://x/99",
        state: "closed",
      },
    ]);
    const taskId = insertTask(projectId, {
      issueNumber: 5,
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });

    await runOneSweep();

    expect(mockListBlockedByIssues).toHaveBeenCalledTimes(1);
    expectClaimedWith(taskId);
  });

  it("claims ready tasks in boardOrder, not insertion order", async () => {
    const projectId = await createProject();
    const second = insertTask(projectId, { issueNumber: 6, dependencyCount: 0, boardOrder: 1 });
    const first = insertTask(projectId, { issueNumber: 7, dependencyCount: 0, boardOrder: 0 });

    await runOneSweep();

    const order = mockClaimTask.mock.calls.map((call) => call[1]);
    expect(order.indexOf(first)).toBeLessThan(order.indexOf(second));
  });

  it("caps dependency checks per sweep and warns when candidates exceed it", async () => {
    const projectId = await createProject();
    for (let i = 0; i < 21; i++) {
      insertTask(projectId, {
        issueNumber: 100 + i,
        dependencyCount: 1,
        blockedBy: null,
        blockedByCheckedAt: null,
        boardOrder: i,
      });
    }
    const warnSpy = vi.spyOn(app.log, "warn");

    await runOneSweep();

    expect(mockListBlockedByIssues).toHaveBeenCalledTimes(20);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ checked: 20 }),
      expect.stringContaining("dependency check"),
    );
  });
});
