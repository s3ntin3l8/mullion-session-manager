import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { eventKey, useDashboardStore } from "./store/index.js";
import { describeEvent, notifyKind, notifyLabel, notifySeverity } from "./eventDescriptions.js";
import { api } from "./api/index.js";
import type { NotificationEvent, Project, Session } from "./api/index.js";
import { BellIcon, BlockedIcon, CheckIcon, CloseIcon, WarningTriangleIcon } from "./ui/icons.js";
import { formatRelativeAge } from "./relativeTime.js";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { truncateHead } from "./lib/truncatePath.js";

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
// Making notifications relevant/scannable — the panel is a fixed-width
// popover (see the portal's inline style below), so this is a character
// budget calibrated by eye against that width, not a measured pixel value.
const NOTIF_ROW_TEXT_MAX = 72;

interface FeedHeaderItem {
  type: "header";
  sessionId: number;
  title: string;
  subtitle: string;
}

interface FeedEventItem {
  type: "event";
  sessionId: number;
  // The newest event in this row's group — its own seq/ts/payload drive the
  // row's icon/pill/text/age. See `foldedSeqs` below for why this alone
  // isn't enough to fully describe a collapsed row.
  event: NotificationEvent;
  read: boolean;
  // Making notifications relevant/scannable — every event this row
  // represents, newest first, always including `event.seq` itself
  // (`repeatCount === foldedSeqs.length`). A row that wasn't collapsed has
  // exactly one entry. Needed because dismissing a collapsed row must
  // dismiss every folded event, not just the one driving the display — see
  // EventRow's onDismiss below, and buildFeedItems'/foldConsecutiveRows' own
  // comments for why the read cursor doesn't need the same treatment.
  foldedSeqs: number[];
}

type FeedItem = FeedHeaderItem | FeedEventItem;

// Making notifications relevant/scannable — folds consecutive rows (already
// sorted newest-first by the caller) that would render IDENTICALLY into one
// row carrying a repeat count, so e.g. 25 auto-approved opencode
// `external_directory` permission asks for the same glob pattern show as one
// "×25" row instead of 25 visually-identical ones. "Identical" is
// (severity, described text) — text alone would also fold e.g. a `bell` and
// a `hookNotification` that happen to produce the same generic fallback
// text, which severity keeps distinct. Deliberately does NOT fold non-
// adjacent duplicates (an unrelated event in between breaks the run) — that
// preserves chronological reading order rather than reordering the feed
// around a foldable value.
function foldConsecutiveRows(
  rows: { event: NotificationEvent; read: boolean; text: string; severity: string | null }[],
): { event: NotificationEvent; read: boolean; foldedSeqs: number[] }[] {
  const folded: {
    event: NotificationEvent;
    read: boolean;
    foldedSeqs: number[];
    text: string;
    severity: string | null;
  }[] = [];
  for (const row of rows) {
    const last = folded[folded.length - 1];
    if (last && last.severity === row.severity && last.text === row.text) {
      last.foldedSeqs.push(row.event.seq);
      // The representative event stays the NEWEST of the group (`rows`
      // arrives newest-first, so `last` was already set from the first —
      // i.e. newest — row of this run) — `event`/`read`/`text`/`severity`
      // are intentionally left untouched here.
      continue;
    }
    folded.push({
      event: row.event,
      read: row.read,
      foldedSeqs: [row.event.seq],
      text: row.text,
      severity: row.severity,
    });
  }
  return folded.map(({ event, read, foldedSeqs }) => ({ event, read, foldedSeqs }));
}

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
  const groups: {
    session: Session;
    rows: { event: NotificationEvent; read: boolean; foldedSeqs: number[] }[];
  }[] = [];

  for (const session of sessions) {
    const sessionEvents = events[session.id];
    if (!sessionEvents || sessionEvents.length === 0) continue;
    const cursor = lastSeenSeq[session.id] ?? 0;
    const rawRows = sessionEvents
      .filter((e) => notifyKind(e) !== null && !dismissedEventKeys[eventKey(session.id, e.seq)])
      .map((e) => ({
        event: e,
        read: e.seq <= cursor,
        text: describeEvent(e)?.text ?? "Event",
        severity: notifySeverity(e),
      }))
      .sort((a, b) => b.event.seq - a.event.seq);
    const rows = foldConsecutiveRows(rawRows);
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
      items.push({
        type: "event",
        sessionId: group.session.id,
        event: row.event,
        read: row.read,
        foldedSeqs: row.foldedSeqs,
      });
    }
  }
  return items;
}

