// Must come before any import that could itself load "node-pty" /
// "node:child_process" — see test/helpers/mock-pty.ts's header comment.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import type * as ChildProcess from "node:child_process";
import { buildTestApp } from "../helpers/app.js";
import { hosts, projects, sessions, tasks } from "../../src/db/schema.js";
import {
  adoptActiveTaskSessions,
  adoptSurvivingSession,
} from "../../src/services/session-adopt.js";
import { reconcileTasks } from "../../src/services/task-reconciler.js";
import type { SessionLiveness } from "../../src/services/session-process.js";

const ptyMock = plainNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
// Every systemd-run / dtach / systemctl call is faked (AGENTS.md invariant: no
// test may start a real scope). Adoption must not need one anyway — these
// tests assert getOrCreate is the only thing that would.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

type App = Awaited<ReturnType<typeof buildTestApp>>;

/** A project and one session row for it; `over` lets a test bend the row. */
function seed(app: App, over: Partial<typeof sessions.$inferInsert> = {}) {
  const [project] = app.db.insert(projects).values({ name: "p", cwd: "/work/p" }).returning().all();
  const [row] = app.db
    .insert(sessions)
    .values({ projectId: project.id, command: "claude", ...over })
    .returning()
    .all();
  return { project, row, id: String(row.id) };
}

/** Pretends PtyManager is told about the session: `get()` answers a live one. */
function stubAdoptable(app: App, liveness: SessionLiveness) {
  const tracked = new Set<string>();
  vi.spyOn(app.pty, "get").mockImplementation(((key: string) =>
    tracked.has(key) ? { isAlive: true } : undefined) as unknown as typeof app.pty.get);
  const isMasterAliveState = vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue(liveness);
  const getOrCreate = vi.spyOn(app.pty, "getOrCreate").mockImplementation(((opts: {
    id: string;
  }) => {
    tracked.add(opts.id);
    return { spawnOutcome: async () => {} };
  }) as unknown as typeof app.pty.getOrCreate);
  return { isMasterAliveState, getOrCreate, tracked };
}

describe("adoptSurvivingSession (issue #2271)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reattaches a session whose scope is alive, from its stored cwd/command/env", async () => {
    const app = await buildTestApp();
    const { id } = seed(app, { cwd: "/work/p/wt", env: JSON.stringify({ FOO: "bar" }) });
    const { getOrCreate } = stubAdoptable(app, "alive");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("adopted");

    expect(getOrCreate).toHaveBeenCalledTimes(1);
    expect(getOrCreate).toHaveBeenCalledWith({
      id,
      cwd: "/work/p/wt",
      command: "claude",
      cols: 80,
      rows: 24,
      env: { FOO: "bar" },
    });
  });

  it("falls back to the project's cwd when the session has none of its own", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate } = stubAdoptable(app, "alive");

    await adoptSurvivingSession(app, id);

    expect(getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work/p" }));
  });

  it("never respawns a session whose scope is gone", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate } = stubAdoptable(app, "dead");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("not-running");

    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("treats an unverifiable scope as retryable, never as dead", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate } = stubAdoptable(app, "unknown");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("unverifiable");

    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("leaves a session PtyManager already tracks alone", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { isMasterAliveState, getOrCreate, tracked } = stubAdoptable(app, "alive");
    tracked.add(id);

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("live");

    expect(isMasterAliveState).not.toHaveBeenCalled();
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it.each(["killed", "exited"] as const)("does not adopt a %s session", async (status) => {
    const app = await buildTestApp();
    const { id } = seed(app, { status });
    const { isMasterAliveState, getOrCreate } = stubAdoptable(app, "alive");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("not-running");

    expect(isMasterAliveState).not.toHaveBeenCalled();
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it.each(["9999", "not-a-number"])(
    "answers not-running for an id with no row (%s)",
    async (id) => {
      const app = await buildTestApp();
      const { getOrCreate } = stubAdoptable(app, "alive");

      await expect(adoptSurvivingSession(app, id)).resolves.toBe("not-running");

      expect(getOrCreate).not.toHaveBeenCalled();
    },
  );

  it("leaves a session on another host to that host's own PtyManager", async () => {
    const app = await buildTestApp();
    app.db.insert(hosts).values({ id: "box", name: "box" }).run();
    const { id } = seed(app, { hostId: "box" });
    const { isMasterAliveState, getOrCreate } = stubAdoptable(app, "alive");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("not-running");

    expect(isMasterAliveState).not.toHaveBeenCalled();
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("shares one adoption between concurrent callers", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate } = stubAdoptable(app, "alive");

    const results = await Promise.all([
      adoptSurvivingSession(app, id),
      adoptSurvivingSession(app, id),
      adoptSurvivingSession(app, id),
    ]);

    expect(results).toEqual(["adopted", "adopted", "adopted"]);
    expect(getOrCreate).toHaveBeenCalledTimes(1);
  });

  it("yields to a terminal attach that won the race during the liveness read", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate, tracked } = stubAdoptable(app, "alive");
    vi.spyOn(app.pty, "isMasterAliveState").mockImplementation(async () => {
      tracked.add(id);
      return "alive";
    });

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("live");

    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("reports unverifiable when the reattach never produces a live process", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    stubAdoptable(app, "alive");
    // getOrCreate "succeeds" but the session never becomes alive.
    vi.spyOn(app.pty, "getOrCreate").mockReturnValue({
      spawnOutcome: () => new Promise<void>(() => {}),
    } as unknown as ReturnType<typeof app.pty.getOrCreate>);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });

    const outcome = adoptSurvivingSession(app, id);
    await vi.advanceTimersByTimeAsync(6000);

    await expect(outcome).resolves.toBe("unverifiable");
  });

  it("reattaches at the size the session already has, not a guessed one", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate } = stubAdoptable(app, "alive");
    vi.spyOn(app.pty, "storedPtySize").mockReturnValue({ cols: 200, rows: 60 });

    await adoptSurvivingSession(app, id);

    expect(getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ cols: 200, rows: 60 }));
  });

  it("surfaces a genuine spawn failure instead of a retryable 'unverifiable'", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    stubAdoptable(app, "alive");
    vi.spyOn(app.pty, "getOrCreate").mockReturnValue({
      spawnOutcome: async () => {
        throw new Error("dtach not found");
      },
    } as unknown as ReturnType<typeof app.pty.getOrCreate>);

    await expect(adoptSurvivingSession(app, id)).rejects.toThrow("dtach not found");
  });

  it("starts a fresh adoption after the previous one settled", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { isMasterAliveState } = stubAdoptable(app, "dead");

    await adoptSurvivingSession(app, id);
    await adoptSurvivingSession(app, id);

    expect(isMasterAliveState).toHaveBeenCalledTimes(2);
  });
});

