import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "../store/index.js";
import { themeClassName } from "../store/theme.js";
import { buildRailPaneEntries, railPaneAccessibleName } from "../lib/railPanes.js";
import type { RailPaneEntry, RailPaneInput } from "../lib/railPanes.js";
import { FileTextIcon, PlusIcon, TerminalPromptIcon } from "../ui/icons.js";

export interface RailPaneListProps {
  /** The entries to show, in order. */
  entries: readonly RailPaneEntry[];
  /** Focus the pane with this dockview id. */
  onFocus: (panelId: string) => void;
  /** The "+" directly under the entries: start a new session there. */
  onAdd: () => void;
  /** Names the list for assistive tech. */
  label?: string;
  /** #3010 — a long press (or a right click) on an entry offers these, e.g.
   *  "Move to the right half". None: no menu. */
  menuItems?: (entry: RailPaneEntry) => RailEntryMenuItem[];
}

export interface RailEntryMenuItem {
  label: string;
  onSelect: () => void;
}

const LONG_PRESS_MS = 500;

// The rail's list of open panes (#3009): an agent logo, a few characters, the
// needs-you dot and the unread count, the focused pane marked, and a "+"
// directly under them. Presentational: entries come from buildRailPaneEntries
// (lib/railPanes.ts), so another layout can hand it any subset of panes.
export function RailPaneList({
  entries,
  onFocus,
  onAdd,
  label = "Open panes",
  menuItems,
}: RailPaneListProps) {
  const [menu, setMenu] = useState<{
    entry: RailPaneEntry;
    top: number;
    left: number;
  } | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A long press opens the menu; the click that ends it must not also
  // focus the pane.
  const suppressClick = useRef(false);
  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(() => clearPress, []);
  const openMenu = (entry: RailPaneEntry, el: HTMLElement) => {
    const items = menuItems?.(entry) ?? [];
    if (items.length === 0) return;
    const rect = el.getBoundingClientRect();
    setMenu({ entry, top: rect.top, left: rect.right + 6 });
  };
  return (
    <div className="rail-pane-list" role="group" aria-label={label}>
      {entries.map((entry) => {
        const tooltip = entry.projectName
          ? `${entry.fullTitle} — ${entry.projectName}`
          : entry.fullTitle;
        return (
          <button
            key={entry.panelId}
            type="button"
            className={`left-rail-btn rail-pane${entry.active ? " active" : ""}`}
            aria-label={railPaneAccessibleName(entry)}
            aria-current={entry.active ? "true" : undefined}
            title={tooltip}
            data-panel-id={entry.panelId}
            aria-haspopup={menuItems ? "menu" : undefined}
            // The menu opens on a long press or the context-menu key
            // (Shift+F10 included); Enter and Space stay the entry's tap.
            aria-expanded={menuItems ? menu?.entry.panelId === entry.panelId : undefined}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              onFocus(entry.panelId);
            }}
            onPointerDown={(e) => {
              // A long press that ended without a click (Android's own
              // context-menu path) must not swallow the next tap.
              suppressClick.current = false;
              if (!menuItems) return;
              const el = e.currentTarget;
              clearPress();
              pressTimer.current = setTimeout(() => {
                pressTimer.current = null;
                suppressClick.current = true;
                openMenu(entry, el);
              }, LONG_PRESS_MS);
            }}
            onPointerUp={clearPress}
            onPointerLeave={clearPress}
            onPointerCancel={clearPress}
            onContextMenu={(e) => {
              if (!menuItems) return;
              e.preventDefault();
              clearPress();
              openMenu(entry, e.currentTarget);
            }}
          >
            {entry.logo ? (
              <img className="rail-pane-logo" src={entry.logo} alt="" aria-hidden="true" />
            ) : entry.isSession ? (
              <TerminalPromptIcon size={16} aria-hidden="true" />
            ) : (
              <FileTextIcon size={16} aria-hidden="true" />
            )}
            <span className="left-rail-label rail-pane-label" aria-hidden="true">
              {entry.label}
            </span>
            {entry.needsYou && <span className="rail-pane-needs-you" aria-hidden="true" />}
            {entry.unreadCount > 0 && (
              <span className="rail-pane-unread" aria-hidden="true">
                {entry.unreadCount > 9 ? "9+" : entry.unreadCount}
              </span>
            )}
          </button>
        );
      })}
      <button
        type="button"
        className="left-rail-btn rail-pane-add"
        aria-label="New session"
        title="New session"
        onClick={onAdd}
      >
        <PlusIcon size={16} strokeLinecap="round" strokeWidth={2} />
      </button>
      {menu && (
        <RailEntryMenu
          title={menu.entry.fullTitle}
          items={menuItems?.(menu.entry) ?? []}
          top={menu.top}
          left={menu.left}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// The small menu a long press on a rail entry opens (design frame 2d).
function RailEntryMenu({
  title,
  items,
  top,
  left,
  onClose,
}: {
  title: string;
  items: RailEntryMenuItem[];
  top: number;
  left: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useDashboardStore((s) => s.theme);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      className={themeClassName(theme, "pane-tab-overflow-menu", "rail-entry-menu")}
      role="menu"
      aria-label={title}
      style={{ position: "fixed", top, left: Math.min(left, window.innerWidth - 220) }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="rail-entry-menu-item"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export interface RailPanesProps extends Pick<RailPaneListProps, "menuItems"> {
  /** The panes to list, in order. */
  panes: readonly RailPaneInput[];
  activePanelId: string | null;
  onFocus: (panelId: string) => void;
  onAdd: () => void;
  label?: string;
}

// The store-connected list: reads what needs-you and unread depend on and
// builds the entries for the panes it is given.
export function RailPanes({
  panes,
  activePanelId,
  onFocus,
  onAdd,
  label,
  menuItems,
}: RailPanesProps) {
  const sessions = useDashboardStore((s) => s.sessions);
  const projects = useDashboardStore((s) => s.projects);
  const events = useDashboardStore((s) => s.events);
  const lastSeenSeq = useDashboardStore((s) => s.lastSeenSeq);
  const dismissedEventKeys = useDashboardStore((s) => s.dismissedEventKeys);
  const mutedSessionIds = useDashboardStore((s) => s.mutedSessionIds);
  const theme = useDashboardStore((s) => s.theme);
  const entries = useMemo(
    () =>
      buildRailPaneEntries(panes, {
        sessions,
        projects,
        events,
        lastSeenSeq,
        dismissedEventKeys,
        mutedSessionIds,
        theme,
        activePanelId,
      }),
    [
      panes,
      sessions,
      projects,
      events,
      lastSeenSeq,
      dismissedEventKeys,
      mutedSessionIds,
      theme,
      activePanelId,
    ],
  );
  return (
    <RailPaneList
      entries={entries}
      onFocus={onFocus}
      onAdd={onAdd}
      label={label}
      menuItems={menuItems}
    />
  );
}
