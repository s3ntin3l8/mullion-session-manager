import { useDashboardStore } from "./store/index.js";
import {
  ChevronLeftIcon,
  GridIcon,
  LayersIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SidebarToggleIcon,
  SunIcon,
  GearIcon,
} from "./ui/icons.js";
import { NotificationBell } from "./NotificationBell.js";
import type { Session } from "./api/index.js";
import type { SettingsSection } from "./Settings.js";

interface ToolbarProps {
  onToggleSidebar: () => void;
  onOpenSession: (session: Session) => void;
  // Issue #270 — passed straight through to NotificationBell; see its own
  // prop doc for why this is distinct from onOpenSession.
  onOpenTimeline?: (session: Session) => void;
  // Issue #404 — opens (or focuses) a project's preview pane, so accepting a
  // dev_server_detected offer can jump straight to it, same handler App.tsx
  // wires to the sidebar's own "Preview" action.
  onOpenBrowser: (projectId: number) => void;
  onOpenLauncher: () => void;
  onOpenSettings: (section?: SettingsSection) => void;
  activeWorkspaceName: string | null;
  paneCount: number;
  currentVersion: string | null;
}

// Ported 1:1 from the design's toolbar: sidebar toggle, attention bell with
// count badge, "+" new-session (opens the global command palette), a
// centered active-workspace/pane-count summary, "Run command… ⌘K", theme
// toggle, and the settings gear. Global keyboard shortcuts (⌘K, ⌘,, Esc) are
// wired once from App.tsx (they need to work regardless of toolbar focus).
export function Toolbar({
  onToggleSidebar,
  onOpenSession,
  onOpenTimeline,
  onOpenBrowser,
  onOpenLauncher,
  onOpenSettings,
  activeWorkspaceName,
  paneCount,
  currentVersion,
}: ToolbarProps) {
  // P1 perf fix — the plan's own audit didn't cite this file by line, but
  // it's the identical whole-store-subscription defect (`useDashboardStore()`
  // with no selector) in one of the four components its own App.tsx finding
  // names as dragged along by App's re-renders; fixed here for the same
  // reason as the cited call sites. `toggleTheme` is a pure action-caller
  // (only used inside the theme button's onClick below) — see the
  // getState() call at that call site instead of subscribing to it here.
  const theme = useDashboardStore((s) => s.theme);
  // Tasks is an install-wide board, not a workspace view — reading viewMode
  // here (rather than threading it through a list/Kanban toggle, issue #211's
  // now-removed ViewModeToggle.tsx) lets the toolbar say so honestly: the
  // workspace name/pane-count this row otherwise shows would be describing a
  // scope Tasks doesn't have. Entering Tasks now only happens from the
  // sidebar's own entry (Sidebar.tsx) or the command palette; this is only
  // the way back out, mirroring Dock.tsx's own contextual-chrome posture.
  const viewMode = useDashboardStore((s) => s.viewMode);

  return (
    <div className="toolbar">
      <div className="toolbar-lead">
        <button
          className="toolbar-icon-btn"
          onClick={onToggleSidebar}
          title="Toggle sidebar"
          data-toggle-sidebar
        >
          <SidebarToggleIcon size={17} />
        </button>
        <NotificationBell
          onOpenSession={onOpenSession}
          onOpenTimeline={onOpenTimeline}
          onOpenBrowser={onOpenBrowser}
        />
        <button
          className="toolbar-icon-btn"
          onClick={onOpenLauncher}
          title={
            viewMode === "kanban" ? "New session (unavailable in Task view)" : "New session (⌘K)"
          }
          disabled={viewMode === "kanban"}
        >
          <PlusIcon size={18} />
        </button>
      </div>
      <div className="toolbar-center">
        {viewMode === "kanban" ? (
          <>
            <LayersIcon size={14} />
            <span className="toolbar-center-name">Tasks</span>
          </>
        ) : (
          activeWorkspaceName !== null && (
            <>
              <GridIcon size={15} />
              <span className="toolbar-center-name">{activeWorkspaceName}</span>
              <span className="toolbar-center-count">
                {paneCount} pane{paneCount === 1 ? "" : "s"}
              </span>
            </>
          )
        )}
      </div>
      <div className="toolbar-actions">
        <button
          className="run-cmd-btn"
          onClick={onOpenLauncher}
          title={
            viewMode === "kanban" ? "Command palette (unavailable in Task view)" : "Command palette"
          }
          disabled={viewMode === "kanban"}
        >
          <SearchIcon size={14} strokeWidth={1.9} />
          <span style={{ fontSize: 12 }}>Run command…</span>
          <span className="kbd">⌘K</span>
        </button>
        {viewMode === "kanban" && (
          <button
            className="toolbar-icon-btn toolbar-back-to-workspace"
            onClick={() => useDashboardStore.getState().setViewMode("list")}
            title="Back to workspace"
          >
            <ChevronLeftIcon size={17} />
            <span>Back</span>
          </button>
        )}
        <button
          className="toolbar-icon-btn"
          onClick={() => useDashboardStore.getState().toggleTheme()}
          title="Toggle theme"
        >
          {theme === "light" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </button>
        {currentVersion !== null && (
          <button
            className="toolbar-version-label"
            onClick={() => onOpenSettings("server")}
            title={`Version ${currentVersion}`}
          >
            v{currentVersion}
          </button>
        )}
        <button className="toolbar-icon-btn" onClick={() => onOpenSettings()} title="Settings (⌘,)">
          <GearIcon size={18} />
        </button>
      </div>
    </div>
  );
}
