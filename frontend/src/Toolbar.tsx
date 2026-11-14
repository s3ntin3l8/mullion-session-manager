import type { ReactNode } from "react";
import { useDashboardStore } from "./store/index.js";
import { SearchIcon } from "./ui/icons.js";
import { NotificationBell } from "./NotificationBell.js";
import type { Session } from "./api/index.js";

interface ToolbarProps {
  onOpenSession: (session: Session) => void;
  // Issue #270 — passed straight through to NotificationBell; see its own
  // prop doc for why this is distinct from onOpenSession.
  onOpenTimeline?: (session: Session) => void;
  // Issue #404 — opens (or focuses) a project's preview pane, so accepting a
  // dev_server_detected offer can jump straight to it, same handler App.tsx
  // wires to the sidebar's own "Preview" action.
  onOpenBrowser: (projectId: number) => void;
  onOpenLauncher: () => void;
  // App's MobileSessionSwitcher: the session picker that fills the bar.
  mobileSessionSlot?: ReactNode;
}

// The phone's top bar (#3009, #3014): [session picker] [palette] [bell]. From
// 700px there is no top bar; its controls live on the left rail (LeftRail.tsx).
// New session is the picker's own row, Settings and the theme the mode bar's
// "more" sheet. Global keyboard shortcuts (⌘K, ⌘,, Esc) are wired once from
// App.tsx.
export function Toolbar({
  onOpenSession,
  onOpenTimeline,
  onOpenBrowser,
  onOpenLauncher,
  mobileSessionSlot,
}: ToolbarProps) {
  // Tasks is an install-wide board, not a workspace view, and has no palette
  // on purpose (issue #730).
  const viewMode = useDashboardStore((s) => s.viewMode);

  return (
    <div className="toolbar">
      {mobileSessionSlot && <div className="toolbar-mobile-session">{mobileSessionSlot}</div>}
      <div className="toolbar-actions">
        {/* The palette button is OMITTED in Task view, not disabled there. A
            disabled control explains itself only through its `title`, which
            touch never shows: a dead grey icon that cannot be pressed is
            worse than no icon at all (issue #1880's review). */}
        {viewMode !== "kanban" && (
          <button
            className="run-cmd-btn toolbar-icon-btn"
            onClick={onOpenLauncher}
            title="Command palette"
            // Icon-only (mobile.css drops the "Run command…" label and the ⌘K
            // hint), so the visible text that would name it is not there to
            // name it (issue #1880). The palette's own name is the honest one,
            // and it is the name the tooltip already uses.
            aria-label="Command palette"
          >
            <SearchIcon size={14} strokeWidth={1.9} />
            <span className="run-cmd-label" style={{ fontSize: "0.75rem" }}>
              Run command…
            </span>
            <span className="kbd">⌘K</span>
          </button>
        )}
        {/* The bell sits at the right edge and renders its feed as a bottom
            sheet. */}
        <NotificationBell
          onOpenSession={onOpenSession}
          onOpenTimeline={onOpenTimeline}
          onOpenBrowser={onOpenBrowser}
          sheet
        />
      </div>
    </div>
  );
}
