import { useWorkspaceTree } from "../hooks/useWorkspaceTree.js";
import { useDashboardStore } from "../store/index.js";
import { Dropdown } from "../ui/primitives.js";
import { workspaceOptions } from "./workspaceOptions.js";

// #3246 — the phone has no workspace switcher, so the launcher's Where group
// names the workspace a new session joins, and lets the user pick another.
// Only on the phone, and only with more than one workspace: on the desk and
// the fold the rail's workspace chip already shows and switches it.

interface LauncherWorkspaceRowProps {
  id: string;
  workspaceId: number | null;
  onChange: (workspaceId: number) => void;
}

export function LauncherWorkspaceRow(props: LauncherWorkspaceRowProps) {
  // Checked before the tree hook mounts: it loads the groups when none are in
  // the store, which a row that never renders should not cost on every open.
  const several = useDashboardStore((s) => s.workspaces.length > 1);
  return several ? <WorkspaceRow {...props} /> : null;
}

function WorkspaceRow({ id, workspaceId, onChange }: LauncherWorkspaceRowProps) {
  const { workspaces, sortedGroups, groupWorkspaces, ungrouped } = useWorkspaceTree();
  const options = workspaceOptions(sortedGroups, groupWorkspaces, ungrouped, workspaces);
  return (
    <div className="launcher-form-row">
      <label htmlFor={id} className="launcher-form-label">
        Workspace
      </label>
      <Dropdown
        id={id}
        className="launcher-form-fill"
        ariaLabel="Workspace"
        value={workspaceId === null ? "" : String(workspaceId)}
        onChange={(v) => onChange(Number(v))}
        options={options}
      />
    </div>
  );
}
