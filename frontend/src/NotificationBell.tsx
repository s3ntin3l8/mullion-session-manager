import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { BottomSheet } from "./ui/BottomSheet.js";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "@tanstack/react-virtual";
import { useDashboardStore } from "./store/index.js";
import { themeClassName } from "./store/theme.js";
import {
  describeEvent,
  notifyLabel,
  sessionContextMap,
  sessionGroupedSummary,
  sessionOpenDecisions,
} from "./eventDescriptions.js";
import type { GroupedSummary, OpenDecisionClass } from "./eventDescriptions.js";
import { api } from "./api/index.js";
import type { NotificationEvent, Project, Session, Task } from "./api/index.js";
import {
  BellIcon,
  BlockedIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  WarningTriangleIcon,
} from "./ui/icons.js";
import { formatRelativeAge } from "./relativeTime.js";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { usePresence } from "./hooks/usePresence.js";
import { useVisualViewportChange } from "./hooks/useVisualViewportChange.js";
import { truncateHead } from "./lib/truncatePath.js";
import { formatStatusLabel, STATUS_PRESENTATION } from "./sessionStatus.js";
import { panelPosition, railPanelPosition } from "./lib/notifPanelPosition.js";
import type { NotifPanelPosition } from "./lib/notifPanelPosition.js";
import { TextInput } from "./ui/primitives.js";

// The notification bell (#169, reworked by #3458/#3460; design note
// docs/design/notification-bell/note.md). It lists what waits on a human
// decision, not every event that rang:
//
// - Open decisions, grouped by session under a sticky header: a permission,
//   plan, question, review gate, promote request, dev-server offer, a failure
//   the agent will not recover from alone, a review verdict on a manual PR.
//   eventDescriptions.ts's bellClass says what kind of row an event is, and
//   sessionOpenDecisions whether it is still open, from the session's own
//   live state. A decision leaves the list when that state clears, however it
//   cleared; viewing the bell never clears it.
// - "Earlier, no decision needed": one collapsed line per session for the
//   informative events (a finished turn, an exit), never counted anywhere.
//
// Needs you is state; read is a cursor, and it applies only to the grouped
// lines. "Read" reuses issue #166's per-session `lastSeenSeq`, the cursor
// PaneTab.tsx's tab badges read. It is monotonic, so advancing it past a
// session's newest event would also mark that session's older decision
// events read: opening the bell and "Read all" only advance it for sessions
// with no open decision. "Dismiss" is a separate per-event set
// (`dismissedEventKeys`), so dismissing one row never touches another's read
// state.
//
// The badge is the number of sessions with an open decision (a muted session
// counts for nothing), not an unread count.

const HEADER_ROW_HEIGHT = 34;
const EVENT_ROW_ESTIMATE_HEIGHT = 60;
const GROUPED_LINE_ESTIMATE_HEIGHT = 44;
// Making notifications relevant/scannable — the panel is a fixed-width
// popover (see the portal's inline style below), so this is a character
// budget calibrated by eye against that width, not a measured pixel value.
const NOTIF_ROW_TEXT_MAX = 90;

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
  // row's icon/pill/age. See `foldedSeqs` below for why this alone isn't
  // enough to fully describe a collapsed row.
  event: NotificationEvent;
  cls: OpenDecisionClass;
  // Issue #903 — the row's actual display text, decided in buildFeedItems
  // BEFORE folding: describeEvent(event).text, unless that description is
  // `generic: true` (content-free) AND sessionContextMap has something better
  // for this event's own seq. Kept on the item so the substitution and the
  // fold decision can never disagree about what a row's text is.
  text: string;
  // Every event this row represents, newest first, always including
  // `event.seq` itself. Dismissing a collapsed row dismisses all of them.
  foldedSeqs: number[];
}

// The "Earlier, no decision needed" group's own header (#3460): a toggle,
// and the sticky header while its lines scroll under it.
interface FeedGroupedToggleItem {
  type: "grouped-toggle";
  sessionId: -1;
  count: number;
}

interface FeedGroupedLineItem {
  type: "grouped";
  sessionId: number;
  title: string;
  subtitle: string;
  summary: GroupedSummary;
  // Read as of when the panel opened: opening marks the lines read, and the
  // ones that were new stay marked new until it closes.
  read: boolean;
}

type FeedItem = FeedHeaderItem | FeedEventItem | FeedGroupedToggleItem | FeedGroupedLineItem;

