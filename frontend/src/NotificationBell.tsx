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
import { BellIcon, CheckIcon, CloseIcon } from "./ui/icons.js";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { usePresence } from "./hooks/usePresence.js";
import { useVisualViewportChange } from "./hooks/useVisualViewportChange.js";
import { usePhoneBackStack } from "./hooks/usePhoneBackStack.js";
import { needsYouTasks } from "./github/taskMasterSummary.js";
import { useOpenTask } from "./hooks/useOpenTask.js";
import {
  buildFeedItems,
  collectNeedsYouIds,
  EMPTY_FEED_ITEMS,
  EVENT_ROW_ESTIMATE_HEIGHT,
  GROUPED_LINE_ESTIMATE_HEIGHT,
  HEADER_ROW_HEIGHT,
  filterFeedItems,
  needsYouText,
  sessionChipOptions,
  taskChipOptions,
  taskOwnedSessionIds,
} from "./notification-bell/feed.js";
import type { FeedItem, SessionsFilter, TasksFilter } from "./notification-bell/feed.js";
import {
  EventRow,
  FeedHeader,
  GroupedLine,
  GroupedToggle,
  SectionSwitch,
  StatusChips,
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
  touch = false,
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
  // The phone: the feed is a full-height bottom sheet (#3461; tap a row =
  // open its target, 44px targets). Everywhere else it is one full-height
  // side panel beside the left rail that holds the bell (#3462).
  sheet?: boolean;
  // A touch tablet: the side panel is wider (480px), modal over a scrim, and
  // the back gesture closes it. A mouse-driven window gets it at 420px with
  // no scrim; Esc and an outside click close it on both.
  touch?: boolean;
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
  const setBellReturn = useDashboardStore((s) => s.setBellReturn);
  const bellReturn = useDashboardStore((s) => s.bellReturn);

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
  // The status chips (#3461): one per section, each remembered while the
  // other section shows.
  const [sessionsFilter, setSessionsFilter] = useState<SessionsFilter>("all");
  const [tasksFilter, setTasksFilter] = useState<TasksFilter>("needs");
  // "Earlier, no decision needed" starts collapsed.
  const [groupedExpanded, setGroupedExpanded] = useState(false);
  // The read cursors as they were when the panel opened: the grouped lines'
  // "new" marking reads this, so the lines opening marked read stay marked
  // new until the panel closes (#3460).
  const [openCursor, setOpenCursor] = useState<Record<number, number>>({});
  // The side panel's left edge: the right edge of the rail that holds the
  // bell (#3462).
  const [panelLeft, setPanelLeft] = useState<number | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const taskOwned = useMemo(() => taskOwnedSessionIds(tasks), [tasks]);

  // The badge, the Sessions count and its "Needs you" chip: one set,
  // computed every tick (cheap: see collectNeedsYouIds).
  const needsYouIds = useMemo(
    () => collectNeedsYouIds(sessions, events, dismissedEventKeys, mutedSessionIds, taskOwned),
    [sessions, events, dismissedEventKeys, mutedSessionIds, taskOwned],
  );
  const sessionsCount = needsYouIds.size;
  // The Tasks section: every task that needs a human, from the same store
  // `tasks` the rail's badge reads.
  const taskEntries = useMemo(
    // Each entry carries its reason and kind from the one definition
    // (taskNeedsYou), so they cannot drift.
    () => needsYouTasks(tasks),
    [tasks],
  );
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
  // What the Sessions section lists under its chip, the grouped lines hidden
  // while their group is collapsed.
  const items = useMemo(
    () =>
      filterFeedItems(allItems, sessionsFilter, needsYouIds).filter(
        (i) => groupedExpanded || i.type !== "grouped",
      ),
    [allItems, sessionsFilter, needsYouIds, groupedExpanded],
  );
  const sessionChips = useMemo(
    () => sessionChipOptions(allItems, sessionsCount, sessionsFilter),
    [allItems, sessionsCount, sessionsFilter],
  );
  const shownTasks = useMemo(
    () =>
      tasksFilter === "needs" ? taskEntries : taskEntries.filter((e) => e.kind === tasksFilter),
    [taskEntries, tasksFilter],
  );
  const taskChips = useMemo(
    () => taskChipOptions(taskEntries, tasksFilter),
    [taskEntries, tasksFilter],
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
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const ids: number[] = [];
    for (const item of allItems) {
      if (item.type !== "grouped" || withDecision.has(item.sessionId)) continue;
      const session = byId.get(item.sessionId);
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
    if (!open || sheet) return;
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
  }, [open, sheet]);

  // P11 — focus management for the side panel: dialog semantics, focus in on
  // open, a Tab trap, focus back to the bell on close. The phone's sheet is a
  // ui/BottomSheet.tsx, which runs its own instance of this same hook against
  // the very same `panelRef`; the `!sheet` gate keeps the two from fighting.
  // Initial focus goes to the dialog itself (tabIndex -1 below): its rows are
  // virtualized and mount a frame after it opens, and a first-focusable
  // lookup could land on nothing and leave focus outside, where the panel's
  // own Escape handler never hears the key.
  const { onKeyDown: onTrapKeyDown, suppressRestore } = useFocusTrap({
    active: !sheet && open,
    containerRef: panelRef,
    initialFocusRef: panelRef,
  });
  // #3015 — stays mounted while it leaves (styles/motion.css plays the exit).
  const { present: panelPresent, state: panelPresence } = usePresence(!sheet && open, panelRef);
  // A touch tablet's panel is modal, so the back gesture closes it, as it
  // closed the bottom sheet it replaces (usePhoneBackStack's compact contract).
  usePhoneBackStack(!sheet && touch && open, () => setOpen(false));
  // The phone sheet's own suppressRestore (a separate useFocusTrap instance,
  // above) — written to by BottomSheet during render, read by the phone
  // row-tap handlers below, same U7 race useFocusTrap.ts's own doc comment
  // covers for the side panel's `suppressRestore` right above.
  const phoneSuppressRestoreRef = useRef<(() => void) | null>(null);
  // Escape scoped to the panel's own onKeyDown (bubbling), not a window-level
  // listener: a global listener would also catch an Escape meant for some
  // other overlay (the command palette, Settings) above it.
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    onTrapKeyDown(e);
  };

  // The panel's left edge follows the rail: a resize or an orientation change
  // can move it while the panel is open. Issue #1399 — same for an iOS
  // visual-viewport pan, which moves without a window `resize`.
  const reposition = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rail = btn.closest(".left-rail") ?? btn;
    setPanelLeft(Math.round(rail.getBoundingClientRect().right));
  }, []);
  useVisualViewportChange(open && !sheet, reposition);

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

  // Opens the panel: on the state a row left it in, when coming back from
  // that row's target (#3463, consumed once); otherwise on the section with
  // something to decide (Sessions first, and Sessions when neither has
  // anything) with its "Needs you" chip when it has something.
  const openPanel = () => {
    reposition();
    const back = bellReturn;
    if (back) {
      setBellReturn(null);
      setSection(back.section);
      if (back.section === "sessions") setSessionsFilter(back.filter as SessionsFilter);
      else setTasksFilter(back.filter as TasksFilter);
    } else {
      setSection(sessionsCount === 0 && tasksCount > 0 ? "tasks" : "sessions");
      setSessionsFilter(sessionsCount > 0 ? "needs" : "all");
      setTasksFilter("needs");
    }
    setOpenCursor(lastSeenSeq);
    markGroupedRead();
    setOpen(true);
  };
  const openPanelRef = useRef(openPanel);
  useEffect(() => {
    openPanelRef.current = openPanel;
  });
  // The phone's back gesture from a row's target asks the bell to reopen
  // itself (App.tsx, #3463).
  const reopenSeq = useDashboardStore((s) => s.bellReopenSeq);
  const lastReopenSeq = useRef(reopenSeq);
  useEffect(() => {
    if (reopenSeq === lastReopenSeq.current) return;
    lastReopenSeq.current = reopenSeq;
    openPanelRef.current();
  }, [reopenSeq]);

  // Leaving the panel for whatever a row opens. `suppress` keeps the focus
  // trap from snapping focus back to the bell once the target has it (P11,
  // PR13/U7); the sheet and the panel each have their own. `remember` runs
  // after the target opened, so a mode switch the target made (a session row
  // from Tasks mode) does not clear the return it writes (#3463).
  const suppress = () => (sheet ? phoneSuppressRestoreRef.current?.() : suppressRestore());
  const leaveFor = (go: () => void) => {
    suppress();
    setOpen(false);
    go();
    setBellReturn({
      section,
      filter: section === "sessions" ? sessionsFilter : tasksFilter,
    });
  };
  const openSessionFromRow = (session: Session) =>
    leaveFor(() => {
      // Issue #1429 — one click destination everywhere (the sheet, push, the
      // ?session= deep link): the terminal, in Workspace, marked read. The
      // timeline is a secondary action.
      markSessionRead(session.id);
      ackAttention(session.id);
      onOpenSession(session);
    });
  const openPrFromRow = (session: Session, number: number) =>
    leaveFor(() => {
      markSessionRead(session.id);
      ackAttention(session.id);
      openRightSidebarPr(session.projectId, number);
    });
  // A task row asks the one "show me this task" entry point; it does not
  // pick the surface itself.
  const openTaskFromRow = (taskId: number) => leaveFor(() => openTask(taskId));
  const openTimelineFromRow = onOpenTimeline
    ? (session: Session) => leaveFor(() => onOpenTimeline(session))
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

  const readAllButton = (className: string) =>
    section === "sessions" &&
    sessionsFilter === "all" &&
    readAllIds.length > 0 && (
      <button
        className={className}
        onClick={markAllRead}
        title="Mark the rows that need no decision read"
      >
        <CheckIcon size={13} />
        Read all
      </button>
    );

  // The panel's contents, the same on every tier (#3462): the section switch
  // with its counts and the status chips stay put at the top; the list under
  // them scrolls.
  const controls = (
    <>
      <SectionSwitch
        section={section}
        sessionsCount={sessionsCount}
        tasksCount={tasksCount}
        onSelect={setSection}
      />
      {section === "sessions" ? (
        <StatusChips
          options={sessionChips}
          selected={sessionsFilter}
          onSelect={(v) => setSessionsFilter(v as SessionsFilter)}
        />
      ) : (
        <StatusChips
          options={taskChips}
          selected={tasksFilter}
          onSelect={(v) => setTasksFilter(v as TasksFilter)}
        />
      )}
    </>
  );
  const taskList =
    shownTasks.length === 0 ? (
      <div className="notif-empty">No task needs you</div>
    ) : (
      shownTasks.map(({ task, reason, kind }) => (
        <TaskRow
          key={task.id}
          title={task.title}
          project={task.projectName}
          reason={reason}
          kind={kind}
          onOpen={() => openTaskFromRow(task.id)}
        />
      ))
    );
  const emptySessions = !items.some((i) => i.type === "event") && (
    <div className="notif-empty">
      {sessionsFilter === "all" && items.length === 0
        ? "No notifications yet"
        : "Nothing needs you right now"}
    </div>
  );

  return (
    <>
      <button
        ref={btnRef}
        className={triggerClassName}
        title={
          needsYouCount > 0 ? `Notifications — ${needsYouText(needsYouCount)}` : "Nothing needs you"
        }
        // Issue #1894 — "dialog", not the generic "true", which maps to
        // `menu`: what this opens is the notifications panel or sheet, both
        // `role="dialog"`.
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label ?? "Notifications"}, ${needsYouText(needsYouCount)}`}
        onClick={(e) => {
          e.stopPropagation();
          // iOS does not focus a tapped button, and the sheet returns focus to
          // what was focused when it opened: this trigger, then (#3288).
          e.currentTarget.focus();
          if (open) setOpen(false);
          else openPanel();
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
          // Full height (#3461): the section switch and the chips pinned at
          // the top, the list scrolling under them.
          sheetClassName="mobile-notif-sheet"
          // The back gesture closes the sheet (usePhoneBackStack).
          backStack
          sheetRef={panelRef}
          suppressRestoreRef={phoneSuppressRestoreRef}
          headerActions={readAllButton("mobile-notif-readall")}
        >
          {controls}
          <div className="mobile-notif-scroll">
            {section === "tasks" ? (
              taskList
            ) : (
              <>
                {emptySessions}
                {/* Direct children of the scroller, not wrapped: a wrapper
                    would confine each sticky header to its own box. */}
                {items.map((item) => (
                  <Fragment
                    key={`${item.type}-${item.sessionId}-${"event" in item ? item.event.seq : 0}`}
                  >
                    {renderItem(item)}
                  </Fragment>
                ))}
              </>
            )}
          </div>
        </BottomSheet>
      )}
      {panelPresent &&
        !sheet &&
        panelLeft !== null &&
        createPortal(
          <>
            {touch && (
              // The touch tablet's scrim: modal, and a tap on it closes.
              <div
                className={themeClassName(theme, "motion-scrim", "notif-scrim")}
                data-presence={panelPresence}
                style={{ left: panelLeft }}
                aria-hidden="true"
                onClick={() => setOpen(false)}
              />
            )}
            <div
              ref={panelRef}
              data-presence={panelPresence}
              inert={panelPresence === "leaving"}
              className={themeClassName(
                theme,
                "pane-tab-overflow-menu",
                "notif-panel",
                touch && "notif-panel--touch",
              )}
              style={{ left: panelLeft }}
              // It slides out of the rail's edge (styles/motion.css).
              data-placement="side"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={onPanelKeyDown}
              role="dialog"
              aria-label="Notifications"
              aria-modal={touch || undefined}
              tabIndex={-1}
            >
              <div className="notif-panel-header">
                <span className="notif-panel-title">Notifications</span>
                <span className="notif-panel-header-actions">
                  {readAllButton("notif-mark-all-btn")}
                  <button
                    type="button"
                    className="notif-panel-close"
                    aria-label="Close notifications"
                    title="Close (Esc)"
                    onClick={() => setOpen(false)}
                  >
                    <CloseIcon size={14} />
                  </button>
                </span>
              </div>
              {controls}
              {section === "tasks" && <div className="notif-feed-scroll">{taskList}</div>}
              {section === "sessions" && emptySessions}
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
                      // Issue #1229 — the active sticky row (see
                      // rangeExtractor above) switches from the normal
                      // virtualized "absolute + translateY" positioning to
                      // `sticky`, pinned to the top of `.notif-feed-scroll`.
                      // Only one row is ever sticky.
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
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
