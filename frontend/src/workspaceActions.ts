import type { Workspace } from "./api/index.js";
import { describeError } from "./lib/describeError.js";
import { computeReorder } from "./reorder.js";
import { useDashboardStore } from "./store/index.js";

// The workspace and group edits the sidebar's switcher and the rail's
// workspace picker (#3048) both make. A rejected request is reported, never
// left as an unhandled rejection: a failed delete used to look exactly like a
// successful one, the workspace simply still there (audit finding 12).

function report(message: string) {
  return (err: unknown) => {
    useDashboardStore.getState().reportError(message, describeError(err));
  };
}

export function renameWorkspace(id: number, name: string): void {
  void useDashboardStore
    .getState()
    .renameWorkspace(id, name)
    .catch(report("Could not rename the workspace."));
}

export function deleteWorkspace(id: number): void {
  void useDashboardStore
    .getState()
    .deleteWorkspace(id)
    .catch(report("Could not delete the workspace."));
}

export function renameGroup(id: number, name: string): void {
  void useDashboardStore.getState().updateGroup(id, { name });
}

export function deleteGroup(id: number): void {
  void useDashboardStore.getState().deleteGroup(id).catch(report("Could not delete the group."));
}

// Moves a workspace to `index` within the bucket `groupId` (null: ungrouped),
// the index counted without the moved workspace itself — the drag-and-drop's
// drop and the picker's Move up/Move down/Move to group share this.
export function moveWorkspace(
  workspaces: Workspace[],
  id: number,
  groupId: number | null,
  index: number,
): void {
  const items = workspaces.map((w) => ({ id: w.id, groupId: w.groupId, position: w.position }));
  void useDashboardStore.getState().reorderWorkspaces(computeReorder(items, id, index, groupId));
}
