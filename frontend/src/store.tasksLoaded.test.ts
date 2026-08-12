// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDashboardStore, clearTaskMasterEnvCacheForTests } from "./store/index.js";
import { api } from "./api/index.js";
import type { ServerInfo } from "./api/index.js";

const SERVER_INFO: ServerInfo = {
  version: "0.1.0",
  role: "primary",
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
  taskMasterEnabled: true,
  taskMasterEnv: {
    enabled: true,
    maxConcurrent: 2,
    budgetMinutes: 120,
    progressCommentMinutes: 15,
    skipPermissions: false,
    issueLabel: "mullion-task",
    pollIntervalSeconds: 60,
  },
};

// UnifiedBoard.tsx's "No tasks yet." empty state (tasks.length === 0) needs
// to tell "nothing has loaded yet" apart from "genuinely no tasks," the same
// reason sessionsLoaded exists (store.sessionsLoaded.test.ts) — without it,
// that message flashed on every single board open, since refreshTasks() is
// called fresh on mount and tasks starts as [].
//
// Deliberately DIFFERENT from sessionsLoaded's own semantics, tested below:
// refreshTasks() swallows a failed fetch to keep the last-known-good list
// (see its own comment in store.ts), so gating this flag on success only —
// sessionsLoaded's own rule — would leave a dead backend on a permanent
// loading skeleton with neither a task list nor an empty state ever reaching
// the UI. It flips true on the first ATTEMPT instead.
describe("store.tasksLoaded", () => {
  beforeEach(() => {
    useDashboardStore.setState({ tasks: [], tasksLoaded: false });
    clearTaskMasterEnvCacheForTests();
    vi.restoreAllMocks();
  });

  it("starts false before any fetch resolves", () => {
    expect(useDashboardStore.getState().tasksLoaded).toBe(false);
  });

  it("flips true once refreshTasks() resolves, even with an empty list", async () => {
    vi.spyOn(api, "getServerInfo").mockResolvedValue(SERVER_INFO);
    vi.spyOn(api, "listTasks").mockResolvedValue([]);
    await useDashboardStore.getState().refreshTasks();
    expect(useDashboardStore.getState().tasksLoaded).toBe(true);
    expect(useDashboardStore.getState().tasks).toEqual([]);
  });

  it("still flips true when the first fetch rejects — unlike sessionsLoaded, this is attempt-based, not success-based", async () => {
    vi.spyOn(api, "getServerInfo").mockResolvedValue(SERVER_INFO);
    vi.spyOn(api, "listTasks").mockRejectedValue(new Error("network error"));
    await useDashboardStore.getState().refreshTasks();
    expect(useDashboardStore.getState().tasksLoaded).toBe(true);
    // The failed fetch must not have blanked the list either — same
    // last-known-good posture refreshTasks documents for itself.
    expect(useDashboardStore.getState().tasks).toEqual([]);
  });
});
