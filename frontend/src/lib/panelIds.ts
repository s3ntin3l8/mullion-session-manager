// The one definition of the panel ids that name a session (`session-12`,
// `timeline-12`, `browserPane-12`). panelUtils' sessionIdFromPanelId and the
// store's recentSessionIds (#3371) both read it, so a new session pane id is
// added in one place.

/** A session's own panes: its terminal and its timeline. */
const OWN_SESSION_PANE = /^(?:session|timeline)-(\d+)$/;
/** Every pane that belongs to one session, its browser pane included. */
const SESSION_PANE = /^(?:session|timeline|browserPane)-(\d+)$/;

/** The session whose own pane (terminal or timeline) this id names, if any. */
export function sessionIdFromOwnPaneId(panelId: string | null | undefined): number | null {
  const match = panelId?.match(OWN_SESSION_PANE);
  return match ? parseInt(match[1]!, 10) : null;
}

/** The session a session-scoped pane id (terminal, timeline, browser) names, if any. */
export function sessionIdFromSessionPaneId(panelId: string | null | undefined): number | null {
  const match = panelId?.match(SESSION_PANE);
  return match ? parseInt(match[1]!, 10) : null;
}
