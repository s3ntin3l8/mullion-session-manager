import { useDashboardStore } from "./store.js";
import {
  BellIcon,
  GridIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SidebarToggleIcon,
  SunIcon,
  GearIcon,
} from "./icons.js";

interface ToolbarProps {
  onToggleSidebar: () => void;
  attentionCount: number;
  onOpenLauncher: () => void;
  onOpenSettings: () => void;
  activeWorkspaceName: string | null;
  paneCount: number;
}

// Ported 1:1 from the design's toolbar: sidebar toggle, attention bell with
// count badge, "+" new-session (opens the global command palette), a
// centered active-workspace/pane-count summary, "Run command… ⌘K", theme
// toggle, and the settings gear. Global keyboard shortcuts (⌘K, ⌘,, Esc) are
// wired once from App.tsx (they need to work regardless of toolbar focus).
export function Toolbar({
  onToggleSidebar,
  attentionCount,
  onOpenLauncher,
  onOpenSettings,
  activeWorkspaceName,
  paneCount,
}: ToolbarProps) {
  const { theme, toggleTheme } = useDashboardStore();

  return (
    <div className="toolbar">
      <div className="toolbar-lead">
        <button className="toolbar-icon-btn" onClick={onToggleSidebar} title="Toggle sidebar">
          <SidebarToggleIcon size={17} />
        </button>
        <button
          className="toolbar-icon-btn"
          title={
            attentionCount > 0
              ? `Attention — ${attentionCount} session${attentionCount === 1 ? "" : "s"} need input`
              : "No sessions need attention"
          }
        >
          <BellIcon size={17} />
          {attentionCount > 0 && <span className="attention-badge">{attentionCount}</span>}
        </button>
        <button className="toolbar-icon-btn" onClick={onOpenLauncher} title="New session (⌘K)">
          <PlusIcon size={18} />
        </button>
      </div>
      <div className="toolbar-center">
        {activeWorkspaceName !== null && (
          <>
            <GridIcon size={15} />
            <span className="toolbar-center-name">{activeWorkspaceName}</span>
            <span className="toolbar-center-count">
              {paneCount} pane{paneCount === 1 ? "" : "s"}
            </span>
          </>
        )}
      </div>
      <div className="toolbar-actions">
        <button className="run-cmd-btn" onClick={onOpenLauncher} title="Command palette">
          <SearchIcon size={14} strokeWidth={1.9} />
          <span style={{ fontSize: 12 }}>Run command…</span>
          <span className="kbd">⌘K</span>
        </button>
        <button className="toolbar-icon-btn" onClick={toggleTheme} title="Toggle theme">
          {theme === "light" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </button>
        <button className="toolbar-icon-btn" onClick={onOpenSettings} title="Settings (⌘,)">
          <GearIcon size={18} />
        </button>
      </div>
    </div>
  );
}
