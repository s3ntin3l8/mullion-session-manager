import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboardStore, eventKey } from "./store/index.js";
import {
  ALL_KINDS,
  KIND_LABELS,
  describeEvent,
  notifyLabel,
  notifySeverity,
  SIGNAL_TO_EVENT_KIND,
} from "./eventDescriptions.js";
import { api } from "./api/index.js";
import type { NotificationEvent, Session, StoredEventRow } from "./api/index.js";
import { formatRelativeAge } from "./relativeTime.js";
import { fromLiveEvent, mergeTimelineEvents, toTimelineEvent } from "./eventHistory.js";
import type { TimelineEvent } from "./eventHistory.js";
import { truncateHead } from "./lib/truncatePath.js";
import { STORAGE_KEYS, readJSON, readBool, writeJSON, writeBool } from "./lib/persistedState.js";

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
// eventDescriptions.ts (making notifications relevant/scannable) so this
// panel's kind-chip vocabulary and NotificationBell.tsx's pill vocabulary
// share one source instead of two that could drift.

// Making notifications relevant/scannable — title_change (86% of every
// row this app has ever persisted) and file_change (another 2%) are opt-out
// of the DEFAULT filter, not removed as chip options: a session actively
// spamming title updates used to be the first thing a freshly-opened
// timeline showed, burying any actual signal under routine chatter. Both
// stay one click away via their own chips.
const DEFAULT_ACTIVE_KINDS = ALL_KINDS.filter(
  (kind) => kind !== "title_change" && kind !== "file_change",
);

/** Restores a persisted kind selection, validated against ALL_KINDS so a
 * future release dropping/renaming a kind can't leave a stale, unrecognized
 * string permanently stuck in someone's localStorage. Absent/invalid
 * persisted state falls back to DEFAULT_ACTIVE_KINDS, not "everything" —
 * this IS the default now. */
function loadPersistedActiveKinds(): Set<NotificationEvent["kind"]> {
  const stored = readJSON<string[] | null>(STORAGE_KEYS.timelineKinds, null);
  if (stored === null) return new Set(DEFAULT_ACTIVE_KINDS);
  const known = new Set<string>(ALL_KINDS);
  const restored = stored.filter((k) => known.has(k)) as NotificationEvent["kind"][];
  return restored.length > 0 ? new Set(restored) : new Set(DEFAULT_ACTIVE_KINDS);
}

// How close in time a specific-kind event (e.g. permission_request) and its
// paired `attention` event (see eventDescriptions.ts's SIGNAL_TO_EVENT_KIND)
// must land to be treated as the SAME occurrence for row-suppression
// purposes. NOT uniformly same-tick: permission_request's own event and its
// paired `attention` really are emitted back-to-back in one call
// (attention-tracker.ts's emitAttentionSignalDeferred/drainDeferred —
// `alsoEmit` fires immediately before `attention`), but tool_failure/
// stop_failure's own event fires immediately at the hook while the paired
// `attention` only lands after the full settle window (up to
// ATTENTION_SETTLE_MS, currently 2000ms) — so this window must stay
// generously larger than that settle delay, not just large enough for WS
// delivery/render jitter. Do not shrink this without checking
// ATTENTION_SETTLE_MS's largest value first.
const PAIRED_ROW_WINDOW_MS = 5_000;

/** Drops an `attention` event when a specific-kind sibling for the SAME
 * occurrence already covers it — e.g. a `permission_request` row and its
 * paired `attention`/`permissionRequest` row would otherwise both describe
 * the exact same request. NotificationBell.tsx doesn't need this (it only
 * ever shows ONE of the two per notifyKind's classification, never both),
 * but the timeline shows every describable event, so without this it always
 * doubled every one of the seven paired kinds. Text-based folding (see
 * NotificationBell.tsx's foldConsecutiveRows) can't substitute: the two
 * rows' text comes from different describeEvent branches and rarely
 * matches verbatim (e.g. tool_failure's own case vs. attention/toolFailure's
 * case format the same error differently). */
