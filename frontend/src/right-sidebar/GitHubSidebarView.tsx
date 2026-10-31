import { useState } from "react";
import { GitHubPanel } from "../GitHubPanel.js";
import { SidebarHeader } from "./SidebarHeader.js";
import { TaskMasterSection } from "./TaskMasterSection.js";
import { usePrList } from "../hooks/useGitHubData.js";
import { useDashboardStore } from "../store/index.js";
import { RefreshIcon } from "../ui/icons.js";
import { ExternalLinkOwnedContext } from "../ui/sidebar/index.js";
import type { RightSidebarViewProps } from "./views.js";

// The real GitHub panel, embedded — one source of truth for PRs, checks,
// issues and releases. Refresh is the one primary action; the GitHub link for
// whatever is showing and pop-out to a full dock panel sit behind the ⋯ menu.
export function GitHubSidebarView({ projectId, actions }: RightSidebarViewProps) {
  const [link, setLink] = useState<{ url: string; label: string } | null>(null);
  // The same list the panel renders (the live store wins over the cached fetch).
  const prCount = usePrList(projectId)?.prs.length ?? 0;
  return (
    <div className="github-sidebar-view">
      <SidebarHeader
        label="GitHub"
        context={prCount > 0 ? `${prCount} open PR${prCount === 1 ? "" : "s"}` : undefined}
        actions={[
          {
            key: "refresh",
            label: "Refresh",
            icon: RefreshIcon,
            onClick: () => useDashboardStore.getState().refreshGithubProject(projectId),
          },
        ]}
        overflow={[
          {
            key: "open-on-github",
            label: link?.label ?? "Open on GitHub",
            disabled: link === null,
            onClick: () => {
              if (link) window.open(link.url, "_blank", "noopener,noreferrer");
            },
          },
          {
            key: "open-panel",
            label: "Open GitHub panel",
            onClick: () => actions.onOpenGitHub(projectId),
          },
        ]}
      />
      <TaskMasterSection projectId={projectId} onOpenTasks={actions.onOpenTasks} />
      <ExternalLinkOwnedContext.Provider value={true}>
        {/* Keyed on the project: the panel's own state (the release row, the open
            PR) belongs to one repo and must not carry over to the next. */}
        <GitHubPanel key={projectId} params={{ projectId }} embedded onExternalLink={setLink} />
      </ExternalLinkOwnedContext.Provider>
    </div>
  );
}
