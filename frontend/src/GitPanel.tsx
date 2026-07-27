import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import type { GitBranchesResult, GitFileStatus, GitStatus } from "./api.js";
import { GitBranchIcon } from "./icons.js";
import { LIVE_REFRESH_INTERVAL_MS, useDashboardStore } from "./store.js";
import { Toggle } from "./settings/primitives.js";

export interface GitPanelParams {
  projectId: number;
}

function statusDotClass(status: GitFileStatus["status"]): string {
  switch (status) {
    case "A":
      return "good";
    case "D":
      return "bad";
    case "U":
      return "bad";
    default:
      return "pending";
  }
}

export function GitPanel({ params }: { params: GitPanelParams }) {
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);
  const [branchesResult, setBranchesResult] = useState<GitBranchesResult | null | undefined>(
    undefined,
  );
  const [isFetching, setIsFetching] = useState(false);

  const autoFetch = useDashboardStore(
    (s) => s.projects.find((p) => p.id === params.projectId)?.autoFetch ?? null,
  );
  const globalEnabled = useDashboardStore(
    (s) => s.settings.sessions.gitAutoFetchIntervalSeconds > 0,
  );
  const effectiveAutoFetch = autoFetch ?? globalEnabled;
  const isInherited = autoFetch === null;

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const result = await api.getProjectGitStatus(params.projectId);
        if (cancelled) return;
        setStatus(result ?? null);
      } catch (err) {
        console.debug("[GitPanel] getProjectGitStatus failed", err);
      }
    };

    void fetchStatus();

    const tick = () => {
      if (document.visibilityState === "visible") void fetchStatus();
    };
    const timer = setInterval(tick, LIVE_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [params.projectId]);

  useEffect(() => {
    if (status === undefined || status === null) return;
    let cancelled = false;
    api
      .getProjectGitBranches(params.projectId)
      .then((r) => {
        if (!cancelled) setBranchesResult(r ?? null);
      })
      .catch(() => {
        if (!cancelled) setBranchesResult(null);
      });
    return () => {
      cancelled = true;
    };
  }, [params.projectId, status]);

  const handleFetch = useCallback(async () => {
    setIsFetching(true);
    try {
      await api.postProjectGitFetch(params.projectId);
    } catch (err) {
      console.debug("[GitPanel] postProjectGitFetch failed", err);
    } finally {
      setIsFetching(false);
    }
  }, [params.projectId]);

  const handleToggleAutoFetch = useCallback(async () => {
    const store = useDashboardStore.getState();
    const p = store.projects.find((p) => p.id === params.projectId);
    const currentAutoFetch = p?.autoFetch ?? null;
    const currentGlobalEnabled = store.settings.sessions.gitAutoFetchIntervalSeconds > 0;
    const currentEffective = currentAutoFetch ?? currentGlobalEnabled;
    await store.toggleAutoFetch(params.projectId, !currentEffective);
  }, [params.projectId]);

  const handleResetAutoFetch = useCallback(async () => {
    const store = useDashboardStore.getState();
    await store.toggleAutoFetch(params.projectId, null);
  }, [params.projectId]);

  if (status === undefined) {
    return <div className="github-panel-empty">Loading…</div>;
  }

  if (status === null) {
    return <div className="github-panel-empty">Not a git repository.</div>;
  }

  return (
    <div className="github-panel cmux-scroll">
      <div className="github-panel-repo">
        <GitBranchIcon size={14} />
        {status.branch}
        {status.hash && <span className="github-panel-row-number">{status.hash}</span>}
      </div>

      <div className="git-panel-sync-row">
        <span className="git-panel-ahead-behind">
          {(status.ahead > 0 || status.behind > 0) && (
            <>
              {status.ahead > 0 && `↑${status.ahead}`}
              {status.ahead > 0 && status.behind > 0 && " "}
              {status.behind > 0 && `↓${status.behind}`}
            </>
          )}
        </span>
        <span className="git-panel-sync-controls">
          <button className="git-panel-fetch-btn" onClick={handleFetch} disabled={isFetching}>
            {isFetching ? "⟳" : "↻"} Fetch
          </button>
          <span className="git-panel-toggle-wrapper">
            <Toggle
              size="small"
              on={effectiveAutoFetch}
              onChange={handleToggleAutoFetch}
              ariaLabel="Auto-fetch"
            />
            {isInherited ? (
              <span className="git-panel-toggle-inherited" title="Inherited from global settings">
                auto
              </span>
            ) : (
              <>
                <span className="git-panel-toggle-label">auto</span>
                <button
                  className="git-panel-toggle-reset"
                  onClick={handleResetAutoFetch}
                  title="Reset to global default"
                >
                  ×
                </button>
              </>
            )}
          </span>
        </span>
      </div>

      <div className="github-panel-section">
        <div className="github-panel-section-title">
          {status.isClean ? "Clean" : `Changes (${status.files.length})`}
        </div>
        {status.isClean && <div className="github-panel-empty-row">Working tree clean</div>}
        {status.files.map((file) => (
          <div key={file.path} className="github-panel-row">
            <span className={`github-panel-ci-dot ${statusDotClass(file.status)}`} />
            <span className="github-panel-row-number">{file.status}</span>
            <span className="github-panel-row-title">{file.path}</span>
          </div>
        ))}
      </div>

      {status.hasConflicts && (
        <div className="github-panel-empty-row github-panel-conflicts">
          This checkout has unresolved merge conflicts.
        </div>
      )}

      {branchesResult && branchesResult.branches.length > 0 && (
        <div className="github-panel-section">
          <div className="github-panel-section-title">
            Branches ({branchesResult.branches.length})
          </div>
          {branchesResult.branches.map((branch) => (
            <div key={branch.name} className="github-panel-row">
              <span className={`github-panel-ci-dot ${branch.isCurrent ? "good" : "pending"}`} />
              <span className="github-panel-row-title">{branch.name}</span>
              {branch.isCurrent && <span className="github-panel-row-number">current</span>}
            </div>
          ))}
        </div>
      )}

      {branchesResult && branchesResult.worktrees.length > 0 && (
        <div className="github-panel-section">
          <div className="github-panel-section-title">
            Worktrees ({branchesResult.worktrees.length})
          </div>
          {branchesResult.worktrees.map((worktree) => (
            <div key={worktree.path} className="github-panel-row">
              <span className="github-panel-row-title">{worktree.path}</span>
              <span className="github-panel-row-number">
                {worktree.branch ?? "detached"}
                {worktree.isMain ? " (main)" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
