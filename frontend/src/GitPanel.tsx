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

// A dockview panel (opened from the CommandPalette's Integrations section —
// see App.tsx/CommandPalette.tsx) showing a project's current git status:
// branch, short hash, ahead/behind vs. upstream, and per-file status (issue
// #76). Same three-state loading/not-applicable/loaded shape as
// GitHubPanel.tsx: `undefined` while loading, `null` for the durable 204
// "not applicable" response (not a git repo), a `GitStatus` once loaded.
//
// Polls on the same cadence as the sidebar's live-refresh (LIVE_REFRESH_
// INTERVAL_MS) rather than fetching once on mount — the original single-
// fetch version got stuck showing "Not a git repository" forever if that one
// mount-time request happened to land on a transient `git status` failure
// (e.g. `.git/index.lock` contention), since nothing ever retried it. Only a
// durable 204 (genuinely not a repo — see git-status.ts's `isGitRepo`/
// `getGitStatus` split) clears the panel to that state; every other outcome
// (the 503 "repo exists but git status itself failed" case, or a raw network
// error) keeps whatever was last successfully shown, exactly like the
// sidebar's own gitStatuses map now does (store.ts's refreshGitStatuses).
export function GitPanel({ params }: { params: GitPanelParams }) {
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);
  // Branches + worktrees (issue #162's "worktree awareness") — fetched once
  // when the panel opens, deliberately NOT polled: unlike working-tree
  // status, a branch/worktree list changes rarely and costs more to
  // enumerate, so there's no live-refresh tick for it (git-refs.ts's own doc
  // comment on why). `undefined` while loading, `null` for the 204 "not
  // applicable" response — same three-state shape as `status` above, kept as
  // a separate piece of state since it loads independently.
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
  const fetchProjectGit = useDashboardStore((s) => s.fetchProjectGit);
  const effectiveAutoFetch = autoFetch ?? globalEnabled;
  const isInherited = autoFetch === null;

  const fetchStatus = useCallback(
    async (cancelledRef?: { current: boolean }) => {
      try {
        const result = await api.getProjectGitStatus(params.projectId);
        if (cancelledRef?.current) return;
        setStatus(result ?? null);
      } catch (err) {
        // Transient failure (a thrown ApiError for the 503 "unavailable"
        // response, or any other network hiccup) — deliberately a no-op on
        // `status`, not `setStatus(null)`. Keeps rendering the last-known-good
        // status (or stays in the initial "Loading…" state if this is the
        // very first attempt) rather than incorrectly claiming "not a git
        // repository". Logged at debug level (same pattern as git-status.ts's
        // own stderr logging) so a *persistent* failure is still observable,
        // even though a single one is intentionally invisible to the user.
        console.debug("[GitPanel] getProjectGitStatus failed", err);
      }
    },
    [params.projectId],
  );

  useEffect(() => {
    const cancelledRef = { current: false };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchStatus(cancelledRef);

    const tick = () => {
      if (document.visibilityState === "visible") void fetchStatus(cancelledRef);
    };
    const timer = setInterval(tick, LIVE_REFRESH_INTERVAL_MS);

    // Same reasoning as GitHubPanel's effect for the dep array: this panel
    // is mounted fresh per project (a stable "git-<projectId>" dockview
    // panel id, see App.tsx' onOpenGit), so params.projectId never
    // actually changes under an existing instance.
    return () => {
      cancelledRef.current = true;
      clearInterval(timer);
    };
  }, [params.projectId, fetchStatus]);

  useEffect(() => {
    // Wait for `status` to resolve before firing the branches/worktrees
    // fetch — a durable "not a git repo" (status === null) means there's
    // nothing to enumerate either, so this skips a pointless network call
    // (and the wasted re-render it would otherwise cause once the panel has
    // already committed to rendering the "not a git repository" state;
    // Hermes review, PR #165) rather than firing both requests in parallel
    // from mount.
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
      await fetchProjectGit(params.projectId);
      await fetchStatus();
    } catch (err) {
      console.debug("[GitPanel] fetchProjectGit failed", err);
    } finally {
      setIsFetching(false);
    }
  }, [params.projectId, fetchProjectGit, fetchStatus]);

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
    // Only reached via the durable 204 now — a transient failure (503, or
    // any other fetch error) is handled above by simply not calling
    // setStatus, so it never lands here.
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
