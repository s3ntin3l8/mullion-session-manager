import type { NotificationEvent, Project, Session, Workspace } from "../api/index.js";
import { sessionNeedsYou, sessionUnreadCount } from "../eventDescriptions.js";
import { isListedSession, sessionDisplayTitle } from "./sessionDisplay.js";
import { buildSessionWorkspaceIndex } from "../panelUtils.js";

// Issue #1882 — the workspace a session's panel lives in.
//
// The phone tier has no workspace switcher and no other way to see which
// workspace it is looking at, so a session opened from another workspace
// used to swap the whole layout with nothing on screen saying so, and no
// way back. The chip this carries is the signal, and the way back.
export interface PickerWorkspace {
  id: number;
  name: string;
  // True when this is the workspace the user is looking at right now.
  isCurrent: boolean;
}

// The panel facts the picker needs — a structural subset of IDockviewPanel so
// the model stays pure and testable without a live dockview.
export interface PickerPanel {
  id: string;
  title: string;
  // Present for a terminal session panel (panelUtils.ts's panelSessionId).
  sessionId?: number;
}

export interface PickerRow {
  // Stable React key: the panel id when open, else `session-<id>`.
  key: string;
  // The open tiled panel for this row, or null when the session isn't open in
  // the current layout (selecting it opens it via the normal opener).
  panelId: string | null;
  session: Session | null;
  title: string;
  unreadCount: number;
  needsYou: boolean;
  // Where this session's panel lives — the workspace whose saved layout holds
  // it — or null when it is in no workspace's layout. See workspaceHomes for
  // why the answer is sometimes absent.
  workspace: PickerWorkspace | null;
  // Text the switcher's search box matches (title, raw command, project name)
  // — the same fields sessionMatchesSearch uses for the sidebar filter.
  searchFields: string[];
}

export interface PickerSection {
  key: string;
  label: string;
  kind: "needs-you" | "panes" | "project";
  rows: PickerRow[];
}

export interface PickerInput {
  sessions: Session[];
  projects: Project[];
  // Tiled panels only (maximizeGroup throws on a floating one).
  panels: PickerPanel[];
  events: Record<number, NotificationEvent[] | undefined>;
  lastSeenSeq: Record<number, number | undefined>;
  dismissedEventKeys: Record<string, true>;
  mutedSessionIds: number[];
  hideEndedSessions: boolean;
  showTaskSessions: boolean;
  taskSessionIds: ReadonlySet<number>;
  // The workspaces whose saved layouts hold the sessions, and the one the user
  // is looking at — issue #1882's chip needs both to say where a session lives
  // and whether that is here.
  workspaces: Workspace[];
  activeWorkspaceId: number | null;
}

// Which workspace, if any, a row's session lives in.
//
// A session can be tiled into more than one workspace's saved layout, so in
// general there is no single home. The chip only claims one when the answer
// is UNAMBIGUOUS:
//
//   - the CURRENT workspace wins over any other claimant — the user is
//     looking at it, and a session tiled there is here;
//   - otherwise exactly one other workspace claims it, and that one is it.
//
// With several other claimants and no current one, there is no home to name.
// That is not a gap to paper over with an arbitrary pick (issue #1883
// removed exactly that kind of pick): the chip says nothing, and the tap
// opens the session locally rather than swapping the layout — which is what
// the opener does for an ambiguous session anyway.
function workspaceFor(
  claims: number[] | undefined,
  byId: Map<number, Workspace>,
  activeWorkspaceId: number | null,
): PickerWorkspace | null {
  if (!claims || claims.length === 0) return null;
  const current = activeWorkspaceId !== null ? byId.get(activeWorkspaceId) : undefined;
  if (current && claims.includes(current.id)) {
    return { id: current.id, name: current.name, isCurrent: true };
  }
  if (claims.length === 1) {
    const only = byId.get(claims[0]);
    if (only) return { id: only.id, name: only.name, isCurrent: false };
  }
  return null;
}

// The workspace the user is looking at, if it is still among the known ones.
// A session open in the current layout belongs to it even when no saved
// layout mentions the session — the phone tier never writes its layout back
// (issue #1426), so an open session is routinely in no workspace's saved
// layout at all.
function currentWorkspace(
  workspaces: Workspace[],
  activeWorkspaceId: number | null,
): PickerWorkspace | null {
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  if (!ws) return null;
  return { id: ws.id, name: ws.name, isCurrent: true };
}

