// #3188 — shell-tail nudge for no-commit workers stuck behind a background shell job.
// Split out of test/services/task-reconciler.test.ts because that file is at its
// max-file-lines ceiling.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as TaskReseedModule from "../../src/services/task-reseed.js";

const { mockResolveHostGitStatus } = vi.hoisted(() => ({
  mockResolveHostGitStatus: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHostGitStatus: mockResolveHostGitStatus,
}));

const actualReseedModule = await vi.importActual<typeof TaskReseedModule>(
  "../../src/services/task-reseed.js",
);
const mockPromptLiveTaskWorker = vi.fn(actualReseedModule.promptLiveTaskWorker);
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
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-shell-tail-nudge-${process.pid}.db`);
const BASE_SHA = "0000000111122223333444455556666777788889"; // pragma: allowlist secret
const MIN = 60_000;

const stuckJob = {
  id: "b1",
  type: "shell",
  status: "running",
  description: "while pgrep -f 'npm ci'; do sleep 5; done",
};

function gitStatus(hash: string | null) {
  return {
    ok: true,
    value: {
      isRepo: true,
      status: { branch: "mullion/task-999", hash, ahead: 0, behind: 0, files: [], isClean: true },
    },
  };
}

function tailInfo(turnEndedAgoMs: number, outstandingBackgroundTasks: unknown[]) {
  const endedAt = Date.now() - turnEndedAgoMs;
  return {
    activity: "idle",
    errorState: "idle",
    errorDetail: null,
    errorAt: null,
    lastTurnEndedAt: endedAt,
    workFinishedAt: endedAt,
    outstandingBackgroundTasks,
  };
}

describe("reconcileTasks shell-tail nudge (#3188)", () => {
  let priorTaskMaster: string | undefined;
  beforeAll(() => {
    priorTaskMaster = process.env.MULLION_TASK_MASTER_ENABLED;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    if (priorTaskMaster === undefined) delete process.env.MULLION_TASK_MASTER_ENABLED;
    else process.env.MULLION_TASK_MASTER_ENABLED = priorTaskMaster;
  });
  beforeEach(() => {
    mockPromptLiveTaskWorker.mockReset();
    mockPromptLiveTaskWorker.mockResolvedValue("typed");
    mockResolveHostGitStatus.mockReset();
  });

  async function setupTask(app: Awaited<ReturnType<typeof buildApp>>) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: `p-shell-nudge-${Math.random()}`,
        cwd: "/tmp",
      },
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const sessionId = session.json().id as number;
    const claimedAt = new Date(Date.now() - 30 * MIN);
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "t",
        status: "in_progress",
        sessionId,
        claimedAt,
        startedAt: claimedAt,
        worktreePath: "/tmp/mullion-task-worktree",
        branchName: "mullion/task-999",
        baseSha: BASE_SHA,
      })
      .returning()
      .all();
    return { taskId: row.id, sessionId };
  }

  function mockSessionInfo(
    app: Awaited<ReturnType<typeof buildApp>>,
    sessionId: number,
    info: ReturnType<typeof tailInfo>,
  ) {
    vi.spyOn(app.pty, "get").mockImplementation((id) =>
      id === String(sessionId) ? ({ toInfo: () => info } as never) : undefined,
    );
  }

  const getTask = (app: Awaited<ReturnType<typeof buildApp>>, id: number) =>
    app.db.select().from(tasks).where(eq(tasks.id, id)).all()[0];

  it("does not nudge at 10 min when no commits are present", async () => {
    const app = await buildApp();
    try {
      const { taskId, sessionId } = await setupTask(app);
      mockSessionInfo(app, sessionId, tailInfo(10 * MIN, [stuckJob]));
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000"));

      await reconcileTasks(app);

      expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
      expect(getTask(app, taskId).status).toBe("in_progress");
    } finally {
      await app.close();
    }
  });

  it("nudges once at 21 min with job description and leaves unchanged latch alone on next tick", async () => {
    const app = await buildApp();
    try {
      const { taskId, sessionId } = await setupTask(app);
      mockSessionInfo(app, sessionId, tailInfo(21 * MIN, [stuckJob]));
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000"));

      await reconcileTasks(app);

      expect(mockPromptLiveTaskWorker).toHaveBeenCalledTimes(1);
      expect(mockPromptLiveTaskWorker.mock.calls[0][2]).toContain(stuckJob.description);
      expect(mockPromptLiveTaskWorker.mock.calls[0][3]).toBe("task shell-tail nudge");
      const afterFirst = getTask(app, taskId);
      expect(afterFirst.status).toBe("in_progress");
      expect(afterFirst.nudgeCount).toBe(1);

      await reconcileTasks(app);
      expect(mockPromptLiveTaskWorker).toHaveBeenCalledTimes(1);
      expect(getTask(app, taskId).nudgeCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("does not nudge when a non-shell background task is outstanding alongside the shell job", async () => {
    const app = await buildApp();
    try {
      const { taskId, sessionId } = await setupTask(app);
      const agentTask = { id: "a1", type: "agent", status: "running", description: "sub" };
      mockSessionInfo(app, sessionId, tailInfo(21 * MIN, [stuckJob, agentTask]));
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000"));

      await reconcileTasks(app);

      expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
      expect(getTask(app, taskId).status).toBe("in_progress");
    } finally {
      await app.close();
    }
  });

  it("takes the existing shell-tail handoff without nudging when commits exist ahead of base", async () => {
    const app = await buildApp();
    try {
      const { taskId, sessionId } = await setupTask(app);
      mockSessionInfo(app, sessionId, tailInfo(21 * MIN, [stuckJob]));
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1"));

      await reconcileTasks(app);

      expect(mockPromptLiveTaskWorker).not.toHaveBeenCalled();
      expect(getTask(app, taskId).status).toBe("reviewing");
    } finally {
      await app.close();
    }
  });

  it("does not count a nudge and keeps waiting when the worker cannot be typed into", async () => {
    mockPromptLiveTaskWorker.mockResolvedValue("unreachable");
    const app = await buildApp();
    try {
      const { taskId, sessionId } = await setupTask(app);
      mockSessionInfo(app, sessionId, tailInfo(21 * MIN, [stuckJob]));
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000"));

      await reconcileTasks(app);

      const row = getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.nudgeCount).toBe(0);
      expect(row.lastNudgedAt).toBeNull();
    } finally {
      await app.close();
    }
  });
});