function insertTask(
  app: App,
  projectId: number,
  status: string,
  fields: Partial<typeof tasks.$inferInsert> = {},
) {
  const [task] = app.db
    .insert(tasks)
    .values({ projectId, title: "t", status, claimedAt: new Date(), ...fields })
    .returning()
    .all();
  return task;
}

describe("adoptActiveTaskSessions (issue #2929)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adopts active local sessions of claimed, in-progress, and reviewing tasks", async () => {
    const app = await buildTestApp();
    const claimed = seed(app);
    const running = seed(app);
    const worker = seed(app);
    const review = seed(app);
    const backlog = seed(app);
    const killed = seed(app, { status: "killed" });
    app.db.insert(hosts).values({ id: "readopt-box", name: "readopt-box" }).run();
    const remote = seed(app, { hostId: "readopt-box" });
    insertTask(app, claimed.project.id, "claimed", { sessionId: claimed.row.id });
    insertTask(app, running.project.id, "in_progress", {
      sessionId: running.row.id,
      startedAt: new Date(),
    });
    insertTask(app, worker.project.id, "reviewing", {
      sessionId: worker.row.id,
      reviewSessionId: review.row.id,
    });
    insertTask(app, backlog.project.id, "backlog", { sessionId: backlog.row.id });
    insertTask(app, killed.project.id, "in_progress", { sessionId: killed.row.id });
    insertTask(app, remote.project.id, "in_progress", { sessionId: remote.row.id });
    const { getOrCreate } = stubAdoptable(app, "alive");

    await adoptActiveTaskSessions(app);

    const adopted = getOrCreate.mock.calls.map((call) => (call[0] as { id: string }).id);
    expect(adopted.sort()).toEqual([claimed.id, running.id, worker.id, review.id].sort());
  });
});

