import type { ComponentType, CSSProperties } from "react";
import {
  CheckIcon,
  DeviceIcon,
  DockIcon,
  FileTextIcon,
  GearIcon,
  GitBranchIcon,
  GitHubIcon,
  GlobeIcon,
  HostsIcon,
  ListIcon,
  PlusIcon,
  RightSidebarIcon,
  SkillIcon,
} from "./ui/icons.js";
import { DOCK_UNAVAILABLE, type DockUnavailableReason } from "./lib/dockAvailability.js";
import type { Session } from "./api/index.js";

type CommandIcon = ComponentType<{ size?: number; style?: CSSProperties }>;

// The command palette's non-launcher entries: fixed actions, as plain data
// so CommandPalette renders them with one row component and useCommandSearch
// can match them against a query.
export interface PaletteCommand {
  id: string;
  title: string;
  subtitle: string;
  icon: CommandIcon;
  // Matched alongside `title` (never `subtitle`) — kept conservative so a
  // command never outranks a launcher for a name like "claude".
  keywords: string[];
  // Where it shows on an empty query: the top-level Commands list, or
  // the "Project ›" drill-in list.
  placement: "top" | "project";
  // Set when the command's effect cannot be seen on this device — the Dock
  // on a touch-only or phone-tier device (issue #1881). The row carries the
  // label in its own availability slot rather than in the subtitle, which is
  // ellipsized and too short to hold a reason.
  availability?: { label: string; reason: string };
  // Set on the "Project ›" row: Enter/click opens that sub-list instead of
  // running anything, and it is not itself a search result (its sub-items
  // are, directly).
  drillIn?: "project";
  // Shown before the title in a search result ("Project › Skills") so a
  // sub-item reads in context once it leaves its sub-list.
  breadcrumb?: string;
  // Enter/click calls `run`, then leaves the palette open so the search box
  // can collect one more input. "New workspace" needs a name; `run` starts
  // that step and the palette calls the same createWorkspace the sidebar
  // form does. A command with `prompt` still has a real `run` — the flag is
  // not a substitute for one.
  prompt?: "workspace-name";
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
  // The task board, Settings (the modal and two of its sections), and the
  // active session's timeline. Optional so a caller that doesn't own that
  // surface omits the row instead of showing one that does nothing — same
  // shape as toggleRightSidebar. App.tsx passes the same openSettings /
  // onOpenTimeline the rest of the UI uses.
  tasks?: () => void;
  devices?: () => void;
  hosts?: () => void;
  settings?: () => void;
  timeline?: (session: Session) => void;
  // "New workspace". `.run()` starts the palette's name step, so a caller
  // that invokes the command directly does not miss it. The `prompt` flag
  // only tells the palette to stay open while the name is typed — it is not
  // the behaviour itself.
  newWorkspace: () => void;
}

export interface PaletteCommandContext {
  projectId: number | null;
  projectName: string | null;
  favoriteUrls: { id: number | string; url: string; label: string }[];
  open: PaletteCommandOpeners;
  // Why the Dock cannot be shown on this device, or null when it can (issue
  // #1881). The Dock is hidden by two rules — a coarse pointer and the
  // phone tier — so this is the shared predicate's answer, not a pointer
  // test; see lib/dockAvailability.ts.
  dockUnavailable: DockUnavailableReason | null;
  // The session whose pane is active, if any. The timeline command is the
  // pane menu's "View timeline" for that session, so it is omitted when
  // there isn't one — the menu only offers the item on a session pane.
  activeSession?: Session | null;
}

export function buildPaletteCommands({
  projectId,
  projectName,
  favoriteUrls,
  open,
  dockUnavailable,
  activeSession,
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
        // The Dock is hidden on touch-only and phone-tier devices. The
        // command still works — it edits the project's `.crs/dock.json`,
        // which applies wherever the Dock IS shown — but a user who cannot
        // see the Dock deserves to be told why, here, where they decide to
        // run it (issue #1881). The reason rides in the row's own
        // availability slot: the subtitle is ellipsized, and a reason does
        // not survive being cut off mid-word.
        subtitle: "Edit this project's dock monitors",
        availability: dockUnavailable
          ? {
              label: DOCK_UNAVAILABLE[dockUnavailable].short,
              reason: DOCK_UNAVAILABLE[dockUnavailable].text,
            }
          : undefined,
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
    {
      // Same create-then-switch as WorkspaceSwitcher's inline form. The
      // palette collects the name (prompt) because that form is the only
      // other way to supply one — there is no default name to invent.
      id: "new-workspace",
      title: "New workspace",
      subtitle: "Create a workspace and switch to it",
      icon: PlusIcon,
      keywords: ["workspace", "new", "create"],
      placement: "top",
      prompt: "workspace-name",
      run: () => open.newWorkspace(),
    },
  );

  if (open.tasks) {
    const openTasks = open.tasks;
    commands.push({
      id: "task-board",
      title: "Task board",
      subtitle: "Every project's tasks, in one board",
      icon: CheckIcon,
      keywords: ["tasks", "kanban", "board"],
      placement: "top",
      run: openTasks,
    });
  }

  if (open.devices) {
    const openDevices = open.devices;
    commands.push({
      id: "devices",
      title: "Devices",
      subtitle: "Settings → Devices",
      icon: DeviceIcon,
      keywords: ["devices", "android", "emulator"],
      placement: "top",
      run: openDevices,
    });
  }

  if (open.hosts) {
    const openHosts = open.hosts;
    commands.push({
      id: "hosts",
      title: "Hosts",
      subtitle: "Settings → Hosts",
      icon: HostsIcon,
      keywords: ["hosts", "ssh", "bridge", "remote"],
      placement: "top",
      run: openHosts,
    });
  }

  if (open.settings) {
    const openSettings = open.settings;
    commands.push({
      id: "settings",
      title: "Settings",
      subtitle: "Open settings",
      icon: GearIcon,
      keywords: ["settings", "preferences"],
      placement: "top",
      run: openSettings,
    });
  }

  if (open.timeline && activeSession) {
    const openTimeline = open.timeline;
    const session = activeSession;
    const label = session.name || session.lastTitle || session.command;
    commands.push({
      id: "session-timeline",
      title: "Session timeline",
      subtitle: label,
      icon: ListIcon,
      keywords: ["timeline", "events", "history", label],
      placement: "top",
      run: () => openTimeline(session),
    });
  }

  // Within each placement the row order is the title. Callers render one
  // group per placement, so sorting the whole list sorts each group.
  commands.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

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
