import { useWorkspaceTree } from "../hooks/useWorkspaceTree.js";
import { Dropdown } from "../ui/primitives.js";
import { workspaceOptions } from "./workspaceOptions.js";

// #3246 — the phone has no workspace switcher, so the launcher's Where group
// names the workspace a new session joins, and lets the user pick another.
// Only on the phone, and only with more than one workspace: on the desk and
// the fold the rail's workspace chip already shows and switches it.

export function LauncherWorkspaceRow({
  id,
  workspaceId,
  onChange,
}: {
  id: string;
  workspaceId: number | null;
  onChange: (workspaceId: number) => void;
}) {
  const { workspaces, sortedGroups, groupWorkspaces, ungrouped } = useWorkspaceTree();
  if (workspaces.length < 2) return null;
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
