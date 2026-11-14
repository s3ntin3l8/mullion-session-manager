import { useMemo } from "react";
import { useDashboardStore } from "../store/index.js";
import { buildRailPaneEntries, railPaneAccessibleName } from "../lib/railPanes.js";
import type { RailPaneEntry, RailPaneInput } from "../lib/railPanes.js";
import { FileTextIcon, PlusIcon, TerminalPromptIcon } from "../ui/icons.js";

export interface RailPaneListProps {
  /** The entries to show, in order. */
  entries: readonly RailPaneEntry[];
  /** Focus the pane with this dockview id. */
  onFocus: (panelId: string) => void;
  /** The "+" directly under the entries: start a new session there. */
  onAdd: () => void;
  /** Names the list for assistive tech. */
  label?: string;
}

// The rail's list of open panes (#3009): an agent logo, a few characters, the
// needs-you dot and the unread count, the focused pane marked, and a "+"
// directly under them. Presentational: entries come from buildRailPaneEntries
// (lib/railPanes.ts), so another layout can hand it any subset of panes.
export function RailPaneList({ entries, onFocus, onAdd, label = "Open panes" }: RailPaneListProps) {
  return (
    <div className="rail-pane-list" role="group" aria-label={label}>
      {entries.map((entry) => {
        const tooltip = entry.projectName
          ? `${entry.fullTitle} — ${entry.projectName}`
          : entry.fullTitle;
        return (
          <button
            key={entry.panelId}
            type="button"
            className={`left-rail-btn rail-pane${entry.active ? " active" : ""}`}
            aria-label={railPaneAccessibleName(entry)}
            aria-current={entry.active ? "true" : undefined}
            title={tooltip}
            data-panel-id={entry.panelId}
            onClick={() => onFocus(entry.panelId)}
          >
            {entry.logo ? (
              <img className="rail-pane-logo" src={entry.logo} alt="" aria-hidden="true" />
            ) : entry.isSession ? (
              <TerminalPromptIcon size={16} aria-hidden="true" />
            ) : (
              <FileTextIcon size={16} aria-hidden="true" />
            )}
            <span className="left-rail-label rail-pane-label" aria-hidden="true">
              {entry.label}
            </span>
            {entry.needsYou && <span className="rail-pane-needs-you" aria-hidden="true" />}
            {entry.unreadCount > 0 && (
              <span className="rail-pane-unread" aria-hidden="true">
                {entry.unreadCount > 9 ? "9+" : entry.unreadCount}
              </span>
            )}
          </button>
        );
      })}
      <button
        type="button"
        className="left-rail-btn rail-pane-add"
        aria-label="New session"
        title="New session"
        onClick={onAdd}
      >
        <PlusIcon size={16} strokeLinecap="round" strokeWidth={2} />
      </button>
    </div>
  );
}

export interface RailPanesProps {
  /** The panes to list, in order. */
  panes: readonly RailPaneInput[];
  activePanelId: string | null;
  onFocus: (panelId: string) => void;
  onAdd: () => void;
  label?: string;
}

// The store-connected list: reads what needs-you and unread depend on and
// builds the entries for the panes it is given.
export function RailPanes({ panes, activePanelId, onFocus, onAdd, label }: RailPanesProps) {
  const sessions = useDashboardStore((s) => s.sessions);
  const projects = useDashboardStore((s) => s.projects);
  const events = useDashboardStore((s) => s.events);
  const lastSeenSeq = useDashboardStore((s) => s.lastSeenSeq);
  const dismissedEventKeys = useDashboardStore((s) => s.dismissedEventKeys);
  const mutedSessionIds = useDashboardStore((s) => s.mutedSessionIds);
  const theme = useDashboardStore((s) => s.theme);
  const entries = useMemo(
    () =>
      buildRailPaneEntries(panes, {
        sessions,
        projects,
        events,
        lastSeenSeq,
        dismissedEventKeys,
        mutedSessionIds,
        theme,
        activePanelId,
      }),
    [
      panes,
      sessions,
      projects,
      events,
      lastSeenSeq,
      dismissedEventKeys,
      mutedSessionIds,
      theme,
      activePanelId,
    ],
  );
  return <RailPaneList entries={entries} onFocus={onFocus} onAdd={onAdd} label={label} />;
}
