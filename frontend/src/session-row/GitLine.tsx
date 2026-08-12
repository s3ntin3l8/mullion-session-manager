import type { GitDiffStats, GitHubPROrWithChecks, GitStatus } from "../api/index.js";
import { sessionGitDotClass, sessionPrDotClass } from "../lib/sidebarStatus.js";

// SessionRow's row 3 (issue #202) — worktree/branch/PR/diff-stats single-line
// summary. Extracted verbatim from SessionRow (PR 27 phase 2, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) — purely presentational, no store
// reads and no local state, so the caller (SessionRow) decides both WHETHER
// to render this at all (its own `gitExpanded && (gitStatus != null ||
// displayBranch)` guard) and passes every already-derived value down as a
// prop rather than this component re-deriving any of them. Keeping that
// guard in the parent (not here) matches how SessionRow already gates
// row 4/5/6 below.
export interface GitLineProps {
  gitStatus: GitStatus | null | undefined;
  displayBranch: string | null | undefined;
  worktreeLabel: string | null;
  effectiveCwd: string;
  matchedPr: GitHubPROrWithChecks | undefined;
  diffStats: GitDiffStats | null | undefined;
}

export function GitLine({
  gitStatus,
  displayBranch,
  worktreeLabel,
  effectiveCwd,
  matchedPr,
  diffStats,
}: GitLineProps) {
  return (
    <div className="session-git-line">
      <span
        className={`project-git-dot ${gitStatus ? sessionGitDotClass(gitStatus) : "none"}`}
        title={
          gitStatus
            ? gitStatus.hasConflicts
              ? `${displayBranch}: unresolved merge conflicts`
              : gitStatus.isClean
                ? `${displayBranch}: clean`
                : `${displayBranch}: ${gitStatus.files.length} changed file${gitStatus.files.length === 1 ? "" : "s"}`
            : (displayBranch ?? "")
        }
      />
      <span className="session-git-branch" title={displayBranch ?? ""}>
        {displayBranch}
      </span>
      {worktreeLabel && (
        <span className="session-git-worktree" title={effectiveCwd}>
          @ {worktreeLabel}
        </span>
      )}
      {matchedPr && (
        <a
          href={matchedPr.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="session-git-pr"
          title={matchedPr.title}
          onClick={(e) => e.stopPropagation()}
        >
          <span className={`github-panel-ci-dot ${sessionPrDotClass(matchedPr.ciStatus)}`} />#
          {matchedPr.number}
        </a>
      )}
      {diffStats && diffStats.filesChanged > 0 && (
        <span className="session-git-diffstat">
          {diffStats.filesChanged} file{diffStats.filesChanged === 1 ? "" : "s"}{" "}
          <span className="session-git-ins">+{diffStats.insertions}</span>{" "}
          <span className="session-git-del">-{diffStats.deletions}</span>
        </span>
      )}
    </div>
  );
}
