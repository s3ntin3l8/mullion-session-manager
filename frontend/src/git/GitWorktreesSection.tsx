import { useCallback, useState } from "react";
import { api } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { FORCEABLE_REASONS, reasonMessage } from "./gitReasons.js";

/** Worktrees with sessions running in them, prune stale, and remove actions. */
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

  const [isPruning, setIsPruning] = useState(false);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, { message: string; reason?: string }>>(
    {},
  );
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  if (projectId !== prevProjectId) {
    setPrevProjectId(projectId);
    setPruneError(null);
    setRowErrors({});
  }

  const handlePruneStale = useCallback(async () => {
    setIsPruning(true);
    setPruneError(null);
    try {
      await api.pruneProjectGitWorktrees(projectId);
      void useDashboardStore.getState().refreshGitRefs([projectId]);
      useDashboardStore.getState().bumpGitRefreshTrigger();
    } catch (err) {
      setPruneError(err instanceof Error ? err.message : "Prune failed — try again.");
    } finally {
      setIsPruning(false);
    }
  }, [projectId]);

  const handleRemoveWorktree = useCallback(
    async (worktreePath: string, force = false) => {
      const key = `worktree:${worktreePath}`;
      try {
        const result = await api.removeProjectGitWorktree(projectId, worktreePath, force);
        if (result.removed) {
          setRowErrors((prev) => {
            if (!(key in prev)) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
          void useDashboardStore.getState().refreshGitRefs([projectId]);
          useDashboardStore.getState().bumpGitRefreshTrigger();
          return;
        }
        setRowErrors((prev) => ({
          ...prev,
          [key]: { message: reasonMessage(result.reason, result.detail), reason: result.reason },
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Request failed — try again.";
        setRowErrors((prev) => ({ ...prev, [key]: { message } }));
      }
    },
    [projectId],
  );

  if (!worktrees) return <div className="github-panel-empty-row">No worktree data</div>;
  const prByBranch = new Map((prs?.prs ?? []).map((p) => [p.headBranch, p]));

  return (
    <div className="git-worktrees-list">
      <div className="git-worktrees-toolbar">
        <button
          type="button"
          className="git-panel-fetch-btn"
          onClick={handlePruneStale}
          disabled={isPruning}
          title="Clears administrative metadata for worktrees whose directory is already gone"
        >
          {isPruning ? "Pruning…" : "Prune stale"}
        </button>
      </div>

      {pruneError && (
        <div className="github-panel-empty-row github-panel-conflicts">{pruneError}</div>
      )}

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
        const rowError = rowErrors[`worktree:${w.path}`];
        const basename = w.path.split("/").filter(Boolean).pop() || w.path;

        return (
          <div key={w.path} className="git-worktree-card">
            <div className="github-panel-row git-worktree-header-row">
              <button
                type="button"
                className={`gh-link-button git-worktree-title-btn${isSelected ? " active" : ""}`}
                title={`Scope commit history to ${w.path}`}
                aria-pressed={isSelected}
                onClick={() => onSelect(w.isMain ? undefined : w.path)}
              >
                {basename}
              </button>
              <span className="github-panel-row-title git-worktree-branch" title={w.path}>
                {w.branch ?? "(detached)"}
              </span>
              {w.isMain && <span className="github-panel-row-number">(main)</span>}
              {pr && <span className="gh-task-chip">#{pr.number}</span>}
              {!w.isMain && (
                <span className="git-panel-row-actions">
                  <ConfirmButton
                    title="Remove worktree"
                    onConfirm={() => handleRemoveWorktree(w.path)}
                  >
                    Remove
                  </ConfirmButton>
                </span>
              )}
            </div>

            {live.length > 0 && (
              <div className="git-worktree-sessions">
                {live.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="git-worktree-session-pill"
                    title={`Open session ${s.name ?? s.id}`}
                    onClick={() => requestOpenSession(s.id)}
                  >
                    <span className="git-worktree-session-label">▶ {s.name ?? `#${s.id}`}</span>
                  </button>
                ))}
              </div>
            )}

            {rowError && (
              <div className="github-panel-empty-row github-panel-conflicts">
                {rowError.message}
                {rowError.reason && FORCEABLE_REASONS.has(rowError.reason) && (
                  <span className="git-panel-row-actions">
                    <ConfirmButton
                      title="Force remove"
                      onConfirm={() => handleRemoveWorktree(w.path, true)}
                    >
                      Force
                    </ConfirmButton>
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