// Folds consecutive rows (already newest-first) that would render
// identically into one row carrying a repeat count, so 25 permission asks
// for the same glob read as one "×25" row. "Identical" is (class, kind label,
// described text): the label keeps two different kinds that happen to share
// substituted context text apart. Non-adjacent duplicates are not folded, so
// the feed keeps its reading order.
function foldConsecutiveRows(
  rows: { event: NotificationEvent; cls: OpenDecisionClass; text: string; label: string }[],
): { event: NotificationEvent; cls: OpenDecisionClass; text: string; foldedSeqs: number[] }[] {
  const folded: {
    event: NotificationEvent;
    cls: OpenDecisionClass;
    text: string;
    label: string;
    foldedSeqs: number[];
  }[] = [];
  for (const row of rows) {
    const last = folded[folded.length - 1];
    if (last && last.cls === row.cls && last.label === row.label && last.text === row.text) {
      // The representative event stays the newest of the run.
      last.foldedSeqs.push(row.event.seq);
      continue;
    }
    folded.push({ ...row, foldedSeqs: [row.event.seq] });
  }
  return folded.map(({ event, cls, text, foldedSeqs }) => ({ event, cls, text, foldedSeqs }));
}

/** The session ids a Task Master task owns (its worker and its reviewer): a
 * task's PR news is the Tasks section's to show, not a session row's. */
function taskOwnedSessionIds(tasks: readonly Task[]): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const t of tasks) {
    if (t.sessionId !== null) ids.add(t.sessionId);
    if (t.reviewSessionId !== null) ids.add(t.reviewSessionId);
  }
  return ids;
}

function sessionTitle(session: Session): string {
  return session.name || session.command;
}

// The feed as one flat, virtualizable list: a header per session with an
// open decision, then its decision rows newest first (sessions ordered by
// their newest decision); then the grouped toggle and, when expanded, one
// line per session with informative events (newest first). Muted sessions
// still list their decisions (they can still be acted on from here); they
// only do not count.
function buildFeedItems(
  sessions: Session[],
  projects: Project[],
  events: Record<number, NotificationEvent[]>,
  readCursor: Record<number, number>,
  dismissedEventKeys: Record<string, true>,
  taskOwned: ReadonlySet<number>,
): FeedItem[] {
  const groups: {
    session: Session;
    rows: ReturnType<typeof foldConsecutiveRows>;
  }[] = [];
  const grouped: { session: Session; summary: GroupedSummary }[] = [];

  for (const session of sessions) {
    const sessionEvents = events[session.id];
    if (!sessionEvents || sessionEvents.length === 0) continue;
    const decisions = sessionOpenDecisions(
      session,
      sessionEvents,
      dismissedEventKeys,
      false,
      taskOwned.has(session.id),
    );
    if (decisions.length > 0) {
      // Issue #903 — one context map per session, built once up front.
      const contextMap = sessionContextMap(sessionEvents, sessionTitle(session));
      const rows = foldConsecutiveRows(
        decisions.map(({ event, cls }) => {
          const described = describeEvent(event);
          // Only a content-free row's own text is ever replaced.
          const context = described?.generic ? contextMap.get(event.seq) : undefined;
          return {
            event,
            cls,
            text: context ?? described?.text ?? "Event",
            label: notifyLabel(event),
          };
        }),
      );
      groups.push({ session, rows });
    }
    const summary = sessionGroupedSummary(
      session.id,
      sessionEvents,
      readCursor[session.id] ?? 0,
      dismissedEventKeys,
      decisions.some((d) => d.event.kind === "session_end"),
    );
    if (summary) grouped.push({ session, summary });
  }

  groups.sort((a, b) => b.rows[0].event.ts - a.rows[0].event.ts);
  grouped.sort((a, b) => b.summary.newestTs - a.summary.newestTs);

  const projectName = (session: Session) =>
    projects.find((p) => p.id === session.projectId)?.name ?? "Unknown project";
  const items: FeedItem[] = [];
  for (const group of groups) {
    items.push({
      type: "header",
      sessionId: group.session.id,
      title: sessionTitle(group.session),
      subtitle: projectName(group.session),
    });
    for (const row of group.rows) {
      items.push({ type: "event", sessionId: group.session.id, ...row });
    }
  }
  if (grouped.length > 0) {
    items.push({
      type: "grouped-toggle",
      sessionId: -1,
      count: grouped.length,
    });
    // Built whether or not the group is expanded: "Read all" reads them.
    for (const { session, summary } of grouped) {
      items.push({
        type: "grouped",
        sessionId: session.id,
        title: sessionTitle(session),
        subtitle: projectName(session),
        summary,
        read: !summary.unread,
      });
    }
  }
  return items;
}

/** Sessions that need you: an open decision, not muted (#3458). The badge,
 * the sheet's "Needs you" count and its filter all read this one set, so they
 * cannot disagree. Two linear passes per session, no sort: it runs on every
 * live tick, panel open or not. */
