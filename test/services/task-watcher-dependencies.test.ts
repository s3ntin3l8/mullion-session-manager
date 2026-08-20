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

// Task-claim queueing (rate-limit-storm fix) — task-watcher.ts's auto-claim
// sweep calls enqueueTask now, not the removed claimTask. dispatchQueuedTasks
// is also mocked — pollOnce's own periodic dispatch call would otherwise run
// for real against this file's real (buildApp()) app/DB, attempting a real
// PTY spawn this file never mocks (only "the claim spawn itself," i.e. the
// enqueue-time no-seed-channel gate, was ever mocked out here — see the
// file's own header comment).
const mockEnqueueTask = vi.hoisted(() => vi.fn());
const mockDispatchQueuedTasks = vi.hoisted(() => vi.fn());
const mockResolveRepoRef = vi.hoisted(() => vi.fn());
const mockResolveGitHubToken = vi.hoisted(() => vi.fn());
const mockListLabeledIssues = vi.hoisted(() => vi.fn());
const mockGetIssueState = vi.hoisted(() => vi.fn());
const mockListBlockedByIssues = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/task-claim.js", () => ({
  enqueueTask: mockEnqueueTask,
}));
vi.mock("../../src/services/task-dispatch.js", () => ({
  dispatchQueuedTasks: mockDispatchQueuedTasks,
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
const { tasks, projects, settings } = await import("../../src/db/schema.js");
const { startTaskWatcher } = await import("../../src/services/task-watcher.js");
const { getStoredSettings, deepMerge, sanitizeSettings, SETTINGS_ROW_ID } =
  await import("../../src/services/settings.js");
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
    mockEnqueueTask.mockReset();
    mockEnqueueTask.mockResolvedValue({ ok: true });
    mockDispatchQueuedTasks.mockReset();
    mockDispatchQueuedTasks.mockResolvedValue(undefined);
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
    // settings isn't a per-test-isolated table like tasks/projects above, so
    // an individual test's own trailing setAutoClaimPaused(false) is not
    // enough — an assertion failure earlier in that same test would throw
    // past it and leave autoClaimPaused: true poisoning every test that
    // runs after it in this file (a real, hit-in-practice failure mode:
    // fixing one such assertion cascaded into 4 unrelated failures before
    // this reset was added here). Reset unconditionally, every test,
    // regardless of whether that test itself ever paused.
    setAutoClaimPaused(false);
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

  // Direct DB write, not app.inject("PATCH", "/api/settings") — runOneSweep
  // below runs under vi.useFakeTimers(), and light-my-request's own internal
  // promise resolution depends on real timers, so an inject call made while
  // fake timers are active (or not yet restored by afterEach) can hang.
  function setAutoClaimPaused(paused: boolean) {
    const next = sanitizeSettings(
      deepMerge(getStoredSettings(app.db), { taskMaster: { autoClaimPaused: paused } }),
    );
    app.db
      .insert(settings)
      .values({ id: SETTINGS_ROW_ID, data: JSON.stringify(next) })
      .onConflictDoUpdate({
        target: settings.id,
        set: { data: JSON.stringify(next), updatedAt: new Date() },
      })
      .run();
  }

  // Deliberately not `toHaveBeenCalledWith(app, taskId, {...})` — Vitest's
  // equality check would structurally walk the real FastifyInstance `app`
  // arg, including its `listeningOrigin` getter, which throws on an app
  // that was never `.listen()`'d (these tests only ever `app.inject()`).
  // Checking the non-`app` args is both sufficient and avoids that getter
  // entirely.
  function expectClaimedWith(taskId: number) {
    expect(mockEnqueueTask).toHaveBeenCalledWith(expect.anything(), taskId, { auto: true });
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

  it("resolves a backlog task's blockers even with autoClaimPaused true — the reported bug", async () => {
    // Reproduces the live-install condition exactly: autoClaimReadyTasks
    // returns before its loop ever runs when paused, so it was the only
    // poll-path caller of refreshTaskBlockers — every GitHub-linked
    // `backlog` task (autoClaimReadyTasks itself only ever looked at
    // `ready`, a second, independent gap) sat at dependencyGate() ===
    // "unresolved" forever, rendering "Checking dependencies…" permanently.
    const projectId = await createProject();
    setAutoClaimPaused(true);
    // A clean (non-shortfall) resolution — dependencyCount:1 matched by
    // exactly one returned blocker. The default `[]` mock would be a
    // shortfall against dependencyCount:1, and a shortfall is deliberately
    // never stamped to blockedByCheckedAt by any caller (see
    // refreshTaskBlockers' own stampOnFailure doc comment) — that's a
    // separate, dedicated behavior covered by its own test below, and would
    // make this test's "blockedByCheckedAt gets stamped at all" assertion
    // fail for a reason that has nothing to do with the bug this test pins.
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
      status: "backlog",
      issueNumber: 50,
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });

    await runOneSweep();

    expect(mockListBlockedByIssues).toHaveBeenCalledTimes(1);
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    const row = getTask(taskId);
    expect(row.status).toBe("backlog");
    expect(row.blockedByCheckedAt).not.toBeNull();
  });

  // Hermes review — the shared-TTL interaction between the claim path and
  // the decoupled display pass (docs/tasks.md's "Backoff on a hard error
  // only" / "No same-tick double-refresh with the claim path"). Both halves
  // of the guarantee matter and were both broken by an earlier version of
  // this fix: (1) within one sweep, a row the claim path already
  // shortfall-checked must not be checked a second time by the display
  // pass, and (2) across sweeps, a shortfall must still be re-checked on
  // the very next sweep rather than sitting stale for the display pass's
  // 30-minute TTL.
  it("a claim-path shortfall makes exactly one GitHub call per sweep, and is re-checked again on the next sweep", async () => {
    const projectId = await createProject();
    const taskId = insertTask(projectId, {
      status: "ready",
      issueNumber: 80,
      dependencyCount: 2,
      blockedBy: null,
      blockedByCheckedAt: null,
    });
    mockListBlockedByIssues.mockResolvedValue([
      {
        owner: "test-owner",
        repo: "test-repo",
        number: 1,
        title: "visible",
        htmlUrl: "https://x/1",
        state: "open",
      },
    ]);

    vi.useFakeTimers();
    cleanup = startTaskWatcher(app);
    await vi.advanceTimersByTimeAsync(10_000);

    // Tick 1: the claim path shortfall-checks this row once; the display
    // pass, running right after in the same tick, must skip it rather than
    // fetching it again.
    expect(mockListBlockedByIssues).toHaveBeenCalledTimes(1);
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(getTask(taskId).blockedByCheckedAt).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);

    // Tick 2 (the interval's first firing, one pollIntervalMs later): a
    // shortfall was never stamped, so the claim path's own 5-minute TTL
    // still reads this row as never-checked and re-fetches it immediately
    // — not stuck for a display-pass-length window.
    expect(mockListBlockedByIssues).toHaveBeenCalledTimes(2);
  });

  it("at capacity, skips the claim-gate check and every claim attempt — but the decoupled display pass still resolves the row", async () => {
    const projectId = await createProject();
    // A clean (non-shortfall) resolution — see the previous test's comment
    // for why the default `[]` mock would be the wrong fixture here.
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
    // MULLION_TASK_MAX_CONCURRENT=5 for this file — fill it exactly.
    for (let i = 0; i < 5; i++) {
      insertTask(projectId, { status: "claimed", issueNumber: null });
    }
    const taskId = insertTask(projectId, {
      issueNumber: 2,
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });

    await runOneSweep();

    // autoClaimReadyTasks' own capacity pre-count bails before its loop
    // ever runs, so it makes zero calls and attempts zero claims — this is
    // unchanged from before this pass existed.
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    // resolveStaleTaskBlockers is deliberately NOT capacity-gated (resolving
    // a blocker for display purposes has nothing to do with concurrency
    // slots), so it still resolves this row in the same sweep.
    expect(mockListBlockedByIssues).toHaveBeenCalledTimes(1);
    expect(getTask(taskId).blockedByCheckedAt).not.toBeNull();
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
    expect(mockEnqueueTask).not.toHaveBeenCalled();
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
    expect(mockEnqueueTask).not.toHaveBeenCalled();
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

    const order = mockEnqueueTask.mock.calls.map((call) => call[1]);
    expect(order.indexOf(first)).toBeLessThan(order.indexOf(second));
  });

  it("caps dependency checks per sweep and warns when candidates exceed it", async () => {
    const projectId = await createProject();
    // A clean (non-shortfall) resolution — dependencyCount:1 matched by
    // exactly one returned blocker — so every claim-path refresh this test
    // triggers actually stamps blockedByCheckedAt. That matters here: with
    // the default `[]` mock (a shortfall against dependencyCount:1) NONE of
    // the claim path's 20 refreshes would stamp anything, so all 21 rows
    // would remain candidates for the decoupled display-refresh pass
    // (resolveStaleTaskBlockers) too and inflate this test's call count in a
    // way that has nothing to do with the claim-gate cap this test exists
    // to pin.
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

    // autoClaimReadyTasks' own cap (MAX_DEPENDENCY_CHECKS_PER_SWEEP = 20)
    // resolves the first 20 of the 21 candidates in boardOrder and defers
    // the 21st, warning about it. The decoupled display pass then picks up
    // that one still-unresolved row in the same tick (its own cap is 10, so
    // one leftover candidate doesn't come close to it) — 20 + 1 = 21 total.
    expect(mockListBlockedByIssues).toHaveBeenCalledTimes(21);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ checked: 20 }),
      expect.stringContaining("dependency check"),
    );
    // The display pass's own cap was never approached (one leftover
    // candidate against a cap of 10), so it must not have logged its own
    // "cap exceeded" line.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("display dependency refresh"),
    );
  });

  it("the decoupled display-refresh pass caps its own checks per sweep and defers the rest", async () => {
    const projectId = await createProject();
    // Paused so autoClaimReadyTasks makes zero calls of its own — isolates
    // resolveStaleTaskBlockers' own MAX_DISPLAY_DEPENDENCY_CHECKS_PER_SWEEP
    // cap from the claim path's cap tested above.
    setAutoClaimPaused(true);
    for (let i = 0; i < 11; i++) {
      insertTask(projectId, {
        issueNumber: 200 + i,
        dependencyCount: 1,
        blockedBy: null,
        blockedByCheckedAt: null,
        boardOrder: i,
      });
    }
    const debugSpy = vi.spyOn(app.log, "debug");

    await runOneSweep();

    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockListBlockedByIssues).toHaveBeenCalledTimes(10);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({ checked: 10 }),
      expect.stringContaining("display dependency refresh"),
    );
  });

  it("resolves a claimed task too — manual claim bypasses dependencyGate entirely, so it's the only path that ever checks it", async () => {
    const projectId = await createProject();
    // A clean (non-shortfall) resolution — see the earlier "reported bug"
    // test's comment for why the default `[]` mock would be the wrong
    // fixture here.
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
      status: "claimed",
      issueNumber: 51,
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });

    await runOneSweep();

    expect(mockListBlockedByIssues).toHaveBeenCalledTimes(1);
    expect(getTask(taskId).blockedByCheckedAt).not.toBeNull();
  });

  it("never checks a done or failed task, regardless of stale dependency state", async () => {
    const projectId = await createProject();
    insertTask(projectId, {
      status: "done",
      issueNumber: 52,
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });
    insertTask(projectId, {
      status: "failed",
      issueNumber: 53,
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });

    await runOneSweep();

    expect(mockListBlockedByIssues).not.toHaveBeenCalled();
  });

  it("does not re-check a row within the display TTL, even though it's well past the claim-gate TTL", async () => {
    const projectId = await createProject();
    // BLOCKER_RECHECK_TTL_MS (claim gate) is 5 minutes; BLOCKER_DISPLAY_TTL_MS
    // is 30. 10 minutes ago is stale for the claim path but fresh for
    // display — pin the two TTLs are genuinely independent, not the same
    // constant reused. Paused so only the display pass is exercised.
    setAutoClaimPaused(true);
    insertTask(projectId, {
      status: "backlog",
      issueNumber: 54,
      dependencyCount: 1,
      blockedBy: "[]",
      blockedByCheckedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    await runOneSweep();

    expect(mockListBlockedByIssues).not.toHaveBeenCalled();
  });

  it("serves never-checked rows before stale-but-resolved ones when both are candidates", async () => {
    const projectId = await createProject();
    setAutoClaimPaused(true);
    // A clean (non-shortfall) resolution — see the earlier "reported bug"
    // test's comment for why the default `[]` mock would be the wrong
    // fixture here.
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
    // Stale-but-previously-resolved (blockedByCheckedAt set, but past the
    // 30-minute display TTL).
    const stale = insertTask(projectId, {
      status: "backlog",
      issueNumber: 60,
      dependencyCount: 1,
      blockedBy: "[]",
      blockedByCheckedAt: new Date(Date.now() - 31 * 60 * 1000),
      boardOrder: 0,
    });
    // Never checked at all — must be served first regardless of boardOrder.
    const neverChecked = insertTask(projectId, {
      status: "backlog",
      issueNumber: 61,
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
      boardOrder: 1,
    });
    void stale;

    await runOneSweep();

    // Both are candidates and the cap (10) comfortably covers both, so this
    // only pins ORDER, not the cap — check call order via mock invocation
    // order rather than call count.
    const issueNumbers = mockListBlockedByIssues.mock.calls.map((c) => c[3]);
    expect(issueNumbers.indexOf(61)).toBeLessThan(issueNumbers.indexOf(60));
    expect(getTask(neverChecked).blockedByCheckedAt).not.toBeNull();
  });

  it("backs off a persistently-failing row instead of re-fetching it every tick", async () => {
    const projectId = await createProject();
    setAutoClaimPaused(true);
    mockListBlockedByIssues.mockRejectedValue(new Error("network unreachable"));
    const taskId = insertTask(projectId, {
      status: "backlog",
      issueNumber: 70,
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });

    await runOneSweep();

    // The error path still stamps blockedByCheckedAt (stampOnFailure) so
    // this row falls out of the display pass's candidate set for a full TTL
    // window instead of being hammered on every tick — see
    // refreshTaskBlockers' own stampOnFailure doc comment.
    expect(mockListBlockedByIssues).toHaveBeenCalledTimes(1);
    const row = getTask(taskId);
    expect(row.blockedByCheckedAt).not.toBeNull();
    expect(row.blockedBy).toBeNull(); // unchanged — an error leaves prior state
  });
});
