import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "./store/index.js";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { ChevronDownIcon, CloseIcon, PlusIcon } from "./ui/icons.js";
import { matchesQuery } from "./matchQuery.js";
import {
  SWIPE_CLICK_SUPPRESS_MS,
  SWIPE_COMMIT_PX,
  swipeTargetId,
} from "./lib/mobileSessionSwipe.js";

// An OPEN pane — what the trigger's `n/N` counter and swipe cycle through.
export interface MobileSessionItem {
  id: string;
  title: string;
  dotColor: string;
  agentLogo: string | null;
  unreadCount: number;
}

// One row of the picker sheet: any listed session, open in the current layout
// (`panelId` set) or not (selecting it opens it, switching workspace if it
// lives in another one).
export interface MobileSessionRow {
  key: string;
  panelId: string | null;
  title: string;
  dotColor: string;
  agentLogo: string | null;
  unreadCount: number;
  needsYou: boolean;
  searchFields: string[];
}

export interface MobileSessionSection {
  key: string;
  label: string;
  kind: "needs-you" | "panes" | "project";
  rows: MobileSessionRow[];
}

// The search box only earns its space once the list is long enough to need
// it; below this the sheet is as compact as the old flat list.
const SEARCH_MIN_ROWS = 8;

// Phone replacement for the old horizontal `.mobile-tabs` strip: the active
// session's name sits in the toolbar as a single trigger (tap = full session
// list in a bottom sheet, horizontal swipe = previous/next session), so
// switching never depends on a strip that only fits ~2.5 truncated tabs.
export function MobileSessionSwitcher({
  items,
  sections,
  unreadElsewhere,
  activeId,
  onSelect,
  onSelectRow,
  onClose,
  onNewSession,
  renderActiveActions,
  renamingId,
  renameDraft,
  renameInputRef,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
}: {
  // Open panes only, in dockview order: the swipe / `n/N` domain.
  items: MobileSessionItem[];
  // Every listed session, grouped — the sheet's content.
  sections: MobileSessionSection[];
  // Unread across ALL listed sessions except the active one (the trigger
  // badge), so activity in a session that isn't open is still noticeable.
  unreadElsewhere: number;
  activeId: string | null;
  onSelect: (id: string) => void;
  onSelectRow: (row: MobileSessionRow) => void;
  onClose: (id: string) => void;
  onNewSession: () => void;
  // The active row's ⋮ menu (PaneActionsMenu) — rendered by App, which owns
  // the dockview api it needs.
  renderActiveActions: () => ReactNode;
  renamingId: string | null;
  renameDraft: string;
  renameInputRef: RefObject<HTMLInputElement | null>;
  onRenameDraftChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}) {
  const theme = useDashboardStore((s) => s.theme);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sheetRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  // A committed swipe may also end in a click on the trigger (browser
  // dependent) — swallow a click arriving right after one, but only then, so
  // a later keyboard/mouse activation is never eaten.
  const swipedAtRef = useRef(0);

  // Every way of closing the sheet goes through here: an in-flight rename is
  // cancelled rather than left pending (React fires no onBlur when the
  // input unmounts), so reopening never shows a stale, unfocused draft.
  const closeSheet = () => {
    if (renamingId !== null) onRenameCancel();
    setOpen(false);
    setQuery("");
  };

  const { onKeyDown: onTrapKeyDown } = useFocusTrap({ active: open, containerRef: sheetRef });
  const onSheetKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      // Escape first backs out of a rename (the input's own Escape handler
      // does the same, and this catches it when focus is elsewhere); a
      // second Escape closes the sheet.
      if (renamingId !== null) onRenameCancel();
      else closeSheet();
      return;
    }
    onTrapKeyDown(e);
  };

  // Ending a rename unmounts the focused input; hand focus back to the sheet
  // so its Escape/Tab-trap handling (a React onKeyDown on the sheet) keeps
  // working instead of focus falling to <body>.
  const wasRenamingRef = useRef(false);
  useEffect(() => {
    if (wasRenamingRef.current && renamingId === null && open) {
      sheetRef.current?.querySelector<HTMLElement>(".mobile-session-row.active button")?.focus();
    }
    wasRenamingRef.current = renamingId !== null;
  }, [renamingId, open]);

  // Undefined when the active dockview panel isn't one of `items` (e.g. a
  // floating panel) — the trigger then names no session rather than
  // pretending the first one is active.
  const active = items.find((item) => item.id === activeId);
  const activeIndex = active ? items.indexOf(active) : -1;

  // Bring the active row into view when the sheet opens — with every session
  // listed the list can now be long. Optional call: jsdom has no
  // scrollIntoView.
  useEffect(() => {
    if (!open) return;
    sheetRef.current
      ?.querySelector<HTMLElement>(".mobile-session-row.active")
      ?.scrollIntoView?.({ block: "center" });
  }, [open]);

  if (sections.length === 0) {
    return (
      <button
        className="mobile-session-trigger mobile-session-trigger--empty"
        onClick={onNewSession}
      >
        <PlusIcon size={15} />
        <span className="mobile-session-title">New session</span>
      </button>
    );
  }

  const select = (row: MobileSessionRow) => {
    onSelectRow(row);
    closeSheet();
  };

  // Distinct rows: the "Needs you" pin repeats rows that also sit under
  // their project, so it's excluded from every count.
  const listedRows = sections.flatMap((section) =>
    section.kind === "needs-you" ? [] : section.rows,
  );
  const showSearch = listedRows.length > SEARCH_MIN_ROWS;
  const trimmedQuery = query.trim();
  const visibleSections = (
    trimmedQuery
      ? sections.map((section) => ({
          ...section,
          rows: section.rows.filter((row) => matchesQuery(row.searchFields, trimmedQuery)),
        }))
      : sections
  ).filter((section) => section.rows.length > 0);

  return (
    <>
      <button
        className="mobile-session-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Switch session (swipe to go to the next/previous one)"
        onTouchStart={(e) => {
          const t = e.touches[0];
          touchStartRef.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchEnd={(e) => {
          const start = touchStartRef.current;
          touchStartRef.current = null;
          const t = e.changedTouches[0];
          if (!start || !t || items.length === 0) return;
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          if (Math.abs(dx) < SWIPE_COMMIT_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
          // No active item (a floating panel is active): swiping forward
          // enters the list at its first item, backward at its last.
          const target = active
            ? swipeTargetId(items, active.id, dx)
            : items[dx < 0 ? 0 : items.length - 1].id;
          if (target) {
            swipedAtRef.current = Date.now();
            onSelect(target);
          }
        }}
        onClick={() => {
          if (Date.now() - swipedAtRef.current < SWIPE_CLICK_SUPPRESS_MS) return;
          setOpen(true);
        }}
      >
        {active ? (
          <>
            <span className="mobile-session-dot" style={{ background: active.dotColor }} />
            {active.agentLogo && (
              <img
                src={active.agentLogo}
                alt=""
                width={14}
                height={14}
                className="mobile-session-logo"
              />
            )}
            <span className="mobile-session-title">{active.title}</span>
          </>
        ) : (
          <span className="mobile-session-title">Sessions</span>
        )}
        {items.length > 1 && (
          <span className="mobile-session-count">
            {active ? `${activeIndex + 1}/${items.length}` : items.length}
          </span>
        )}
        {unreadElsewhere > 0 && (
          <span
            className="mobile-session-unread"
            aria-label={`${unreadElsewhere} unread elsewhere`}
          >
            {unreadElsewhere}
          </span>
        )}
        <ChevronDownIcon size={14} />
      </button>
      {open &&
        createPortal(
          <div
            className={`cmux-root${theme === "light" ? " light" : ""} mobile-session-backdrop`}
            onClick={closeSheet}
          >
            <div
              ref={sheetRef}
              className="mobile-session-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Sessions"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={onSheetKeyDown}
            >
              <div className="mobile-session-sheet-header">
                <span>Sessions ({listedRows.length})</span>
                <button
                  className="mobile-tab-btn"
                  aria-label="Close session list"
                  onClick={closeSheet}
                >
                  <CloseIcon size={14} />
                </button>
              </div>
              {showSearch && (
                <input
                  type="search"
                  className="mobile-session-search"
                  aria-label="Search sessions"
                  placeholder="Search sessions"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              )}
              <div className="mobile-session-list">
                {visibleSections.map((section) => (
                  <section key={section.key} className="mobile-session-section">
                    <h3
                      className={`mobile-session-section-head${
                        section.kind === "needs-you" ? " needs-you" : ""
                      }`}
                    >
                      <span>{section.label}</span>
                      <span className="mobile-session-section-count">{section.rows.length}</span>
                    </h3>
                    <ul>
                      {section.rows.map((row) => {
                        // The pin only repeats rows that live under their
                        // project, so it carries no actions / active mark.
                        const pinned = section.kind === "needs-you";
                        const isOpenRow = row.panelId !== null;
                        const isActive = !pinned && row.panelId === active?.id;
                        return (
                          <li
                            key={row.key}
                            className={`mobile-session-row${isActive ? " active" : ""}${
                              isOpenRow ? "" : " closed"
                            }`}
                          >
                            {!pinned && renamingId !== null && renamingId === row.panelId ? (
                              <input
                                ref={renameInputRef}
                                className="mobile-session-rename-input"
                                aria-label="Session name"
                                value={renameDraft}
                                onChange={(e) => onRenameDraftChange(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") onRenameCommit();
                                  else if (e.key === "Escape") {
                                    // Handled here; don't also reach the sheet's
                                    // Escape handler (a second cancel).
                                    e.stopPropagation();
                                    onRenameCancel();
                                  }
                                }}
                                onBlur={onRenameCommit}
                              />
                            ) : (
                              <button
                                className="mobile-session-row-main"
                                aria-current={isActive ? "true" : undefined}
                                onClick={() => select(row)}
                              >
                                <span
                                  className="mobile-session-dot"
                                  style={{ background: row.dotColor }}
                                />
                                {row.agentLogo && (
                                  <img
                                    src={row.agentLogo}
                                    alt=""
                                    width={16}
                                    height={16}
                                    className="mobile-session-logo"
                                  />
                                )}
                                <span className="mobile-session-title">{row.title}</span>
                                {row.unreadCount > 0 && (
                                  <span className="mobile-session-unread">{row.unreadCount}</span>
                                )}
                              </button>
                            )}
                            {isActive && renamingId !== row.panelId && renderActiveActions()}
                            {!pinned && row.panelId !== null && (
                              <button
                                className="mobile-tab-btn"
                                title="Close pane — detaches your view, session keeps running"
                                aria-label={`Close ${row.title}`}
                                onClick={() => onClose(row.panelId as string)}
                              >
                                <CloseIcon size={13} />
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
                {visibleSections.length === 0 && (
                  <p className="mobile-session-empty">No sessions match “{trimmedQuery}”.</p>
                )}
              </div>
              <button
                className="mobile-session-new"
                onClick={() => {
                  closeSheet();
                  onNewSession();
                }}
              >
                <PlusIcon size={15} />
                New session
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