// Builds the phone session picker's sections, in order:
//   1. "Needs you" — sessions where sessionNeedsYou; the same rows ALSO
//      appear under their project (a pin, not a move).
//   2. "Open panes" — tiled panels that aren't a known session (git, browser,
//      device, timeline, ...), so the picker stays the one way to reach them.
//   3. One section per project, in `projects` order, empty ones skipped.
// A session is listed when the sidebar would list it (isListedSession), OR
// when it has an open tiled panel — an open pane must always be switchable.
export function buildPickerSections(input: PickerInput): PickerSection[] {
  const muted = new Set(input.mutedSessionIds);
  // One pass over the workspaces' layouts answers "which workspaces claim
  // this session" for every session at once (issue #1882).
  const claims = buildSessionWorkspaceIndex(input.workspaces);
  const byId = new Map(input.workspaces.map((ws) => [ws.id, ws] as const));
  const current = currentWorkspace(input.workspaces, input.activeWorkspaceId);
  const sessionById = new Map(input.sessions.map((s) => [s.id, s] as const));
  const panelBySession = new Map<number, PickerPanel>();
  const paneRows: PickerRow[] = [];
  for (const panel of input.panels) {
    // Only the session's own terminal panel (`session-<id>`) is its row.
    // Other panels can carry the same `sessionId` (an Agent Browser pane, a
    // restored pre-#477 timeline) and coexist with it — those stay switchable
    // under Open panes instead of overwriting the session's own panel.
    const session =
      panel.sessionId !== undefined && panel.id === `session-${panel.sessionId}`
        ? sessionById.get(panel.sessionId)
        : undefined;
    if (session) {
      panelBySession.set(session.id, panel);
    } else {
      paneRows.push({
        key: panel.id,
        panelId: panel.id,
        session: null,
        title: panel.title,
        unreadCount: 0,
        needsYou: false,
        workspace: null,
        searchFields: [panel.title],
      });
    }
  }

  // `project: null` covers the #1440 edge case below: an open session panel
  // whose project isn't in `projects` (a stale/deleted project reference)
  // still needs a row, just without a project name to search or group by.
  const sessionRow = (session: Session, project: Project | null): PickerRow => {
    const panel = panelBySession.get(session.id);
    const isMuted = muted.has(session.id);
    const events = input.events[session.id];
    const seen = input.lastSeenSeq[session.id] ?? 0;
    // Both names are searchable, not just whichever one is displayed — a
    // renamed tab's live panel title and the locked/OSC name
    // sessionDisplayTitle resolves (and the sidebar's own search matches)
    // can disagree once the panel's title has drifted since the rename.
    const displayTitle = sessionDisplayTitle(session);
    const title = panel?.title || displayTitle;
    const searchFields = [displayTitle, session.command];
    if (panel && panel.title && panel.title !== displayTitle) searchFields.push(panel.title);
    if (project) searchFields.push(project.name);
    return {
      key: panel?.id ?? `session-${session.id}`,
      panelId: panel?.id ?? null,
      session,
      title,
      searchFields,
      unreadCount: sessionUnreadCount(session.id, events, seen, input.dismissedEventKeys, isMuted),
      needsYou: sessionNeedsYou(session, events, seen, input.dismissedEventKeys, isMuted),
      // Where this session lives (issue #1882). A session OPEN in the live
      // grid is in the current workspace's layout, full stop — the opener
      // would focus that panel, never swap — so the live layout wins over
      // any stale saved layout that also mentions the session.
      workspace: panel
        ? current
        : workspaceFor(claims.get(session.id), byId, input.activeWorkspaceId),
    };
  };

  const sections: PickerSection[] = [];
  const projectSections: PickerSection[] = [];
  const needsYouRows: PickerRow[] = [];
  const consumedSessionIds = new Set<number>();
  for (const project of input.projects) {
    const rows: PickerRow[] = [];
    for (const session of input.sessions) {
      if (session.projectId !== project.id) continue;
      const listed =
        panelBySession.has(session.id) ||
        isListedSession(session, {
          hideEndedSessions: input.hideEndedSessions,
          showTaskSessions: input.showTaskSessions,
          taskSessionIds: input.taskSessionIds,
        });
      if (!listed) continue;
      const row = sessionRow(session, project);
      rows.push(row);
      if (row.needsYou) needsYouRows.push(row);
      consumedSessionIds.add(session.id);
    }
    if (rows.length > 0) {
      projectSections.push({
        key: `project-${project.id}`,
        label: project.name,
        kind: "project",
        rows,
      });
    }
  }

  // An open session panel is only reachable through the project loop above —
  // if its project isn't (or is no longer) in `projects`, it was silently
  // dropped from every section, leaving swipe/n-of-N as the only way back to
  // it. Surface it under Open panes instead, same as any other open pane the
  // picker doesn't otherwise know how to group.
  for (const sessionId of panelBySession.keys()) {
    if (consumedSessionIds.has(sessionId)) continue;
    const session = sessionById.get(sessionId);
    if (!session) continue;
    const row = sessionRow(session, null);
    paneRows.push(row);
    // Same pin the project loop above gives every other needs-you row — an
    // orphaned-project session shouldn't lose it just for being harder to
    // place, or "Needs you" would under-count relative to what's actually
    // open.
    if (row.needsYou) needsYouRows.push(row);
  }

  if (needsYouRows.length > 0) {
    sections.push({ key: "needs-you", label: "Needs you", kind: "needs-you", rows: needsYouRows });
  }
  if (paneRows.length > 0) {
    sections.push({ key: "panes", label: "Open panes", kind: "panes", rows: paneRows });
  }
  return [...sections, ...projectSections];
}
