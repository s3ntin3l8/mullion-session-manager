import type { ComponentType, CSSProperties } from "react";
import {
  DockIcon,
  FileTextIcon,
  GitBranchIcon,
  GitHubIcon,
  GlobeIcon,
  RightSidebarIcon,
  SkillIcon,
} from "./ui/icons.js";

type CommandIcon = ComponentType<{ size?: number; style?: CSSProperties }>;

// The command palette's non-launcher entries ("Integrations"): fixed
// navigation actions, as plain data so CommandPalette renders them with one
// row component and useCommandSearch can match them against a query.
export interface PaletteCommand {
  id: string;
  title: string;
  subtitle: string;
  icon: CommandIcon;
  // Matched alongside `title` (never `subtitle`) — kept conservative so a
  // command never outranks a launcher for a name like "claude".
  keywords: string[];
  // Where it shows on an empty query: the top-level Integrations list, or
  // the "Project ›" drill-in list.
  placement: "top" | "project";
  // Set on the "Project ›" row: Enter/click opens that sub-list instead of
  // running anything, and it is not itself a search result (its sub-items
  // are, directly).
  drillIn?: "project";
  // Shown before the title in a search result ("Project › Skills") so a
  // sub-item reads in context once it leaves its sub-list.
  breadcrumb?: string;
  run: () => void;
}

export interface PaletteCommandOpeners {
  github: (projectId: number) => void;
  git: (projectId: number) => void;
  agentRules: (projectId: number) => void;
  fileEditor: (projectId: number) => void;
  externalFile: (projectId: number) => void;
  projectBriefing: (projectId: number) => void;
  projectSetup: (projectId: number) => void;
  dockConfig: (projectId: number) => void;
  skills: (projectId: number) => void;
  browser: (projectId: number) => void;
  browserUrl: (projectId: number, url: string, label: string) => void;
  integrationsSettings: () => void;
  blankBrowser: () => void;
  // Absent where there is no right sidebar (phone) — the command is then
  // omitted rather than shown dead.
  toggleRightSidebar?: () => void;
}

export interface PaletteCommandContext {
  projectId: number | null;
  projectName: string | null;
  favoriteUrls: { id: number | string; url: string; label: string }[];
  open: PaletteCommandOpeners;
}

export function buildPaletteCommands({
  projectId,
  projectName,
  favoriteUrls,
  open,
}: PaletteCommandContext): PaletteCommand[] {
  const name = projectName ?? "this project";
  const commands: PaletteCommand[] = [];

  if (projectId !== null) {
    const id = projectId;
    commands.push(
      {
        id: "github",
        title: "GitHub",
        subtitle: "Open issues, pull requests, and status",
        icon: GitHubIcon,
        keywords: ["github", "issues", "pull requests", "prs", "ci"],
        placement: "top",
        run: () => open.github(id),
      },
      {
        id: "git",
        title: "Git",
        subtitle: "Branch, status, and changed files",
        icon: GitBranchIcon,
        keywords: ["git", "branch", "changes", "diff"],
        placement: "top",
        run: () => open.git(id),
      },
      {
        id: "project",
        title: `Project: ${name}`,
        subtitle: "Agent rules, briefing, scaffold, dock, skills, files",
        icon: FileTextIcon,
        keywords: [],
        placement: "top",
        drillIn: "project",
        run: () => {},
      },
      {
        id: "agent-rules",
        title: "Agent Rules",
        subtitle: "CLAUDE.md, AGENTS.md, GEMINI.md",
        icon: FileTextIcon,
        keywords: ["agent rules", "rules", "agents.md"],
        placement: "project",
        breadcrumb: "Project",
        run: () => open.agentRules(id),
      },
      {
        id: "project-briefing",
        title: "Mullion Briefing",
        subtitle: "DB-authored — pushed on top of whatever AGENTS.md already says",
        icon: FileTextIcon,
        keywords: ["briefing"],
        placement: "project",
        breadcrumb: "Project",
        run: () => open.projectBriefing(id),
      },
      {
        id: "project-setup",
        title: "Scaffold Mullion",
        subtitle: "Commit a briefing region, skill, and reviewer subagent as a PR",
        icon: FileTextIcon,
        keywords: ["scaffold", "setup"],
        placement: "project",
        breadcrumb: "Project",
        run: () => open.projectSetup(id),
      },
      {
        id: "dock-config",
        title: "Dock",
        subtitle: "Edit this project's dock monitors",
        icon: DockIcon,
        keywords: ["dock", "monitors"],
        placement: "project",
        breadcrumb: "Project",
        run: () => open.dockConfig(id),
      },
      {
        id: "skills",
        title: "Skills",
        subtitle: "Discovered skills across every agent",
        icon: SkillIcon,
        keywords: ["skills"],
        placement: "project",
        breadcrumb: "Project",
        run: () => open.skills(id),
      },
      {
        id: "file-editor",
        title: "Edit project files",
        subtitle: "Browse and edit in the Files sidebar",
        icon: FileTextIcon,
        keywords: ["files", "edit", ".env"],
        placement: "project",
        breadcrumb: "Project",
        run: () => open.fileEditor(id),
      },
      {
        id: "external-file",
        title: "Open file by path",
        subtitle: "View an agent's plan or other readable file outside the project",
        icon: FileTextIcon,
        keywords: ["open", "path", "plan", "file", "external", "~/"],
        placement: "project",
        breadcrumb: "Project",
        run: () => open.externalFile(id),
      },
      {
        id: "preview",
        title: "Preview",
        subtitle: "Open this project's dev server",
        icon: GlobeIcon,
        keywords: ["preview", "dev server", "browser"],
        placement: "top",
        run: () => open.browser(id),
      },
      ...favoriteUrls.map((u): PaletteCommand => ({
        id: `url-${u.id}`,
        title: u.label,
        subtitle: u.url,
        icon: GlobeIcon,
        keywords: [u.label, u.url],
        placement: "top",
        run: () => open.browserUrl(id, u.url, u.label),
      })),
    );
  }

  if (open.toggleRightSidebar) {
    const toggle = open.toggleRightSidebar;
    commands.push({
      id: "toggle-right-sidebar",
      title: "Toggle right sidebar",
      subtitle: "Show or hide the right sidebar (Ctrl/Cmd+Alt+B)",
      icon: RightSidebarIcon,
      keywords: ["sidebar", "right", "drawer", "panel"],
      placement: "top",
      run: toggle,
    });
  }

  commands.push(
    {
      id: "integrations-settings",
      title: "Manage integrations…",
      subtitle: "Settings → Integrations",
      icon: GitHubIcon,
      keywords: ["integrations", "settings"],
      placement: "top",
      run: () => open.integrationsSettings(),
    },
    {
      id: "blank-browser",
      title: "New preview tab",
      subtitle: "Embed any external site — type an address directly",
      icon: GlobeIcon,
      keywords: ["preview", "browser", "website"],
      placement: "top",
      run: () => open.blankBrowser(),
    },
  );

  return commands;
}

// What a non-empty query can find: every command (top-level and project
// sub-items alike) except the drill-in row itself.
export function searchPaletteCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return commands.filter(
    (c) =>
      !c.drillIn &&
      [c.title, ...c.keywords, c.breadcrumb ? `${c.breadcrumb} ${c.title}` : null].some(
        (field) => field != null && field.toLowerCase().includes(q),
      ),
  );
}
