import { useMemo } from "react";
import type { ReactNode } from "react";
import type { Session } from "./api/index.js";
import { needsYouTasks } from "./github/taskMasterSummary.js";
import { NotificationBell } from "./NotificationBell.js";
import { RailStatusList } from "./rail/RailStatusList.js";
import type { SettingsSection } from "./Settings.js";
import { useDashboardStore } from "./store/index.js";
import { GearIcon, GridIcon, LayersIcon, SearchIcon, SidebarToggleIcon } from "./ui/icons.js";

export interface LeftRailProps {
  /** Shows or hides the docked left sidebar. Unset from 700 to 1099px, which
   *  has no left sidebar (#3041): the button is not rendered. */
  onToggleSidebar?: () => void;
  /** Whether the left sidebar is showing, for the toggle's pressed state. */
  sidebarShown: boolean;
  /** The command box: the command palette. */
  onOpenLauncher: () => void;
  onOpenSettings: (section?: SettingsSection) => void;
  onOpenSession: (session: Session) => void;
  onOpenTimeline?: (session: Session) => void;
  onOpenBrowser: (projectId: number) => void;
  /** Touch tablets: the bell's feed as a bottom sheet instead of a popover. */
  notificationSheet?: boolean;
  /**
   * The rail's middle region in Workspace mode (Tasks mode fills its own,
   * the board's statuses), the one part of
   * the rail that scrolls: App passes RailWorkspaceSection (the workspace
   * chip and, while the left sidebar is not showing, the open panes).
   */
  middle?: ReactNode;
}

// The left rail (#3009): the app's global navigation from 700px up, in place of
// the top bar. Top: the mode switch. Middle: Workspace mode's own entries.
// Bottom: the command box, the bell and settings. The phone keeps its top bar
// and does not render this.
export function LeftRail({
  onToggleSidebar,
  sidebarShown,
  onOpenLauncher,
  onOpenSettings,
  onOpenSession,
  onOpenTimeline,
  onOpenBrowser,
  notificationSheet = false,
  middle,
}: LeftRailProps) {
  const tasksMode = useDashboardStore((s) => s.viewMode === "kanban");
  const tasks = useDashboardStore((s) => s.tasks);
  // The one "needs you" definition (taskMasterSummary.ts), the same count the
  // board's "Needs me" filter shows, install-wide: Tasks mode is not scoped to
  // a project or a workspace.
  const needsYou = useMemo(() => needsYouTasks(tasks).length, [tasks]);
  const needsYouText = `${needsYou} need${needsYou === 1 ? "s" : ""} you`;
  const setViewMode = (mode: "list" | "kanban") => useDashboardStore.getState().setViewMode(mode);

  return (
    <nav className="left-rail" aria-label="App">
      <div className="left-rail-modes" role="group" aria-label="Mode">
        <button
          type="button"
          className={`left-rail-btn left-rail-mode${tasksMode ? "" : " active"}`}
          aria-pressed={!tasksMode}
          aria-label="Workspace"
          title="Workspace (Ctrl/⌘ + Alt + O)"
          onClick={() => setViewMode("list")}
        >
          <GridIcon size={17} />
          <span className="left-rail-label" aria-hidden="true">
            Work
          </span>
        </button>
        <button
          type="button"
          className={`left-rail-btn left-rail-mode${tasksMode ? " active" : ""}`}
          aria-pressed={tasksMode}
          // A stable name, so voice control and screen readers find "Tasks"
          // whatever the count; the count is the button's description.
          aria-label="Tasks"
          aria-describedby={needsYou > 0 ? "left-rail-needs-you" : undefined}
          title={
            needsYou > 0 ? `Tasks: ${needsYouText} (Ctrl/⌘ + Alt + O)` : "Tasks (Ctrl/⌘ + Alt + O)"
          }
          onClick={() => setViewMode("kanban")}
        >
          <LayersIcon size={17} />
          <span className="left-rail-label" aria-hidden="true">
            Tasks
          </span>
          {needsYou > 0 && (
            <span className="left-rail-badge" aria-hidden="true">
              {needsYou > 99 ? "99+" : needsYou}
            </span>
          )}
          {needsYou > 0 && (
            <span id="left-rail-needs-you" className="visually-hidden">
              {needsYouText}
            </span>
          )}
        </button>
      </div>
      {!tasksMode && (
        <>
          <span className="left-rail-sep" aria-hidden="true" />
          {/* The left sidebar's toggle. On the rail rather than in the
              sidebar: a control inside a collapsed sidebar cannot open it.
              Only where there is a left sidebar, from 1100px (#3041). */}
          {onToggleSidebar && (
            <button
              type="button"
              className={`left-rail-btn${sidebarShown ? "" : " collapsed"}`}
              aria-pressed={sidebarShown}
              aria-label="Sidebar"
              title={sidebarShown ? "Hide sidebar" : "Show sidebar"}
              onClick={onToggleSidebar}
              data-toggle-sidebar
            >
              <SidebarToggleIcon size={17} />
            </button>
          )}
          {/* ---- Middle region (Workspace mode only) ----
              The workspace chip with its group squares and, while the
              sidebar is not showing, the workspace's open panes with a "+"
              under them (rail/RailWorkspaceSection.tsx, from the `middle`
              prop). The only part of the rail that scrolls. */}
          <div className="left-rail-middle" data-rail-region="middle">
            {middle}
          </div>
        </>
      )}
      {tasksMode && (
        // Tasks mode's middle region (#3026): the board's statuses, each a
        // jump. Nothing else of Workspace mode's belongs here.
        <div className="left-rail-middle" data-rail-region="middle">
          <RailStatusList />
        </div>
      )}
      <div className="left-rail-bottom">
        <button
          type="button"
          className="left-rail-btn"
          onClick={onOpenLauncher}
          // The palette launches terminals, which only open in a workspace
          // (issue #730), so it stays off in Tasks mode, as the top bar's did.
          disabled={tasksMode}
          aria-label="Command palette"
          title={
            tasksMode
              ? "Command palette (switch to Workspace to use it)"
              : "Command palette: run a command or start a session (⌘K)"
          }
        >
          <SearchIcon size={17} strokeWidth={1.9} />
        </button>
        <NotificationBell
          onOpenSession={onOpenSession}
          onOpenTimeline={onOpenTimeline}
          onOpenBrowser={onOpenBrowser}
          sheet={notificationSheet}
          sheetClassName={notificationSheet ? "mobile-notif-sheet--tablet" : undefined}
          placement="beside"
          triggerClassName="left-rail-btn"
        />
        <button
          type="button"
          className="left-rail-btn"
          onClick={() => onOpenSettings()}
          aria-label="Settings"
          title="Settings (⌘,)"
        >
          <GearIcon size={17} />
        </button>
      </div>
    </nav>
  );
}
