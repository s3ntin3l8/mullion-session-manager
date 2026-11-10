import type { SidebarProps } from "../Sidebar.js";
import { Sidebar } from "../Sidebar.js";

// Extracted from App.tsx (issue #2407) — the `<Sidebar>` element the shell
// used to build inline (`const sidebar = <Sidebar .../>`). The issue's
// 500-line sidebar range (around the old 1602-2103) is stale; this is that
// element and nothing else. Props and expressions stay at the call site.
export function SidebarShell(props: SidebarProps) {
  return (
    <Sidebar
      showSourceControl={props.showSourceControl}
      phoneSection={props.phoneSection}
      workspaceProjectIds={props.workspaceProjectIds}
      openSessionIds={props.openSessionIds}
      onOpenSession={props.onOpenSession}
      onOpenSessionAsFloat={props.onOpenSessionAsFloat}
      onSessionEnded={props.onSessionEnded}
      onOpenProjectLauncher={props.onOpenProjectLauncher}
      onOpenGlobalLauncher={props.onOpenGlobalLauncher}
      onOpenSettingsProjects={props.onOpenSettingsProjects}
      onOpenTasks={props.onOpenTasks}
      onOpenGit={props.onOpenGit}
      onOpenProjectSetup={props.onOpenProjectSetup}
      onOpenDevice={props.onOpenDevice}
    />
  );
}
