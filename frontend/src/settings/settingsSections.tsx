import type React from "react";
import {
  AccountIcon,
  AppearanceIcon,
  BellIcon,
  BoltIcon,
  BotIcon,
  DeviceIcon,
  DockIcon,
  FolderIcon,
  GitHubIcon,
  GlobeIcon,
  HostsIcon,
  KeyboardIcon,
  LayersIcon,
  ServerRackIcon,
  SkillIcon,
  TerminalPromptIcon,
} from "../ui/icons.js";

export type SettingsSection =
  | "account"
  | "appearance"
  | "terminal"
  | "input"
  | "notifications"
  | "sessions"
  | "launchers"
  | "agent-context"
  | "tasks"
  | "projects"
  | "dock"
  | "browser"
  | "devices"
  | "hosts"
  | "integrations"
  | "server";

// Section ids that were folded into another section. Still accepted as a
// deep link so an old `openSettings("models")` call lands on the section
// that now hosts that content instead of crashing on a missing entry.
const LEGACY_SECTION_ALIASES = {
  models: "launchers",
  skills: "agent-context",
} as const satisfies Record<string, SettingsSection>;

export type SettingsSectionLink = SettingsSection | keyof typeof LEGACY_SECTION_ALIASES;

export function resolveSettingsSection(id: SettingsSectionLink): SettingsSection {
  return id in LEGACY_SECTION_ALIASES
    ? LEGACY_SECTION_ALIASES[id as keyof typeof LEGACY_SECTION_ALIASES]
    : (id as SettingsSection);
}

type SettingsGroup = "Personal" | "Sessions & agents" | "Workspace" | "Connections" | "System";

// Nav order is this array's order; a group heading is rendered before the
// first section of each group.
export const SECTIONS: Array<{
  id: SettingsSection;
  group: SettingsGroup;
  title: string;
  desc: string;
  icon: (size: number) => React.ReactNode;
}> = [
  {
    id: "account",
    group: "Personal",
    title: "Account",
    desc: "Your authenticated identity and sign-out options.",
    icon: (size) => <AccountIcon size={size} />,
  },
  {
    id: "appearance",
    group: "Personal",
    title: "Appearance",
    desc: "Theme, sidebar density, and layout.",
    icon: (size) => <AppearanceIcon size={size} />,
  },
  {
    id: "terminal",
    group: "Personal",
    title: "Terminal",
    desc: "Fonts, colors, cursor, scrollback, and reconnect.",
    icon: (size) => <TerminalPromptIcon size={size} />,
  },
  {
    id: "input",
    group: "Personal",
    title: "Keyboard & input",
    desc: "Clipboard, key capture, and voice dictation.",
    icon: (size) => <KeyboardIcon size={size} />,
  },
  {
    id: "notifications",
    group: "Personal",
    title: "Notifications",
    desc: "Attention alerts and how they reach you.",
    icon: (size) => <BellIcon size={size} />,
  },
  {
    id: "sessions",
    group: "Sessions & agents",
    title: "Sessions",
    desc: "Naming, visibility, child sessions, and cleanup.",
    icon: (size) => <LayersIcon size={size} />,
  },
  {
    id: "launchers",
    group: "Sessions & agents",
    title: "Agents",
    desc: "Detected CLIs, launcher defaults, and opencode models.",
    icon: (size) => <BoltIcon size={size} />,
  },
  {
    id: "agent-context",
    group: "Sessions & agents",
    title: "Agent context & skills",
    desc: "What Mullion adds to every session's context, and installed skills.",
    icon: (size) => <SkillIcon size={size} />,
  },
  {
    id: "tasks",
    group: "Sessions & agents",
    title: "Task Master",
    desc: "Autonomous task claiming and its safety limits.",
    icon: (size) => <BotIcon size={size} />,
  },
  {
    id: "projects",
    group: "Workspace",
    title: "Projects",
    desc: "Where Mullion finds repositories, and how often it fetches them.",
    icon: (size) => <FolderIcon size={size} />,
  },
  {
    id: "dock",
    group: "Workspace",
    title: "Dock & previews",
    desc: "Preview worktrees, dev-server detection, and Docker services.",
    icon: (size) => <DockIcon size={size} />,
  },
  {
    id: "browser",
    group: "Workspace",
    title: "Browser",
    desc: "Sign-in cookies for a project's browser pane.",
    icon: (size) => <GlobeIcon size={size} />,
  },
  {
    id: "devices",
    group: "Workspace",
    title: "Devices",
    desc: "Android emulators and phones streamed into the dashboard.",
    icon: (size) => <DeviceIcon size={size} />,
  },
  {
    id: "hosts",
    group: "Connections",
    title: "Hosts & SSH bridges",
    desc: "Remote machines Mullion can run sessions on, and forwarded SSH agents.",
    icon: (size) => <HostsIcon size={size} />,
  },
  {
    id: "integrations",
    group: "Connections",
    title: "Integrations",
    desc: "GitHub account, webhooks, and GitHub Apps.",
    icon: (size) => <GitHubIcon size={size} />,
  },
  {
    id: "server",
    group: "System",
    title: "Server",
    desc: "Diagnostics, storage, and updates.",
    icon: (size) => <ServerRackIcon size={size} />,
  },
];

