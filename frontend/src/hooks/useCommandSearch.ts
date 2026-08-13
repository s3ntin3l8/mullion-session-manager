import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { normalizeAgentId } from "../api/index.js";
import type { Launcher, Project, Session, Workspace } from "../api/index.js";
import { matchesQuery } from "../matchQuery.js";

// CommandPalette.tsx's three parallel filter pipelines (U2, issue #581) —
// Sessions, Workspaces, and the launcher "Matching commands" list — plus the
// single flattened selection index arrow-key nav walks across all three.
// Extracted verbatim from CommandPalette.tsx (PR 29, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md): the plan calls the combined-index
// math (`groupOffset`/`activeIndex` below) the fragile part, so nothing about
// the math itself changed here — only where it lives.
//
// This hook deliberately does NOT own the ArrowUp/ArrowDown/Enter keydown
// handler — that needs onOpenSession/launch/closeAfterAction and the
// worktree/skip-permissions state, none of which this hook has access to.
// CommandPalette.tsx still owns the handler; it just reads `entries` /
// `activeIndex` / `groupOffset` from here instead of computing them inline.
export type PaletteEntry =
  | { type: "session"; session: Session }
  | { type: "workspace"; workspace: Workspace }
  | { type: "launcher"; launcher: Launcher };

export interface UseCommandSearchOptions {
  scope: "global" | "project";
  effectiveProjectId: number | null;
  sessions: Session[];
  projects: Project[];
  workspaces: Workspace[];
  launchers: Launcher[];
  hiddenAgents: string[] | undefined;
}

export interface UseCommandSearchResult {
  query: string;
  /** Sets the query AND resets `selectedIndex` to 0 — the search input's own
   * onChange used to inline both of these together; typing always restarts
   * selection at the top of the (new) combined list. */
  setQuery: (query: string) => void;
  selectedIndex: number;
  /** Raw setter, exposed alongside `setQuery` above — CommandPalette's own
   * launcher-fetch effect needs to seed a specific default index (the
   * configured default agent's row, or 0) on a project switch, not just the
   * +/-1-against-`activeIndex` nav this hook's callers do inline. */
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  /** Launchers matching the current query, with hidden agents stripped —
   * renders as "Matching commands". */
  filtered: Launcher[];
  /** Live, non-killed terminal sessions matching the current query — empty
   * on a blank query (this is search, not an always-on browse list; the
   * sidebar and WorkspaceSwitcher already own that). */
  matchingSessions: Session[];
  /** Workspaces matching the current query — same blank-query gate as
   * `matchingSessions`. */
  matchingWorkspaces: Workspace[];
  /** `matchingSessions`, then `matchingWorkspaces`, then `filtered`,
   * flattened into one ordered list purely for index math: `entries[i]` is
   * whichever group `i` falls into once each group renders at its own
   * absolute offset (`groupOffset` below). */
  entries: PaletteEntry[];
  /** `selectedIndex` clamped to `entries.length - 1` (or -1 when empty).
   * `sessions` (and therefore `entries`) refreshes every 4s off the store's
   * live-refresh poll while the palette can stay open — a session dropping
   * out of the match set mid-poll can leave `selectedIndex` past the new
   * end; clamping here (rather than at every read site) is what keeps
   * Enter/highlight/the options-strip from targeting a stale index. */
  activeIndex: number;
  activeEntry: PaletteEntry | undefined;
  /** `matchingSessions.length + matchingWorkspaces.length` — the absolute
   * index the launcher ("Matching commands") group starts at within
   * `entries`. */
  groupOffset: number;
}

