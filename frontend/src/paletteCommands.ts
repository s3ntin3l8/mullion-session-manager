import type { SettingsSection } from "./settings/settingsSections.js";
import type { ComponentType, CSSProperties } from "react";
import {
  BotIcon,
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
  PinIcon,
  PlusIcon,
  RightSidebarIcon,
  SkillIcon,
} from "./ui/icons.js";
import { DOCK_UNAVAILABLE, type DockUnavailableReason } from "./lib/dockAvailability.js";
import type { Session } from "./api/index.js";
import { sessionPaneTitle } from "./lib/sessionDisplay.js";
import type { SessionTitleContext } from "./lib/sessionDisplay.js";

type CommandIcon = ComponentType<{ size?: number; style?: CSSProperties }>;

// The command palette's non-launcher entries: fixed actions, as plain data
// so CommandPalette renders them with one row component and useCommandSearch
// can match them against a query.
export interface PaletteCommand {
  id: string;
  // The opener takes focus itself after the palette closes — Settings' trap,
  // a blank preview's address bar, the external-file path field. The palette
  // derives its suppress-restore set from this flag, so a command that
  // autofocuses cannot be added without being included.
  movesFocus?: boolean;
  title: string;
  subtitle: string;
  icon: CommandIcon;
  // Matched alongside `title` (never `subtitle`) — kept conservative so a
  // command never outranks a launcher for a name like "claude".
  keywords: string[];
  // Where it shows on an empty query. The rule: the default list is the
  // create actions and the top-level destinations, the same on every layout
  // tier (`top`, in the order of TOP_ORDER); the "Project ›" drill-in holds
  // the project's own editors (`project`); anything parameterised or rare
  // (one row per PR / branch / URL, GitHub, Devices, Hosts, …) is `search`:
  // never listed on an empty query, only found by typing.
  placement: "top" | "project" | "search";
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
  // A command that takes a number typed in the search box ("queue 42").
  // `searchPaletteCommands` builds the concrete row from the match; the
  // template itself is never a result.
  parametric?: { pattern: RegExp; build: (n: number) => PaletteCommand };
  run: () => void;
}

export interface PaletteCommandOpeners {
  github: (projectId: number) => void;
  agentRules: (projectId: number) => void;
  fileEditor: (projectId: number) => void;
  externalFile: (projectId: number) => void;
  projectBriefing: (projectId: number) => void;
  projectSetup: (projectId: number) => void;
  dockConfig: (projectId: number) => void;
  skills: (projectId: number) => void;
  browser: (projectId: number) => void;
  browserUrl: (projectId: number, url: string, label: string) => void;
  settingsSection: (section: SettingsSection) => void;
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
  // The pane menu's "Open browser" for the active session: the
  // session's server-side browser, the one its agent drives (#3215).
  // CommandPalette decides where it opens (a grid pane, or the right
  // sidebar's Browser view in the companion bands).
  agentBrowser?: (session: Session) => void;
  // "New workspace". `.run()` starts the palette's name step, so a caller
  // that invokes the command directly does not miss it. The `prompt` flag
  // only tells the palette to stay open while the name is typed — it is not
  // the behaviour itself.
  newWorkspace: () => void;
  // #3069 — "New session…": opens the launcher on the palette's project.
  // Optional like the rows above: a caller without a launcher omits it.
  newSession?: () => void;
  // Source Control / GitHub deep links. All take the palette's project.
  goToPr: (projectId: number, number: number) => void;
  openSessionOnBranch: (projectId: number, branch: string) => void;
  queueIssue: (projectId: number, number: number) => void;
  prune: (projectId: number) => void;
  // #3537 — pins the palette's project to the active workspace, or unpins it.
  // Optional: omitted where the sidebar is not workspace-scoped (phone).
  toggleWorkspacePin?: (projectId: number) => void;
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
  // False when the server's browser feature is off, so the "Browser" row falls
  // back to the project's preview targets. Defaults to on.
  browserFeature?: boolean;
  // The session whose pane is active, if any. The timeline command is the
  // pane menu's "View timeline" for that session, so it is omitted when
  // there isn't one — the menu only offers the item on a session pane.
  activeSession?: Session | null;
  // The active session's task title and number (#3285), so its commands
  // name it the way the sidebar does.
  activeSessionTitleContext?: SessionTitleContext;
  // The project's open PRs and local branch names, for the search-only
  // "Go to PR" / "Open session on branch" rows. Empty until loaded.
  prs?: { number: number; title: string }[];
  branches?: string[];
  // #3537 — whether the palette's project is pinned to the active workspace;
  // null (or absent) leaves the pin command out.
  workspacePinned?: boolean | null;
}