function collectNeedsYouIds(
  sessions: Session[],
  events: Record<number, NotificationEvent[]>,
  dismissedEventKeys: Record<string, true>,
  mutedSessionIds: ReadonlyArray<number>,
  taskOwned: ReadonlySet<number>,
): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const session of sessions) {
    const open = sessionOpenDecisions(
      session,
      events[session.id],
      dismissedEventKeys,
      mutedSessionIds.includes(session.id),
      taskOwned.has(session.id),
    );
    if (open.length > 0) ids.add(session.id);
  }
  return ids;
}

// Stable reference for the closed-panel case — a fresh `[]` literal every
// render would give useVirtualizer/the length check a new identity for no
// reason.
const EMPTY_FEED_ITEMS: FeedItem[] = [];

// The row's icon and colour: a decision is "blocked" (waiting on you), a
// failure "error"; a review verdict reads as what it says (changes requested
// is red, an approval green).
function kindTreatment(item: FeedEventItem): { icon: ReactNode; className: string } {
  const severity =
    item.cls === "decision"
      ? "blocked"
      : item.cls === "failed" || item.event.payload.decision === "CHANGES_REQUESTED"
        ? "error"
        : "done";
  switch (severity) {
    case "blocked":
      return { icon: <BlockedIcon size={13} />, className: "notif-sev-blocked" };
    case "error":
      return { icon: <WarningTriangleIcon size={13} />, className: "notif-sev-error" };
    case "done":
      return { icon: <CheckIcon size={13} />, className: "notif-sev-done" };
  }
}

function needsYouText(count: number): string {
  return count > 0 ? `${count} need${count === 1 ? "s" : ""} you` : "nothing needs you";
}

