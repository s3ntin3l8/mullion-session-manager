// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore, clearTaskMasterEnabledCacheForTests } from "./store.js";
import type { Task } from "./api.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? undefined : { "content-type": "application/json" },
  });
}

const SERVER_INFO_BASE = {
  version: "0.1.0",
  role: "primary" as const,
  nodeEnv: "test",
  port: 3000,
  encryptionEnabled: false,
  sessionsDir: "/tmp/sessions",
  dbPath: "/tmp/app.db",
  uptimeSeconds: 1,
  rateLimit: { max: 100, window: "1 minute" },
  projectsRoots: "",
  crsConfigDir: "~/.config/crs",
  previewsEnabled: false,
  previewBaseHost: "",
  previewAuthRequired: false,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    projectName: "demo",
    issueNumber: 42,
    title: "Fix the thing",
    body: "details",
    htmlUrl: "https://github.com/o/r/issues/42",
    status: "ready",
    boardOrder: 0,
    sessionId: null,
    reviewSessionId: null,
    worktreePath: null,
    branchName: null,
    agentCommand: null,
    prUrl: null,
    assignee: null,
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    reviewingAt: null,
    completedAt: null,
    ...overrides,
  };
}

const TASK = makeTask();

describe("store.refreshTasks (Phase 6 Task Master, 6.5/#218)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let taskMasterEnabled: boolean;
  let tasksResponse: Task[];
  let serverInfoCalls: number;

  beforeEach(() => {
    clearTaskMasterEnabledCacheForTests();
    taskMasterEnabled = true;
    tasksResponse = [TASK];
    serverInfoCalls = 0;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/server-info") {
        serverInfoCalls++;
        return jsonResponse(200, { ...SERVER_INFO_BASE, taskMasterEnabled });
      }
      if (url === "/api/tasks") {
        return jsonResponse(200, tasksResponse);
      }
      if (url === "/api/tasks/1/claim") {
        return jsonResponse(201, { id: 99, projectId: 1, command: "claude", seedDelivered: true });
      }
      if (url === "/api/tasks/1/approve") {
        return jsonResponse(200, { ...TASK, status: "done" });
      }
      if (url === "/api/tasks/1/reject") {
        return jsonResponse(200, { ...TASK, status: "in_progress" });
      }
      if (url === "/api/sessions") {
        return jsonResponse(200, []);
      }
      throw new Error(`unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ tasks: [], taskMasterEnabled: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the task list and sets taskMasterEnabled from server-info", async () => {
    await useDashboardStore.getState().refreshTasks();
    expect(useDashboardStore.getState().taskMasterEnabled).toBe(true);
    expect(useDashboardStore.getState().tasks).toEqual([TASK]);
  });

  it("fetches the task list even when taskMasterEnabled is false — the local board works regardless", async () => {
    taskMasterEnabled = false;
    await useDashboardStore.getState().refreshTasks();
    expect(useDashboardStore.getState().taskMasterEnabled).toBe(false);
    expect(useDashboardStore.getState().tasks).toEqual([TASK]);
  });

  it("only fetches /api/server-info once across repeated calls", async () => {
    await useDashboardStore.getState().refreshTasks();
    await useDashboardStore.getState().refreshTasks();
    await useDashboardStore.getState().refreshTasks();
    expect(serverInfoCalls).toBe(1);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/tasks")).toHaveLength(3);
  });

  it("preserves the previous task list on a transient GET /api/tasks failure", async () => {
    await useDashboardStore.getState().refreshTasks();
    expect(useDashboardStore.getState().tasks).toEqual([TASK]);

    // server-info is already cached, so this next call only fetches
    // /api/tasks — mockImplementationOnce intercepts exactly that request.
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    await useDashboardStore.getState().refreshTasks();

    expect(useDashboardStore.getState().tasks).toEqual([TASK]);
  });

  it("dedups overlapping calls onto the same returned promise", async () => {
    const first = useDashboardStore.getState().refreshTasks();
    const second = useDashboardStore.getState().refreshTasks();
    expect(second).toBe(first);
    await Promise.all([first, second]);
  });

  it("re-fetches once more when a call arrives while one is already in flight, instead of silently dropping it (independent review, PR #477)", async () => {
    // Prime taskMasterEnabledLoaded so both refreshes below only need to
    // fetch /api/tasks, not also /api/server-info — keeps the "in flight"
    // window unambiguous.
    await useDashboardStore.getState().refreshTasks();

    let releaseFirst: (() => void) | undefined;
    let tasksCallCount = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url !== "/api/tasks") throw new Error(`unhandled fetch in test: ${url}`);
      tasksCallCount++;
      if (tasksCallCount === 1) {
        // Simulates a still-in-flight GET issued before a mutation's own
        // write landed — held open until the test releases it below.
        return new Promise<Response>((resolve) => {
          releaseFirst = () => resolve(jsonResponse(200, []));
        });
      }
      // The second call reflects state a mutation has since changed —
      // this is what a real createTask/updateTask/... call's own
      // `refreshTasks()` is trying to observe.
      return Promise.resolve(jsonResponse(200, [TASK]));
    });

    const first = useDashboardStore.getState().refreshTasks();
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());

    // Simulates the mutation's own post-write refreshTasks() call, arriving
    // while the (now-stale) first GET is still in flight.
    const second = useDashboardStore.getState().refreshTasks();
    expect(second).toBe(first);

    releaseFirst!();
    await first;

    expect(tasksCallCount).toBe(2);
    expect(useDashboardStore.getState().tasks).toEqual([TASK]);
  });

  it("claimTask returns the spawned session and refreshes sessions + tasks", async () => {
    tasksResponse = []; // simulates the claimed task dropping out of the ready column
    const session = await useDashboardStore.getState().claimTask(1);
    expect(session).toMatchObject({ id: 99, projectId: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/1/claim",
      expect.objectContaining({ method: "POST" }),
    );
    await vi.waitFor(() => expect(useDashboardStore.getState().tasks).toEqual([]));
  });

  it("approveTask returns the updated task and refreshes the list", async () => {
    const task = await useDashboardStore.getState().approveTask(1);
    expect(task.status).toBe("done");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/1/approve",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejectTask sends feedback and refreshes sessions + tasks", async () => {
    const task = await useDashboardStore.getState().rejectTask(1, "please fix X");
    expect(task.status).toBe("in_progress");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/1/reject",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ feedback: "please fix X" }),
      }),
    );
  });
});

describe("store.createTask / updateTask / deleteTask (local-board CRUD, 6.9/#233)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearTaskMasterEnabledCacheForTests();
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/server-info") {
        return jsonResponse(200, { ...SERVER_INFO_BASE, taskMasterEnabled: false });
      }
      if (url === "/api/tasks" && init?.method === "POST") {
        return jsonResponse(200, makeTask({ id: 2, title: "New task", issueNumber: null }));
      }
      if (url === "/api/tasks") {
        return jsonResponse(200, []);
      }
      if (url === "/api/tasks/2" && init?.method === "PATCH") {
        return jsonResponse(200, makeTask({ id: 2, status: "ready", boardOrder: 1 }));
      }
      if (url === "/api/tasks/2" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ tasks: [], taskMasterEnabled: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createTask posts the new task and refreshes the list", async () => {
    const task = await useDashboardStore.getState().createTask(1, "New task");
    expect(task.title).toBe("New task");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ projectId: 1, title: "New task", body: undefined }),
      }),
    );
  });

  it("updateTask patches boardOrder/status and refreshes the list", async () => {
    const task = await useDashboardStore
      .getState()
      .updateTask(2, { status: "ready", boardOrder: 1 });
    expect(task).toMatchObject({ status: "ready", boardOrder: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/2",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "ready", boardOrder: 1 }),
      }),
    );
  });

  it("deleteTask sends DELETE and refreshes the list", async () => {
    await useDashboardStore.getState().deleteTask(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
