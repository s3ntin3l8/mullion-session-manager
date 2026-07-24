import { useMemo, useState } from "react";
import { useDashboardStore } from "./store.js";
import { describeEvent } from "./eventDescriptions.js";
import type { NotificationEvent } from "./api.js";
import { formatRelativeAge } from "./relativeTime.js";

export interface SessionTimelineParams {
  sessionId: number;
}

// Phase 2's session timeline panel (issue #212) — a dockview panel over the
// SAME structured event stream NotificationBell.tsx already renders (issue
// #166's store.ts `events` slice), but scoped to one session and showing
// the FULL history rather than NotificationBell's narrower "notification-
// worthy" triage filter (eventDescriptions.ts's notifyKind): every
// describable event — attention signals, status/title changes, file
// changes, review-gate state — appears here, filterable by kind and
// searchable. Deliberately the structured event stream, not a raw terminal
// replay (out of scope for this PR — see the plan's PR10 entry).
const KIND_LABELS: Record<NotificationEvent["kind"], string> = {
  attention: "Attention",
  status_change: "Status",
  title_change: "Title",
  file_change: "Files",
  review_gate: "Review",
};

const ALL_KINDS = Object.keys(KIND_LABELS) as NotificationEvent["kind"][];

interface DescribedEvent {
  event: NotificationEvent;
  text: string;
}

export function SessionTimeline({ params }: { params: SessionTimelineParams }) {
  const events = useDashboardStore((s) => s.events[params.sessionId]);
  const session = useDashboardStore((s) => s.sessions.find((sess) => sess.id === params.sessionId));
  const [activeKinds, setActiveKinds] = useState<Set<NotificationEvent["kind"]>>(
    () => new Set(ALL_KINDS),
  );
  const [search, setSearch] = useState("");

  // Describes every buffered event up front, dropping anything
  // eventDescriptions.ts's describeEvent doesn't recognize (e.g. a bare
  // title_change with no title) — same "last-known-good, not everything"
  // filter describeLatestEvent applies for the sidebar's status line, just
  // over the whole history instead of only the newest entry. store.ts's
  // addEvent already keeps `events` sorted ascending by seq (oldest first,
  // capped at EVENTS_PER_SESSION_CAP) — this renders in that same order, a
  // history read top-to-bottom, oldest to newest.
  const described = useMemo<DescribedEvent[]>(() => {
    if (!events) return [];
    const result: DescribedEvent[] = [];
    for (const event of events) {
      const d = describeEvent(event);
      if (d) result.push({ event, text: d.text });
    }
    return result;
  }, [events]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return described.filter(
      ({ event, text }) =>
        activeKinds.has(event.kind) && (query === "" || text.toLowerCase().includes(query)),
    );
  }, [described, activeKinds, search]);

  const toggleKind = (kind: NotificationEvent["kind"]) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  if (!session) {
    return <div className="session-timeline-empty">Session not found.</div>;
  }

  return (
    <div className="session-timeline">
      <div className="session-timeline-controls">
        <input
          className="session-timeline-search"
          type="text"
          placeholder="Search timeline…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search timeline"
        />
        <div className="session-timeline-kinds" role="group" aria-label="Filter by kind">
          {ALL_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`session-timeline-kind-chip${activeKinds.has(kind) ? " active" : ""}`}
              aria-pressed={activeKinds.has(kind)}
              onClick={() => toggleKind(kind)}
            >
              {KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="session-timeline-empty">
          {described.length === 0 ? "No events yet." : "No events match the current filter."}
        </div>
      ) : (
        <div className="session-timeline-list cmux-scroll">
          {filtered.map(({ event, text }) => (
            <div key={event.seq} className="session-timeline-row">
              <span className="session-timeline-row-time">{formatRelativeAge(event.ts)}</span>
              <span className={`session-timeline-row-kind kind-${event.kind}`}>
                {KIND_LABELS[event.kind]}
              </span>
              <span className="session-timeline-row-text">{text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