// The empty-query list: two groups, in this order. `id`s of the `top` rows.
export const PALETTE_CREATE_IDS = ["new-session", "new-workspace"] as const;
export const PALETTE_GO_TO_IDS = ["task-board", "browser", "project", "settings"] as const;
const TOP_ORDER: readonly string[] = [...PALETTE_CREATE_IDS, ...PALETTE_GO_TO_IDS];

export function buildPaletteCommands({
  projectId,
  projectName,
  favoriteUrls,
  open,
  dockUnavailable,
  browserFeature = true,
  activeSession,
  activeSessionTitleContext,
  prs = [],
  branches = [],
  workspacePinned = null,
}: PaletteCommandContext): PaletteCommand[] {
  const name = projectName ?? "this project";
  const commands: PaletteCommand[] = [];

  // #3069 — the sort below keeps it first, so it leads the blank view and
  // ⌘K then Enter opens the launcher. The palette lists no agent, shell or
  // script until one is typed.
  if (open.newSession) {
    const newSession = open.newSession;
    commands.push({
      id: "new-session",
      title: "New session…",
      subtitle: "Choose an agent, shell or script",
      icon: PlusIcon,
      keywords: ["new session", "launch", "start", "agent", "shell", "terminal"],
      placement: "top",
      run: () => newSession(),
    });
  }

  if (projectId !== null) {
    const id = projectId;
    commands.push(
      {
        id: "github",
        title: "GitHub",
        subtitle: "Open issues, pull requests, and status",
        icon: GitHubIcon,
        keywords: ["github", "issues", "pull requests", "prs", "ci"],
        placement: "search",
        run: () => open.github(id),
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
      ...(open.toggleWorkspacePin && workspacePinned != null
        ? [
            {
              id: "workspace-pin",
              title: workspacePinned ? "Unpin from this workspace" : "Pin to this workspace",
              subtitle: workspacePinned
                ? "Stop keeping it in this workspace's sidebar"
                : "Keep it in this workspace's sidebar with nothing tiled",
              icon: PinIcon,
              keywords: ["pin", "unpin", "workspace", "sidebar"],
              placement: "project" as const,
              breadcrumb: "Project",
              run: () => open.toggleWorkspacePin?.(id),
            },
          ]
        : []),
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
        movesFocus: true,
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
        movesFocus: true,
        // #3215/#3374: the preview rows say "preview" or the saved label; only the
        // session's row says "agent's browser".
        title: "Open browser: preview…",
        subtitle: "Choose a preview target for this project",
        icon: GlobeIcon,
        keywords: ["preview", "preview browser", "open preview browser", "dev server", "browser"],
        placement: "search",
        run: () => open.browser(id),
      },
      // Both deep-link into the right sidebar, so they are omitted where
      // there is none (phone) — same gate as the toggle command.
      ...(open.toggleRightSidebar
        ? [
            {
              id: "prune-merged",
              title: "Prune merged branches",
              subtitle: "Preview and delete branches already merged",
              icon: GitBranchIcon,
              keywords: ["prune", "merged", "branches", "delete", "cleanup"],
              placement: "search",
              run: () => open.prune(id),
            } satisfies PaletteCommand,
          ]
        : []),
      ...(open.toggleRightSidebar ? prs : []).map((pr): PaletteCommand => ({
        id: `go-to-pr-${pr.number}`,
        title: `Go to PR #${pr.number}: ${pr.title}`,
        subtitle: "Open the pull request in the GitHub sidebar",
        icon: GitHubIcon,
        keywords: [`pr ${pr.number}`, `pr #${pr.number}`, `#${pr.number}`, `go to pr`],
        placement: "search",
        run: () => open.goToPr(id, pr.number),
      })),
      ...branches.map((branch): PaletteCommand => ({
        id: `session-on-${branch}`,
        title: `Open session on branch ${branch}`,
        subtitle: "Start the default agent in a worktree for this branch",
        icon: GitBranchIcon,
        keywords: ["open session", "session on branch", branch],
        placement: "search",
        run: () => open.openSessionOnBranch(id, branch),
      })),
      {
        id: "queue-issue",
        title: "Queue issue for Task Master",
        subtitle: "Type “queue 42” to label issue #42",
        icon: CheckIcon,
        keywords: [],
        placement: "search",
        parametric: {
          pattern: /^queue\s+#?(\d+)$/i,
          build: (n) => ({
            id: `queue-issue-${n}`,
            title: `Queue issue #${n} for Task Master`,
            subtitle: "Adds the Task Master label to the issue",
            icon: CheckIcon,
            keywords: [],
            placement: "search",
            run: () => open.queueIssue(id, n),
          }),
        },
        run: () => {},
      },
      ...favoriteUrls.map((u): PaletteCommand => ({
        id: `url-${u.id}`,
        title: `Open browser: ${u.label}`,
        subtitle: u.url,
        icon: GlobeIcon,
        keywords: [u.label, u.url, "preview", `preview: ${u.label}`],
        placement: "search",
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
      placement: "search",
      run: toggle,
    });
  }

  commands.push(
    ...(
      [
        [
          "github",
          "GitHub settings",
          ["github", "account", "webhooks", "settings", "integrations"],
        ],
        ["review-relay", "Review relay", ["review relay", "hermes", "reviewer", "settings"]],
        ["runway", "Runway", ["runway", "quota", "settings"]],
      ] as const
    ).map(([section, title, keywords]): PaletteCommand => ({
      id: `settings-${section}`,
      movesFocus: true,
      title,
      subtitle: `Settings → ${title}`,
      icon: GearIcon,
      keywords: [...keywords],
      placement: "search",
      run: () => open.settingsSection(section),
    })),
    {
      id: "blank-browser",
      movesFocus: true,
      title: "Open browser: blank preview",
      subtitle: "Embed any external site — type an address directly",
      icon: GlobeIcon,
      // The old title, so a search learned from it still finds the row.
      keywords: ["preview", "browser", "website", "new preview tab", "new blank preview browser"],
      placement: "search",
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

  // The default list's one Browser row: the session's own browser when there
  // is an active session and the server's browser feature is on, otherwise
  // the project's preview targets. Both open the rail's Browser view below
  // 1100px (CommandPalette routes them).
  {
    const agentBrowser = open.agentBrowser;
    const session = activeSession;
    const browser: Pick<PaletteCommand, "id" | "title" | "icon" | "keywords" | "placement"> = {
      id: "browser",
      title: "Browser",
      icon: GlobeIcon,
      keywords: ["browser", "preview", "web"],
      placement: "top",
    };
    if (agentBrowser && session && browserFeature) {
      commands.push({
        ...browser,
        subtitle: "The browser this session's agent drives",
        run: () => agentBrowser(session),
      });
    } else if (projectId !== null) {
      const id = projectId;
      commands.push({
        ...browser,
        movesFocus: true,
        subtitle: "Open a preview of this project",
        run: () => open.browser(id),
      });
    }
  }

  if (open.devices) {
    const openDevices = open.devices;
    commands.push({
      id: "devices",
      movesFocus: true,
      title: "Devices",
      subtitle: "Settings → Devices",
      icon: DeviceIcon,
      keywords: ["devices", "android", "emulator"],
      placement: "search",
      run: openDevices,
    });
  }

  if (open.hosts) {
    const openHosts = open.hosts;
    commands.push({
      id: "hosts",
      movesFocus: true,
      title: "Hosts",
      subtitle: "Settings → Hosts",
      icon: HostsIcon,
      keywords: ["hosts", "ssh", "bridge", "remote"],
      placement: "search",
      run: openHosts,
    });
  }

  if (open.settings) {
    const openSettings = open.settings;
    commands.push({
      id: "settings",
      movesFocus: true,
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
    const label = sessionPaneTitle(session, activeSessionTitleContext);
    commands.push({
      id: "session-timeline",
      title: "Session timeline",
      subtitle: label,
      icon: ListIcon,
      keywords: ["timeline", "events", "history", label],
      placement: "search",
      run: () => openTimeline(session),
    });
  }

  if (open.agentBrowser && activeSession) {
    const openAgentBrowser = open.agentBrowser;
    const session = activeSession;
    // The same rule as the pane it opens (openBrowserPanePanel) and the
    // timeline row above: a session's tab title.
    const label = sessionPaneTitle(session, activeSessionTitleContext);
    commands.push({
      id: "agent-browser",
      title: `Open browser: agent's browser · ${label}`,
      subtitle: "The browser this session's agent drives",
      icon: BotIcon,
      keywords: ["agent browser", "open agent browser", "browser", "automation", label],
      placement: "search",
      run: () => openAgentBrowser(session),
    });
  }

  // The default list's order is declared, not derived from titles. Rows of
  // the other placements keep the title order (the "Project ›" drill-in list).
  const rank = (c: PaletteCommand) => {
    const at = TOP_ORDER.indexOf(c.id);
    return c.placement === "top" && at >= 0 ? at : TOP_ORDER.length;
  };
  commands.sort(
    (a, b) =>
      rank(a) - rank(b) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );

  return commands;
}

// What a non-empty query can find: every command (top-level and project
// sub-items alike) except the drill-in row itself.
export function searchPaletteCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const typed = commands.flatMap((c) => {
    const m = c.parametric?.pattern.exec(q);
    return m ? [c.parametric!.build(Number.parseInt(m[1], 10))] : [];
  });
  const matched = commands.filter(
    (c) =>
      !c.drillIn &&
      !c.parametric &&
      [c.title, ...c.keywords, c.breadcrumb ? `${c.breadcrumb} ${c.title}` : null].some(
        (field) => field != null && field.toLowerCase().includes(q),
      ),
  );
  return [...typed, ...matched];
}
