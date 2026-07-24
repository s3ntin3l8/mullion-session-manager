// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore } from "./store.js";
import type { Task } from "./api.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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
};

const TASK: Task = {
  id: 1,
  projectId: 1,
  projectName: "demo",
  issueNumber: 42,
  title: "Fix the thing",
  body: "details",
  htmlUrl: "https://github.com/o/r/issues/42",
  status: "pending",
  sessionId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  claimedAt: null,
};

describe("store.refreshTasks / claimTask (Phase 2.5 Task Master, Thin Slice)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let taskMasterEnabled: boolean;
  let tasksResponse: Task[];

  beforeEach(() => {
    taskMasterEnabled = true;
    tasksResponse = [TASK];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/server-info") {
        return jsonResponse(200, { ...SERVER_INFO_BASE, taskMasterEnabled });
      }
      if (url === "/api/tasks") {
        return jsonResponse(200, tasksResponse);
      }
      if (url === "/api/tasks/1/claim") {
        return jsonResponse(201, { id: 99, projectId: 1, command: "claude" });
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

  it("sets taskMasterEnabled and fetches the task list when enabled", async () => {
    await useDashboardStore.getState().refreshTasks();
    expect(useDashboardStore.getState().taskMasterEnabled).toBe(true);
    expect(useDashboardStore.getState().tasks).toEqual([TASK]);
  });

  it("clears the task list without fetching it when disabled", async () => {
    taskMasterEnabled = false;
    useDashboardStore.setState({ tasks: [TASK] });
    await useDashboardStore.getState().refreshTasks();
    expect(useDashboardStore.getState().taskMasterEnabled).toBe(false);
    expect(useDashboardStore.getState().tasks).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/tasks");
  });

  it("claimTask returns the spawned session and refreshes sessions + tasks", async () => {
    tasksResponse = []; // simulates the claimed task dropping out of the pending list
    const session = await useDashboardStore.getState().claimTask(1);
    expect(session).toMatchObject({ id: 99, projectId: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/1/claim",
      expect.objectContaining({ method: "POST" }),
    );
    expect(useDashboardStore.getState().tasks).toEqual([]);
  });
});
