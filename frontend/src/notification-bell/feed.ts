// The bell's feed model (#3458, #3460): what NotificationBell.tsx lists, as
// one flat virtualizable list, and the needs-you set its badge counts.
import {
  describeEvent,
  notifyLabel,
  sessionContextMap,
  sessionGroupedSummary,
  sessionOpenDecisions,
} from "../eventDescriptions.js";
import { decisionCategory } from "../eventDescriptions.js";
import type { DecisionCategory, GroupedSummary, OpenDecisionClass } from "../eventDescriptions.js";
import type { NotificationEvent, Project, Session, Task } from "../api/index.js";
import type { TaskNeedsYouKind } from "../github/taskMasterSummary.js";
export const HEADER_ROW_HEIGHT = 34;
export const EVENT_ROW_ESTIMATE_HEIGHT = 60;
export const GROUPED_LINE_ESTIMATE_HEIGHT = 44;
// Making notifications relevant/scannable — the panel is a fixed-width
// popover (see the portal's inline style below), so this is a character
// budget calibrated by eye against that width, not a measured pixel value.
export const NOTIF_ROW_TEXT_MAX = 90;

export interface FeedHeaderItem {
  type: "header";
  sessionId: number;
  title: string;
  subtitle: string;
}

export interface FeedEventItem {
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
export interface FeedGroupedToggleItem {
  type: "grouped-toggle";
  sessionId: -1;
  count: number;
}

export interface FeedGroupedLineItem {
  type: "grouped";
  sessionId: number;
  title: string;
  subtitle: string;
  summary: GroupedSummary;
  // Read as of when the panel opened: opening marks the lines read, and the
  // ones that were new stay marked new until it closes.
  read: boolean;
}

export type FeedItem = FeedHeaderItem | FeedEventItem | FeedGroupedToggleItem | FeedGroupedLineItem;

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
export function taskOwnedSessionIds(tasks: readonly Task[]): ReadonlySet<number> {
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
export function buildFeedItems(
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
export function collectNeedsYouIds(
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
export const EMPTY_FEED_ITEMS: FeedItem[] = [];

export function needsYouText(count: number): string {
  return count > 0 ? `${count} need${count === 1 ? "s" : ""} you` : "nothing needs you";
}

// A task row's kind pill (#3459).
export const TASK_KIND_LABEL: Record<TaskNeedsYouKind, string> = {
  failed: "Failed",
  review: "Review",
  stopped: "Stopped",
};

// ---- Status chips (#3461) ----------------------------------------------------
// One row of single-select chips per section. Sessions: "Needs you" (the open
// decisions of the sessions that count), "All" (every open decision, muted
// sessions' too, and the grouped lines), and one chip per decision category
// (decisionCategory, derived from bellClass). Tasks: "Needs you" (every task
// that needs a human) and one chip per kind (taskNeedsYouKind). Tasks has no
// "All": it lists open items only, so "All" would be "Needs you" again.

export type SessionsFilter = "needs" | "all" | DecisionCategory;
export type TasksFilter = "needs" | TaskNeedsYouKind;

export interface ChipOption {
  value: string;
  label: string;
  count: number | null;
}

const CATEGORY_LABEL: Record<DecisionCategory, string> = {
  permission: "Permission",
  plan: "Plan",
  question: "Question",
  failed: "Failed",
  review: "Review",
};

/** The Sessions section's rows under `filter`: a category keeps its rows and
 * the headers of the sessions that still have one. */
export function filterFeedItems(
  items: FeedItem[],
  filter: SessionsFilter,
  needsYouIds: ReadonlySet<number>,
): FeedItem[] {
  if (filter === "all") return items;
  if (filter === "needs") {
    return items.filter(
      (i) => (i.type === "header" || i.type === "event") && needsYouIds.has(i.sessionId),
    );
  }
  const keep = items.filter(
    (i): i is FeedEventItem => i.type === "event" && decisionCategory(i.event) === filter,
  );
  const sessions = new Set(keep.map((i) => i.sessionId));
  return items.filter(
    (i) =>
      (i.type === "header" && sessions.has(i.sessionId)) ||
      (i.type === "event" && decisionCategory(i.event) === filter),
  );
}

/** Sessions chips: Needs you (its count is sessions, as on the badge), All, and
 * each category with an open row (or the one selected), counting rows. */
export function sessionChipOptions(
  items: FeedItem[],
  sessionsCount: number,
  selected: SessionsFilter,
): ChipOption[] {
  const counts = new Map<DecisionCategory, number>();
  for (const i of items) {
    if (i.type !== "event") continue;
    const c = decisionCategory(i.event);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const chips: ChipOption[] = [
    { value: "needs", label: "Needs you", count: sessionsCount },
    { value: "all", label: "All", count: null },
  ];
  for (const c of Object.keys(CATEGORY_LABEL) as DecisionCategory[]) {
    const n = counts.get(c) ?? 0;
    if (n > 0 || selected === c) chips.push({ value: c, label: CATEGORY_LABEL[c], count: n });
  }
  return chips;
}

/** Tasks chips: Needs you, and each kind with a task (or the one selected). */
export function taskChipOptions(
  entries: ReadonlyArray<{ kind: TaskNeedsYouKind }>,
  selected: TasksFilter,
): ChipOption[] {
  const chips: ChipOption[] = [{ value: "needs", label: "Needs you", count: entries.length }];
  for (const k of ["failed", "review", "stopped"] as const) {
    const n = entries.filter((e) => e.kind === k).length;
    if (n > 0 || selected === k) chips.push({ value: k, label: TASK_KIND_LABEL[k], count: n });
  }
  return chips;
}