describe("reconcileTasks re-adopts a local null (issue #2929)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MULLION_TASK_MASTER_ENABLED;
    delete process.env.MULLION_TASK_BUDGET_MINUTES;
    delete process.env.MULLION_TASK_RATE_LIMIT_GRACE_MINUTES;
  });

  function trackFinished(app: App) {
    const tracked = new Set<string>();
    const finishedAt = Date.now();
    vi.spyOn(app.pty, "get").mockImplementation(((key: string) =>
      tracked.has(key)
        ? {
            isAlive: true,
            toInfo: () => ({
              activity: "idle",
              lastTurnEndedAt: finishedAt,
              workFinishedAt: finishedAt,
              outstandingBackgroundTasks: [],
            }),
          }
        : undefined) as unknown as typeof app.pty.get);
    vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue("alive");
    const getOrCreate = vi.spyOn(app.pty, "getOrCreate").mockImplementation(((opts: {
      id: string;
    }) => {
      tracked.add(opts.id);
      return { spawnOutcome: async () => {} };
    }) as unknown as typeof app.pty.getOrCreate);
    return getOrCreate;
  }

  it("hands a finished turn off once the surviving scope is adopted", async () => {
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    const app = await buildTestApp();
    app.db.delete(tasks).run();
    const { project, row, id } = seed(app);
    const claimedAt = new Date(Date.now() - 60_000);
    const task = insertTask(app, project.id, "in_progress", {
      sessionId: row.id,
      claimedAt,
      startedAt: claimedAt,
    });
    const getOrCreate = trackFinished(app);

    await reconcileTasks(app);

    const saved = app.db
      .select()
      .from(tasks)
      .all()
      .find((row) => row.id === task.id);
    expect(getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ id }));
    expect(saved?.status).toBe("reviewing");
  });

  it("still budget-fails a past-deadline task whose scope is gone", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    const app = await buildTestApp();
    app.db.delete(tasks).run();
    const { project, row } = seed(app);
    const task = insertTask(app, project.id, "in_progress", {
      sessionId: row.id,
      claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);
    vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue("dead");
    const getOrCreate = vi.spyOn(app.pty, "getOrCreate");

    await reconcileTasks(app);

    const saved = app.db
      .select()
      .from(tasks)
      .all()
      .find((row) => row.id === task.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.failureReason).toContain("budget exceeded");
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("still budget-fails a past-deadline task whose scope cannot be verified", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    const app = await buildTestApp();
    app.db.delete(tasks).run();
    const { project, row } = seed(app);
    const task = insertTask(app, project.id, "in_progress", {
      sessionId: row.id,
      claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);
    vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue("unknown");
    const getOrCreate = vi.spyOn(app.pty, "getOrCreate");

    await reconcileTasks(app);

    const saved = app.db
      .select()
      .from(tasks)
      .all()
      .find((row) => row.id === task.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.failureReason).toContain("budget exceeded");
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("does not budget-fail a task still inside its budget when the scope cannot be verified", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "60";
    const app = await buildTestApp();
    app.db.delete(tasks).run();
    const { project, row } = seed(app);
    const task = insertTask(app, project.id, "in_progress", {
      sessionId: row.id,
      claimedAt: new Date(),
    });
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);
    vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue("unknown");

    await reconcileTasks(app);

    const saved = app.db
      .select()
      .from(tasks)
      .all()
      .find((row) => row.id === task.id);
    expect(saved?.status).toBe("in_progress");
  });

  it("does not budget-fail a past-deadline task that is inside rate-limit grace (#2930)", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    process.env.MULLION_TASK_RATE_LIMIT_GRACE_MINUTES = "30";
    const app = await buildTestApp();
    app.db.delete(tasks).run();
    const { project, row } = seed(app);
    const task = insertTask(app, project.id, "in_progress", {
      sessionId: row.id,
      claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      lastRateLimitAt: new Date(),
    });
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);
    vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue("dead");

    await reconcileTasks(app);

    const saved = app.db
      .select()
      .from(tasks)
      .all()
      .find((row) => row.id === task.id);
    expect(saved?.status).toBe("in_progress");
    const sessionRow = app.db
      .select()
      .from(sessions)
      .all()
      .find((s) => s.id === row.id);
    expect(sessionRow?.status).not.toBe("killed");
  });

  it("still budget-fails a past-deadline task whose rate-limit grace has expired (#2930)", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    process.env.MULLION_TASK_RATE_LIMIT_GRACE_MINUTES = "30";
    const app = await buildTestApp();
    app.db.delete(tasks).run();
    const { project, row } = seed(app);
    const task = insertTask(app, project.id, "in_progress", {
      sessionId: row.id,
      claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      lastRateLimitAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);
    vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue("dead");

    await reconcileTasks(app);

    const saved = app.db
      .select()
      .from(tasks)
      .all()
      .find((row) => row.id === task.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.failureReason).toContain("budget exceeded");
  });

  it("retries a reviewing session whose scope cannot be verified, without failing it", async () => {
    const app = await buildTestApp();
    app.db.delete(tasks).run();
    const worker = seed(app);
    const review = seed(app);
    const task = insertTask(app, worker.project.id, "reviewing", {
      sessionId: worker.row.id,
      reviewSessionId: review.row.id,
    });
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);
    vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue("unknown");

    await reconcileTasks(app);

    const saved = app.db
      .select()
      .from(tasks)
      .all()
      .find((row) => row.id === task.id);
    expect(saved?.status).toBe("reviewing");
  });

  it("ingests a reviewing session as inconclusive once the findings grace has passed (#2929)", async () => {
    const app = await buildTestApp();
    app.db.delete(tasks).run();
    const worker = seed(app);
    const review = seed(app, { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
    const task = insertTask(app, worker.project.id, "reviewing", {
      sessionId: worker.row.id,
      reviewSessionId: review.row.id,
    });
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);
    vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue("unknown");

    await reconcileTasks(app);

    const saved = app.db
      .select()
      .from(tasks)
      .all()
      .find((row) => row.id === task.id);
    expect(saved?.status).toBe("reviewing");
    expect(saved?.lastReviewVerdict).toBe("inconclusive");
  });
});
