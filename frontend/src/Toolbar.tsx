import type { ReactNode } from "react";
import { useDashboardStore } from "./store/index.js";
import { SearchIcon } from "./ui/icons.js";

interface ToolbarProps {
  /** #3216 — out of focus and the accessibility tree while a phone sidebar
   * view covers the top bar. */
  inert?: boolean;
  onOpenLauncher: () => void;
  // App's MobileSessionSwitcher: the session picker that fills the bar.
  mobileSessionSlot?: ReactNode;
}

// The phone's top bar (#3009, #3014, #3288): [session picker] [palette]. From
// 700px there is no top bar; its controls live on the left rail (LeftRail.tsx).
// New session is the picker's own row and the tab bar's New entry, the
// notifications the tab bar's Inbox entry, Settings and the theme the tab
// bar's "more" sheet. Global keyboard shortcuts (⌘K, ⌘,, Esc) are wired once from
// App.tsx.
export function Toolbar({ onOpenLauncher, mobileSessionSlot, inert = false }: ToolbarProps) {
  // Tasks is an install-wide board, not a workspace view, and has no palette
  // on purpose (issue #730).
  const viewMode = useDashboardStore((s) => s.viewMode);

  return (
    <div className="toolbar" inert={inert}>
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
      </div>
    </div>
  );
}
