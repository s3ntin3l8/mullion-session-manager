import type { NotificationEvent, Project, Session } from "../api/index.js";
import { commandToBinary, resolveAgentLogo } from "../cliLogos.js";
import { sessionNeedsYou, sessionUnreadCount } from "../eventDescriptions.js";
import type { Theme } from "../store/index.js";
import { sessionDisplayTitle } from "./sessionDisplay.js";

// The left rail's pane list (#3009): one entry per pane open in a workspace.
// Built here as plain data, so the list component only renders entries and a
// later layout (the two halves, #3010) can pass any subset of panes.

/** A pane as the rail needs it: dockview's id and title, and its session. */
export interface RailPaneInput {
  id: string;
  title: string;
  /** The terminal's session id; undefined for a non-terminal pane. */
  sessionId: number | undefined;
}

export interface RailPaneEntry {
  panelId: string;
  /** A few characters for the rail itself; CSS truncates what does not fit. */
  label: string;
  /** The whole title, for the accessible name and the tooltip. */
  fullTitle: string;
  projectName: string | null;
  /** The agent's logo, or null for a shell, script or non-terminal pane. */
  logo: string | null;
  /** Whether the pane is a terminal (a session), for the fallback glyph. */
  isSession: boolean;
  needsYou: boolean;
  unreadCount: number;
  active: boolean;
}

const SEPARATORS = /[\s·•|:/\\,()[\]{}<>—–]+/;
const EXTENSION = /\.[a-z0-9]{1,4}$/i;

/**
 * The few characters a rail entry has room for, picked from the title the
 * sidebar shows (sessionDisplayTitle). A task's number wins ("task #7 worker"
 * is "#7"); otherwise the first word that is not the agent's own name, which
 * the logo already says ("claude · login fix" is "login"), without a file
 * extension ("fake-agent.sh" is "fake-agent"). Falls back to the title.
 */
export function railLabel(title: string, command?: string): string {
  const tokens = title.split(SEPARATORS).filter(Boolean);
  const issue = tokens.find((t) => /^#\d+$/.test(t));
  if (issue) return issue;
  const binary = command ? commandToBinary(command).toLowerCase() : null;
  const word = tokens.find((t) => /[\p{L}\p{N}]/u.test(t) && t.toLowerCase() !== binary);
  const picked = word ?? tokens[0] ?? title;
  return picked.replace(EXTENSION, "") || picked;
}

export interface RailPaneContext {
  sessions: Session[];
  projects: Project[];
  events: Record<number, NotificationEvent[]>;
  lastSeenSeq: Record<number, number>;
  dismissedEventKeys: Record<string, true>;
  mutedSessionIds: number[];
  theme: Theme;
  activePanelId: string | null;
}

/** One entry per pane, in the order given; needs-you and unread follow the
 * same definitions the bell and the session picker use. */
export function buildRailPaneEntries(
  panes: readonly RailPaneInput[],
  ctx: RailPaneContext,
): RailPaneEntry[] {
  return panes.map((pane) => {
    const session =
      pane.sessionId === undefined ? undefined : ctx.sessions.find((s) => s.id === pane.sessionId);
    const active = pane.id === ctx.activePanelId;
    if (!session) {
      const title = pane.title || "Pane";
      return {
        panelId: pane.id,
        label: railLabel(title),
        fullTitle: title,
        projectName: null,
        logo: null,
        isSession: pane.sessionId !== undefined,
        needsYou: false,
        unreadCount: 0,
        active,
      };
    }
    const fullTitle = sessionDisplayTitle(session);
    const muted = ctx.mutedSessionIds.includes(session.id);
    const seen = ctx.lastSeenSeq[session.id] ?? 0;
    const events = ctx.events[session.id];
    return {
      panelId: pane.id,
      label: railLabel(fullTitle, session.command),
      fullTitle,
      projectName: ctx.projects.find((p) => p.id === session.projectId)?.name ?? null,
      logo: resolveAgentLogo(session.command, ctx.theme),
      isSession: true,
      needsYou: sessionNeedsYou(session, events, seen, ctx.dismissedEventKeys, muted),
      unreadCount: sessionUnreadCount(session.id, events, seen, ctx.dismissedEventKeys, muted),
      active,
    };
  });
}

/** "login fix — aurora-web, needs you, 2 unread": the entry's accessible name. */
export function railPaneAccessibleName(entry: RailPaneEntry): string {
  const parts = [entry.projectName ? `${entry.fullTitle} — ${entry.projectName}` : entry.fullTitle];
  if (entry.needsYou) parts.push("needs you");
  if (entry.unreadCount > 0) parts.push(`${entry.unreadCount} unread`);
  return parts.join(", ");
}