// A real (not cosmetic) filter over control labels — the nav rail's search
// box (ported from the reference's 1a nav) narrows to sections that
// actually contain a matching control, not just a section whose title
// matches. Kept as a flat static index rather than scraping the rendered
// DOM: simpler, and stays correct even for a section that isn't currently
// mounted.
export const SEARCH_INDEX: Array<{ section: SettingsSection; text: string }> = [
  { section: "account", text: "account identity username email authentication sign out logout" },
  { section: "appearance", text: "theme dark light system" },
  { section: "appearance", text: "sidebar density comfortable compact" },
  { section: "appearance", text: "layout auto phone tablet desktop foldable" },
  { section: "appearance", text: "tablet columns panes side by side" },
  { section: "terminal", text: "terminal font family geist jetbrains ibm plex sf mono menlo" },
  { section: "terminal", text: "font size" },
  { section: "terminal", text: "pane padding margin inset panel edge" },
  { section: "terminal", text: "color scheme tokyo night dracula solarized gruvbox one dark" },
  { section: "terminal", text: "cursor style block bar underline blink" },
  { section: "terminal", text: "scrollback lines history" },
  { section: "terminal", text: "auto reconnect drop" },
  { section: "input", text: "copy on select clipboard" },
  { section: "input", text: "allow programs set clipboard write osc 52" },
  { section: "input", text: "paste on right click" },
  { section: "input", text: "key conflict handling ctrl r l k reverse search clear kill line" },
  {
    section: "input",
    text: "clipboard shortcuts ctrl v paste ctrl c copy selection sigint insert",
  },
  {
    section: "input",
    text: "voice dictation microphone push to talk speech hotkey language",
  },
  { section: "notifications", text: "browser permission bell osc" },
  { section: "notifications", text: "delivery channels browser sound ping chime blip push" },
  { section: "notifications", text: "idle threshold" },
  { section: "notifications", text: "status notification matrix notify sound focus" },
  { section: "notifications", text: "auto focus on attention" },
  { section: "sessions", text: "new session name pattern agent project" },
  { section: "sessions", text: "confirm before kill" },
  { section: "sessions", text: "show exited killed ended sessions" },
  { section: "sessions", text: "show task sessions worker review" },
  { section: "sessions", text: "auto open child panels spawned subagent" },
  { section: "sessions", text: "max child sessions per parent spawn cap" },
  { section: "sessions", text: "auto reconcile interval" },
  { section: "sessions", text: "stale error busy timeout" },
  { section: "sessions", text: "event history persistence retention days cap" },
  { section: "launchers", text: "detected clis shells agents refresh" },
  { section: "launchers", text: "ai agents skip permissions status show hide" },
  { section: "launchers", text: "default shell" },
  { section: "launchers", text: "default agent" },
  { section: "launchers", text: "global launchers manage actions" },
  { section: "launchers", text: "opencode models implementer reviewer small model" },
  { section: "agent-context", text: "inject agent guide session start context" },
  { section: "agent-context", text: "inject project briefing pinned note" },
  { section: "agent-context", text: "workflow conventions wizard branching merge review policy" },
  { section: "agent-context", text: "mullion tooling bundle sync re-sync remove" },
  {
    section: "agent-context",
    text: "skills subagents slash commands claude codex opencode agy installed",
  },
  { section: "tasks", text: "task master enable autonomous claim board" },
  { section: "tasks", text: "pause auto-claim kill switch" },
  { section: "tasks", text: "max concurrent claims cap in flight" },
  { section: "tasks", text: "per-task budget minutes timeout" },
  { section: "tasks", text: "progress comment throttle github issue" },
  { section: "tasks", text: "review agent ci wait" },
  { section: "tasks", text: "skip permissions unattended spawns" },
  { section: "tasks", text: "reset to environment server defaults" },
  { section: "tasks", text: "issue label poll interval deploy-time" },
  { section: "tasks", text: "default agent default review agent per-project" },
  { section: "projects", text: "project roots add root directory discovery" },
  { section: "projects", text: "discover now rescan" },
  { section: "projects", text: "git auto fetch interval origin" },
  { section: "projects", text: "global config directory" },
  { section: "dock", text: "worktree refresh branch sync monitor hmr preview" },
  { section: "dock", text: "detect dev servers vite next port preview" },
  { section: "dock", text: "docker compose services logs auto attach" },
  { section: "browser", text: "browser cookies import chrome firefox profile signed in" },
  { section: "devices", text: "android emulator avd adb scrcpy device panel phone" },
  { section: "devices", text: "new device create stop delete pair wireless" },
  { section: "devices", text: "sdk system images install licenses" },
  { section: "hosts", text: "remote host agent register base url token" },
  { section: "hosts", text: "test connection ping online offline" },
  { section: "hosts", text: "cascade delete host projects" },
  { section: "hosts", text: "agent update version skew self-update" },
  { section: "hosts", text: "ssh agent bridge pair laptop 1password forward helper revoke" },
  { section: "integrations", text: "github personal access token pat connect disconnect" },
  { section: "integrations", text: "issues pull requests actions device flow oauth" },
  { section: "integrations", text: "webhooks real-time updates" },
  { section: "integrations", text: "github app reviewer app private key rotate installation" },
  { section: "server", text: "version environment port encryption uptime role primary agent" },
  { section: "server", text: "sessions directory database rate limit cpu ram" },
  { section: "server", text: "storage disk docker cleanup prune reclaimable" },
  { section: "server", text: "updates update now release latest apply auto-update" },
];
