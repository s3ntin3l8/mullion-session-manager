import type { Group, Workspace } from "../api/index.js";

export interface WorkspaceOption {
  value: string;
  label: string;
}

/** The workspaces in the rail picker's order (WorkspaceChip): each group by
 * name with its workspaces, then the ungrouped ones. `Dropdown` has no option
 * groups, so a grouped workspace carries its group's name in its label. */
export function workspaceOptions(
  sortedGroups: readonly Group[],
  groupWorkspaces: (groupId: number) => Workspace[],
  ungrouped: readonly Workspace[],
  all: readonly Workspace[],
): WorkspaceOption[] {
  const options: WorkspaceOption[] = [];
  for (const group of sortedGroups) {
    for (const w of groupWorkspaces(group.id)) {
      options.push({ value: String(w.id), label: `${group.name} / ${w.name}` });
    }
  }
  for (const w of ungrouped) options.push({ value: String(w.id), label: w.name });
  // A workspace whose group is not known (the groups have not loaded yet, on
  // the launcher's first open) is still listed, last and under its own name:
  // with no group loaded there is no group name to give it. Once the groups
  // load, the row re-renders in the picker's order.
  const listed = new Set(options.map((o) => o.value));
  for (const w of all) {
    if (!listed.has(String(w.id))) options.push({ value: String(w.id), label: w.name });
  }
  return options;
}