// P3 perf fix — buildFeedItems above does an O(sessions × up-to-200 events)
// filter+map, then sorts both the rows within each session AND the session
// groups themselves. Before this fix, it re-ran on every store update that
// touched `sessions` — including the 4s live-refresh poll tick, which gives
// `sessions` a fresh array identity regardless of whether any event/read-
// cursor actually changed — even while this panel was closed and nothing
// was rendering its output. The toolbar bell's unread badge, however, DOES
// need to stay live while closed. This does the same eligibility scan
// buildFeedItems does (notifyKind !== null, not dismissed, unseen) but
// without materializing or sorting a list — just a running count — so it
// stays cheap enough to run on every tick regardless of panel state. See
// the `items` useMemo below (gated on `open`) for where the expensive full
// build now actually happens.
// Making notifications relevant/scannable — deliberately counts RAW
// unread notify-worthy events, not folded groups: the toolbar badge is a
// magnitude indicator ("how much happened while you were away"), not a
// promise that exactly this many rows will be visible once the panel opens
// — replicating foldConsecutiveRows' sort-and-group work here would also
// defeat the whole point of this function existing separately from
// buildFeedItems (see the P3 perf fix comment above).
function countUnread(
  sessions: Session[],
  events: Record<number, NotificationEvent[]>,
  lastSeenSeq: Record<number, number>,
  dismissedEventKeys: Record<string, true>,
  mutedSessionIds: ReadonlyArray<number>,
): number {
  let count = 0;
  for (const session of sessions) {
    // #719 — a muted session doesn't count toward the toolbar's unread badge
    // (it's been deliberately silenced — see useAttentionNotifications.ts),
    // but its events still live in the feed/history when the panel is opened.
    // `.includes` directly on the array (no per-recompute Set allocation in
    // this hot path, per review).
    if (mutedSessionIds.includes(session.id)) continue;
    const sessionEvents = events[session.id];
    if (!sessionEvents || sessionEvents.length === 0) continue;
    const cursor = lastSeenSeq[session.id] ?? 0;
    for (const e of sessionEvents) {
      if (e.seq <= cursor) continue;
      if (notifyKind(e) === null) continue;
      if (dismissedEventKeys[eventKey(session.id, e.seq)]) continue;
      count += 1;
    }
  }
  return count;
}

// Stable reference for the closed-panel case — a fresh `[]` literal every
// render would give useVirtualizer/the length check a new identity for no
// reason, same anti-pattern P1 elsewhere in this PR removes for store
// selectors.
const EMPTY_FEED_ITEMS: FeedItem[] = [];

// Making notifications relevant/scannable — three-tier severity replaces
// the old bell-or-check binary (see eventDescriptions.ts's notifySeverity
// for the full tier rationale): "blocked" (needs a decision) gets its own
// distinct icon/color from "error" (something broke), which the old binary
// collapsed into the same generic bell. `notifySeverity` can return null for
// a shape neither table covers (defensive, not expected given feed items
// are always pre-filtered to notifyKind() !== null) — falls back to the old
// binary's "attention" treatment rather than rendering nothing.
function kindTreatment(event: NotificationEvent): { icon: ReactNode; className: string } {
  const severity =
    notifySeverity(event) ?? (notifyKind(event) === "attention" ? "blocked" : "done");
  switch (severity) {
    case "blocked":
      return { icon: <BlockedIcon size={13} />, className: "notif-sev-blocked" };
    case "error":
      return { icon: <WarningTriangleIcon size={13} />, className: "notif-sev-error" };
    case "done":
      return { icon: <CheckIcon size={13} />, className: "notif-sev-done" };
  }
}

