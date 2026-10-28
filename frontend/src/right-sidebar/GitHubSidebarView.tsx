import { GitHubPanel } from "../GitHubPanel.js";
import { SidebarToolbar } from "./SidebarToolbar.js";
import { PopOutIcon } from "../ui/icons.js";
import type { RightSidebarViewProps } from "./views.js";

// The real GitHub panel, embedded — one source of truth for PRs, checks,
// issues and releases. The toolbar's last button pops it out as a full panel.
export function GitHubSidebarView({ projectId, actions }: RightSidebarViewProps) {
  return (
    <div className="github-sidebar-view">
      <SidebarToolbar
        actions={[
          {
            key: "open-panel",
            label: "Open GitHub panel",
            icon: PopOutIcon,
            onClick: () => actions.onOpenGitHub(projectId),
          },
        ]}
      />
      <GitHubPanel key={projectId} params={{ projectId }} embedded />
    </div>
  );
}
