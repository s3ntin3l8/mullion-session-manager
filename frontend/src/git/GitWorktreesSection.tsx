import { useDashboardStore } from "../store/index.js";

/** Worktrees with the sessions running in them (click to focus one) and a PR chip. */
export function GitWorktreesSection({
  projectId,
  selected,
  onSelect,
}: {
  projectId: number;
  /** The worktree path History is scoped to (undefined = project root). */
  selected: string | undefined;
  onSelect: (path: string | undefined) => void;
}) {
  const worktrees = useDashboardStore((s) => s.gitBranchesByProject[projectId]?.worktrees);
  const sessions = useDashboardStore((s) => s.sessions);
  const prs = useDashboardStore((s) => s.prsByProject[projectId]);
  const requestOpenSession = useDashboardStore((s) => s.requestOpenSession);
  const projectCwd = useDashboardStore((s) => s.projects.find((p) => p.id === projectId)?.cwd);
  if (!worktrees) return <div className="github-panel-empty-row">No worktree data</div>;
  const prByBranch = new Map((prs?.prs ?? []).map((p) => [p.headBranch, p]));
  return (
    <div>
      {worktrees.map((w) => {
        const live = sessions.filter(
          // Same precedence as the rest of the app: where the shell actually is,
          // else where it was launched, else the project root.
          (s) =>
            s.projectId === projectId &&
            s.status === "active" &&
            (s.liveCwd ?? s.cwd ?? projectCwd) === w.path,
        );
        const pr = w.branch ? prByBranch.get(w.branch) : undefined;
        const isSelected = (selected ?? worktrees.find((x) => x.isMain)?.path) === w.path;
        return (
          <div key={w.path} className="github-panel-row">
            <button
              type="button"
              className={`gh-link-button${isSelected ? " active" : ""}`}
              title={`Show history for ${w.path}`}
              aria-pressed={isSelected}
              onClick={() => onSelect(w.isMain ? undefined : w.path)}
            >
              {w.path.split("/").filter(Boolean).pop()}
            </button>
            <span className="github-panel-row-title">{w.branch ?? "(detached)"}</span>
            {pr && <span className="gh-task-chip">#{pr.number}</span>}
            {live.map((s) => (
              <button
                key={s.id}
                type="button"
                className="gh-link-button"
                title={`Open session ${s.name ?? s.id}`}
                onClick={() => requestOpenSession(s.id)}
              >
                ▶ {s.name ?? `#${s.id}`}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
