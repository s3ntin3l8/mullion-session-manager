import { useEffect, useMemo, useState } from "react";
import { useDashboardStore, eventKey } from "./store.js";
import { describeEvent } from "./eventDescriptions.js";
import { api } from "./api.js";
import type { NotificationEvent, Session, StoredEventRow } from "./api.js";
import { formatRelativeAge } from "./relativeTime.js";
import {
  ALL_KINDS,
  KIND_LABELS,
  fromLiveEvent,
  mergeTimelineEvents,
  toTimelineEvent,
} from "./eventHistory.js";
import type { TimelineEvent } from "./eventHistory.js";

export interface SessionTimelineParams {
  // Phase 6 (6.5/#218) widened this from a single required `sessionId` to
  // an array — a task may have zero sessions (not yet claimed), one (the
  // worker), or two (worker + an optional review agent) over its lifetime.
  // The pre-existing "timeline" panel (panelUtils.ts's openTimelinePanel)
  // keeps working unchanged by passing a single-element array.
  sessionIds?: number[];
  // Independent review, PR #477 — a workspace layout saved before this PR
  // persists timeline panels with the OLD `{ sessionId: N }` shape
  // (dockview's fromJSON restores panel params verbatim from the saved
  // blob, see App.tsx's restore effect). Without this fallback, restoring
  // such a layout threw here (sessionIds undefined), which either crashed
  // this one panel or, if the throw propagated out of fromJSON, discarded
  // the whole layout. Optional and only ever read as a fallback — every
  // caller in this codebase now passes sessionIds.
  sessionId?: number;
}

// Phase 2's session timeline panel (issue #212) — a dockview panel over the
// SAME structured event stream NotificationBell.tsx already renders (issue
// #166's store.ts `events` slice), but scoped to one or more sessions and
// showing the FULL history rather than NotificationBell's narrower
// "notification-worthy" triage filter (eventDescriptions.ts's notifyKind):
// every describable event — attention signals, status/title changes, file
// changes, review-gate state — appears here, filterable by kind and
// searchable. Deliberately the structured event stream, not a raw terminal
// replay (out of scope for this PR — see the plan's PR10 entry).
//
// Issue #213 (roadmap 4.7) — this panel's data source is no longer just the
// live in-memory store: it also fetches persisted `session_events` history
// (GET /api/events, api.listEventHistory) and merges the two (see
// eventHistory.ts's mergeTimelineEvents). KIND_LABELS/ALL_KINDS moved to
// eventHistory.ts so that module can validate a stored row's `kind` without
// this file importing back from it.

// Phase 5 (Track A, #195/5.5a) — group/filter the timeline by the subagent
// that produced each event. `agentId` rides file_change/tool_failure/
// status_change(subagent) payloads (see hook-protocol.ts's agent-attribution
// envelope); it's untyped (`payload: Record<string, unknown>`), so this reads
// it the same defensive way eventDescriptions.ts's own subagent branch does.
// Grouped by agentId, never agentType — two parallel same-type subagents
// would otherwise collapse into one bucket.
const UNATTRIBUTED_AGENT_KEY = "__unattributed__";

function eventAgentId(event: TimelineEvent): string | null {
  const raw = event.payload.agentId;
  return typeof raw === "string" ? raw : null;
}

interface DescribedEvent {
  event: TimelineEvent;
  text: string;
}

// Per-session persisted-history fetch state — one entry per requested
// sessionId, so a 2-session timeline (worker + review agent) can be in
// different states at once (e.g. one still loading its first page while the
// other already has one). `persistenceEnabled` is technically a single
// global setting (sessions.eventPersistence), not per-session, but the API
// response carries it per-request, so it's stored per-session here too —
// they're always equal for every id once both are "ready".
interface SessionHistoryState {
  rows: StoredEventRow[];
  nextCursor: number | null;
  persistenceEnabled: boolean;
  status: "loading" | "ready" | "error";
}

