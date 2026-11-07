// The right sidebar's registry: one entry per view, in rail order.
//
// Adding a view is one entry here.
//
// It lives apart from views.ts (which holds the shared TYPES) because it
// imports the view components themselves, and every one of those imports
// its props type back from views.ts — the barrel and its members importing
// each other was an import cycle (issue #2414).

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
import {
  useAlwaysEnabled,
  useGitBadge,
  useGitHubBadge,
  useNoBadge,
  useTaskMasterEnabled,
  useTasksBadge,
} from "./views-badges.js";
import type { RightSidebarView } from "./views.js";

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
