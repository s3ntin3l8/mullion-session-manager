import type { ComponentType, SVGProps } from "react";
import { useDashboardStore } from "../store/index.js";
import { needsYouTasks } from "../github/taskMasterSummary.js";
import { ATTENTION_ORDER, PHASE_LABEL, attentionSummary } from "../github/prPhase.js";
import {
  FolderIcon,
  GitBranchIcon,
  GitHubIcon,
  GearIcon,
  HistoryIcon,
  ListIcon,
} from "../ui/icons.js";
import { FilesSidebarView } from "./FilesSidebarView.js";
import { GitHubSidebarView } from "./GitHubSidebarView.js";
import { GitSidebarView } from "./GitSidebarView.js";
import { HistorySidebarView } from "./HistorySidebarView.js";
import { ProjectSidebarView } from "./ProjectSidebarView.js";
import { TasksSidebarView } from "./TasksSidebarView.js";

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
  onOpenFile: (projectId: number, path: string, sessionId?: number) => void;
  onOpenAgentRules: (projectId: number) => void;
  onOpenProjectBriefing: (projectId: number) => void;
  onOpenProjectSetup: (projectId: number) => void;
  onOpenDockConfig: (projectId: number) => void;
  onOpenSkills: (projectId: number) => void;
  onOpenTasks: () => void;
}

export interface RightSidebarViewProps {
  projectId: number;
  /** The session whose own checkout (a git worktree) the focused panel is in,
   * when that differs from the project's — null otherwise. Only views that
   * browse files care. */
  checkoutSessionId?: number | null;
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
  // Whether the rail shows this view at all (same hook-per-button rule as
  // useBadge). `useAlwaysEnabled` for the views that are always there.
  useEnabled: () => boolean;
}

export function useNoBadge(): RailBadge | null {
  return null;
}

export function useAlwaysEnabled(): boolean {
  return true;
}

function useTaskMasterEnabled(): boolean {
  return useDashboardStore((s) => s.taskMasterEnabled);
}

// Tasks that want a human (failed, awaiting approval, a merge/release error)
// for the followed project. Archived tasks never count.
function useTasksBadge(projectId: number | null): RailBadge | null {
  const tasks = useDashboardStore((s) => s.tasks);
  if (projectId == null) return null;
  const n = needsYouTasks(tasks.filter((t) => t.projectId === projectId)).length;
  if (n === 0) return null;
  return {
    kind: "count",
    value: n,
    title: `${n} task${n === 1 ? "" : "s"} ${n === 1 ? "needs" : "need"} you`,
  };
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

// PRs that want the user (failing CI, requested changes, conflicts, unresolved
// conversations, a head behind its base — by phase, not just red CI) and a red default branch both
// come straight from the live store (prsByProject from the /ws/github push,
// defaultBranchCiByProject from the poller via the same refreshGitRefs
// batch), so the badge costs no extra requests.
function useGitHubBadge(projectId: number | null): RailBadge | null {
  const prs = useDashboardStore((s) =>
    projectId != null ? s.prsByProject[projectId]?.prs : undefined,
  );
  const defaultBranchFailing = useDashboardStore((s) =>
    projectId != null ? s.defaultBranchCiByProject[projectId] === "failure" : false,
  );
  const { total, byPhase } = attentionSummary(prs ?? []);
  if (total === 0 && !defaultBranchFailing) return null;
  const reasons: string[] = [];
  for (const phase of ATTENTION_ORDER) {
    const n = byPhase[phase];
    if (n) reasons.push(`${n} PR${n === 1 ? "" : "s"}: ${PHASE_LABEL[phase].toLowerCase()}`);
  }
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
    useEnabled: useAlwaysEnabled,
  },
  {
    id: "history",
    label: "History",
    icon: HistoryIcon,
    Component: HistorySidebarView,
    useBadge: useNoBadge,
    useEnabled: useAlwaysEnabled,
  },
  {
    id: "github",
    label: "GitHub",
    icon: GitHubIcon,
    Component: GitHubSidebarView,
    useBadge: useGitHubBadge,
    useEnabled: useAlwaysEnabled,
  },
  {
    id: "tasks",
    label: "Tasks",
    icon: ListIcon,
    Component: TasksSidebarView,
    useBadge: useTasksBadge,
    useEnabled: useTaskMasterEnabled,
  },
  {
    id: "files",
    label: "Files",
    icon: FolderIcon,
    Component: FilesSidebarView,
    useBadge: useNoBadge,
    useEnabled: useAlwaysEnabled,
  },
  {
    id: "project",
    label: "Project",
    icon: GearIcon,
    Component: ProjectSidebarView,
    useBadge: useNoBadge,
    useEnabled: useAlwaysEnabled,
  },
];
