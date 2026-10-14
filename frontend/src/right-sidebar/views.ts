import type { ComponentType, SVGProps } from "react";
import { useDashboardStore } from "../store/index.js";
import { FolderIcon, GitBranchIcon, GitHubIcon } from "../ui/icons.js";
import { FilesSidebarView } from "./FilesSidebarView.js";
import { GitHubSidebarView } from "./GitHubSidebarView.js";
import { GitSidebarView } from "./GitSidebarView.js";

type ViewIconProps = SVGProps<SVGSVGElement> & { size?: number };

// A count badge (changed files) or an attention badge (conflicts, failing
// CI). `title` is the rail button's tooltip suffix / the badge's a11y label.
export type RailBadge =
  { kind: "count"; value: number; title: string } | { kind: "alert"; title: string };

// Openers a view's "open the full panel" affordance calls — passed down from
// App.tsx so the sidebar never imports panel-opening machinery itself.
export interface RightSidebarActions {
  onOpenGit: (projectId: number) => void;
  onOpenGitHub: (projectId: number) => void;
  onOpenFileEditor: (projectId: number) => void;
  onOpenFile: (projectId: number, path: string) => void;
}

export interface RightSidebarViewProps {
  projectId: number;
  actions: RightSidebarActions;
}

export interface RightSidebarView {
  id: string;
  label: string;
  icon: ComponentType<ViewIconProps>;
  Component: ComponentType<RightSidebarViewProps>;
  // A hook (called once per rail button, so each view's subscription lives
  // in its own component — looping hooks in the parent would break the rules
  // of hooks). Required (use `useNoBadge`) so the rail never has to call a
  // hook conditionally. `null` means no badge.
  useBadge: (projectId: number | null) => RailBadge | null;
}

export function useNoBadge(): RailBadge | null {
  return null;
}

function useGitBadge(projectId: number | null): RailBadge | null {
  const status = useDashboardStore((s) => (projectId != null ? s.gitStatuses[projectId] : null));
  if (!status) return null;
  if (status.hasConflicts) return { kind: "alert", title: "Unresolved merge conflicts" };
  if (status.files.length > 0) {
    return {
      kind: "count",
      value: status.files.length,
      title: `${status.files.length} changed file${status.files.length === 1 ? "" : "s"}`,
    };
  }
  return null;
}

// Failing PR checks and a red default branch both come straight from the live
// store (prsByProject from the /ws/github push, defaultBranchCiByProject from
// the poller via the same refreshGitRefs batch), so the badge costs no extra
// requests.
function useGitHubBadge(projectId: number | null): RailBadge | null {
  const failing = useDashboardStore((s) =>
    projectId != null ? (s.prsByProject[projectId]?.prSummary.fail ?? 0) : 0,
  );
  const defaultBranchFailing = useDashboardStore((s) =>
    projectId != null ? s.defaultBranchCiByProject[projectId] === "failure" : false,
  );
  if (failing === 0 && !defaultBranchFailing) return null;
  const reasons: string[] = [];
  if (failing > 0) reasons.push(`${failing} PR check${failing === 1 ? "" : "s"} failing`);
  if (defaultBranchFailing) reasons.push("default branch CI failing");
  return { kind: "alert", title: reasons.join(", ") };
}

// Registry — adding a view is one entry here.
export const RIGHT_SIDEBAR_VIEWS: RightSidebarView[] = [
  {
    id: "git",
    label: "Git",
    icon: GitBranchIcon,
    Component: GitSidebarView,
    useBadge: useGitBadge,
  },
  {
    id: "github",
    label: "GitHub",
    icon: GitHubIcon,
    Component: GitHubSidebarView,
    useBadge: useGitHubBadge,
  },
  {
    id: "files",
    label: "Files",
    icon: FolderIcon,
    Component: FilesSidebarView,
    useBadge: useNoBadge,
  },
];