export function SessionTimeline({ params }: { params: SessionTimelineParams }) {
  // Independent review, PR #477 — normalized once here rather than at every
  // call site: a persisted pre-6.5 workspace layout restores this panel
  // with the old `{ sessionId: N }` shape (see SessionTimelineParams's own
  // doc comment), so `sessionIds` alone can't be trusted to exist.
  const sessionIds =
    params.sessionIds ?? (params.sessionId !== undefined ? [params.sessionId] : []);

  // Selecting the whole `events`/`sessions` slices (rather than one key each,
  // the pre-6.5 shape) trades a little extra re-render sensitivity for
  // supporting an arbitrary sessionIds array without calling a hook in a
  // loop — this panel is never mounted en masse, so the cost is negligible.
  const eventsBySession = useDashboardStore((s) => s.events);
  const allSessions = useDashboardStore((s) => s.sessions);
  // Joined to a string for a stable useMemo dep — callers (TaskDetail.tsx)
  // often pass a fresh array literal (e.g. `[task.sessionId].filter(...)`)
  // on every render.
  const sessionIdsKey = sessionIds.join(",");
  const sessions = useMemo(
    () =>
      sessionIds
        .map((id) => allSessions.find((sess) => sess.id === id))
        .filter((s): s is Session => s !== undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSessions, sessionIdsKey],
  );
  const [activeKinds, setActiveKinds] = useState<Set<NotificationEvent["kind"]>>(
    () => new Set(ALL_KINDS),
  );
  // Empty set = no agent filtering (show everything, including unattributed
  // events) — unlike activeKinds above, this can't default to "every known
  // key selected" since the key set grows as new subagents appear over the
  // panel's lifetime; "nothing selected yet" reads as "no filter" instead.
  const [activeAgentKeys, setActiveAgentKeys] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");

  // Issue #213 — fetches persisted history for every requested session on
  // mount / whenever the session set changes. Deliberately per-session
  // (rather than one batched request): `sessionIds` is at most 2 in
  // practice (worker + an optional review agent, see this param's own doc
  // comment), so N parallel requests costs nothing today. If a future
  // caller ever passes an unbounded array, batch or cap here — don't let
  // this silently become N requests on mount.
  const [historyBySession, setHistoryBySession] = useState<Record<number, SessionHistoryState>>({});

  useEffect(() => {
    let cancelled = false;
    // Deliberately does NOT synchronously reset historyBySession for the
    // new sessionIds before fetching (that would be a setState call inside
    // the effect body itself, which React's own lint rule flags as a
    // cascading-render footgun). Every reader below already treats a
    // missing entry (`historyBySession[id] === undefined`) as "loading", so
    // omitting the reset is correctness-neutral for a session seen for the
    // first time. The one visible trade-off: switching away from a session
    // and back shows its last-fetched (possibly stale) rows for a moment
    // instead of an immediate loading state, while the fresh request below
    // is still in flight — acceptable stale-while-revalidate behavior, not
    // a bug.
    for (const id of sessionIds) {
      void api
        .listEventHistory({ sessionId: id })
        .then((page) => {
          if (cancelled) return;
          setHistoryBySession((prev) => ({
            ...prev,
            [id]: {
              rows: page.events,
              nextCursor: page.nextCursor,
              persistenceEnabled: page.persistenceEnabled,
              status: "ready",
            },
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setHistoryBySession((prev) => ({
            ...prev,
            [id]: { rows: [], nextCursor: null, persistenceEnabled: false, status: "error" },
          }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIdsKey]);

  const [loadingMore, setLoadingMore] = useState(false);
  // The server pages newest-inserted-first with an `id` cursor
  // (src/services/event-history.ts's querySessionEvents) while this panel
  // renders oldest-first — loading a page therefore PREPENDS older rows to
  // what's already on screen, it doesn't append.
  const loadOlder = async () => {
    setLoadingMore(true);
    try {
      await Promise.all(
        sessionIds.map(async (id) => {
          const current = historyBySession[id];
          if (current === undefined || current.nextCursor === null) return;
          const page = await api.listEventHistory({ sessionId: id, cursor: current.nextCursor });
          setHistoryBySession((prev) => {
            const prevForId = prev[id];
            if (prevForId === undefined) return prev;
            return {
              ...prev,
              [id]: {
                rows: [...prevForId.rows, ...page.events],
                nextCursor: page.nextCursor,
                persistenceEnabled: page.persistenceEnabled,
                status: "ready",
              },
            };
          });
        }),
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const anyNextCursor = sessionIds.some((id) => historyBySession[id]?.nextCursor != null);
  const anyLoading = sessionIds.some(
    (id) => historyBySession[id] === undefined || historyBySession[id].status === "loading",
  );
  // Only ever "false" once at least one session's fetch has actually
  // completed and reported it — `undefined` (not yet loaded) deliberately
  // reads as "don't know yet", not "off", so the hint below doesn't flash
  // on before the first response lands.
  const persistenceEnabled = sessionIds
    .map((id) => historyBySession[id])
    .find((s) => s?.status === "ready")?.persistenceEnabled;

  const historyEvents = useMemo(() => {
    const rows = sessionIds.flatMap((id) => historyBySession[id]?.rows ?? []);
    return rows.map(toTimelineEvent).filter((e): e is TimelineEvent => e !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyBySession, sessionIdsKey]);

  const liveEvents = useMemo(
    () => sessionIds.flatMap((id) => eventsBySession[id] ?? []).map(fromLiveEvent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventsBySession, sessionIdsKey],
  );

  // Describes every event across every requested session — persisted
  // history unioned with the live store (see eventHistory.ts's
  // mergeTimelineEvents for why both sources matter: history persistence is
  // debounced up to 30s, so the newest activity is store-only for a while)
  // — dropping anything eventDescriptions.ts's describeEvent doesn't
  // recognize (e.g. a bare title_change with no title). Same
  // "last-known-good, not everything" filter describeLatestEvent applies
  // for the sidebar's status line, just over the whole history instead of
  // only the newest entry.
  const described = useMemo<DescribedEvent[]>(() => {
    const merged = mergeTimelineEvents(historyEvents, liveEvents);
    const result: DescribedEvent[] = [];
    for (const event of merged) {
      const d = describeEvent(event);
      if (d) result.push({ event, text: d.text });
    }
    return result;
  }, [historyEvents, liveEvents]);

  // Filter chip options — only the agentIds actually seen in this session's
  // buffered events (not session.subagents, which can evict finished entries
  // past its cap and would otherwise show a chip for a group with no events
  // left to filter, or miss one whose registry entry was evicted). Resolved
  // to a friendly label via session.subagents when available, else a
  // truncated agentId. "Unattributed" only appears once there's at least one
  // real subagent group to distinguish it from — a session that has never
  // hosted a subagent shows no agent-filter row at all.
  const agentOptions = useMemo(() => {
    const labels = new Map<string, string>();
    let hasUnattributed = false;
    for (const { event } of described) {
      const agentId = eventAgentId(event);
      if (agentId === null) {
        hasUnattributed = true;
        continue;
      }
      if (!labels.has(agentId)) {
        const info = sessions.flatMap((s) => s.subagents).find((s) => s.agentId === agentId);
        labels.set(agentId, info?.agentType ?? agentId.slice(0, 8));
      }
    }
    // Disambiguate agentType collisions (e.g. two parallel same-type
    // subagents) — a bare agentType label would otherwise give two
    // functionally distinct filter chips the exact same accessible name,
    // with nothing (visually or for assistive tech) to tell them apart.
    const labelCounts = new Map<string, number>();
    for (const label of labels.values()) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    const options = Array.from(labels, ([key, label]) => ({
      key,
      label: (labelCounts.get(label) ?? 0) > 1 ? `${label} (${key.slice(0, 8)})` : label,
    }));
    if (hasUnattributed && options.length > 0) {
      options.push({ key: UNATTRIBUTED_AGENT_KEY, label: "Unattributed" });
    }
    return options;
  }, [described, sessions]);

  // The set of agent keys actually reachable right now — buffered events are
  // capped (store.ts's EVENTS_PER_SESSION_CAP), so a key the user selected
  // can age out of `agentOptions` entirely while still sitting in
  // activeAgentKeys. Filtering against the raw activeAgentKeys in that case
  // would silently dead-end the timeline (every event fails the check, with
  // no visible chip left to un-click to recover). Intersecting against the
  // options actually on screen means a fully-stale selection degrades back
  // to "no filter" instead.
  const reachableActiveAgentKeys = useMemo(() => {
    const optionKeys = new Set(agentOptions.map((o) => o.key));
    return new Set([...activeAgentKeys].filter((key) => optionKeys.has(key)));
  }, [activeAgentKeys, agentOptions]);

  // Deliberate asymmetry vs. the kind-chip check just above: activeKinds is
  // opt-out (all selected by default, click to hide), but the agent-chip
  // check below is opt-in (isolate) — selecting a chip narrows to exactly
  // the selected key(s), including "Unattributed" as just another key. This
  // means selecting a subagent's chip alone DOES hide unattributed events,
  // by design — filtering to one subagent's activity is supposed to hide
  // its parent's/other agents' events too, the same way any isolate filter
  // works. This is safe for adapters that can never attribute an agentId
  // (e.g. OpenCode): agentOptions' `hasUnattributed && options.length > 0`
  // gate means the agent-chip row (Unattributed included) only ever renders
  // once a real subagent chip also exists, so a session with zero subagents
  // has no chip to isolate against and nothing here can ever hide its
  // events. See SessionTimeline.test.tsx's "selecting an agent chip
  // isolates it" and "renders no subagent filter row..." tests.
  //
  // NOTE: search only matches against LOADED events (`described`'s own
  // input) — it cannot search history pages not yet fetched. The hint below
  // the search box (rendered when anyNextCursor) says so explicitly.
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return described.filter(({ event, text }) => {
      if (!activeKinds.has(event.kind)) return false;
      if (query !== "" && !text.toLowerCase().includes(query)) return false;
      if (reachableActiveAgentKeys.size > 0) {
        const key = eventAgentId(event) ?? UNATTRIBUTED_AGENT_KEY;
        if (!reachableActiveAgentKeys.has(key)) return false;
      }
      return true;
    });
  }, [described, activeKinds, search, reachableActiveAgentKeys]);

  const toggleKind = (kind: NotificationEvent["kind"]) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const toggleAgentKey = (key: string) => {
    setActiveAgentKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Distinct from "Session not found." below — a task with no worker/review
  // session yet (never claimed) is an expected, legitimate empty state, not
  // a stale/invalid id (TaskDetail.tsx's own doc comment).
  if (sessionIds.length === 0) {
    return <div className="session-timeline-empty">No session yet.</div>;
  }
  if (sessions.length === 0) {
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
        {agentOptions.length > 0 && (
          <div className="session-timeline-agents" role="group" aria-label="Filter by subagent">
            {agentOptions.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`session-timeline-kind-chip${activeAgentKeys.has(key) ? " active" : ""}`}
                aria-pressed={activeAgentKeys.has(key)}
                title={key === UNATTRIBUTED_AGENT_KEY ? undefined : key}
                onClick={() => toggleAgentKey(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {anyNextCursor && (
        <div className="session-timeline-search-hint">
          Search only covers loaded events — load older events to search further back.
        </div>
      )}
      {persistenceEnabled === false && (
        <div className="session-timeline-persistence-hint">
          History persistence is off — only the live buffer is shown here, and it won't survive a
          restart. Turn it on in Settings → Sessions to keep history.
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="session-timeline-empty">
          {described.length === 0
            ? anyLoading
              ? "Loading…"
              : "No events yet."
            : "No events match the current filter."}
        </div>
      ) : (
        <div className="session-timeline-list cmux-scroll">
          {filtered.map(({ event, text }) => (
            <div
              key={
                event.rowId !== undefined
                  ? `h:${event.rowId}`
                  : eventKey(event.sessionId ?? -1, event.seq)
              }
              className="session-timeline-row"
            >
              <span className="session-timeline-row-time">{formatRelativeAge(event.ts)}</span>
              <span className={`session-timeline-row-kind kind-${event.kind}`}>
                {KIND_LABELS[event.kind]}
              </span>
              <span className="session-timeline-row-text">
                {text}
                {event.sessionId === null && (
                  <span
                    className="session-timeline-row-orphan"
                    title="This event's session no longer exists"
                  >
                    {" "}
                    (session removed)
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {anyNextCursor && (
        <button
          type="button"
          className="session-timeline-load-older"
          onClick={() => void loadOlder()}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading…" : "Load older events"}
        </button>
      )}
    </div>
  );
}
