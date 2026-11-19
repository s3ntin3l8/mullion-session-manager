import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reconcilerMocks,
  mockPushDeliveryFactory,
  mockHermesIntegrationFactory,
  mockHermesTaskReviewFactory,
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  mockTaskReseedFactory,
  mockHostGitFactory,
  mockGitWorktreeFactory,
  mockGithubIntegrationFactory,
  mockGithubWriteFactory,
  mockGithubFactory,
  setupReconcilerTestLifecycle,
  fakeInfo,
  createSessionAndTask,
  getTask,
} from "../helpers/task-reconciler-harness.js";

const mockPromptLiveTaskWorker = vi.fn(async () => "typed" as const);

vi.mock("../../src/services/push-delivery.js", (io) => mockPushDeliveryFactory(io));
vi.mock("../../src/services/hermes-integration.js", (io) => mockHermesIntegrationFactory(io));
vi.mock("../../src/services/hermes-task-review.js", (io) => mockHermesTaskReviewFactory(io));
vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", (io) => mockTaskPromoteFactory(io));
vi.mock("../../src/services/task-reseed.js", async (io) => ({
  ...(await mockTaskReseedFactory(io)),
  promptLiveTaskWorker: mockPromptLiveTaskWorker,
}));
vi.mock("../../src/services/host-git.js", (io) => mockHostGitFactory(io));
vi.mock("../../src/services/git-worktree.js", (io) => mockGitWorktreeFactory(io));
vi.mock("../../src/services/github-integration.js", (io) => mockGithubIntegrationFactory(io));
vi.mock("../../src/services/github-write.js", (io) => mockGithubWriteFactory(io));
vi.mock("../../src/services/github.js", (io) => mockGithubFactory(io));

