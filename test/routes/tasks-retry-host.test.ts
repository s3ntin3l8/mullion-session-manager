import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { sessions, tasks } from "../../src/db/schema.js";
import type { SessionBackend } from "../../src/services/session-backend.js";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { waitForTaskRunning } = await import("../helpers/retry-task.js");

function fakeSessionBackend(overrides: Partial<SessionBackend>): SessionBackend {
  return {
    spawn: vi.fn().mockResolvedValue({}),
    liveStatus: vi.fn().mockResolvedValue({}),
    liveness: vi.fn().mockResolvedValue({}),
    compareWorktreePaths: vi.fn().mockResolvedValue([]),
    terminate: vi.fn().mockResolvedValue(undefined),
    getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    getRenderedScrollback: vi.fn().mockResolvedValue(""),
    getTranscript: vi.fn().mockResolvedValue({ ok: false, status: 404, error: "not running" }),
    listSessionProcesses: vi.fn().mockResolvedValue([]),
    uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
    uploadFile: vi.fn().mockResolvedValue({ path: "/remote/upload.bin" }),
    resolveReviewGate: vi.fn().mockResolvedValue(false),
    acknowledgeAttention: vi.fn().mockResolvedValue(false),
    prompt: vi.fn().mockResolvedValue({ ok: true, outputOffset: 0 }),
    waitOutput: vi.fn().mockResolvedValue({ notRunning: true }),
    createWorktree: vi.fn().mockResolvedValue(null),
    checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
    removeWorktree: vi.fn().mockResolvedValue(false),
    syncWorktree: vi.fn().mockResolvedValue(false),
    resumeTaskWorktree: vi.fn().mockResolvedValue(null),
    listTaskWorktreeDirs: vi.fn().mockResolvedValue([]),
    stashSeed: vi.fn().mockResolvedValue(undefined),
    resolvePendingPromote: vi.fn().mockResolvedValue(false),
    removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
    pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
    clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    deleteBranch: vi.fn().mockResolvedValue({ deleted: false, reason: "no-such-branch" }),
    checkoutBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    createBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    rebaseBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    removeListedWorktree: vi.fn().mockResolvedValue({ removed: false, reason: "not-listed" }),
    pruneWorktreeMetadata: vi.fn().mockResolvedValue({ pruned: false }),
    readTaskReviewFindings: vi.fn().mockResolvedValue(null),
    deleteTaskReviewFindings: vi.fn().mockResolvedValue(undefined),
    resolveSessionsDir: vi.fn().mockResolvedValue("/remote/sessions"),
    readTaskCommitTitle: vi.fn().mockResolvedValue(null),
    readTaskRereviewRequest: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const tmpDb = path.join(os.tmpdir(), `tasks-retry-host-test-${process.pid}.db`);

describe("POST /api/tasks/:id/retry worker host resolution (#3192)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(tmpDb, { force: true });
  });

  it("resumes on the worker's remote host (with its host_cwds path) rather than the project's local host", async () => {
    const REMOTE_CWD = "/Users/dev/remote-repo";
    const BRANCH = "mullion/task-3192";
    const REMOTE_WT = `${REMOTE_CWD}/.mullion-worktrees/mullion-task-3192`;

    const localBackend = fakeSessionBackend({
      spawn: vi.fn().mockResolvedValue({ initialPromptApplied: true }),
      resumeTaskWorktree: vi.fn().mockResolvedValue(null),
    });
    const remoteBackend = fakeSessionBackend({
      spawn: vi.fn().mockResolvedValue({ initialPromptApplied: true }),
      liveStatus: vi.fn().mockResolvedValue({}),
      liveness: vi.fn().mockResolvedValue({}),
      terminate: vi.fn().mockResolvedValue(undefined),
      resumeTaskWorktree: vi.fn().mockResolvedValue({
        path: REMOTE_WT,
        branch: BRANCH,
      }),
    });

    const app = await buildApp();
    let resolveBackendSpy: ReturnType<typeof vi.spyOn> | undefined;

    try {
      const hostRes = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "MacBook", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remoteHostId = hostRes.json().id as string;

      resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((_app, hostId) =>
          hostId === remoteHostId ? remoteBackend : localBackend,
        );

      const projectRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "remote-worker-retry-p",
          cwd: "/tmp/local-repo",
          hostId: "local",
          hostCwds: { [remoteHostId]: REMOTE_CWD },
        },
      });
      const projectId = projectRes.json().id as number;

      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "remote task",
          status: "failed",
          branchName: BRANCH,
          worktreePath: REMOTE_WT,
        })
        .returning()
        .all();

      const [workerSession] = app.db
        .insert(sessions)
        .values({
          projectId,
          taskId: task.id,
          name: `Task #${task.id} · worker`,
          command: "claude",
          hostId: remoteHostId,
          status: "exited",
        })
        .returning()
        .all();

      app.db.update(tasks).set({ sessionId: workerSession.id }).where(eq(tasks.id, task.id)).run();

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(res.statusCode).toBe(202);

      await waitForTaskRunning(app, task.id);

      expect(remoteBackend.resumeTaskWorktree).toHaveBeenCalledWith(REMOTE_CWD, BRANCH);
      expect(localBackend.resumeTaskWorktree).not.toHaveBeenCalled();
    } finally {
      resolveBackendSpy?.mockRestore();
      await app.close();
    }
  });
});
