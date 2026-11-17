// A worker failed on its budget keeps its scrollback tail in failureDiagnostics
// (#3155). Its own file: the reconciler's test file is at its file-size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

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
const scrollbackRender = await import("../../src/services/scrollback-render.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-budget-diag-${process.pid}.db`);

function workingInfo() {
  return {
    activity: "working",
    attention: false,
    attentionKind: null,
    permissionState: "idle",
    planState: "idle",
    gateState: "idle",
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    elicitationState: "idle",
    elicitationServer: null,
    questionState: "idle",
    questionHeader: null,
    errorState: "idle",
    errorDetail: null,
    endedReason: null,
    exitCode: null,
    compactState: "idle",
    subagentCount: 0,
    lastTurnEndedAt: null,
    workFinishedAt: null,
    outstandingBackgroundTasks: [],
  };
}

describe("budget failure keeps the worker's scrollback tail", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_BUDGET_MINUTES;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function setup(ptyExtras: Record<string, unknown>) {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const sessionId = session.json().id as number;
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "t",
        status: "claimed",
        sessionId,
        claimedAt,
      })
      .returning()
      .all();
    const terminate = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: workingInfo,
      getRenderableScrollback: () => Buffer.from("raw"),
      size: { cols: 80, rows: 24 },
      ...ptyExtras,
    } as never);
    return { app, taskId: row.id, sessionId, terminate };
  }

  const getTask = (app: Awaited<ReturnType<typeof buildApp>>, id: number) =>
    app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  it("stores the rendered tail (alternate-screen marker kept, ANSI stripped)", async () => {
    const { app, taskId, sessionId, terminate } = await setup({});
    vi.spyOn(scrollbackRender, "renderScrollback").mockResolvedValue(
      "--- alternate screen ---\n\u001b[31mxcodebuild: command not found\u001b[0m\n",
    );

    await reconcileTasks(app);

    const row = getTask(app, taskId);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toContain("budget exceeded");
    expect(row.failureDiagnostics).toContain("xcodebuild: command not found");
    expect(row.failureDiagnostics).toContain("--- alternate screen ---");
    expect(row.failureDiagnostics).not.toContain("\u001b");
    expect(terminate).toHaveBeenCalledWith(String(sessionId));
    const [s] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    expect(s.status).toBe("killed");
    await app.close();
  });

  it("still fails the task and kills the session when the read throws", async () => {
    const { app, taskId, sessionId, terminate } = await setup({
      getRenderableScrollback: () => {
        throw new Error("scrollback gone");
      },
    });

    await reconcileTasks(app);

    const row = getTask(app, taskId);
    expect(row.status).toBe("failed");
    expect(row.failureDiagnostics).toBeNull();
    expect(terminate).toHaveBeenCalledWith(String(sessionId));
    await app.close();
  });

  it("still fails the task and kills the session when the read hangs past the bound", async () => {
    const { app, taskId, sessionId, terminate } = await setup({});
    vi.spyOn(scrollbackRender, "renderScrollback").mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const done = reconcileTasks(app);
    await vi.advanceTimersByTimeAsync(6_000);
    await done;

    const row = getTask(app, taskId);
    expect(row.status).toBe("failed");
    expect(row.failureDiagnostics).toBeNull();
    expect(terminate).toHaveBeenCalledWith(String(sessionId));
    await app.close();
  });

  // Issue #3193 — a budget failure must remove the worktree on the host the
  // worker actually ran on, using that host's project path (projects.hostCwds),
  // never the primary's project.cwd. The #3193 incident sent the primary path
  // to a macbook agent, which rejected it and left the worktree behind.
  it("removes a budget-failed remote worker's worktree with the worker host's mapped path, never the primary's cwd (#3193)", async () => {
    const app = await buildApp();
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "budget-remote-p", cwd: "/tmp" },
    });
    const projectId = projectRes.json().id as number;
    const hostRes = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const remoteHostId = hostRes.json().id as string;
    const remoteCwd = "/Users/bjoern/Projects/branchdam-mobile";
    const worktreePath = `${remoteCwd}/.mullion-worktrees/mullion-task-1`;

    const { sessions, projects } = await import("../../src/db/schema.js");
    const [session] = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", hostId: remoteHostId, status: "active" })
      .returning()
      .all();
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "claimed",
        sessionId: session.id,
        claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        worktreePath,
      })
      .returning()
      .all();
    app.db
      .update(projects)
      .set({ hostCwds: JSON.stringify({ [remoteHostId]: remoteCwd }) })
      .where(eq(projects.id, projectId))
      .run();

    const sessionBackendModule = await import("../../src/services/session-backend.js");
    const realResolveBackend = sessionBackendModule.resolveBackend;
    const removeWorktreeIfCleanMock = vi.fn().mockResolvedValue({ removed: true });
    const resolveBackendSpy = vi
      .spyOn(sessionBackendModule, "resolveBackend")
      .mockImplementation((appArg, hostId) => {
        const real = realResolveBackend(appArg, hostId);
        if (hostId !== remoteHostId) return real;
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "liveStatus") return async () => ({ [session.id]: workingInfo() });
            if (prop === "getRenderedScrollback") return async () => "tail";
            if (prop === "removeWorktreeIfClean") return removeWorktreeIfCleanMock;
            if (prop === "terminate") return async () => undefined;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });

    await reconcileTasks(app);

    expect(getTask(app, row.id).status).toBe("failed");
    expect(removeWorktreeIfCleanMock).toHaveBeenCalledWith(worktreePath, remoteCwd);
    expect(removeWorktreeIfCleanMock.mock.calls[0][1]).not.toBe("/tmp");
    resolveBackendSpy.mockRestore();
    await app.close();
  });
});
