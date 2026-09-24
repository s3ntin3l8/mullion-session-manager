import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "./store/index.js";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { ChevronDownIcon, CloseIcon, PlusIcon } from "./ui/icons.js";
import {
  SWIPE_CLICK_SUPPRESS_MS,
  SWIPE_COMMIT_PX,
  swipeTargetId,
} from "./lib/mobileSessionSwipe.js";

export interface MobileSessionItem {
  id: string;
  title: string;
  dotColor: string;
  agentLogo: string | null;
  unreadCount: number;
}

// Phone replacement for the old horizontal `.mobile-tabs` strip: the active
// session's name sits in the toolbar as a single trigger (tap = full session
// list in a bottom sheet, horizontal swipe = previous/next session), so
// switching never depends on a strip that only fits ~2.5 truncated tabs.
export function MobileSessionSwitcher({
  items,
  activeId,
  onSelect,
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
  items: MobileSessionItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
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
  const sheetRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  // A committed swipe may also end in a click on the trigger (browser
  // dependent) — swallow a click arriving right after one, but only then, so
  // a later keyboard/mouse activation is never eaten.
  const swipedAtRef = useRef(0);

  const { onKeyDown: onTrapKeyDown } = useFocusTrap({ active: open, containerRef: sheetRef });
  const onSheetKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && renamingId === null) {
      e.stopPropagation();
      setOpen(false);
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
  const otherUnread = items.reduce(
    (sum, item) => (item.id === active?.id ? sum : sum + item.unreadCount),
    0,
  );
  const activeIndex = active ? items.indexOf(active) : -1;

  if (items.length === 0) {
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

  const select = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

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
          if (!start || !t) return;
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          if (Math.abs(dx) < SWIPE_COMMIT_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
          const target = active ? swipeTargetId(items, active.id, dx) : items[0].id;
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
        {otherUnread > 0 && (
          <span className="mobile-session-unread" aria-label={`${otherUnread} unread elsewhere`}>
            {otherUnread}
          </span>
        )}
        <ChevronDownIcon size={14} />
      </button>
      {open &&
        createPortal(
          <div
            className={`cmux-root${theme === "light" ? " light" : ""} mobile-session-backdrop`}
            onClick={() => setOpen(false)}
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
                <span>Sessions ({items.length})</span>
                <button
                  className="mobile-tab-btn"
                  aria-label="Close session list"
                  onClick={() => setOpen(false)}
                >
                  <CloseIcon size={14} />
                </button>
              </div>
              <ul className="mobile-session-list">
                {items.map((item) => {
                  const isActive = item.id === active?.id;
                  return (
                    <li key={item.id} className={`mobile-session-row${isActive ? " active" : ""}`}>
                      {renamingId === item.id ? (
                        <input
                          ref={renameInputRef}
                          className="mobile-session-rename-input"
                          aria-label="Session name"
                          value={renameDraft}
                          onChange={(e) => onRenameDraftChange(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") onRenameCommit();
                            else if (e.key === "Escape") onRenameCancel();
                          }}
                          onBlur={onRenameCommit}
                        />
                      ) : (
                        <button
                          className="mobile-session-row-main"
                          aria-current={isActive ? "true" : undefined}
                          onClick={() => select(item.id)}
                        >
                          <span
                            className="mobile-session-dot"
                            style={{ background: item.dotColor }}
                          />
                          {item.agentLogo && (
                            <img
                              src={item.agentLogo}
                              alt=""
                              width={16}
                              height={16}
                              className="mobile-session-logo"
                            />
                          )}
                          <span className="mobile-session-title">{item.title}</span>
                          {item.unreadCount > 0 && (
                            <span className="mobile-session-unread">{item.unreadCount}</span>
                          )}
                        </button>
                      )}
                      {isActive && renamingId !== item.id && renderActiveActions()}
                      <button
                        className="mobile-tab-btn"
                        title="Close pane — detaches your view, session keeps running"
                        aria-label={`Close ${item.title}`}
                        onClick={() => onClose(item.id)}
                      >
                        <CloseIcon size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button
                className="mobile-session-new"
                onClick={() => {
                  setOpen(false);
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
