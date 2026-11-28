import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/index.js";
import type { Workspace } from "../api/index.js";
import { useDashboardStore } from "./index.js";
import { toggleActiveWorkspacePin } from "../hooks/useWorkspacePinnedProjects.js";

// #3537 — the workspace pin action and the toggle the sidebar menu and the
// palette call.
const ws = (id: number, pinnedProjectIds: number[]): Workspace => ({
  id,
  name: `w${id}`,
  layout: null,
  groupId: null,
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  pinnedProjectIds,
});

describe("workspaces slice: setWorkspacePinnedProjects", () => {
  afterEach(() => vi.restoreAllMocks());

  it("PATCHes the pins and keeps the server's row", async () => {
    const patch = vi
      .spyOn(api, "setWorkspacePinnedProjects")
      .mockResolvedValue({ ...ws(1, [3, 2]), name: "server" });
    useDashboardStore.setState({ workspaces: [ws(1, []), ws(2, [5])] });

    await useDashboardStore.getState().setWorkspacePinnedProjects(1, [3, 2]);

    expect(patch).toHaveBeenCalledWith(1, [3, 2]);
    const [first, second] = useDashboardStore.getState().workspaces;
    expect(first).toMatchObject({ name: "server", pinnedProjectIds: [3, 2] });
    expect(second.pinnedProjectIds).toEqual([5]);
  });

  it("applies the pins before the PATCH resolves and rolls back on failure", async () => {
    const list = vi.spyOn(api, "listWorkspaces").mockResolvedValue([ws(1, [4])]);
    let reject!: (err: Error) => void;
    vi.spyOn(api, "setWorkspacePinnedProjects").mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      }),
    );
    useDashboardStore.setState({ workspaces: [ws(1, [4])] });

    const pending = useDashboardStore.getState().setWorkspacePinnedProjects(1, [4, 6]);
    expect(useDashboardStore.getState().workspaces[0].pinnedProjectIds).toEqual([4, 6]);
    reject(new Error("nope"));

    await expect(pending).rejects.toThrow("nope");
    expect(useDashboardStore.getState().workspaces[0].pinnedProjectIds).toEqual([4]);
    // Resyncs with the server after a failure.
    expect(list).toHaveBeenCalled();
  });

  it("does not roll back over a later toggle that already moved the pins on", async () => {
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([ws(1, [7])]);
    let rejectFirst!: (err: Error) => void;
    vi.spyOn(api, "setWorkspacePinnedProjects")
      .mockReturnValueOnce(
        new Promise((_, r) => {
          rejectFirst = r;
        }),
      )
      .mockResolvedValueOnce(ws(1, [7]));
    useDashboardStore.setState({ workspaces: [ws(1, [])] });

    const first = useDashboardStore.getState().setWorkspacePinnedProjects(1, [5]);
    await useDashboardStore.getState().setWorkspacePinnedProjects(1, [7]);
    rejectFirst(new Error("late failure"));
    await expect(first).rejects.toThrow("late failure");

    expect(useDashboardStore.getState().workspaces[0].pinnedProjectIds).toEqual([7]);
  });
});

describe("toggleActiveWorkspacePin", () => {
  afterEach(() => vi.restoreAllMocks());

  it("appends an unpinned project and removes a pinned one, on the active workspace", async () => {
    const patch = vi
      .spyOn(api, "setWorkspacePinnedProjects")
      .mockImplementation(async (id, ids) => ws(id, ids));
    useDashboardStore.setState({
      workspaces: [ws(1, [2]), ws(7, [])],
      activeWorkspaceId: 1,
      projects: [{ id: 2 }, { id: 5 }] as never,
      projectsLoaded: true,
    });

    await expect(toggleActiveWorkspacePin(5)).resolves.toBeNull();
    expect(patch).toHaveBeenLastCalledWith(1, [2, 5]);
    await expect(toggleActiveWorkspacePin(2)).resolves.toBeNull();
    expect(patch).toHaveBeenLastCalledWith(1, [5]);
  });

  it("drops a stored pin whose project no longer exists", async () => {
    const patch = vi
      .spyOn(api, "setWorkspacePinnedProjects")
      .mockImplementation(async (id, ids) => ws(id, ids));
    // Project 3 was deleted; the server already cascaded its pin away.
    useDashboardStore.setState({
      workspaces: [ws(1, [3, 2])],
      activeWorkspaceId: 1,
      projects: [{ id: 2 }, { id: 5 }] as never,
      projectsLoaded: true,
    });

    await expect(toggleActiveWorkspacePin(5)).resolves.toBeNull();
    expect(patch).toHaveBeenLastCalledWith(1, [2, 5]);
  });

  it("keeps every stored pin while the project list has not loaded", async () => {
    const patch = vi
      .spyOn(api, "setWorkspacePinnedProjects")
      .mockImplementation(async (id, ids) => ws(id, ids));
    useDashboardStore.setState({
      workspaces: [ws(1, [3, 2])],
      activeWorkspaceId: 1,
      projects: [],
      projectsLoaded: false,
    });

    await expect(toggleActiveWorkspacePin(5)).resolves.toBeNull();
    expect(patch).toHaveBeenLastCalledWith(1, [3, 2, 5]);
  });

  it("returns the error message when the PATCH fails", async () => {
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([ws(1, [])]);
    vi.spyOn(api, "setWorkspacePinnedProjects").mockRejectedValue(new Error("gone"));
    useDashboardStore.setState({ workspaces: [ws(1, [])], activeWorkspaceId: 1 });
    await expect(toggleActiveWorkspacePin(5)).resolves.toBe("gone");
  });

  it("does nothing without an active workspace", async () => {
    const patch = vi.spyOn(api, "setWorkspacePinnedProjects");
    useDashboardStore.setState({ workspaces: [ws(1, [])], activeWorkspaceId: null });
    await expect(toggleActiveWorkspacePin(5)).resolves.toBeNull();
    useDashboardStore.setState({ activeWorkspaceId: 99 });
    await expect(toggleActiveWorkspacePin(5)).resolves.toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });
});
