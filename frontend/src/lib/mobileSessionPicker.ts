import type { NotificationEvent, Project, Session } from "../api/index.js";
import { sessionNeedsYou, sessionUnreadCount } from "../eventDescriptions.js";
import { isListedSession, sessionDisplayTitle } from "./sessionDisplay.js";

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
  const sessionById = new Map(input.sessions.map((s) => [s.id, s] as const));
  const panelBySession = new Map<number, PickerPanel>();
  const paneRows: PickerRow[] = [];
  for (const panel of input.panels) {
    const session = panel.sessionId !== undefined ? sessionById.get(panel.sessionId) : undefined;
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
        searchFields: [panel.title],
      });
    }
  }

  const sessionRow = (session: Session, project: Project): PickerRow => {
    const panel = panelBySession.get(session.id);
    const isMuted = muted.has(session.id);
    const events = input.events[session.id];
    const seen = input.lastSeenSeq[session.id] ?? 0;
    const title = panel?.title || sessionDisplayTitle(session);
    return {
      key: panel?.id ?? `session-${session.id}`,
      panelId: panel?.id ?? null,
      session,
      title,
      searchFields: [title, session.command, project.name],
      unreadCount: sessionUnreadCount(session.id, events, seen, input.dismissedEventKeys, isMuted),
      needsYou: sessionNeedsYou(session, events, seen, input.dismissedEventKeys, isMuted),
    };
  };

  const sections: PickerSection[] = [];
  const projectSections: PickerSection[] = [];
  const needsYouRows: PickerRow[] = [];
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

  if (needsYouRows.length > 0) {
    sections.push({ key: "needs-you", label: "Needs you", kind: "needs-you", rows: needsYouRows });
  }
  if (paneRows.length > 0) {
    sections.push({ key: "panes", label: "Open panes", kind: "panes", rows: paneRows });
  }
  return [...sections, ...projectSections];
}