const { buildApp } = await import("../../src/app.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { WORKER_STALL_MS, NUDGE_TURN_GRACE_MS, MAX_WORKER_NUDGES } =
  await import("../../src/services/task-nudge.js");
const { registerTaskTransitionListener } = await import("../../src/services/task-state.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

void reconcilerMocks;

describe("reconcileTasks — stalled in-flight worker nudge & early fail", () => {
  setupReconcilerTestLifecycle("task-reconciler-stall-nudge");

  beforeEach(() => {
    mockPromptLiveTaskWorker.mockReset();
    mockPromptLiveTaskWorker.mockResolvedValue("typed");
  });

  it("leaves a mid-turn worker alone when silent for under WORKER_STALL_MS", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: true,
          lastActivityAt: Date.now() - (WORKER_STALL_MS - 60_000),
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.nudgeCount).toBe(0);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();

    await app.close();
  });

  it("nudges once when silent past WORKER_STALL_MS and waits during NUDGE_TURN_GRACE_MS", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    app.db
      .update(tasks)
      .set({ claimedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(tasks.id, taskId))
      .run();

    const silentSince = Date.now() - (WORKER_STALL_MS + 60_000);
    // PtyManager caps agentTurnInFlight at 15m, so by 45m+ of silence it is
    // false while lastTurnEndedAt remains null (or < claimedAt).
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: false,
          lastTurnEndedAt: null,
          lastActivityAt: silentSince,
        }),
    } as never);

    await reconcileTasks(app);

    let row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.nudgeCount).toBe(1);
    expect(row.lastNudgedAt).not.toBeNull();
    expect(row.lastStallNudgedAt).not.toBeNull();
    expect(mockPromptLiveTaskWorker).toHaveBeenCalledTimes(1);

    // Next tick within NUDGE_TURN_GRACE_MS must neither re-nudge nor fail, even
    // when the nudge's own TUI redraw bumped lastActivityAt right after typing.
    const nudgeEchoAt = row.lastStallNudgedAt!.getTime() + 1_000;
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: true,
          lastTurnEndedAt: null,
          lastActivityAt: nudgeEchoAt,
        }),
    } as never);
    await reconcileTasks(app);

    row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.nudgeCount).toBe(1);
    expect(mockPromptLiveTaskWorker).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("fails the task with worker-stalled when still silent NUDGE_TURN_GRACE_MS after the nudge (including nudge echo)", async () => {
    const app = await buildApp();
    const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
    const transitions: Array<{ taskId: number; to: string; via: string }> = [];
    registerTaskTransitionListener((_app, p) => {
      transitions.push({ taskId: p.taskId, to: p.to, via: p.via });
    });

    const { taskId, sessionId } = await createSessionAndTask(app, "in_progress");
    const claimedAt = new Date(Date.now() - 70 * 60_000);
    const nudgedAt = new Date(Date.now() - (NUDGE_TURN_GRACE_MS + 60_000));
    const nudgeEchoAt = nudgedAt.getTime() + 1_000;
    app.db
      .update(tasks)
      .set({ claimedAt, nudgeCount: 1, lastNudgedAt: nudgedAt, lastStallNudgedAt: nudgedAt })
      .where(eq(tasks.id, taskId))
      .run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: true,
          lastTurnEndedAt: null,
          lastActivityAt: nudgeEchoAt,
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toMatch(/^worker stalled: no output for \d+ minutes$/);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
    expect(terminateSpy).toHaveBeenCalledWith(String(sessionId));

    const [sessionRow] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    expect(sessionRow.status).toBe("killed");
    expect(transitions).toContainEqual({ taskId, to: "failed", via: "worker-stalled" });

    await app.close();
  });

  it("never nudges or fails a worker with an outstanding background task", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    const nudgedAt = new Date(Date.now() - (NUDGE_TURN_GRACE_MS + 60_000));
    app.db
      .update(tasks)
      .set({
        claimedAt: new Date(Date.now() - 70 * 60_000),
        nudgeCount: 1,
        lastNudgedAt: nudgedAt,
        lastStallNudgedAt: nudgedAt,
      })
      .where(eq(tasks.id, taskId))
      .run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: false,
          lastTurnEndedAt: null,
          lastActivityAt: Date.now() - (WORKER_STALL_MS + NUDGE_TURN_GRACE_MS + 60_000),
          outstandingBackgroundTasks: [
            { id: "bg-1", kind: "shell", description: "make test", startedAt: Date.now() - 60_000 },
          ],
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();

    await app.close();
  });

  it("never nudges or fails a worker with active subagents (subagentCount > 0)", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    app.db
      .update(tasks)
      .set({ claimedAt: new Date(Date.now() - 70 * 60_000) })
      .where(eq(tasks.id, taskId))
      .run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: false,
          lastTurnEndedAt: null,
          lastActivityAt: Date.now() - (WORKER_STALL_MS + 60_000),
          subagentCount: 1,
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.nudgeCount).toBe(0);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();

    await app.close();
  });

  it("never nudges or fails a worker in rate-limit grace", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    app.db
      .update(tasks)
      .set({
        claimedAt: new Date(Date.now() - 70 * 60_000),
        lastRateLimitAt: new Date(Date.now() - 60_000),
      })
      .where(eq(tasks.id, taskId))
      .run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: false,
          lastTurnEndedAt: null,
          lastActivityAt: Date.now() - (WORKER_STALL_MS + 60_000),
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.nudgeCount).toBe(0);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();

    await app.close();
  });

  it("never fails a worker that produced output after the nudge", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    const nudgedAt = new Date(Date.now() - (NUDGE_TURN_GRACE_MS + 60_000));
    app.db
      .update(tasks)
      .set({
        claimedAt: new Date(Date.now() - 70 * 60_000),
        nudgeCount: 1,
        lastNudgedAt: nudgedAt,
        lastStallNudgedAt: nudgedAt,
      })
      .where(eq(tasks.id, taskId))
      .run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: true,
          lastTurnEndedAt: null,
          lastActivityAt: Date.now() - 10_000,
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.nudgeCount).toBe(1);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();

    await app.close();
  });

  it("never nudges or fails a worker whose row transitioned to reviewing meanwhile", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    app.db
      .update(tasks)
      .set({ claimedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(tasks.id, taskId))
      .run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => {
        // Simulate a concurrent transition to reviewing after the tick's SELECT.
        app.db.update(tasks).set({ status: "reviewing" }).where(eq(tasks.id, taskId)).run();
        return fakeInfo({
          agentTurnInFlight: false,
          lastTurnEndedAt: null,
          lastActivityAt: Date.now() - (WORKER_STALL_MS + 60_000),
        });
      },
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.nudgeCount).toBe(0);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();

    await app.close();
  });

  it("does not fail on a continuation nudge (lastStallNudgedAt null) before WORKER_STALL_MS", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    const nudgedAt = new Date(Date.now() - (NUDGE_TURN_GRACE_MS + 60_000));
    app.db
      .update(tasks)
      .set({
        claimedAt: new Date(Date.now() - 70 * 60_000),
        nudgeCount: 1,
        lastNudgedAt: nudgedAt,
        lastStallNudgedAt: null,
      })
      .where(eq(tasks.id, taskId))
      .run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: true,
          lastTurnEndedAt: null,
          lastActivityAt: nudgedAt.getTime() + 1_000,
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.nudgeCount).toBe(1);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();

    await app.close();
  });

  it("ignores a worker whose turn already ended in this spell", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    const claimedAt = new Date(Date.now() - 70 * 60_000);
    app.db.update(tasks).set({ claimedAt }).where(eq(tasks.id, taskId)).run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: false,
          lastTurnEndedAt: claimedAt.getTime() + 60_000,
          lastActivityAt: Date.now() - (WORKER_STALL_MS + 60_000),
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.nudgeCount).toBe(0);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();

    await app.close();
  });

  it("fires only budget-exceeded (not worker-stalled) when both budget and stall are past due", async () => {
    const app = await buildApp();
    vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
    const transitions: Array<{ taskId: number; to: string; via: string }> = [];
    registerTaskTransitionListener((_app, p) => {
      transitions.push({ taskId: p.taskId, to: p.to, via: p.via });
    });

    const { taskId } = await createSessionAndTask(app, "in_progress");
    const nudgedAt = new Date(Date.now() - (NUDGE_TURN_GRACE_MS + 60_000));
    app.db
      .update(tasks)
      .set({
        claimedAt: new Date(Date.now() - 130 * 60_000),
        nudgeCount: 1,
        lastNudgedAt: nudgedAt,
        lastStallNudgedAt: nudgedAt,
      })
      .where(eq(tasks.id, taskId))
      .run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: false,
          lastTurnEndedAt: null,
          lastActivityAt: Date.now() - (WORKER_STALL_MS + NUDGE_TURN_GRACE_MS + 60_000),
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toContain("budget exceeded");
    expect(transitions.filter((t) => t.taskId === taskId)).toEqual([
      { taskId, to: "failed", via: "budget-exceeded" },
    ]);

    await app.close();
  });

  it("leaves the budget as backstop when MAX_WORKER_NUDGES was spent on continuation nudges (lastStallNudgedAt null)", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    app.db
      .update(tasks)
      .set({
        claimedAt: new Date(Date.now() - 70 * 60_000),
        nudgeCount: MAX_WORKER_NUDGES,
        lastNudgedAt: new Date(Date.now() - 20 * 60_000),
        lastStallNudgedAt: null,
      })
      .where(eq(tasks.id, taskId))
      .run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: false,
          lastTurnEndedAt: null,
          lastActivityAt: Date.now() - (WORKER_STALL_MS + 60_000),
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.nudgeCount).toBe(MAX_WORKER_NUDGES);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();

    await app.close();
  });

  it("fails early when MAX_WORKER_NUDGES is exhausted and a stall nudge already landed in this spell", async () => {
    const app = await buildApp();
    vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
    const transitions: Array<{ taskId: number; to: string; via: string }> = [];
    registerTaskTransitionListener((_app, p) => {
      transitions.push({ taskId: p.taskId, to: p.to, via: p.via });
    });

    const { taskId } = await createSessionAndTask(app, "in_progress");
    const claimedAt = new Date(Date.now() - 105 * 60_000);
    const stallNudgedAt = new Date(Date.now() - 55 * 60_000);
    app.db
      .update(tasks)
      .set({
        claimedAt,
        nudgeCount: MAX_WORKER_NUDGES,
        lastNudgedAt: stallNudgedAt,
        lastStallNudgedAt: stallNudgedAt,
      })
      .where(eq(tasks.id, taskId))
      .run();

    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          agentTurnInFlight: false,
          lastTurnEndedAt: null,
          lastActivityAt: Date.now() - (WORKER_STALL_MS + 60_000),
        }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toMatch(/^worker stalled: no output for \d+ minutes$/);
    expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
    expect(transitions).toContainEqual({ taskId, to: "failed", via: "worker-stalled" });

    await app.close();
  });
});
