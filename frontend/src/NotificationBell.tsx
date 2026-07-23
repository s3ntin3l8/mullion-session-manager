import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { eventKey, useDashboardStore } from "./store.js";
import { describeEvent, notifyKind } from "./eventDescriptions.js";
import type { NotificationEvent, Project, Session } from "./api.js";
import { BellIcon, CheckIcon, CloseIcon } from "./icons.js";
import { formatRelativeAge } from "./relativeTime.js";

// The toolbar bell, upgraded for issue #169 from a per-session "who's
// currently ringing" list into an actual event feed: one row per buffered
// NotificationEvent (issue #166's store.ts `events` slice), grouped by
// session and sorted by recency, with past — already-read — events staying
// visible rather than disappearing the moment a session stops needing
// attention. Structurally still modeled on KebabMenu.tsx's portal-dropdown
// pattern (position:fixed off the trigger's own getBoundingClientRect(), an
// outside-click listener, and reapplying the `cmux-root`/`light` theme
// classes on the portaled node — see this component's prior history for why
// that last one is load-bearing).
//
// Read/dismiss state design (see store.ts for the fields themselves):
// - "Read" reuses issue #166's existing `lastSeenSeq` read cursor — the
//   same primitive PaneTab.tsx's tab badges already consume — rather than
//   inventing a second one: an event is read once `seq <= lastSeenSeq`, and
//   the per-event "mark read" button here just advances that cursor to the
//   event's own seq (store.ts's markEventSeen, unchanged from #168). This
//   is why the panel's read state and the tab badges can never disagree.
// - "Dismiss" is a genuinely different operation — "stop listing this
//   forever", not "I've seen it" — so it's backed by its own
//   `dismissedEventKeys` set (store.ts) instead of also moving the cursor.
//   Coupling dismiss to the read cursor would be actively wrong: cursors
//   are monotonic per session, so dismissing the *newest* of several unread
//   events would advance the cursor past all the older still-listed ones
//   too, silently marking them read even though the user only dismissed
//   one. Keeping the two orthogonal avoids that.
//
// Feed inclusion is intentionally narrower than "every buffered event this
// session has": only the two kinds eventDescriptions.ts's `notifyKind`
// already treats as an actual notification (an attention signal actually
// ringing, and a program exiting) are shown here — not routine, high-
// frequency chatter like every OSC title update or every alt-screen
// open/close. This is the same filter PaneTab.tsx's own tab badge uses, so
// this panel's feed and unread count stay consistent with what the tabs are
// already showing, rather than surfacing "unread" items no tab badge agrees
// are notification-worthy.

const HEADER_ROW_HEIGHT = 34;
const EVENT_ROW_ESTIMATE_HEIGHT = 60;

interface FeedHeaderItem {
  type: "header";
  sessionId: number;
  title: string;
  subtitle: string;
}

interface FeedEventItem {
  type: "event";
  sessionId: number;
  event: NotificationEvent;
  read: boolean;
}

type FeedItem = FeedHeaderItem | FeedEventItem;

// Turns the raw per-session event slices into one flat, virtualizable list:
// a header row per session (only sessions with at least one feed-eligible,
// non-dismissed event), followed by that session's events newest-first.
// Sessions themselves are ordered by their own newest feed event, so the
// session that rang most recently always leads.
function buildFeedItems(
  sessions: Session[],
  projects: Project[],
  events: Record<number, NotificationEvent[]>,
  lastSeenSeq: Record<number, number>,
  dismissedEventKeys: Record<string, true>,
): FeedItem[] {
  const groups: { session: Session; rows: { event: NotificationEvent; read: boolean }[] }[] = [];

  for (const session of sessions) {
    const sessionEvents = events[session.id];
    if (!sessionEvents || sessionEvents.length === 0) continue;
    const cursor = lastSeenSeq[session.id] ?? 0;
    const rows = sessionEvents
      .filter((e) => notifyKind(e) !== null && !dismissedEventKeys[eventKey(session.id, e.seq)])
      .map((e) => ({ event: e, read: e.seq <= cursor }))
      .sort((a, b) => b.event.seq - a.event.seq);
    if (rows.length > 0) groups.push({ session, rows });
  }

  groups.sort((a, b) => b.rows[0].event.ts - a.rows[0].event.ts);

  const items: FeedItem[] = [];
  for (const group of groups) {
    const project = projects.find((p) => p.id === group.session.projectId);
    items.push({
      type: "header",
      sessionId: group.session.id,
      title: group.session.name || group.session.command,
      subtitle: project?.name ?? "Unknown project",
    });
    for (const row of group.rows) {
      items.push({ type: "event", sessionId: group.session.id, event: row.event, read: row.read });
    }
  }
  return items;
}

// Feed items are always pre-filtered to notifyKind() !== null (see
// buildFeedItems), so this only ever sees the two kinds it's built for.
function kindTreatment(event: NotificationEvent): { icon: ReactNode; className: string } {
  return notifyKind(event) === "attention"
    ? { icon: <BellIcon size={13} />, className: "attention" }
    : { icon: <CheckIcon size={13} />, className: "exited" };
}

