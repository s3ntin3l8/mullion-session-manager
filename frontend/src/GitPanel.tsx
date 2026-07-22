import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { GitBranchesResult, GitFileStatus, GitStatus } from "./api.js";
import { GitBranchIcon } from "./icons.js";

export interface GitPanelParams {
  projectId: number;
}

// Maps a file's simplified status code to the same "status dot" language
// GitHubPanel's Actions section and the sidebar badge use — VS Code-style
// single-letter status, colored via the same --g/--r/--o/--dim variables.
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
// GitHubPanel.tsx, for the same reason: `undefined` while loading, `null`
// for the 204 "not applicable" response (not a git repo, or `git` itself
// failed) — never surfaced as an error, just an empty state.
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

  useEffect(() => {
    let cancelled = false;
    // Same reasoning as GitHubPanel's effect: this panel is mounted fresh
    // per project (a stable "git-<projectId>" dockview panel id, see
    // App.tsx's onOpenGit), so params.projectId never actually changes
    // under an existing instance.
    api
      .getProjectGitStatus(params.projectId)
      .then((s) => {
        if (!cancelled) setStatus(s ?? null);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [params.projectId]);

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

  if (status === undefined) {
    return <div className="github-panel-empty">Loading…</div>;
  }

  if (status === null) {
    return (
      <div className="github-panel-empty">Not a git repository, or git status is unavailable.</div>
    );
  }

  return (
    <div className="github-panel cmux-scroll">
      <div className="github-panel-repo">
        <GitBranchIcon size={14} />
        {status.branch}
        {status.hash && <span className="github-panel-row-number">{status.hash}</span>}
      </div>

      {(status.ahead > 0 || status.behind > 0) && (
        <div className="github-panel-empty-row">
          {status.ahead > 0 && `↑${status.ahead}`}
          {status.ahead > 0 && status.behind > 0 && " "}
          {status.behind > 0 && `↓${status.behind}`}
        </div>
      )}

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
