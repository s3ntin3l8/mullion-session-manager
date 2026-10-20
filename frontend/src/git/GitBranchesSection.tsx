import { useCallback, useEffect, useState } from "react";
import { api } from "../api/index.js";
import type { GitBranchInfo } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { PHASE_LABEL, phaseTone } from "../github/prPhase.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { FORCEABLE_REASONS, reasonMessage } from "./gitReasons.js";

/** Local branches with ahead/behind, last commit age, merged tag, PR phase chip, and delete. */
export function GitBranchesSection({ projectId }: { projectId: number }) {
  const storeBranches = useDashboardStore((s) => s.gitBranchesByProject[projectId]?.branches);
  const storeDefaultBranch = useDashboardStore(
    (s) => s.gitBranchesByProject[projectId]?.defaultBranch,
  );
  const worktrees = useDashboardStore((s) => s.gitBranchesByProject[projectId]?.worktrees);
  const gitRefreshTrigger = useDashboardStore((s) => s.gitRefreshTrigger);
  const [detailed, setDetailed] = useState<{
    projectId: number;
    branches: GitBranchInfo[];
    defaultBranch?: string | null;
  } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, { message: string; reason?: string }>>(
    {},
  );
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  if (projectId !== prevProjectId) {
    setPrevProjectId(projectId);
    setRowErrors({});
  }

  const fetchDetailed = useCallback(() => {
    let cancelled = false;
    api
      .getProjectGitBranches(projectId, true)
      .then(
        (r) =>
          !cancelled &&
          setDetailed(
            r ? { projectId, branches: r.branches, defaultBranch: r.defaultBranch } : null,
          ),
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    return fetchDetailed();
  }, [fetchDetailed, gitRefreshTrigger]);

  const branches = detailed?.projectId === projectId ? detailed.branches : storeBranches;
  const rawDefaultBranch =
    detailed?.projectId === projectId ? detailed.defaultBranch : storeDefaultBranch;
  const resolvedDefaultBranch = rawDefaultBranch
    ?.replace(/^refs\/remotes\//, "")
    .replace(/^origin\//, "");
  const prs = useDashboardStore((s) => s.prsByProject[projectId]);

  const handleDeleteBranch = useCallback(
    async (name: string, force = false) => {
      const key = `${projectId}:branch:${name}`;
      try {
        const result = await api.deleteProjectGitBranch(projectId, name, force);
        if (result.deleted) {
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

  if (!branches) return <div className="github-panel-empty-row">No branch data</div>;
  const prByBranch = new Map((prs?.prs ?? []).map((p) => [p.headBranch, p]));

  return (
    <div className="git-branches-list">
      {branches.map((b) => {
        const pr = prByBranch.get(b.name);
        const checkedOutElsewhere = worktrees?.find((w) => w.branch === b.name && !w.isMain);
        const deleteDisabled = b.isCurrent || Boolean(checkedOutElsewhere);
        const tooltip = b.upstream ? `${b.name}\nTracks: ${b.upstream}` : b.name;
        const rowError = rowErrors[`${projectId}:branch:${b.name}`];
        const isDefaultBranch = resolvedDefaultBranch
          ? b.name === resolvedDefaultBranch
          : b.name === "main" || b.name === "master";

        return (
          <div key={b.name} className="git-branch-card">
            <div className="github-panel-row git-branch-row">
              <span className="github-panel-row-title git-branch-name" title={tooltip}>
                {b.isCurrent ? "● " : ""}
                {b.name}
              </span>
              {b.isCurrent && <span className="github-panel-row-number">current</span>}
              {(b.ahead ?? 0) > 0 && <span className="gh-add">↑{b.ahead}</span>}
              {(b.behind ?? 0) > 0 && <span className="gh-del">↓{b.behind}</span>}
              {!isDefaultBranch && !b.isCurrent && b.isMerged && (
                <span className="gh-task-chip">merged</span>
              )}
              {pr && (
                <span
                  className={`gh-phase-pill ${pr.prPhase ? phaseTone(pr.prPhase) : "dim"}`}
                  title={pr.prPhase ? PHASE_LABEL[pr.prPhase] : undefined}
                >
                  #{pr.number}
                </span>
              )}
              {b.lastCommitRelative && (
                <span className="github-panel-row-number">{b.lastCommitRelative}</span>
              )}
              <span className="git-panel-row-actions">
                <ConfirmButton
                  title={
                    b.isCurrent
                      ? "Cannot delete current branch"
                      : checkedOutElsewhere
                        ? `Checked out in ${checkedOutElsewhere.path.split("/").pop()}`
                        : "Delete branch"
                  }
                  onConfirm={() => handleDeleteBranch(b.name)}
                  disabled={deleteDisabled}
                >
                  Delete
                </ConfirmButton>
              </span>
            </div>
            {rowError && (
              <div className="github-panel-empty-row github-panel-conflicts">
                {rowError.message}
                {rowError.reason && FORCEABLE_REASONS.has(rowError.reason) && (
                  <span className="git-panel-row-actions">
                    <ConfirmButton
                      title="Force delete"
                      onConfirm={() => handleDeleteBranch(b.name, true)}
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