export function NotificationBell({
  onOpenSession,
  onOpenTimeline,
  onOpenBrowser,
}: {
  onOpenSession: (session: Session) => void;
  // Issue #270 — the roadmap's own framing is that the timeline (2.8) is
  // this notification panel's per-session complement ("clicking a session
  // opens its timeline"), distinct from the sidebar/Kanban click paths which
  // deliberately keep opening the terminal. Optional so callers that don't
  // (yet) have a timeline concept fall back to onOpenSession, same shape as
  // NotificationBell.test.tsx already exercises for onOpenBrowser being
  // absent.
  onOpenTimeline?: (session: Session) => void;
  // Issue #404 — opens (or focuses) a project's preview pane once a
  // dev_server_detected offer is accepted, so the user lands straight on
  // the now-wired-up preview rather than having to find it themselves.
  onOpenBrowser: (projectId: number) => void;
}) {
  const theme = useDashboardStore((s) => s.theme);
  const sessions = useDashboardStore((s) => s.sessions);
  const projects = useDashboardStore((s) => s.projects);
  const events = useDashboardStore((s) => s.events);
  const lastSeenSeq = useDashboardStore((s) => s.lastSeenSeq);
  const dismissedEventKeys = useDashboardStore((s) => s.dismissedEventKeys);
  const markEventSeen = useDashboardStore((s) => s.markEventSeen);
  const dismissEvents = useDashboardStore((s) => s.dismissEvents);
  const mutedSessionIds = useDashboardStore((s) => s.mutedSessionIds);
  const openRequest = useDashboardStore((s) => s.notificationsPanelOpenRequest);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The expensive full build (filter + map + two sorts, see buildFeedItems'
  // own comment) only runs while the panel is actually open — `open` is in
  // the deps array specifically so this recomputes the moment the panel
  // opens (picking up whatever changed while it was closed), not just on
  // the next unrelated dependency change. While closed, this returns the
  // same EMPTY_FEED_ITEMS reference every time regardless of how often
  // `sessions`/`events`/etc. tick — the row list is never rendered while
  // closed anyway (see the `open && pos &&` guard below), so there's
  // nothing for a real list to do here but cost CPU.
  const items = useMemo(
    () =>
      open
        ? buildFeedItems(sessions, projects, events, lastSeenSeq, dismissedEventKeys)
        : EMPTY_FEED_ITEMS,
    [open, sessions, projects, events, lastSeenSeq, dismissedEventKeys],
  );
  // Deliberately NOT derived from `items` (unlike before this fix) — the
  // toolbar badge must stay accurate every tick regardless of whether the
  // panel is open, and countUnread (above) gets there without paying for
  // buildFeedItems' sort.
  const unreadCount = useMemo(
    () => countUnread(sessions, events, lastSeenSeq, dismissedEventKeys, mutedSessionIds),
    [sessions, events, lastSeenSeq, dismissedEventKeys, mutedSessionIds],
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
      // P11 — see PaneTab.tsx's identical outside-click handler for why
      // this suppresses the mousedown's own default focus shift: without
      // it, that default action (focus whatever was clicked, or
      // document.body) wins the race against useFocusTrap's restore-on-close
      // cleanup below.
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [open]);

  // P11 — this popover previously had no focus management: no role="dialog",
  // no focus-in on open, no Tab trap, no focus-restore on close. Same shared
  // hook as Settings/CommandPalette/PaneTab's menu. No `aria-modal` — same
  // "no backdrop, background stays interactive" rule as PaneTab's menu and
  // UnifiedBoard.tsx's drawer.
  const { onKeyDown: onTrapKeyDown, suppressRestore } = useFocusTrap({
    active: open,
    containerRef: panelRef,
  });
  // Escape scoped to the popover's own onKeyDown (bubbling), not a
  // window-level listener — same reasoning as PaneTab's menu/UnifiedBoard's
  // drawer: a global listener would also catch an Escape meant for some
  // other overlay (the command palette, Settings) sitting above the
  // toolbar.
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    onTrapKeyDown(e);
  };

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
            onKeyDown={onPanelKeyDown}
            role="dialog"
            aria-label="Notifications"
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
                              // P11 — opening a session/timeline moves focus
                              // to whatever it opened (a terminal pane, per
                              // PR13/U7); suppress the trap's restore so it
                              // doesn't fight that by snapping focus back to
                              // the bell button right after.
                              suppressRestore();
                              setOpen(false);
                              (onOpenTimeline ?? onOpenSession)(session);
                            }}
                            onOpenBrowser={onOpenBrowser}
                            onMarkRead={() => markEventSeen(item.sessionId, item.event.seq)}
                            // Making notifications relevant/scannable — a
                            // collapsed row dismisses EVERY folded seq, not
                            // just the newest: dismissedEventKeys is a
                            // per-event set (see this file's own header
                            // comment on why dismiss is deliberately NOT
                            // cursor-based), so dismissing only the head
                            // would resurrect the older folded rows on the
                            // very next render.
                            onDismiss={() => {
                              dismissEvents(item.sessionId, item.foldedSeqs);
                            }}
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
  onOpenBrowser,
  onMarkRead,
  onDismiss,
}: {
  item: FeedEventItem;
  session: Session | undefined;
  onOpen: (session: Session) => void;
  onOpenBrowser: (projectId: number) => void;
  onMarkRead: () => void;
  onDismiss: () => void;
}) {
  const described = describeEvent(item.event);
  const { icon, className } = kindTreatment(item.event);
  const age = formatRelativeAge(item.event.ts);
  const fullText = described?.text ?? "Event";
  // Making notifications relevant/scannable — head-truncated (see
  // truncatePath.ts's own comment for why: a permission summary's ONLY
  // distinguishing part is usually its tail, and CSS ellipsis cuts the
  // wrong end). The untruncated text stays in the row's aria-label/title so
  // nothing is actually lost, just not shown inline.
  const text = truncateHead(fullText, NOTIF_ROW_TEXT_MAX);
  const label = notifyLabel(item.event);
  const repeatCount = item.foldedSeqs.length;

  const open = () => {
    if (!session) return;
    onOpen(session);
  };

  // Minimal review gate (issue #178) — gated on the SESSION's own live
  // `gates` list, not just this event's own payload.state === "waiting":
  // once resolved, the gate disappears from that list but the original
  // "waiting" event row stays in the feed unchanged (each NotificationEvent
  // is an immutable point-in-time record — resolution appends a NEW
  // review_gate event rather than mutating this one). Keying off live state
  // means Approve/Deny disappears from this row the instant the gate is
  // actually resolved (by this click or a timeout elsewhere), rather than
  // staying clickable against an already-answered gate.
  //
  // Issue: correlate concurrent permission gates — matched by `gateId`, NOT
  // just `session?.gateState === "waiting"`: a session can now have more
  // than one gate waiting at once, and gateState alone would make EVERY
  // waiting-gate event row show Approve/Deny as long as ANY gate on the
  // session is pending, including one that isn't THIS row's. An event
  // predating this change (or a `gateId` that somehow doesn't match a
  // still-live gate) never matches `.some()` over an empty/mismatched
  // `gates` array, so it fails safe to "not pending" rather than showing a
  // dead pair of buttons.
  const isWaitingGateEvent =
    item.event.kind === "review_gate" && item.event.payload.state === "waiting";
  const eventGateId =
    isWaitingGateEvent && typeof item.event.payload.gateId === "string"
      ? item.event.payload.gateId
      : null;
  // A row with no gateId at all is a legacy/malformed event (an older
  // forwarder build predating gate correlation) — falls back to the OLDEST
  // still-waiting gate, the same fallback semantics
  // `POST /api/sessions/:id/review-gate`'s own `gateId`-omitted contract
  // uses server-side (routes/sessions.ts's reviewGateSchema), rather than
  // simply never matching and leaving a genuinely-still-pending gate with
  // no way to answer it from this row.
  const matchingGate = isWaitingGateEvent
    ? eventGateId !== null
      ? session?.gates.find((g) => g.gateId === eventGateId)
      : session?.gates[0]
    : undefined;
  const isPendingGate = matchingGate !== undefined;

  // Issue #404 — same "key off the session's own live state, not this
  // immutable event's payload" reasoning as isPendingGate above: accepting
  // or dismissing appends a NEW dev_server_detected event rather than
  // mutating this one, so Use/Dismiss must disappear the instant the
  // session's own pendingDevServerPort moves past this exact port (by this
  // click, or a decision made from another tab).
  const eventPort = typeof item.event.payload.port === "string" ? item.event.payload.port : null;
  const isPendingDevServer =
    item.event.kind === "dev_server_detected" &&
    item.event.payload.state === undefined &&
    eventPort !== null &&
    session?.pendingDevServerPort === eventPort;

  return (
    <div
      className={`notif-event-row${item.read ? " read" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={
        repeatCount > 1
          ? `${label}: ${fullText} — ${age}, repeated ${repeatCount} times`
          : `${label}: ${fullText} — ${age}`
      }
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") open();
      }}
    >
      <span className={`notif-event-icon ${className}`}>{icon}</span>
      <span className="notif-event-body">
        {/* Suppressed when the pill would just repeat the row's own text
            verbatim (e.g. a plain bell: SIGNAL_LABELS.bell === "Bell" and
            describeEvent's own text for it is also "Bell") — showing the
            same word twice is noise, not information. */}
        {label !== fullText && <span className="notif-event-kind-pill">{label}</span>}
        <span className="notif-event-text" title={fullText}>
          {text}
        </span>
        {repeatCount > 1 && <span className="notif-event-repeat">×{repeatCount}</span>}
        <span className="notif-event-time">{age}</span>
        {isPendingGate && matchingGate && (
          <GateActions sessionId={item.sessionId} gateId={matchingGate.gateId} />
        )}
        {isPendingDevServer && eventPort && (
          <DevServerActions
            sessionId={item.sessionId}
            port={eventPort}
            onAccepted={() => {
              if (session) onOpenBrowser(session.projectId);
            }}
          />
        )}
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

// Minimal review gate (issue #178) — Approve is a single click; Deny opens
// an inline optional-reason field rather than firing immediately, since a
// denial is the more consequential of the two and the reason is worth a
// beat to type. Both call POST /api/sessions/:id/review-gate directly; no
// optimistic local state is needed because the row's own visibility already
// reacts live once the store's next poll/event picks up the session's
// updated gateState (see EventRow's isPendingGate).
function GateActions({ sessionId, gateId }: { sessionId: number; gateId: string }) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const approve = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSubmitting(true);
    try {
      await api.resolveReviewGate(sessionId, gateId, "approved");
    } catch (err) {
      // Best-effort: a failed request (network hiccup, or the gate already
      // resolved/timed out elsewhere — most commonly, since issue #844, a
      // stale "waiting" row surviving a backend restart, whose 409 this
      // console.debug is what makes visible at all, since the row itself
      // just silently stays put) just leaves the row as-is — the next store
      // refresh reflects whatever the real gateState actually is.
      console.debug("[NotificationBell] resolveReviewGate(approved) failed", err);
    } finally {
      setSubmitting(false);
    }
  };

  const deny = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSubmitting(true);
    try {
      await api.resolveReviewGate(sessionId, gateId, "denied", reason.trim() || undefined);
    } catch (err) {
      // See approve()'s catch above.
      console.debug("[NotificationBell] resolveReviewGate(denied) failed", err);
    } finally {
      setSubmitting(false);
      setDenying(false);
    }
  };

  if (denying) {
    return (
      <span
        className="notif-gate-deny-form"
        onClick={(e) => e.stopPropagation()}
        // The row this renders inside (EventRow) treats a Space/Enter
        // keydown as "open this session" (its own keyboard-activation
        // handler, mirroring its role="button"/tabIndex=0) — without this,
        // typing a space into the reason field below bubbles up and closes
        // the whole notifications panel mid-keystroke.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <input
          className="notif-gate-deny-reason"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
        <button
          className="notif-gate-btn notif-gate-deny-confirm"
          disabled={submitting}
          onClick={deny}
        >
          Deny
        </button>
        <button
          className="notif-gate-btn"
          disabled={submitting}
          onClick={(e) => {
            e.stopPropagation();
            setDenying(false);
          }}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span
      className="notif-gate-actions"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button className="notif-gate-btn notif-gate-approve" disabled={submitting} onClick={approve}>
        Approve
      </button>
      <button
        className="notif-gate-btn notif-gate-deny"
        disabled={submitting}
        onClick={(e) => {
          e.stopPropagation();
          setDenying(true);
        }}
      >
        Deny
      </button>
    </span>
  );
}

// Issue #404 — accept/dismiss for a plain session's detected dev-server
// offer, following GateActions' own pattern above: no optimistic local
// state, since the row's visibility already reacts live once the store's
// next poll/event picks up the session's updated pendingDevServerPort (see
// EventRow's isPendingDevServer). "Use this port" patches the project's
// devServerUrl and creates/reuses its preview server-side (POST
// /api/sessions/:id/dev-server/accept) — the ALREADY-RUNNING dev server in
// this session is what gets wired up, not a new one spawned — then opens
// the preview pane via onAccepted so the user lands on it immediately.
function DevServerActions({
  sessionId,
  port,
  onAccepted,
}: {
  sessionId: number;
  port: string;
  onAccepted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  const accept = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSubmitting(true);
    try {
      await api.acceptDevServerPort(sessionId, port);
      onAccepted();
    } catch {
      // Best-effort — see GateActions' approve/deny catch above for why.
    } finally {
      setSubmitting(false);
    }
  };

  const dismiss = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSubmitting(true);
    try {
      await api.dismissDevServerPort(sessionId, port);
    } catch {
      // Best-effort.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <span
      className="notif-gate-actions"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button className="notif-gate-btn notif-gate-approve" disabled={submitting} onClick={accept}>
        Use this port
      </button>
      {/* Labeled "Ignore port", not "Dismiss" — the row's own generic
          "Dismiss" icon-button (remove this event from the feed entirely)
          sits right next to this one with the SAME accessible name
          ("Dismiss"), which would otherwise make the two indistinguishable
          both to a screen reader and to a test's getByRole lookup. */}
      <button className="notif-gate-btn notif-gate-deny" disabled={submitting} onClick={dismiss}>
        Ignore port
      </button>
    </span>
  );
}
