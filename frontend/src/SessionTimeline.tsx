import { useMemo, useState } from "react";
import { useDashboardStore, eventKey } from "./store.js";
import { describeEvent } from "./eventDescriptions.js";
import type { NotificationEvent, Session } from "./api.js";
import { formatRelativeAge } from "./relativeTime.js";

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
const KIND_LABELS: Record<NotificationEvent["kind"], string> = {
  attention: "Attention",
  status_change: "Status",
  title_change: "Title",
  file_change: "Files",
  review_gate: "Review",
  promote_request: "Promote",
  permission_request: "Permission",
  stop_failure: "Stop",
  tool_failure: "Tool",
  session_end: "Exit",
  plan_ready: "Plan",
  // Rich statuses (issue: extend surfaced session statuses).
  elicitation: "Elicitation",
  // OpenCode v2 events.
  question: "Question",
  todo: "Todo",
  session_diff: "Diff",
  // Issue #404.
  dev_server_detected: "Dev Server",
};

const ALL_KINDS = Object.keys(KIND_LABELS) as NotificationEvent["kind"][];

// Phase 5 (Track A, #195/5.5a) — group/filter the timeline by the subagent
// that produced each event. `agentId` rides file_change/tool_failure/
// status_change(subagent) payloads (see hook-protocol.ts's agent-attribution
// envelope); it's untyped (`payload: Record<string, unknown>`), so this reads
// it the same defensive way eventDescriptions.ts's own subagent branch does.
// Grouped by agentId, never agentType — two parallel same-type subagents
// would otherwise collapse into one bucket.
const UNATTRIBUTED_AGENT_KEY = "__unattributed__";

function eventAgentId(event: NotificationEvent): string | null {
  const raw = event.payload.agentId;
  return typeof raw === "string" ? raw : null;
}

interface DescribedEvent {
  event: NotificationEvent;
  text: string;
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

  // Describes every buffered event across every requested session up front,
  // dropping anything eventDescriptions.ts's describeEvent doesn't recognize
  // (e.g. a bare title_change with no title) — same "last-known-good, not
  // everything" filter describeLatestEvent applies for the sidebar's status
  // line, just over the whole history instead of only the newest entry.
  // store.ts's addEvent keeps each session's own array sorted ascending by
  // seq, but seq is only comparable *within* one session — merging more than
  // one requires sorting by wall-clock `ts` instead (sessionId as a final
  // tiebreak for full determinism when two events share a timestamp).
  const described = useMemo<DescribedEvent[]>(() => {
    const merged = sessionIds
      .flatMap((id) => eventsBySession[id] ?? [])
      .sort((a, b) => a.ts - b.ts || a.seq - b.seq || a.sessionId - b.sessionId);
    const result: DescribedEvent[] = [];
    for (const event of merged) {
      const d = describeEvent(event);
      if (d) result.push({ event, text: d.text });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsBySession, sessionIdsKey]);

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
      {filtered.length === 0 ? (
        <div className="session-timeline-empty">
          {described.length === 0 ? "No events yet." : "No events match the current filter."}
        </div>
      ) : (
        <div className="session-timeline-list cmux-scroll">
          {filtered.map(({ event, text }) => (
            <div key={eventKey(event.sessionId, event.seq)} className="session-timeline-row">
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
