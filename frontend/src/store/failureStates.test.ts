// @vitest-environment jsdom
// The store-level half of the UI/UX audit's "surface failures instead of
// swallowing them" pass (docs/ui-ux-audit.md).
//
// Three findings live here:
//
//   - #9  — the session rename was optimistic with no rollback, so a
//           rejected rename left the row showing a name the server never
//           accepted.
//   - #14 — the project list had no "loaded" flag, so the sidebar's
//           first-run empty state covered "still loading" AND "the fetch
//           failed".
//   - #15 — a failed task fetch was indistinguishable from an empty task
//           list, so the board said "No tasks yet." and invited the user
//           to create one.
//
// These exercise the REAL store against a mocked global fetch, the same
// shape store/mute.test.ts uses for the store's own actions.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useDashboardStore } from "./index.js";
import { resetStore } from "../test/resetStore.js";
import { mockFetch } from "../test/mockFetch.js";
import { jsonResponse } from "../test/jsonResponse.js";
import type { MockFetchResult } from "../test/mockFetch.js";
import type { Session } from "../api/index.js";

let fetchMock: MockFetchResult;

const SESSION: Session = {
  id: 12,
  projectId: 1,
  name: "original name",
  command: "claude",
  cwd: "/tmp",
  status: "running",
  createdAt: "2026-01-01T00:00:00Z",
  endedAt: null,
} as unknown as Session;

beforeEach(() => {
  fetchMock = mockFetch({
    "PATCH /api/sessions/:id": () => jsonResponse(500, { message: "rename rejected" }),
    "GET /api/projects": () => jsonResponse(200, []),
    "GET /api/tasks": () => jsonResponse(200, []),
    "GET /api/sessions": () => jsonResponse(200, []),
  });
  vi.stubGlobal("fetch", fetchMock.fetchMock);
  resetStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renameSession rollback (audit finding 9)", () => {
  // The rename is OPTIMISTIC: the row shows the new name before the
  // server has accepted it. That is what makes the rollback below
  // meaningful — without an optimistic write there would be nothing to
  // roll back.
  it("applies the new name optimistically, before the PATCH resolves", async () => {
    let releasePatch: () => void = () => {};
    const patchPending = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "PATCH /api/sessions/:id": async () => {
          await patchPending;
          return jsonResponse(200, { ...SESSION, name: "new name" });
        },
        "GET /api/sessions": () => jsonResponse(200, []),
      }).fetchMock,
    );
    resetStore({ sessions: [SESSION] });

    const pending = useDashboardStore.getState().renameSession(12, "new name");
    // The PATCH is still in flight here.
    expect(useDashboardStore.getState().sessions.find((s) => s.id === 12)?.name).toBe("new name");

    releasePatch();
    await pending;
  });

  it("restores the previous name when the rename is rejected", async () => {
    resetStore({ sessions: [SESSION] });
    await expect(useDashboardStore.getState().renameSession(12, "new name")).rejects.toThrow();
    const session = useDashboardStore.getState().sessions.find((s) => s.id === 12);
    expect(session?.name).toBe("original name");
  });

  it("rethrows so the caller can tell the user", async () => {
    resetStore({ sessions: [SESSION] });
    await expect(useDashboardStore.getState().renameSession(12, "new name")).rejects.toThrow();
  });

  it("restores nameLocked along with the name", async () => {
    resetStore({
      sessions: [{ ...SESSION, nameLocked: false } as unknown as Session],
    });
    await expect(useDashboardStore.getState().renameSession(12, "new name")).rejects.toThrow();
    const session = useDashboardStore.getState().sessions.find((s) => s.id === 12);
    expect(session?.nameLocked).toBe(false);
  });

  it("keeps the new name when the rename succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "PATCH /api/sessions/:id": () => jsonResponse(200, { ...SESSION, name: "new name" }),
        "GET /api/sessions": () => jsonResponse(200, [{ ...SESSION, name: "new name" }]),
      }).fetchMock,
    );
    resetStore({ sessions: [SESSION] });
    await useDashboardStore.getState().renameSession(12, "new name");
    const session = useDashboardStore.getState().sessions.find((s) => s.id === 12);
    expect(session?.name).toBe("new name");
  });

  it("leaves other sessions alone", async () => {
    const other = { ...SESSION, id: 13, name: "untouched" } as unknown as Session;
    resetStore({ sessions: [SESSION, other] });
    await expect(useDashboardStore.getState().renameSession(12, "new name")).rejects.toThrow();
    expect(useDashboardStore.getState().sessions.find((s) => s.id === 13)?.name).toBe("untouched");
  });
});

describe("project list load state (audit finding 14)", () => {
  it("starts not loaded, with no error", () => {
    expect(useDashboardStore.getState().projectsLoaded).toBe(false);
    expect(useDashboardStore.getState().projectsError).toBeNull();
  });

  it("flips to loaded on success", async () => {
    await useDashboardStore.getState().refreshProjects();
    expect(useDashboardStore.getState().projectsLoaded).toBe(true);
    expect(useDashboardStore.getState().projectsError).toBeNull();
  });

  it("records the failure and rethrows", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/projects": () => jsonResponse(500, { message: "no projects for you" }),
      }).fetchMock,
    );
    await expect(useDashboardStore.getState().refreshProjects()).rejects.toThrow();
    expect(useDashboardStore.getState().projectsLoaded).toBe(true);
    expect(useDashboardStore.getState().projectsError).toBeTruthy();
  });

  it("clears a previous error on the next success", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/projects": () => jsonResponse(500, { message: "boom" }),
      }).fetchMock,
    );
    await expect(useDashboardStore.getState().refreshProjects()).rejects.toThrow();
    expect(useDashboardStore.getState().projectsError).toBeTruthy();

    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/projects": () => jsonResponse(200, []),
      }).fetchMock,
    );
    await useDashboardStore.getState().refreshProjects();
    expect(useDashboardStore.getState().projectsError).toBeNull();
  });
});

describe("task fetch failure (audit finding 15)", () => {
  it("starts with no error", () => {
    expect(useDashboardStore.getState().tasksError).toBeNull();
  });

  it("records the failure when the list cannot be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/tasks": () => jsonResponse(500, { message: "tasks unavailable" }),
        "GET /api/server-info": () => jsonResponse(200, { taskMasterEnv: null }),
      }).fetchMock,
    );
    await useDashboardStore.getState().refreshTasks();
    expect(useDashboardStore.getState().tasksError).toBeTruthy();
    // The last-known-good list is deliberately kept rather than blanked.
    expect(useDashboardStore.getState().tasks).toEqual([]);
  });

  it("clears the error on the next success", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/tasks": () => jsonResponse(500, { message: "boom" }),
        "GET /api/server-info": () => jsonResponse(200, { taskMasterEnv: null }),
      }).fetchMock,
    );
    await useDashboardStore.getState().refreshTasks();
    expect(useDashboardStore.getState().tasksError).toBeTruthy();

    vi.stubGlobal(
      "fetch",
      mockFetch({
        "GET /api/tasks": () => jsonResponse(200, []),
        "GET /api/server-info": () => jsonResponse(200, { taskMasterEnv: null }),
      }).fetchMock,
    );
    await useDashboardStore.getState().refreshTasks();
    expect(useDashboardStore.getState().tasksError).toBeNull();
  });
});