export function NotificationBell({
  onOpenSession,
  onOpenTimeline,
  onOpenBrowser,
  sheet = false,
  sheetClassName,
  placement = "below",
  triggerClassName = "toolbar-icon-btn",
  label,
  labelClassName,
  iconSize = 17,
  onOpenChange,
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
  // Render the feed as a full-height bottom sheet (tap a row = open the
  // session's terminal, "Needs you | All" filter, 44px targets) instead of
  // the desktop dropdown popover. Set on the phone tier and on touch
  // tablets; a mouse-driven desktop/tablet window leaves it unset and gets
  // the popover exactly as before.
  sheet?: boolean;
  // Extra class on the sheet (e.g. the tablet variant that caps its width).
  sheetClassName?: string;
  // Where the popover opens: under the bell (the phone's top bar) or beside it,
  // growing upward from its bottom edge (the left rail's bottom cluster, #3009).
  placement?: "below" | "beside";
  // The trigger's class: the rail's icon button, or the phone tab bar's entry.
  triggerClassName?: string;
  // A visible label under the icon, which also names the trigger (the phone
  // tab bar's "Inbox" entry, #3288). Without one the trigger is icon-only and
  // named "Notifications".
  label?: string;
  // The visible label's class (the tab bar's own label style).
  labelClassName?: string;
  // The bell's size: the tab bar's entries draw theirs at 20.
  iconSize?: number;
  // Told when the feed opens or closes (the phone tab bar returns focus to
  // its Inbox entry itself when the sheet closed while the bar was hidden).
  onOpenChange?: (open: boolean) => void;
}) {
  const theme = useDashboardStore((s) => s.theme);
  const sessions = useDashboardStore((s) => s.sessions);
  const openRightSidebarPr = useDashboardStore((s) => s.openRightSidebarPr);
  const projects = useDashboardStore((s) => s.projects);
  const events = useDashboardStore((s) => s.events);
  const tasks = useDashboardStore((s) => s.tasks);
  const lastSeenSeq = useDashboardStore((s) => s.lastSeenSeq);
  const dismissedEventKeys = useDashboardStore((s) => s.dismissedEventKeys);
  const markSessionRead = useDashboardStore((s) => s.markSessionRead);
  const dismissEvents = useDashboardStore((s) => s.dismissEvents);
  const ackAttention = useDashboardStore((s) => s.ackAttention);
  const mutedSessionIds = useDashboardStore((s) => s.mutedSessionIds);

  const [open, setOpen] = useState(false);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    onOpenChangeRef.current?.(open);
  }, [open]);
  // Sheet only: decisions alone, or everything (the grouped lines too).
  const [filter, setFilter] = useState<"needs" | "all">("all");
  // "Earlier, no decision needed" starts collapsed.
  const [groupedExpanded, setGroupedExpanded] = useState(false);
  // The read cursors as they were when the panel opened: the grouped lines'
  // "new" marking reads this, so the lines opening marked read stay marked
  // new until the panel closes (#3460).
  const [openCursor, setOpenCursor] = useState<Record<number, number>>({});
  const [pos, setPos] = useState<NotifPanelPosition | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const taskOwned = useMemo(() => taskOwnedSessionIds(tasks), [tasks]);

  // The badge, the sheet's "Needs you" count and its filter: one set,
  // computed every tick (cheap: see collectNeedsYouIds).
  const needsYouIds = useMemo(
    () => collectNeedsYouIds(sessions, events, dismissedEventKeys, mutedSessionIds, taskOwned),
    [sessions, events, dismissedEventKeys, mutedSessionIds, taskOwned],
  );
  const needsYouCount = needsYouIds.size;

  // The full build (describe, fold, sort) only runs while the panel is open:
  // while closed this returns the same EMPTY_FEED_ITEMS reference whatever
  // ticks, and nothing renders it anyway.
  const allItems = useMemo(
    () =>
      open
        ? buildFeedItems(sessions, projects, events, openCursor, dismissedEventKeys, taskOwned)
        : EMPTY_FEED_ITEMS,
    [open, sessions, projects, events, openCursor, dismissedEventKeys, taskOwned],
  );
  // The grouped lines hide while their group is collapsed.
  const items = useMemo(
    () => (groupedExpanded ? allItems : allItems.filter((i) => i.type !== "grouped")),
    [allItems, groupedExpanded],
  );
  // What the sheet lists under "Needs you": the decision rows of the sessions
  // that count. The desktop popover always shows everything.
  const shownItems = useMemo(
    () =>
      sheet && filter === "needs"
        ? items.filter(
            (i) => (i.type === "header" || i.type === "event") && needsYouIds.has(i.sessionId),
          )
        : items,
    [sheet, filter, items, needsYouIds],
  );

  // Sessions whose grouped lines "Read all" may mark: no open decision, and
  // something left to read or acknowledge (a new line, or a raised
  // "Finished" the sidebar still shows).
  // Listed decisions, muted sessions' included: a muted session counts for
  // nothing, but its cursor still must not move past its open decision.
  const readAllIds = useMemo(() => {
    const withDecision = new Set(
      allItems.filter((i) => i.type === "event").map((i) => i.sessionId),
    );
    const ids: number[] = [];
    for (const item of allItems) {
      if (item.type !== "grouped" || withDecision.has(item.sessionId)) continue;
      const session = sessions.find((s) => s.id === item.sessionId);
      if (!item.read || session?.attention) ids.push(item.sessionId);
    }
    return ids;
  }, [allItems, sessions]);

  // Opening the panel marks the grouped lines read, for the sessions with no
  // open decision: the cursor is monotonic and shared with the tab badges,
  // so advancing it for a session with an open decision would mark that
  // decision's events read too. Never acknowledges: that is "Read all".
  const markGroupedRead = () => {
    for (const session of sessions) {
      const sessionEvents = events[session.id];
      if (!sessionEvents || sessionEvents.length === 0) continue;
      const cursor = lastSeenSeq[session.id] ?? 0;
      if (sessionEvents[sessionEvents.length - 1].seq <= cursor) continue;
      const decisions = sessionOpenDecisions(
        session,
        sessionEvents,
        dismissedEventKeys,
        false,
        taskOwned.has(session.id),
      );
      if (decisions.length > 0) continue;
      const summary = sessionGroupedSummary(
        session.id,
        sessionEvents,
        cursor,
        dismissedEventKeys,
        false,
      );
      if (summary?.unread) markSessionRead(session.id);
    }
  };

  // Issue #1229 — sticky group headers. Plain CSS `position: sticky` can't
  // work here: every row (headers included) is absolutely positioned with
  // `transform: translateY(...)` below, which removes it from the sticky
  // containing block entirely. This is TanStack Virtual's own documented
  // workaround (its "Sticky" example) instead: every header's index goes in
  // `stickyIndexes`; `rangeExtractor` — called on every scroll/resize — always
  // adds "whichever sticky header index is the last one at or before the
  // current top-of-viewport row" (activeStickyIndexRef) to the rendered
  // range, REGARDLESS of whether that header's own row is actually scrolled
  // into view. The grouped toggle is a header too, so the last session's
  // header does not stay pinned over the grouped lines.
  const stickyIndexes = useMemo(
    () =>
      items.reduce<number[]>((acc, item, index) => {
        if (item.type === "header" || item.type === "grouped-toggle") acc.push(index);
        return acc;
      }, []),
    [items],
  );
  const activeStickyIndexRef = useRef(0);
  const rangeExtractor = useCallback(
    (range: Range) => {
      activeStickyIndexRef.current =
        [...stickyIndexes].reverse().find((index) => range.startIndex >= index) ?? 0;
      const next = new Set([activeStickyIndexRef.current, ...defaultRangeExtractor(range)]);
      return [...next].sort((a, b) => a - b);
    },
    [stickyIndexes],
  );

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const type = items[index]?.type;
      if (type === "header" || type === "grouped-toggle") return HEADER_ROW_HEIGHT;
      if (type === "grouped") return GROUPED_LINE_ESTIMATE_HEIGHT;
      return EVENT_ROW_ESTIMATE_HEIGHT;
    },
    overscan: 8,
    rangeExtractor,
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
  // UnifiedBoard.tsx's drawer. Popover only (`!sheet`) — the bottom sheet
  // below is a ui/BottomSheet.tsx, which runs its own instance of this same
  // hook against the very same `panelRef`; without this gate both instances
  // would fight over focus-in/restore-on-close on the one DOM node.
  // Initial focus goes to the dialog itself (tabIndex -1 below): its rows are
  // virtualized and mount a frame after it opens, and with no "Read all" to
  // land on, a first-focusable lookup would find nothing and leave focus
  // outside, where the panel's own Escape handler never hears the key.
  const { onKeyDown: onTrapKeyDown, suppressRestore } = useFocusTrap({
    active: !sheet && open,
    containerRef: panelRef,
    initialFocusRef: panelRef,
  });
  // #3015 — stays mounted while it leaves (styles/motion.css plays the exit).
  const { present: panelPresent, state: panelPresence } = usePresence(!sheet && open, panelRef);
  // The phone sheet's own suppressRestore (a separate useFocusTrap instance,
  // above) — written to by BottomSheet during render, read by the phone
  // row-tap handlers below, same U7 race useFocusTrap.ts's own doc comment
  // covers for the desktop popover's `suppressRestore` right above.
  const phoneSuppressRestoreRef = useRef<(() => void) | null>(null);
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

  // A resize or orientation change can move the bell (the phone's top bar,
  // the left rail) while the panel is open — recompute rather than leave
  // it anchored to a stale rect. Issue #1399 — same for an iOS visual-viewport
  // pan/resize: since #1398 `.app` (toolbar and bell included) tracks the
  // visual viewport's offsetTop, which moves without a window `resize`.
  const reposition = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos(
      placement === "beside"
        ? railPanelPosition(rect, window.innerWidth, window.innerHeight)
        : panelPosition(rect, window.innerWidth),
    );
  }, [placement]);
  useVisualViewportChange(open, reposition);

  // "Read all" (#3460): the grouped lines of the sessions with no open
  // decision. Advances each to its latest seq (also clearing its tab badges)
  // and acknowledges it (clearing a "Finished" the sidebar shows). A session
  // with an open decision is left alone: see markGroupedRead.
  const markAllRead = () => {
    for (const sessionId of readAllIds) {
      markSessionRead(sessionId);
      // Issue #1430 — "Read all" is an explicit action.
      ackAttention(sessionId);
    }
    setOpenCursor((prev) => {
      const next = { ...prev };
      for (const sessionId of readAllIds) next[sessionId] = Number.MAX_SAFE_INTEGER;
      return next;
    });
  };

  // Leaving the panel for whatever a row opens. `suppress` keeps the focus
  // trap from snapping focus back to the bell once the target has it (P11,
  // PR13/U7); the sheet and the popover each have their own.
  const suppress = () => (sheet ? phoneSuppressRestoreRef.current?.() : suppressRestore());
  const openSessionFromRow = (session: Session) => {
    suppress();
    setOpen(false);
    // Issue #1429 — one click destination everywhere (the sheet, push, the
    // ?session= deep link): the terminal, marked read. The timeline is a
    // secondary action.
    markSessionRead(session.id);
    ackAttention(session.id);
    onOpenSession(session);
  };
  const openPrFromRow = (session: Session, number: number) => {
    suppress();
    setOpen(false);
    markSessionRead(session.id);
    ackAttention(session.id);
    openRightSidebarPr(session.projectId, number);
  };
  const openTimelineFromRow = onOpenTimeline
    ? (session: Session) => {
        suppress();
        setOpen(false);
        onOpenTimeline(session);
      }
    : undefined;

  const renderItem = (item: FeedItem): ReactNode => {
    const session = sessions.find((s) => s.id === item.sessionId);
    switch (item.type) {
      case "header":
        return <FeedHeader item={item} session={session} />;
      case "grouped-toggle":
        return (
          <GroupedToggle
            item={item}
            expanded={groupedExpanded}
            onToggle={() => setGroupedExpanded((v) => !v)}
          />
        );
      case "grouped":
        return (
          <GroupedLine
            item={item}
            session={session}
            onOpen={openSessionFromRow}
            onDismiss={() => dismissEvents(item.sessionId, item.summary.seqs)}
          />
        );
      case "event":
        return (
          <EventRow
            item={item}
            session={session}
            onOpen={openSessionFromRow}
            // The phone has no right sidebar: a PR row opens the terminal.
            onOpenPr={sheet ? undefined : openPrFromRow}
            // The sheet's tap opens the terminal, so the timeline (this
            // panel's per-session complement) is its own action there.
            onTimeline={openTimelineFromRow}
            onOpenBrowser={onOpenBrowser}
            // A collapsed row dismisses every folded seq, not just the
            // newest: dismissedEventKeys is per event, so dismissing only the
            // head would resurrect the older folded rows on the next render.
            onDismiss={() => {
              dismissEvents(item.sessionId, item.foldedSeqs);
              ackAttention(item.sessionId);
            }}
          />
        );
    }
  };

  const hasDecisions = items.some((i) => i.type === "event");
  const readAllButton = (className: string) =>
    readAllIds.length > 0 && (
      <button
        className={className}
        onClick={markAllRead}
        title="Mark the rows that need no decision read"
      >
        <CheckIcon size={className === "notif-mark-all-btn" ? 12 : 13} />
        Read all
      </button>
    );

  return (
    <>
      <button
        ref={btnRef}
        className={triggerClassName}
        title={
          needsYouCount > 0 ? `Notifications — ${needsYouText(needsYouCount)}` : "Nothing needs you"
        }
        // Issue #1894 — "dialog", not the generic "true". `aria-haspopup="true"`
        // maps to `menu` in the ARIA spec, so assistive technology was told
        // this trigger opens a menu; what it opens is the notifications
        // panel, which carries `role="dialog"` (the desktop popover) or is
        // a `ui/BottomSheet.tsx` on the phone — itself `role="dialog"`.
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label ?? "Notifications"}, ${needsYouText(needsYouCount)}`}
        onClick={(e) => {
          e.stopPropagation();
          // iOS does not focus a tapped button, and the sheet returns focus to
          // what was focused when it opened: this trigger, then (#3288).
          e.currentTarget.focus();
          if (!open && btnRef.current) {
            reposition();
            // Opens on "Needs you" when something does, else everything.
            setFilter(needsYouCount > 0 ? "needs" : "all");
            setOpenCursor(lastSeenSeq);
            markGroupedRead();
          }
          setOpen((v) => !v);
        }}
      >
        <BellIcon size={iconSize} aria-hidden="true" />
        {/* The label before the badge, so "Inbox 3" reads in the name's order. */}
        {label && (
          <>
            <span className={labelClassName}>{label}</span>{" "}
          </>
        )}
        {needsYouCount > 0 && <span className="attention-badge">{needsYouCount}</span>}
      </button>
      {sheet && (
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          label="Notifications"
          closeLabel="Close notifications"
          title="Notifications"
          sheetClassName={`mobile-notif-sheet${sheetClassName ? ` ${sheetClassName}` : ""}`}
          // Android / browser back closes the sheet on any tier that renders it
          // (phone and touch tablet), via usePhoneBackStack's compact contract.
          backStack
          sheetRef={panelRef}
          suppressRestoreRef={phoneSuppressRestoreRef}
          headerActions={filter === "all" && readAllButton("mobile-notif-readall")}
        >
          <div className="mobile-notif-filters" role="group" aria-label="Filter notifications">
            <button
              className={`mobile-notif-filter${filter === "needs" ? " active" : ""}`}
              aria-pressed={filter === "needs"}
              onClick={() => setFilter("needs")}
            >
              Needs you{needsYouCount > 0 ? ` ${needsYouCount}` : ""}
            </button>
            <button
              className={`mobile-notif-filter${filter === "all" ? " active" : ""}`}
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              All
            </button>
          </div>
          <div className="mobile-notif-scroll">
            {!shownItems.some((i) => i.type === "event") && (
              <div className="notif-empty">
                {filter === "needs" || shownItems.length > 0
                  ? "Nothing needs you right now"
                  : "No notifications yet"}
              </div>
            )}
            {/* Direct children of the scroller, not wrapped: a wrapper would
                confine each sticky header to its own box. */}
            {shownItems.map((item) => (
              <Fragment
                key={`${item.type}-${item.sessionId}-${"event" in item ? item.event.seq : 0}`}
              >
                {renderItem(item)}
              </Fragment>
            ))}
          </div>
        </BottomSheet>
      )}
      {panelPresent &&
        !sheet &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            data-presence={panelPresence}
            inert={panelPresence === "leaving"}
            className={themeClassName(theme, "pane-tab-overflow-menu", "notif-panel")}
            // Every side is set: the shared `.pane-tab-overflow-menu` shell
            // (terminal.css) carries `top: 31px; right: 6px` for PaneTab's
            // in-pane menu. The rail's bell sets only `bottom`, and with the
            // panel's height capped by max-height a leftover `top` wins over
            // `bottom`, which pinned the panel to the window's top edge
            // instead of beside the bell (#3072).
            style={{ position: "fixed", top: "auto", right: "auto", bottom: "auto", ...pos }}
            // Opening upward from the rail's bell, it grows from its bottom
            // edge (styles/motion.css), toward the bell it came from.
            data-placement={placement === "beside" ? "top" : undefined}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onPanelKeyDown}
            role="dialog"
            aria-label="Notifications"
            tabIndex={-1}
          >
            <div className="notif-panel-header">
              <span className="notif-panel-title">Notifications</span>
              {readAllButton("notif-mark-all-btn")}
            </div>
            {!hasDecisions && (
              <div className="notif-empty">
                {items.length > 0 ? "Nothing needs you right now" : "No notifications yet"}
              </div>
            )}
            {items.length > 0 && (
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
                    // Issue #1229 — the active sticky row (see rangeExtractor
                    // above) switches from the normal virtualized "absolute +
                    // translateY" positioning to `sticky`, pinning it to the
                    // top of `.notif-feed-scroll`. Only one row is ever sticky.
                    const isActiveSticky =
                      (item.type === "header" || item.type === "grouped-toggle") &&
                      virtualRow.index === activeStickyIndexRef.current;
                    return (
                      <div
                        key={virtualRow.key}
                        data-index={virtualRow.index}
                        ref={rowVirtualizer.measureElement}
                        style={
                          isActiveSticky
                            ? { position: "sticky", top: 0, left: 0, width: "100%", zIndex: 1 }
                            : {
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${virtualRow.start}px)`,
                              }
                        }
                      >
                        {renderItem(item)}
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