// Hermes review, PR #717 — the naive version re-scanned the FULL merged
// event list (events.some(...)) for every single `attention` row, so a
// long-lived session with thousands of routine rows (title_change alone is
// ~86% of every row ever persisted, per eventHistory.ts) turned into
// millions of comparisons per live tick. Indexing by `sessionId|kind` first
// means each attention row's lookup only scans events of its OWN paired
// kind (e.g. permission_request occurrences — typically a tiny fraction of
// the total) instead of the entire history.
function suppressPairedAttentionRows(events: TimelineEvent[]): TimelineEvent[] {
  const byKey = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const key = `${event.sessionId}|${event.kind}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(event);
    else byKey.set(key, [event]);
  }
  return events.filter((event) => {
    if (event.kind !== "attention") return true;
    const signal = typeof event.payload.signal === "string" ? event.payload.signal : null;
    if (signal === null) return true;
    const pairedKind = SIGNAL_TO_EVENT_KIND[signal];
    if (pairedKind === undefined) return true;
    const bucket = byKey.get(`${event.sessionId}|${pairedKind}`);
    if (bucket === undefined) return true;
    return !bucket.some(
      (other) => other !== event && Math.abs(other.ts - event.ts) <= PAIRED_ROW_WINDOW_MS,
    );
  });
}

// Row text is head-truncated (truncatePath.ts) past this length — same
// "the timeline is a fixed-width dockview panel, calibrated by eye" posture
// as NotificationBell.tsx's own NOTIF_ROW_TEXT_MAX, just a bit more generous
// since a timeline row doesn't also carry a kind pill competing for width.
const TIMELINE_ROW_TEXT_MAX = 100;

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
//
// No `"loading"` status member (Hermes review, PR #560: it was declared but
// never assigned, making a `status === "loading"` check dead code) —
// "loading" is represented by the ABSENCE of an entry for that id, which
// every reader below already checks for.
interface SessionHistoryState {
  rows: StoredEventRow[];
  nextCursor: number | null;
  persistenceEnabled: boolean;
  status: "ready" | "error";
}

// Fetches one session's first page of persisted history, normalizing a
// failure into an `"error"` state rather than letting it reject — used by
// both the mount effect and the retry button below, so a failed fetch is
// handled identically either way.
async function fetchInitialHistoryPage(sessionId: number): Promise<SessionHistoryState> {
  try {
    const page = await api.listEventHistory({ sessionId });
    return {
      rows: page.events,
      nextCursor: page.nextCursor,
      persistenceEnabled: page.persistenceEnabled,
      status: "ready",
    };
  } catch {
    return { rows: [], nextCursor: null, persistenceEnabled: false, status: "error" };
  }
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
  // Making notifications relevant/scannable — persisted across panel
  // remounts (see loadPersistedActiveKinds' own comment); defaults to
  // DEFAULT_ACTIVE_KINDS (everything except title_change/file_change), not
  // ALL_KINDS.
  const [activeKinds, setActiveKinds] =
    useState<Set<NotificationEvent["kind"]>>(loadPersistedActiveKinds);
  useEffect(() => {
    writeJSON(STORAGE_KEYS.timelineKinds, Array.from(activeKinds));
  }, [activeKinds]);
  // Making notifications relevant/scannable — a quick, persisted toggle
  // that narrows to only notifySeverity()-classified rows (the SAME
  // notify-worthy set NotificationBell.tsx's feed already shows), layered
  // ON TOP of activeKinds rather than replacing it — so turning it back off
  // restores whatever kind selection was already in place, instead of
  // resetting it.
  const [onlyAttention, setOnlyAttention] = useState<boolean>(() =>
    readBool(STORAGE_KEYS.timelineOnlyAttention, false),
  );
  useEffect(() => {
    writeBool(STORAGE_KEYS.timelineOnlyAttention, onlyAttention);
  }, [onlyAttention]);
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
      void fetchInitialHistoryPage(id).then((state) => {
        if (cancelled) return;
        setHistoryBySession((prev) => ({ ...prev, [id]: state }));
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIdsKey]);

  // Hermes review, PR #560 — a failed initial fetch was invisible whenever
  // ANY live event existed for the requested sessions: the error was only
  // ever surfaced by the empty-state ternary below, which never renders once
  // `filtered.length > 0`. Retries every session currently in `"error"`
  // status, independent of whether the list is showing anything.
  const retryFailedHistory = () => {
    for (const id of sessionIds) {
      if (historyBySession[id]?.status !== "error") continue;
      void fetchInitialHistoryPage(id).then((state) => {
        setHistoryBySession((prev) => ({ ...prev, [id]: state }));
      });
    }
  };

  const [loadingMore, setLoadingMore] = useState(false);
  // Hermes review, PR #560 — a failed page fetch was previously an
  // unhandled promise rejection with zero user feedback (the per-session
  // Promise.all entry threw, the outer `finally` still cleared
  // `loadingMore`, but nothing told the user the click did nothing). Surface
  // it as a dismissible-by-retry inline message instead of swallowing it.
  const [loadOlderError, setLoadOlderError] = useState(false);
  // Hermes review, PR #560 — `loadingMore` is async state: two rapid clicks
  // before React commits the `disabled` attribute would otherwise both pass
  // the button's own disabled check and fire two concurrent requests with
  // the SAME cursor. A synchronous ref closes that window regardless of
  // when React re-renders (today this was harmless — mergeTimelineEvents
  // dedupes the doubled rows — but the guard makes that not load-bearing).
  const loadOlderInFlight = useRef(false);
  const loadOlder = async () => {
    if (loadOlderInFlight.current) return;
    loadOlderInFlight.current = true;
    setLoadingMore(true);
    setLoadOlderError(false);
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
                // The server pages newest-inserted-first with an `id`
                // cursor (event-history.ts's querySessionEvents); appending
                // here is correct despite that — display order is restored
                // by mergeTimelineEvents' own ascending `ts` sort below, not
                // by insertion order in this array.
                rows: [...prevForId.rows, ...page.events],
                nextCursor: page.nextCursor,
                persistenceEnabled: page.persistenceEnabled,
                status: "ready",
              },
            };
          });
        }),
      );
    } catch {
      setLoadOlderError(true);
    } finally {
      loadOlderInFlight.current = false;
      setLoadingMore(false);
    }
  };

  const anyNextCursor = sessionIds.some((id) => historyBySession[id]?.nextCursor != null);
  // "loading" is the absence of an entry (see SessionHistoryState's own
  // comment on why there's no explicit "loading" status member).
  const anyLoading = sessionIds.some((id) => historyBySession[id] === undefined);
  // Hermes review, PR #560 (round 2) — rendered unconditionally below, not
  // folded into the empty-state ternary: the first round's fix only read
  // this inside that ternary, which never renders once `filtered.length >
  // 0` — so a failed fetch for one session stayed invisible whenever the
  // OTHER requested session (or the live store) still had events to show.
  const anyError = sessionIds.some((id) => historyBySession[id]?.status === "error");
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
    // Making notifications relevant/scannable — suppressPairedAttentionRows
    // runs BEFORE describeEvent, on the raw merged list: it needs the OTHER
    // sibling events still present to detect a pairing, so it can't run on
    // an already-filtered `result`.
    const merged = suppressPairedAttentionRows(mergeTimelineEvents(historyEvents, liveEvents));
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
      // Making notifications relevant/scannable — layered on top of
      // activeKinds (see onlyAttention's own state comment), not a
      // replacement for it.
      if (onlyAttention && notifySeverity(event) === null) return false;
      if (query !== "" && !text.toLowerCase().includes(query)) return false;
      if (reachableActiveAgentKeys.size > 0) {
        const key = eventAgentId(event) ?? UNATTRIBUTED_AGENT_KEY;
        if (!reachableActiveAgentKeys.has(key)) return false;
      }
      return true;
    });
  }, [described, activeKinds, onlyAttention, search, reachableActiveAgentKeys]);

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
        {/* Making notifications relevant/scannable — layered on top of the
            kind chips below, not a replacement (see onlyAttention's own
            state comment). */}
        <button
          type="button"
          className={`session-timeline-kind-chip session-timeline-only-attention${onlyAttention ? " active" : ""}`}
          aria-pressed={onlyAttention}
          onClick={() => setOnlyAttention((v) => !v)}
        >
          Only attention
        </button>
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
      {/* Hermes review, PR #560 — only worth showing once the user has
          actually typed something; with an empty search box there's nothing
          for the hint's "search further back" caveat to apply to yet. */}
      {search.trim() !== "" && anyNextCursor && (
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
      {/* Hermes review, PR #560 (round 2) — rendered unconditionally, not
          folded into the empty-state branch below: a failed history fetch
          for one session must stay visible even when the timeline isn't
          empty (live events, or the other requested session's history,
          still fill the list). */}
      {anyError && (
        <div className="session-timeline-error-hint" role="alert">
          Couldn't load history for this session.
          <button
            type="button"
            className="session-timeline-error-retry"
            onClick={retryFailedHistory}
          >
            Retry
          </button>
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
          {filtered.map(({ event, text }) => {
            // Making notifications relevant/scannable — for an `attention`
            // event, labels by its signal (permissionRequest → "Permission"),
            // not the generic "attention" kind — same notifyLabel()
            // NotificationBell.tsx's own pill uses, so the two surfaces
            // never disagree about what to call the same event.
            const label =
              event.kind === "attention" ? notifyLabel(event) : (KIND_LABELS[event.kind] ?? "?");
            const severity = notifySeverity(event) ?? "none";
            const fullText = text;
            const displayText = truncateHead(text, TIMELINE_ROW_TEXT_MAX);
            return (
              <div
                key={
                  event.rowId !== undefined
                    ? `h:${event.rowId}`
                    : eventKey(event.sessionId ?? -1, event.seq)
                }
                className={`session-timeline-row sev-${severity}`}
              >
                <span className="session-timeline-row-time">{formatRelativeAge(event.ts)}</span>
                <span className={`session-timeline-row-kind kind-${event.kind}`}>{label}</span>
                <span className="session-timeline-row-text" title={fullText}>
                  {displayText}
                  {/* Hermes review, PR #560 — `event.sessionId === null` alone
                      is unreachable here: every history fetch is scoped by an
                      explicit `sessionId` filter (eq(sessionEvents.sessionId,
                      id)), and SQL equality never matches a NULL column, so a
                      row whose session was deleted (onDelete: "set null")
                      drops out of every future per-session query entirely —
                      it can only ever surface from an unscoped, cross-session
                      query this panel doesn't make. Keyed off the session's
                      absence from the live store instead, which IS reachable:
                      a multi-session panel (worker + review agent) can have
                      one session still alive while the other was removed, and
                      that session's already-fetched rows should still read as
                      orphaned. The `sessionId === null` check stays as a
                      harmless defensive fallback in case a future query
                      surface ever does return one. */}
                  {(event.sessionId === null ||
                    !sessions.some((s) => s.id === event.sessionId)) && (
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
            );
          })}
        </div>
      )}
      {anyNextCursor && (
        <>
          <button
            type="button"
            className="session-timeline-load-older"
            onClick={() => void loadOlder()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load older events"}
          </button>
          {loadOlderError && (
            <div className="session-timeline-load-older-error" role="alert">
              Couldn't load older events. Try again.
            </div>
          )}
        </>
      )}
    </div>
  );
}
