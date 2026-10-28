import { useState } from "react";
import { GitHubPanel } from "../GitHubPanel.js";
import { SidebarToolbar } from "./SidebarToolbar.js";
import { DockIcon, GitHubIcon } from "../ui/icons.js";
import { ExternalLinkOwnedContext } from "../ui/sidebar/index.js";
import type { RightSidebarViewProps } from "./views.js";

// The real GitHub panel, embedded — one source of truth for PRs, checks,
// issues and releases. The toolbar carries the two "open" actions: the GitHub
// link for whatever is showing, and pop-out to a full dock panel.
export function GitHubSidebarView({ projectId, actions }: RightSidebarViewProps) {
  const [link, setLink] = useState<{ url: string; label: string } | null>(null);
  return (
    <div className="github-sidebar-view">
      <SidebarToolbar
        actions={[
          {
            key: "open-on-github",
            label: link?.label ?? "Open on GitHub",
            icon: GitHubIcon,
            disabled: link === null,
            onClick: () => {
              if (link) window.open(link.url, "_blank", "noopener,noreferrer");
            },
          },
          {
            key: "open-panel",
            label: "Open GitHub panel",
            icon: DockIcon,
            onClick: () => actions.onOpenGitHub(projectId),
          },
        ]}
      />
      <ExternalLinkOwnedContext.Provider value={true}>
        {/* Keyed on the project: the panel's own state (the release row, the open
            PR) belongs to one repo and must not carry over to the next. */}
        <GitHubPanel key={projectId} params={{ projectId }} embedded onExternalLink={setLink} />
      </ExternalLinkOwnedContext.Provider>
    </div>
  );
}