// "Earlier, no decision needed" (#3460): the header of the informative lines,
// and the button that shows or hides them. Styled as a group header, so it
// pins the same way while its lines scroll.
function GroupedToggle({
  item,
  expanded,
  onToggle,
}: {
  item: FeedGroupedToggleItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="notif-group-header notif-grouped-header">
      <button
        type="button"
        className="notif-grouped-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span className="notif-group-header-title">Earlier, no decision needed</span>
        <span className="notif-grouped-count">{item.count}</span>
      </button>
    </div>
  );
}

// One informative line per session: "finished", "exited", or both, with the
// newest one's age. Opens the session; Dismiss drops every grouped event the
// line stands for.
function GroupedLine({
  item,
  session,
  onOpen,
  onDismiss,
}: {
  item: FeedGroupedLineItem;
  session: Session | undefined;
  onOpen: (session: Session) => void;
  onDismiss: () => void;
}) {
  const what = [item.summary.finished && "finished", item.summary.exited && "exited"]
    .filter(Boolean)
    .join(", ");
  const age = formatRelativeAge(item.summary.newestTs);
  const open = () => {
    if (session) onOpen(session);
  };
  return (
    <div className={`notif-event-row notif-grouped-line${item.read ? " read" : ""}`} onClick={open}>
      {/* Same structure as EventRow (#3106): the row is a plain container,
          the keyboard gets this one open button. */}
      <button
        type="button"
        className="visually-hidden row-open-btn notif-event-open"
        aria-label={`${item.title} ${what} — ${item.subtitle}, ${age}${item.read ? "" : ", new"}`}
      />
      <span className="notif-event-icon notif-sev-done">
        <CheckIcon size={13} />
      </span>
      <span className="notif-event-body">
        <span className="notif-event-text" title={`${item.title} ${what}`}>
          <span className="notif-grouped-title">{item.title}</span> {what}
        </span>
        <span className="notif-event-time">{age}</span>
      </span>
      <span className="notif-event-actions">
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

// Issue #1229 — live status alongside the group header's title/subtitle,
// answering "is this still stuck?" without leaving the panel. `session` is
// looked up at render time by the caller (same `sessions.find(...)` idiom
// EventRow already uses below), NOT snapshotted onto FeedHeaderItem — that
// keeps buildFeedItems' memoized output identity untouched and lets the
// status track the same 4s live-poll tick the rest of the panel already
// rides on `sessions` for.
function FeedHeader({ item, session }: { item: FeedHeaderItem; session: Session | undefined }) {
  const presentation = session ? STATUS_PRESENTATION[session.sessionStatus] : null;
  return (
    <div className="notif-group-header">
      <div className="notif-group-header-top">
        <span className="notif-group-header-title">{item.title}</span>
        {presentation && (
          <span className="notif-group-header-status">
            {/* Hermes review, PR #1284 — no `.session-dot-exited` class
                exists (styles/sidebar.css only defines attention/error/
                finished/idle/permission/plan/working), so an exited
                session's dot would otherwise render as an unstyled
                zero-width span. Mirrors Sidebar.tsx's own special-case:
                CloseIcon instead of a colored dot for "exited". */}
            {session?.sessionStatus === "exited" ? (
              <CloseIcon size={10} style={{ color: "var(--dim)" }} />
            ) : (
              <span className={`session-dot-${presentation.tone}`} />
            )}
            <span className={`session-status-label ${presentation.tone}`}>
              {/* Issue #1227 — "compact" explicit, not relying on
                  showDetail being false for every awaiting_* status: once
                  #1227 flips showDetail to true for four of them (with up to
                  a 200-char gatePrompt/promoteSummary), this 380x380px
                  popover has no room for the verbose form. */}
              {formatStatusLabel(presentation, session?.sessionStatusDetail ?? null, "compact")}
            </span>
          </span>
        )}
      </div>
      <span className="notif-group-header-subtitle">{item.subtitle}</span>
    </div>
  );
}

function EventRow({
  item,
  session,
  onOpen,
  onOpenPr,
  onTimeline,
  onOpenBrowser,
  onDismiss,
}: {
  item: FeedEventItem;
  session: Session | undefined;
  onOpen: (session: Session) => void;
  // Desktop only (the phone has no right sidebar): a pr_* event's row opens
  // its PR in the sidebar instead of the session's terminal, which stays one
  // click away on the row's "Session" button.
  onOpenPr?: (session: Session, number: number) => void;
  // The row's tap opens the terminal, so the timeline (this panel's
  // per-session complement) is its own action.
  onTimeline?: (session: Session) => void;
  onOpenBrowser: (projectId: number) => void;
  onDismiss: () => void;
}) {
  const { icon, className } = kindTreatment(item);
  const age = formatRelativeAge(item.event.ts);
  // Issue #903 — buildFeedItems already decided this row's actual text
  // (describeEvent's own text, or a sessionContextMap substitute for a
  // generic row — see FeedEventItem.text's own comment); re-deriving via
  // describeEvent(item.event) here would only recompute the PRE-
  // substitution text and, for a folded row, disagree with whatever text
  // the fold decision above was actually keyed on.
  const fullText = item.text;
  // Making notifications relevant/scannable — head-truncated (see
  // truncatePath.ts's own comment for why: a permission summary's ONLY
  // distinguishing part is usually its tail, and CSS ellipsis cuts the
  // wrong end). The untruncated text stays in the row's aria-label/title so
  // nothing is actually lost, just not shown inline.
  const text = truncateHead(fullText, NOTIF_ROW_TEXT_MAX);
  const label = notifyLabel(item.event);
  const repeatCount = item.foldedSeqs.length;

  const prNumber =
    item.event.kind.startsWith("pr_") && typeof item.event.payload.number === "number"
      ? item.event.payload.number
      : null;
  const open = () => {
    if (!session) return;
    if (onOpenPr && prNumber !== null) onOpenPr(session, prNumber);
    else onOpen(session);
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
      // A decision row has no read state: it stays until its decision is
      // answered or dismissed (#3460).
      className="notif-event-row"
      // #3106 — a plain container, not a role="button": the row holds its own
      // buttons (Approve/Deny, Session, Timeline, Dismiss), and a
      // control inside a control is axe's nested-interactive. A pointer still
      // opens by clicking anywhere on it (each nested control stops its own
      // click); the keyboard gets the one real button below, first in tab
      // order, and the row's other controls are their own tab stops after it.
      onClick={open}
    >
      {/* No onClick of its own: Enter/Space fire a click that bubbles to the
          row's onClick, so it opens exactly once. The name carries the full
          text the row truncates; the button shows nothing itself, so there is
          no visible text for the name to mismatch. */}
      <button
        type="button"
        className="visually-hidden row-open-btn notif-event-open"
        aria-label={
          repeatCount > 1
            ? `${label}: ${fullText} — ${age}, repeated ${repeatCount} times`
            : `${label}: ${fullText} — ${age}`
        }
      />
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
        {onOpenPr && prNumber !== null && session && (
          <button
            className="notif-timeline-btn"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(session);
            }}
          >
            Session
          </button>
        )}
        {onTimeline && session && (
          <button
            className="notif-timeline-btn"
            onClick={(e) => {
              e.stopPropagation();
              onTimeline(session);
            }}
          >
            Timeline
          </button>
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
        // Keeps the reason field's keystrokes to itself. The row this renders
        // in used to open on Space/Enter anywhere inside it, which closed the
        // panel mid-keystroke; since #3106 only its own open button does, but
        // the panel above still reads keydowns (Escape closes it).
        onKeyDown={(e) => e.stopPropagation()}
      >
        <TextInput
          small
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
