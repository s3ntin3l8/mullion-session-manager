// Pure helpers for UnifiedBoard.tsx's ad-hoc session lane — split out for the
// same react-refresh/only-export-components reason kanban.ts and
// tasksBoard.ts document, so it's directly unit-testable without mounting
// anything.
import { KANBAN_COLUMNS, columnForSession } from "./kanban.js";
import type { KanbanColumnId } from "./kanban.js";
import type { Session, Task } from "./api/index.js";

// Every session id currently owned by a task — its worker and, when one was
// spawned, its advisory review agent. These render nested on their task's
// card (UnifiedBoard.tsx's TaskSessionSlot), so the ad-hoc lane below must
// exclude them: a task-linked session should appear exactly once, attributed
// to its task, not also as an unrelated card in the lane.
export function taskLinkedSessionIds(tasks: Task[]): Set<number> {
  const ids = new Set<number>();
  for (const t of tasks) {
    if (t.sessionId !== null) ids.add(t.sessionId);
    if (t.reviewSessionId !== null) ids.add(t.reviewSessionId);
  }
  return ids;
}

// KanbanBoard.tsx's own session grouping (issue #211), minus task-owned
// sessions. Filters are reproduced exactly as that component applied them —
// `kind === "terminal"` only (dock sessions are persistent per-project
// background monitors, not cards to triage), drop `status === "killed"`, and
// honor `hideEndedSessions` — with the task-linked exclusion applied BEFORE
// calling columnForSession, so a task-linked session is never double-
// counted between its own card and the lane. The one thing this does NOT
// account for is a session whose project has since been deleted —
// UnifiedBoard.tsx skips rendering that card (same "nothing sensible to
// render without a real Project" rule KanbanBoard.tsx's own cards followed),
// so a column's returned length can still exceed what's actually drawn in
// that rare edge case, same tradeoff KanbanBoard.tsx accepted.
export function adhocSessionsByColumn(
  sessions: Session[],
  linkedSessionIds: ReadonlySet<number>,
  hideEndedSessions: boolean,
): Record<KanbanColumnId, Session[]> {
  const map: Record<KanbanColumnId, Session[]> = {
    working: [],
    attention: [],
    finished: [],
    idle: [],
    exited: [],
  };
  for (const session of sessions) {
    if (session.kind !== "terminal") continue;
    if (session.status === "killed") continue;
    if (hideEndedSessions && session.status === "exited") continue;
    if (linkedSessionIds.has(session.id)) continue;
    map[columnForSession(session)].push(session);
  }
  return map;
}

// The lane renders its five severity sub-groups attention-first — a triage
// strip, not a full board — rather than KANBAN_COLUMNS' own declaration
// order (Working first), which is what the standalone session board used.
export const LANE_COLUMN_ORDER: KanbanColumnId[] = [
  "attention",
  "working",
  "finished",
  "idle",
  "exited",
];

export function laneColumnTitle(id: KanbanColumnId): string {
  return KANBAN_COLUMNS.find((c) => c.id === id)?.title ?? id;
}

// The ad-hoc strip's collapsed summary ("9 running · 3 need you · 8 idle") and
// its row of status dots. Tones are the lane's own five severity groups folded
// to the four a glance needs: Finished and Idle both read as "idle" (neither
// wants anything from you), Needs Attention as "attention". Counts only the
// sessions `isShown` accepts — the same visible-card rule the expanded lane
// uses, so a session whose project was deleted is neither counted nor dotted.
export type AdhocTone = "attention" | "running" | "idle" | "ended";

const ADHOC_TONE: Record<KanbanColumnId, AdhocTone> = {
  attention: "attention",
  working: "running",
  finished: "idle",
  idle: "idle",
  exited: "ended",
};

// Past this many the dot row stops (a 60-session install would otherwise wrap
// the header over several lines); the count and the text still carry the rest.
export const ADHOC_MAX_DOTS = 24;

export interface AdhocSummary {
  total: number;
  counts: Record<AdhocTone, number>;
  /** One tone per session, attention first, capped at ADHOC_MAX_DOTS. */
  dots: AdhocTone[];
  /** `n running · m need you · k idle · e ended`, zero parts left out. */
  text: string;
}

export function adhocSummary(
  columns: Record<KanbanColumnId, Session[]>,
  isShown: (session: Session) => boolean,
): AdhocSummary {
  const counts: Record<AdhocTone, number> = { attention: 0, running: 0, idle: 0, ended: 0 };
  for (const id of LANE_COLUMN_ORDER) {
    counts[ADHOC_TONE[id]] += columns[id].filter(isShown).length;
  }
  const total = counts.attention + counts.running + counts.idle + counts.ended;
  const dots: AdhocTone[] = [];
  for (const tone of ["attention", "running", "idle", "ended"] as const) {
    for (let i = 0; i < counts[tone] && dots.length < ADHOC_MAX_DOTS; i += 1) dots.push(tone);
  }
  const text = [
    counts.running > 0 ? `${counts.running} running` : null,
    counts.attention > 0
      ? `${counts.attention} ${counts.attention === 1 ? "needs" : "need"} you`
      : null,
    counts.idle > 0 ? `${counts.idle} idle` : null,
    counts.ended > 0 ? `${counts.ended} ended` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return { total, counts, dots, text };
}
