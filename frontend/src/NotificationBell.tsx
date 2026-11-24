import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { BottomSheet } from "./ui/BottomSheet.js";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "@tanstack/react-virtual";
import { useDashboardStore } from "./store/index.js";
import { themeClassName } from "./store/theme.js";
import { sessionGroupedSummary, sessionOpenDecisions } from "./eventDescriptions.js";
import type { Session } from "./api/index.js";
import { BellIcon, CheckIcon } from "./ui/icons.js";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { usePresence } from "./hooks/usePresence.js";
import { useVisualViewportChange } from "./hooks/useVisualViewportChange.js";
import { panelPosition, railPanelPosition } from "./lib/notifPanelPosition.js";
import type { NotifPanelPosition } from "./lib/notifPanelPosition.js";
import { needsYouTasks, taskNeedsYouKind } from "./github/taskMasterSummary.js";
import { useOpenTask } from "./hooks/useOpenTask.js";
import {
  buildFeedItems,
  collectNeedsYouIds,
  EMPTY_FEED_ITEMS,
  EVENT_ROW_ESTIMATE_HEIGHT,
  GROUPED_LINE_ESTIMATE_HEIGHT,
  HEADER_ROW_HEIGHT,
  needsYouText,
  taskOwnedSessionIds,
} from "./notification-bell/feed.js";
import type { FeedItem } from "./notification-bell/feed.js";
import {
  EventRow,
  FeedHeader,
  GroupedLine,
  GroupedToggle,
  SectionSwitch,
  TaskRow,
} from "./notification-bell/rows.js";

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
// Two sections (#3459), each with its own needs-you count: Sessions (the
// above) and Tasks, the tasks Task Master holds for a human
// (taskMasterSummary.ts's needsYouTasks, the same list behind the rail's and
// the phone bar's Tasks badge, so the three can never disagree). Tasks have no
// events, so that section is a live list of derived state: no read state, no
// dismiss; a task leaves when its state clears.
//
// The badge is the sum of the two needs-you counts (a muted session counts for
// nothing), not an unread count.

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
  const [section, setSection] = useState<"sessions" | "tasks">("sessions");
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
  const sessionsCount = needsYouIds.size;
  // The Tasks section: every task that needs a human, from the same store
  // `tasks` the rail's badge reads.
  const taskEntries = useMemo(() => needsYouTasks(tasks), [tasks]);
  const tasksCount = taskEntries.length;
  const needsYouCount = sessionsCount + tasksCount;
  const openTask = useOpenTask();

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
  // A task row asks the one "show me this task" entry point; it does not
  // pick the surface itself.
  const openTaskFromRow = (taskId: number) => {
    suppress();
    setOpen(false);
    openTask(taskId);
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

  const sectionSwitch = (
    <SectionSwitch
      section={section}
      sessionsCount={sessionsCount}
      tasksCount={tasksCount}
      onSelect={setSection}
    />
  );
  const taskList =
    taskEntries.length === 0 ? (
      <div className="notif-empty">No task needs you</div>
    ) : (
      taskEntries.map(({ task, reason }) => (
        <TaskRow
          key={task.id}
          title={task.title}
          project={task.projectName}
          reason={reason}
          kind={taskNeedsYouKind(task) ?? "failed"}
          onOpen={() => openTaskFromRow(task.id)}
        />
      ))
    );

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
            // Opens on the section with something to decide: Sessions
            // first, and Sessions when neither has anything.
            setSection(sessionsCount === 0 && tasksCount > 0 ? "tasks" : "sessions");
            // Opens on "Needs you" when a session does, else everything.
            setFilter(sessionsCount > 0 ? "needs" : "all");
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
          headerActions={
            section === "sessions" && filter === "all" && readAllButton("mobile-notif-readall")
          }
        >
          {sectionSwitch}
          {section === "tasks" ? (
            <div className="mobile-notif-scroll">{taskList}</div>
          ) : (
            <>
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
            </>
          )}
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
              {section === "sessions" && readAllButton("notif-mark-all-btn")}
            </div>
            {sectionSwitch}
            {section === "tasks" && <div className="notif-feed-scroll">{taskList}</div>}
            {section === "sessions" && !hasDecisions && (
              <div className="notif-empty">
                {items.length > 0 ? "Nothing needs you right now" : "No notifications yet"}
              </div>
            )}
            {section === "sessions" && items.length > 0 && (
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
