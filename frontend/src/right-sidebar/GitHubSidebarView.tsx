import { useEffect } from "react";
import { useDockGithubStatus } from "../dock/useDockGithubStatus.js";
import { ciDotClass } from "../dock/dockHelpers.js";
import { useDashboardStore } from "../store/index.js";
import { EmptyStateNote } from "../ui/EmptyState.js";
import type { RightSidebarViewProps } from "./views.js";

// How many open PRs the compact list shows before pointing at the full panel.
const MAX_PRS = 8;

// A compact GitHub summary for the right sidebar: repo, default-branch CI,
// open-issue count and open PRs with their CI state. The full panel (checks,
// jobs, releases) stays one click away.
export function GitHubSidebarView({ projectId, actions }: RightSidebarViewProps) {
  const prsRefreshTrigger = useDashboardStore((s) => s.prsRefreshTrigger);
  // Live PRs pushed over /ws/github win over the fetched snapshot, same as
  // GitHubPanel.
  const storePrs = useDashboardStore((s) => s.prsByProject[projectId]);
  const subscribe = useDashboardStore((s) => s.subscribeToGitHubProject);
  const unsubscribe = useDashboardStore((s) => s.unsubscribeFromGitHubProject);
  const { githubStatus, prsStatus } = useDockGithubStatus(projectId, prsRefreshTrigger);

  // Ref-counted in the store, so this never cancels GitHubPanel's own updates.
  useEffect(() => {
    subscribe(projectId);
    return () => unsubscribe(projectId);
  }, [projectId, subscribe, unsubscribe]);

  const prs = storePrs ?? prsStatus;
  const openFull = (
    <button
      type="button"
      className="git-panel-fetch-btn"
      onClick={() => actions.onOpenGitHub(projectId)}
    >
      Open GitHub Panel
    </button>
  );

  if (githubStatus === null && prs == null) {
    return (
      <div className="github-sidebar-view">
        <EmptyStateNote>
          No GitHub status — still loading, or this project has no github.com remote or connected
          account.
        </EmptyStateNote>
        <div className="source-control-actions">{openFull}</div>
      </div>
    );
  }

  const shown = prs?.prs.slice(0, MAX_PRS) ?? [];
  const hidden = (prs?.prs.length ?? 0) - shown.length;

  return (
    <div className="github-sidebar-view">
      {githubStatus && (
        <div className="source-control-branch-row">
          {githubStatus.ciStatus && (
            <span
              className={`github-panel-ci-dot ${ciDotClass(githubStatus.ciStatus)}`}
              title={`Default branch CI: ${githubStatus.ciStatus.replace("_", " ")}`}
            />
          )}
          <a
            className="source-control-branch-name"
            href={githubStatus.repo.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {githubStatus.repo.owner}/{githubStatus.repo.repo}
          </a>
          <span className="git-panel-ahead-behind">
            {githubStatus.openIssues} issue{githubStatus.openIssues === 1 ? "" : "s"}
          </span>
        </div>
      )}
      <div className="source-control-actions">{openFull}</div>
      {prs &&
        (shown.length === 0 ? (
          <div className="github-panel-empty-row">No open pull requests</div>
        ) : (
          <div className="github-panel-section">
            {shown.map((pr) => (
              <a
                key={pr.number}
                className="github-panel-row"
                href={pr.htmlUrl}
                target="_blank"
                rel="noreferrer noopener"
                title={`${pr.title} (${pr.headBranch} → ${pr.baseBranch})`}
              >
                {pr.ciStatus && (
                  <span className={`github-panel-ci-dot ${ciDotClass(pr.ciStatus)}`} />
                )}
                <span className="github-panel-row-number">#{pr.number}</span>
                <span className="github-panel-row-title">{pr.title}</span>
              </a>
            ))}
            {hidden > 0 && <div className="github-panel-empty-row">+{hidden} more</div>}
          </div>
        ))}
    </div>
  );
}
