// The continuation nudge (task-nudge.ts): a worker whose turn ended with no
// commits gets up to MAX_WORKER_NUDGES typed continuations before the task
// fails as it always did.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import * as taskEvents from "../../src/services/task-events.js";

const { mockPromptLiveTaskWorker } = vi.hoisted(() => ({ mockPromptLiveTaskWorker: vi.fn() }));

// test/setup.ts turns the nudge off for every suite; this one tests it.
vi.unmock("../../src/services/task-nudge.js");
vi.mock("../../src/services/task-reseed.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  promptLiveTaskWorker: mockPromptLiveTaskWorker,
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
const { closeDb } = await import("../../src/db/client.js");
const { projects, tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const {
  buildContinuationNudge,
  buildShellTailNudge,
  nudgeInsteadOfFailing,
  nudgeShellTailWorker,
  nudgesThisSpell,
  MAX_WORKER_NUDGES,
  NUDGE_TURN_GRACE_MS,
} = await import("../../src/services/task-nudge.js");

const tmpDb = path.join(os.tmpdir(), `task-nudge-${process.pid}.db`);

const NOW = new Date("2026-11-16T12:00:00Z");
const CLAIMED = new Date("2026-11-16T11:00:00Z");

describe("task nudge", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });
  beforeEach(() => {
    mockPromptLiveTaskWorker.mockReset();
    mockPromptLiveTaskWorker.mockResolvedValue("typed");
  });

  async function setup(over: Partial<typeof tasks.$inferInsert> = {}) {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-nudge-repo-"));
    const [project] = app.db.insert(projects).values({ name: "nudge-p", cwd }).returning().all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "t",
        status: "in_progress",
        branchName: "mullion/task-1",
        sessionId: null,
        claimedAt: CLAIMED,
        ...over,
      })
      .returning()
      .all();
    const load = () => app.db.select().from(tasks).where(eq(tasks.id, task.id)).all()[0];
    return { app, task, load, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
  }

  const info = (over: Record<string, unknown> = {}) =>
    ({ workFinishedAt: NOW.getTime() - 60_000, errorState: null, ...over }) as never;

  it("words the continuation so a worker knows what to do and that nobody will answer", () => {
    const text = buildContinuationNudge("mullion/task-1");
    expect(text).toContain("nothing is committed on mullion/task-1");
    expect(text).toContain("Nobody is available to answer questions");
    expect(text).toContain("commit");
    expect(buildContinuationNudge(null)).not.toContain(" on null");
  });

  it("counts nudges only within the current in_progress spell", () => {
    const base = { claimedAt: CLAIMED, nudgeCount: 2, lastNudgedAt: null };
    expect(nudgesThisSpell(base)).toBe(0);
    expect(nudgesThisSpell({ ...base, lastNudgedAt: new Date(CLAIMED.getTime() + 1000) })).toBe(2);
    // A nudge from before the latest claim belongs to an earlier spell.
    expect(nudgesThisSpell({ ...base, lastNudgedAt: new Date(CLAIMED.getTime() - 1000) })).toBe(0);
    expect(nudgesThisSpell({ ...base, claimedAt: null, lastNudgedAt: CLAIMED })).toBe(0);
  });

  it("rings the board's doorbell once, after the row is written (#3179)", async () => {
    const { app, task, load, cleanup } = await setup();
    let countAtEmit: number | undefined;
    const spy = vi.spyOn(taskEvents, "broadcastTaskEvent").mockImplementation(() => {
      countAtEmit = load().nudgeCount;
    });
    expect(await nudgeInsteadOfFailing(app, task, info(), NOW)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, projectId: task.projectId, kind: "nudge" }),
    );
    expect(countAtEmit).toBe(1);
    spy.mockRestore();
    cleanup();
    await app.close();
  });

  it("emits nothing when no continuation was typed (#3179)", async () => {
    const { app, task, cleanup } = await setup();
    mockPromptLiveTaskWorker.mockResolvedValue("failed");
    const spy = vi.spyOn(taskEvents, "broadcastTaskEvent").mockImplementation(() => {});
    expect(await nudgeInsteadOfFailing(app, task, info(), NOW)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    cleanup();
    await app.close();
  });

  it("types a continuation into the idle worker and records it", async () => {
    const { app, task, load, cleanup } = await setup();
    expect(await nudgeInsteadOfFailing(app, task, info(), NOW)).toBe(true);
    expect(mockPromptLiveTaskWorker).toHaveBeenCalledTimes(1);
    expect(mockPromptLiveTaskWorker.mock.calls[0][2]).toContain("nothing is committed");
    expect(load()).toMatchObject({ nudgeCount: 1 });
    expect(load().lastNudgedAt?.getTime()).toBe(Math.floor(NOW.getTime() / 1000) * 1000);
    cleanup();
    await app.close();
  });

  it.each([
    { signal: false, finishOffset: 1000, expectedCount: 2 },
    { signal: false, finishOffset: -1000, expectedCount: 2 },
    { signal: true, finishOffset: 1000, expectedCount: 1 },
    { signal: true, finishOffset: 6000, expectedCount: 1 },
    { signal: undefined, finishOffset: 1000, expectedCount: 1 },
    { signal: undefined, finishOffset: 5000, expectedCount: 1 },
    { signal: undefined, finishOffset: 6000, expectedCount: 2 },
  ])(
    "uses agentTurnInFlight=$signal with finish offset $finishOffset ms (count=$expectedCount)",
    async ({ signal, finishOffset, expectedCount }) => {
      const nudgedAt = new Date(NOW.getTime() - 10_000);
      const { app, task, load, cleanup } = await setup({ nudgeCount: 1, lastNudgedAt: nudgedAt });
      const live = info({
        workFinishedAt: nudgedAt.getTime() + finishOffset,
        ...(signal === undefined ? {} : { agentTurnInFlight: signal }),
      });
      expect(await nudgeInsteadOfFailing(app, task, live, NOW)).toBe(true);
      expect(mockPromptLiveTaskWorker).toHaveBeenCalledTimes(expectedCount - 1);
      expect(load().nudgeCount).toBe(expectedCount);
      cleanup();
      await app.close();
    },
  );

  it.each([1, MAX_WORKER_NUDGES])(
    "bounds an in-flight turn by the grace period after %i nudges",
    async (nudgeCount) => {
      const nudgedAt = new Date(NOW.getTime() - NUDGE_TURN_GRACE_MS);
      const { app, task, load, cleanup } = await setup({ nudgeCount, lastNudgedAt: nudgedAt });
      const live = info({ agentTurnInFlight: true });
      expect(await nudgeInsteadOfFailing(app, task, live, NOW)).toBe(false);
      expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
      expect(load().nudgeCount).toBe(nudgeCount);
      cleanup();
      await app.close();
    },
  );

  it("waits while a nudged turn has not finished, without spending the next nudge", async () => {
    const nudgedAt = new Date(NOW.getTime() - 30_000);
    const { app, task, load, cleanup } = await setup({ nudgeCount: 1, lastNudgedAt: nudgedAt });
    // The finish latch still reads the OLD turn: it predates the nudge.
    const stale = info({ workFinishedAt: nudgedAt.getTime() - 20_000 });
    expect(await nudgeInsteadOfFailing(app, task, stale, NOW)).toBe(true);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
    expect(load().nudgeCount).toBe(1);
    cleanup();
    await app.close();
  });

  it("gives up waiting on a nudged turn that never starts", async () => {
    const nudgedAt = new Date(NOW.getTime() - NUDGE_TURN_GRACE_MS - 1000);
    const { app, task, cleanup } = await setup({ nudgeCount: 1, lastNudgedAt: nudgedAt });
    const stale = info({ workFinishedAt: nudgedAt.getTime() - 20_000 });
    expect(await nudgeInsteadOfFailing(app, task, stale, NOW)).toBe(false);
    cleanup();
    await app.close();
  });

  it("sends a second nudge when the nudged turn also ended with no commits", async () => {
    const nudgedAt = new Date(NOW.getTime() - 300_000);
    const { app, task, load, cleanup } = await setup({ nudgeCount: 1, lastNudgedAt: nudgedAt });
    const fresh = info({ workFinishedAt: nudgedAt.getTime() + 120_000 });
    expect(await nudgeInsteadOfFailing(app, task, fresh, NOW)).toBe(true);
    expect(load().nudgeCount).toBe(2);
    cleanup();
    await app.close();
  });

  it("fails after the cap", async () => {
    const nudgedAt = new Date(NOW.getTime() - 300_000);
    const { app, task, load, cleanup } = await setup({
      nudgeCount: MAX_WORKER_NUDGES,
      lastNudgedAt: nudgedAt,
    });
    const fresh = info({ workFinishedAt: nudgedAt.getTime() + 120_000 });
    expect(await nudgeInsteadOfFailing(app, task, fresh, NOW)).toBe(false);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
    expect(load().nudgeCount).toBe(MAX_WORKER_NUDGES);
    cleanup();
    await app.close();
  });

  it("fails without counting a nudge when the worker cannot be typed into", async () => {
    for (const outcome of ["declined", "unreachable"]) {
      mockPromptLiveTaskWorker.mockResolvedValue(outcome);
      const { app, task, load, cleanup } = await setup();
      expect(await nudgeInsteadOfFailing(app, task, info(), NOW)).toBe(false);
      expect(load()).toMatchObject({ nudgeCount: 0, lastNudgedAt: null });
      cleanup();
      await app.close();
    }
  });

  it("types nothing when the task left in_progress since the tick's snapshot", async () => {
    const { app, task, load, cleanup } = await setup();
    app.db.update(tasks).set({ status: "ready" }).where(eq(tasks.id, task.id)).run();
    expect(await nudgeInsteadOfFailing(app, task, info(), NOW)).toBe(true);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
    expect(load()).toMatchObject({ status: "ready", nudgeCount: 0 });
    cleanup();
    await app.close();
  });

  it("leaves a rate-limited or errored worker to its own grace path", async () => {
    const { app, task, cleanup } = await setup({ lastRateLimitAt: new Date() });
    // Within the (default 30 min) grace window of a recorded rate limit.
    expect(await nudgeInsteadOfFailing(app, { ...task }, info(), new Date())).toBe(false);
    expect(await nudgeInsteadOfFailing(app, task, info({ errorState: "api_error" }), NOW)).toBe(
      false,
    );
    expect(await nudgeInsteadOfFailing(app, task, null, NOW)).toBe(false);
    expect(await nudgeInsteadOfFailing(app, task, info({ workFinishedAt: null }), NOW)).toBe(false);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
    cleanup();
    await app.close();
  });

  describe("nudgeShellTailWorker", () => {
    const shellInfo = (over: Record<string, unknown> = {}) =>
      info({
        workFinishedAt: NOW.getTime() - 25 * 60_000,
        outstandingBackgroundTasks: [
          {
            id: "b1",
            type: "shell",
            status: "running",
            description: "while pgrep -f npm; do sleep 5; done",
          },
        ],
        ...over,
      });

    it("words the shell-tail nudge with the job description and wait-loop guidance", () => {
      const text = buildShellTailNudge("mullion/task-1", "wait loop");
      expect(text).toContain("wait loop");
      expect(text).toContain("nothing is committed on mullion/task-1");
      expect(text).toContain("pgrep -f");
      expect(text).toContain("kill it");
      expect(text).not.toBe(buildContinuationNudge("mullion/task-1"));
    });

    it("truncates job descriptions longer than 200 characters and records the nudge", async () => {
      const { app, task, load, cleanup } = await setup();
      const longDesc = "x".repeat(250);
      const live = shellInfo({
        outstandingBackgroundTasks: [
          { id: "b1", type: "shell", status: "running", description: longDesc },
        ],
      });
      expect(await nudgeShellTailWorker(app, task, live, NOW)).toBe(true);
      expect(mockPromptLiveTaskWorker).toHaveBeenCalledTimes(1);
      expect(mockPromptLiveTaskWorker.mock.calls[0][3]).toBe("task shell-tail nudge");
      const sentText = mockPromptLiveTaskWorker.mock.calls[0][2] as string;
      expect(sentText).toContain(`${"x".repeat(200)}…`);
      expect(sentText).not.toContain("x".repeat(201));
      expect(load().nudgeCount).toBe(1);
      cleanup();
      await app.close();
    });

    it("leaves a worker behind the same job alone until a new turn ends", async () => {
      const nudgedAt = new Date(NOW.getTime() - NUDGE_TURN_GRACE_MS - 60_000);
      const { app, task, load, cleanup } = await setup({ nudgeCount: 1, lastNudgedAt: nudgedAt });
      const sameTurn = shellInfo({
        workFinishedAt: nudgedAt.getTime() - 60_000,
        agentTurnInFlight: false,
      });
      expect(await nudgeShellTailWorker(app, task, sameTurn, NOW)).toBe(false);
      expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
      expect(load().nudgeCount).toBe(1);

      const newerTurn = shellInfo({ workFinishedAt: nudgedAt.getTime() + 60_000 });
      expect(await nudgeShellTailWorker(app, task, newerTurn, NOW)).toBe(true);
      expect(mockPromptLiveTaskWorker).toHaveBeenCalledTimes(1);
      expect(load().nudgeCount).toBe(2);
      cleanup();
      await app.close();
    });

    it("does not count a nudge when the worker cannot be typed into", async () => {
      mockPromptLiveTaskWorker.mockResolvedValue("unreachable");
      const { app, task, load, cleanup } = await setup();
      expect(await nudgeShellTailWorker(app, task, shellInfo(), NOW)).toBe(false);
      expect(load()).toMatchObject({ nudgeCount: 0, lastNudgedAt: null });
      cleanup();
      await app.close();
    });
  });
});