export function NotificationBell({ onOpenSession }: { onOpenSession: (session: Session) => void }) {
  const theme = useDashboardStore((s) => s.theme);
  const sessions = useDashboardStore((s) => s.sessions);
  const projects = useDashboardStore((s) => s.projects);
  const events = useDashboardStore((s) => s.events);
  const lastSeenSeq = useDashboardStore((s) => s.lastSeenSeq);
  const dismissedEventKeys = useDashboardStore((s) => s.dismissedEventKeys);
  const markEventSeen = useDashboardStore((s) => s.markEventSeen);
  const dismissEvent = useDashboardStore((s) => s.dismissEvent);
  const openRequest = useDashboardStore((s) => s.notificationsPanelOpenRequest);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () => buildFeedItems(sessions, projects, events, lastSeenSeq, dismissedEventKeys),
    [sessions, projects, events, lastSeenSeq, dismissedEventKeys],
  );
  const unreadCount = useMemo(
    () => items.filter((i) => i.type === "event" && !i.read).length,
    [items],
  );

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      items[index]?.type === "header" ? HEADER_ROW_HEIGHT : EVENT_ROW_ESTIMATE_HEIGHT,
    overscan: 8,
  });

  useEffect(() => {
    if (!open) return;
    const onOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [open]);

  // The toolbar's mobile breakpoint (styles.css's max-width:699px block)
  // changes .toolbar-lead's width, so the bell can move under the panel on a
  // resize/orientation-change while it's open — recompute rather than leave
  // it anchored to a stale rect.
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      if (!btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, left: rect.left });
    };
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open]);

  // Issue #170: a desktop notification's onclick handler bumps
  // `notificationsPanelOpenRequest` via the store (this component can't be
  // reached with a prop from App.tsx — see that field's own comment) instead
  // of setting `open` directly. The ref starts equal to the current value so
  // the initial render never opens the panel — only an actual *change*
  // (a fresh click) does, same "transition, not level" shape as the
  // seenAttentionRef-style effects this issue's App.tsx side replaces.
  const openRequestRef = useRef(openRequest);
  useEffect(() => {
    if (openRequest === openRequestRef.current) return;
    openRequestRef.current = openRequest;
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: rect.left });
    setOpen(true);
  }, [openRequest]);

  // Advances every session with at least one unread feed item to that
  // session's true latest seq (across ALL its buffered events, not just the
  // notification-worthy ones shown here) — the same "seen everything"
  // semantics PaneTab.tsx's own mark-seen-on-focus effect uses, so this also
  // fully clears those sessions' tab badges, not just this panel's view.
  const markAllRead = () => {
    const unreadSessionIds = new Set(
      items
        .filter((i): i is FeedEventItem => i.type === "event" && !i.read)
        .map((i) => i.sessionId),
    );
    for (const sessionId of unreadSessionIds) {
      const maxSeq = (events[sessionId] ?? []).reduce((max, e) => Math.max(max, e.seq), 0);
      if (maxSeq > 0) markEventSeen(sessionId, maxSeq);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        className="toolbar-icon-btn"
        title={
          unreadCount > 0 ? `Notifications — ${unreadCount} unread` : "No unread notifications"
        }
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={
          unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications, none unread"
        }
        onClick={(e) => {
          e.stopPropagation();
          if (!open && btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 6, left: rect.left });
          }
          setOpen((v) => !v);
        }}
      >
        <BellIcon size={17} />
        {unreadCount > 0 && <span className="attention-badge">{unreadCount}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className={`cmux-root${theme === "light" ? " light" : ""} pane-tab-overflow-menu notif-panel`}
            style={{ position: "fixed", top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="notif-panel-header">
              <span className="notif-panel-title">Notifications</span>
              {unreadCount > 0 && (
                <button
                  className="notif-mark-all-btn"
                  onClick={markAllRead}
                  title="Mark all as read"
                >
                  <CheckIcon size={12} />
                  Mark all read
                </button>
              )}
            </div>
            {items.length === 0 ? (
              <div className="notif-empty">No notifications yet</div>
            ) : (
              <div ref={scrollRef} className="notif-feed-scroll">
                <div
                  style={{
                    height: rowVirtualizer.getTotalSize(),
                    position: "relative",
                    width: "100%",
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const item = items[virtualRow.index];
                    return (
                      <div
                        key={virtualRow.key}
                        data-index={virtualRow.index}
                        ref={rowVirtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        {item.type === "header" ? (
                          <div className="notif-group-header">
                            <span className="notif-group-header-title">{item.title}</span>
                            <span className="notif-group-header-subtitle">{item.subtitle}</span>
                          </div>
                        ) : (
                          <EventRow
                            item={item}
                            session={sessions.find((s) => s.id === item.sessionId)}
                            onOpen={(session) => {
                              setOpen(false);
                              onOpenSession(session);
                            }}
                            onMarkRead={() => markEventSeen(item.sessionId, item.event.seq)}
                            onDismiss={() => dismissEvent(item.sessionId, item.event.seq)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function EventRow({
  item,
  session,
  onOpen,
  onMarkRead,
  onDismiss,
}: {
  item: FeedEventItem;
  session: Session | undefined;
  onOpen: (session: Session) => void;
  onMarkRead: () => void;
  onDismiss: () => void;
}) {
  const described = describeEvent(item.event);
  const { icon, className } = kindTreatment(item.event);
  const age = formatRelativeAge(item.event.ts);
  const text = described?.text ?? "Event";

  const open = () => {
    if (!session) return;
    onOpen(session);
  };

  return (
    <div
      className={`notif-event-row${item.read ? " read" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${text} — ${age}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") open();
      }}
    >
      <span className={`notif-event-icon ${className}`}>{icon}</span>
      <span className="notif-event-body">
        <span className="notif-event-text">{text}</span>
        <span className="notif-event-time">{age}</span>
      </span>
      <span className="notif-event-actions">
        {!item.read && (
          <button
            className="notif-event-action-btn"
            title="Mark read"
            aria-label="Mark read"
            onClick={(e) => {
              e.stopPropagation();
              onMarkRead();
            }}
          >
            <CheckIcon size={11} />
          </button>
        )}
        <button
          className="notif-event-action-btn"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <CloseIcon size={11} />
        </button>
      </span>
    </div>
  );
}