export function useCommandSearch({
  scope,
  effectiveProjectId,
  sessions,
  projects,
  workspaces,
  launchers,
  hiddenAgents,
}: UseCommandSearchOptions): UseCommandSearchResult {
  const [query, setQueryState] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const setQuery = (next: string) => {
    setQueryState(next);
    setSelectedIndex(0);
  };

  // Hidden-agent filtering: strip the "agent:" prefix from launcher IDs
  // (detected agents have ids like "agent:claude") and compare against the
  // bare names stored in settings.launchers.hiddenAgents. A .crs/actions.json
  // override with a non-standard id (no "agent:" prefix) falls through to a
  // raw id lookup, which won't match the Settings toggle's always-bare stored
  // names — an acknowledged edge case that only affects projects with custom
  // actions.json overrides.
  const filtered = useMemo(
    () =>
      launchers.filter(
        (l) =>
          (!(l.kind === "agent") || !hiddenAgents?.includes(normalizeAgentId(l.id))) &&
          (query.trim() === "" || matchesQuery([l.title, l.command], query)),
      ),
    [launchers, query, hiddenAgents],
  );

  // U2 — search existing sessions from the palette instead of only being
  // able to launch new ones. Matched against the exact field precedence the
  // finding spells out: an explicit name first, then the last OSC-reported
  // title, then the raw launch command — deliberately NOT SessionRow's
  // nameLocked-gated `title`: an un-locked, auto-generated title is still a
  // perfectly good thing to find a session by here. Project name and the
  // best-known live branch extend the match beyond the title alone.
  const matchingSessions = useMemo(() => {
    if (query.trim() === "") return [];
    return sessions
      .filter(
        (s) =>
          // Killed sessions have no pane left to reopen, and "dock" sessions
          // live in the Dock region rather than the tab strip onOpenSession
          // targets — both filtered out to match what actually opens. In
          // "project" scope this also scopes to effectiveProjectId (Hermes
          // review, PR #581) — a session from a DIFFERENT project ranking
          // above this project's own commands would contradict the target
          // strip's "Runs in <project>" framing. "global" scope has no such
          // single-project framing, so it stays unfiltered.
          s.kind === "terminal" &&
          s.status !== "killed" &&
          (scope !== "project" || s.projectId === effectiveProjectId),
      )
      .filter((s) => {
        const project = projects.find((p) => p.id === s.projectId);
        const title = s.name || s.lastTitle || s.command;
        return matchesQuery([title, s.command, project?.name, s.liveBranch], query);
      });
    // Deliberately NOT filtered by the global "hide ended sessions" setting
    // the way Sidebar.tsx's tree is — typing a query here is explicit search
    // intent, not passive browsing, so an exited session the user is
    // actively looking for should still surface.
  }, [sessions, projects, query, scope, effectiveProjectId]);

  // Same "only once there's a real query" gate as matchingSessions above —
  // dumping every workspace into an unscoped list on open would just
  // duplicate WorkspaceSwitcher's own always-visible list for no benefit.
  const matchingWorkspaces = useMemo(() => {
    if (query.trim() === "") return [];
    return workspaces.filter((w) => matchesQuery([w.name], query));
  }, [workspaces, query]);

  // Sessions, Workspaces, and Matching commands render as three separate
  // groups but share ONE selection index across all of them for arrow-key
  // nav — this flattens the three result arrays into one ordered list purely
  // for index math.
  const entries = useMemo<PaletteEntry[]>(
    () => [
      ...matchingSessions.map((session): PaletteEntry => ({ type: "session", session })),
      ...matchingWorkspaces.map((workspace): PaletteEntry => ({ type: "workspace", workspace })),
      ...filtered.map((launcher): PaletteEntry => ({ type: "launcher", launcher })),
    ],
    [matchingSessions, matchingWorkspaces, filtered],
  );
  const activeIndex = entries.length === 0 ? -1 : Math.min(selectedIndex, entries.length - 1);
  const activeEntry = entries[activeIndex];
  const groupOffset = matchingSessions.length + matchingWorkspaces.length;

  return {
    query,
    setQuery,
    selectedIndex,
    setSelectedIndex,
    filtered,
    matchingSessions,
    matchingWorkspaces,
    entries,
    activeIndex,
    activeEntry,
    groupOffset,
  };
}
