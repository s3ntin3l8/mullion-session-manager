// @vitest-environment jsdom
// #3048: the workspace and group edits the sidebar and the rail's picker
// share report a refused request instead of dropping it.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import {
  deleteGroup,
  deleteWorkspace,
  moveWorkspace,
  renameGroup,
  renameWorkspace,
} from "./workspaceActions.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function ws(id: number, groupId: number | null, position: number): Workspace {
  return { id, groupId, position, name: `ws${id}` } as Workspace;
}

describe("workspaceActions", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["renameWorkspace", () => renameWorkspace(1, "a"), "Could not rename the workspace."],
    ["deleteWorkspace", () => deleteWorkspace(1), "Could not delete the workspace."],
    ["updateGroup", () => renameGroup(2, "b"), "Could not rename the group."],
    ["deleteGroup", () => deleteGroup(2), "Could not delete the group."],
  ] as const)("reports a refused %s", async (action, run, message) => {
    const reportError = vi.fn();
    useDashboardStore.setState({
      reportError,
      [action]: vi.fn().mockRejectedValue(new Error("refused")),
    });
    run();
    await flush();
    expect(reportError).toHaveBeenCalledWith(message, expect.stringContaining("refused"));
  });

  it("moves through computeReorder, and reloads the order after a refused move", async () => {
    const reportError = vi.fn();
    const refreshWorkspaces = vi.fn().mockResolvedValue(undefined);
    const reorderWorkspaces = vi.fn().mockResolvedValue(undefined);
    useDashboardStore.setState({ reportError, refreshWorkspaces, reorderWorkspaces });
    const list = [ws(1, null, 0), ws(2, null, 1), ws(3, null, 2)];

    moveWorkspace(list, 3, null, 0);
    await flush();
    const updates = reorderWorkspaces.mock.calls[0][0] as { id: number; position: number }[];
    expect(updates.find((u) => u.id === 3)?.position).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
    expect(refreshWorkspaces).not.toHaveBeenCalled();

    reorderWorkspaces.mockRejectedValueOnce(new Error("refused"));
    moveWorkspace(list, 1, null, 2);
    await flush();
    expect(reportError).toHaveBeenCalledWith(
      "Could not move the workspace.",
      expect.stringContaining("refused"),
    );
    expect(refreshWorkspaces).toHaveBeenCalled();
  });
});
