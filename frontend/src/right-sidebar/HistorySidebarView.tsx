import { useState } from "react";
import { GitHistorySection } from "../git/GitHistorySection.js";
import { useDashboardStore } from "../store/index.js";
import { Dropdown } from "../ui/primitives.js";
import { ViewHeader } from "../ui/sidebar/index.js";
import type { RightSidebarViewProps } from "./views.js";

const ROOT = "";

/** The History rail view: the commit graph on its own, scoped to a branch and a worktree. */
export function HistorySidebarView({ projectId }: RightSidebarViewProps) {
  // The worktree path chosen for History; tied to the project it was chosen
  // for, because this view does not remount on a project switch and another
  // project's worktree path is invalid here.
  const [selection, setSelection] = useState<{ projectId: number; cwd: string }>({
    projectId,
    cwd: ROOT,
  });
  const cwd = selection.projectId === projectId ? selection.cwd : ROOT;
  const worktrees = useDashboardStore((s) => s.gitBranchesByProject[projectId]?.worktrees);
  const branch = useDashboardStore((s) =>
    s.gitBranchesByProject[projectId]?.branches.find((b) => b.isCurrent),
  )?.name;
  // No repo URL is stored on the project; any PR's link carries it.
  const githubUrl = useDashboardStore((s) => {
    const m = s.prsByProject[projectId]?.prs[0]?.htmlUrl.match(
      /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\//,
    );
    return m ? `${m[1]}/commits` : null;
  });

  const others = (worktrees ?? []).filter((w) => !w.isMain);
  const options = [
    { value: ROOT, label: "Project root" },
    ...others.map((w) => ({
      value: w.path,
      label: w.path.split("/").filter(Boolean).pop() || w.path,
    })),
  ];
  // A worktree that has since been removed would leave the Dropdown with no
  // matching option; fall back to the root.
  const value = options.some((o) => o.value === cwd) ? cwd : ROOT;

  return (
    <div className="history-sidebar-view">
      <ViewHeader
        title="History"
        subtitle={branch}
        externalUrl={githubUrl}
        externalLabel="Open commits on GitHub"
      />
      {others.length > 0 && (
        <div className="history-worktree-filter">
          <Dropdown
            small
            ariaLabel="Worktree filter"
            value={value}
            onChange={(next) => setSelection({ projectId, cwd: next })}
            options={options}
          />
        </div>
      )}
      <GitHistorySection projectId={projectId} cwd={value || undefined} />
    </div>
  );
}
