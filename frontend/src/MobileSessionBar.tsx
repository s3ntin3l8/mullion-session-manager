import { useEffect, useMemo, useRef, useState } from "react";
import type { DockviewApi, IDockviewPanel } from "dockview";
import { useDashboardStore } from "./store/index.js";
import { PaneActionsMenu } from "./PaneActionsMenu.js";
import { MobileSessionSwitcher } from "./MobileSessionSwitcher.js";
import type {
  MobileSessionItem,
  MobileSessionRow,
  MobileSessionSection,
} from "./MobileSessionSwitcher.js";
import type { Session } from "./api/index.js";
import { buildPickerSections } from "./lib/mobileSessionPicker.js";
import { taskLinkedSessionIds } from "./unifiedBoard.js";
import { sessionUnreadCount } from "./eventDescriptions.js";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { panelSessionId } from "./panelUtils.js";
import { resolveAgentLogo } from "./cliLogos.js";

// Phone-only glue between App's dockview panels and MobileSessionSwitcher
// (which App renders into the toolbar in place of the old `.mobile-tabs`
// strip). The sheet is a UNIVERSAL picker — every session the sidebar would
// list, grouped by project (lib/mobileSessionPicker.ts), whichever workspace
// it lives in; workspaces themselves don't exist on phone. Selecting an open
// row activates + maximizes its panel (phone shows one maximized group at a
// time); selecting one that isn't open goes through onOpenSession, which
// opens it or switches to the workspace that already holds it. The trigger's
// `n/N` and swipe still cycle only the open panes. Also owns the inline rename — PaneActionsMenu can't host
// the rename UI itself (see its own comment), so each host of the menu owns
// an equivalent inline swap, same as PaneTab.tsx's renaming/draftName pair.
export function MobileSessionBar({
  panels,
  activePanelId,
  dockviewApi,
  onNewSession,
  onOpenSession,
}: {
  // Tiled panels only: maximizeGroup on a floating panel throws.
  panels: IDockviewPanel[];
  activePanelId: string | null;
  dockviewApi: DockviewApi | null;
  onNewSession: () => void;
  // App's usePanelOpener onOpenSession: opens the session's panel, or
  // switches to the workspace that already has it.
  onOpenSession: (session: Session) => void;
}) {
  const sessions = useDashboardStore((s) => s.sessions);
  const projects = useDashboardStore((s) => s.projects);
  const tasks = useDashboardStore((s) => s.tasks);
  const hideEndedSessions = useDashboardStore((s) => s.hideEndedSessions);
  const showTaskSessions = useDashboardStore((s) => s.showTaskSessions);
  const mutedSessionIds = useDashboardStore((s) => s.mutedSessionIds);
  const events = useDashboardStore((s) => s.events);
  const lastSeenSeq = useDashboardStore((s) => s.lastSeenSeq);
  const dismissedEventKeys = useDashboardStore((s) => s.dismissedEventKeys);
  const theme = useDashboardStore((s) => s.theme);
  const taskSessionIds = useMemo(() => taskLinkedSessionIds(tasks), [tasks]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Focus the rename input the moment it opens — an explicit transition, not
  // a bare mount effect (same shape as TerminalPane.tsx's find-bar focus).
  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  // Something other than the user (the auto-focus-on-attention effect in
  // App.tsx) can move the active panel mid-rename. Cancel rather than commit:
  // silently persisting a half-typed name off an external focus steal would
  // be a worse surprise than losing the in-progress edit.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRenamingId((current) => (current !== null && current !== activePanelId ? null : current));
  }, [activePanelId]);

  const dotColorFor = (session: Session | undefined) => {
    if (session?.attention) return "var(--ring)";
    if (session?.activity === "working") return "var(--g)";
    return "var(--dim)";
  };

  const pickerSections = useMemo(
    () =>
      buildPickerSections({
        sessions,
        projects,
        panels: panels.map((panel) => ({
          id: panel.id,
          title: panel.title ?? "",
          sessionId: panelSessionId(panel),
        })),
        events,
        lastSeenSeq,
        dismissedEventKeys,
        mutedSessionIds,
        hideEndedSessions,
        showTaskSessions,
        taskSessionIds,
      }),
    [
      sessions,
      projects,
      panels,
      events,
      lastSeenSeq,
      dismissedEventKeys,
      mutedSessionIds,
      hideEndedSessions,
      showTaskSessions,
      taskSessionIds,
    ],
  );

  const sections: MobileSessionSection[] = pickerSections.map((section) => ({
    key: section.key,
    label: section.label,
    kind: section.kind,
    rows: section.rows.map((row): MobileSessionRow => ({
      key: row.key,
      panelId: row.panelId,
      title: row.title,
      dotColor: dotColorFor(row.session ?? undefined),
      agentLogo: row.session ? resolveAgentLogo(row.session.command, theme) : null,
      unreadCount: row.unreadCount,
      needsYou: row.needsYou,
      searchFields: row.searchFields,
    })),
  }));

  // Unread everywhere but the active session — every distinct row once (the
  // "Needs you" pin repeats rows, so it's skipped).
  const activeSessionId = (() => {
    const panel = activePanelId ? panels.find((p) => p.id === activePanelId) : undefined;
    return panel ? panelSessionId(panel) : undefined;
  })();
  const unreadElsewhere = pickerSections.reduce(
    (sum, section) =>
      section.kind === "needs-you"
        ? sum
        : sum +
          section.rows.reduce(
            (rowSum, row) =>
              row.session?.id === activeSessionId ? rowSum : rowSum + row.unreadCount,
            0,
          ),
    0,
  );

  // The open panes, in dockview order — the trigger's `n/N` and swipe domain.
  const items: MobileSessionItem[] = panels.map((panel) => {
    const sessionId = panelSessionId(panel);
    const session = sessions.find((s) => s.id === sessionId);
    return {
      id: panel.id,
      title: panel.title ?? "",
      dotColor: dotColorFor(session),
      agentLogo: session ? resolveAgentLogo(session.command, theme) : null,
      unreadCount:
        sessionId === undefined
          ? 0
          : sessionUnreadCount(
              sessionId,
              events[sessionId],
              lastSeenSeq[sessionId] ?? 0,
              dismissedEventKeys,
              mutedSessionIds.includes(sessionId),
            ),
    };
  });

  const findPanel = (id: string) => panels.find((panel) => panel.id === id);
  const activePanel = activePanelId ? findPanel(activePanelId) : undefined;

  const selectPanel = (id: string) => {
    const panel = findPanel(id);
    if (!panel) return;
    panel.api.setActive();
    dockviewApi?.maximizeGroup(panel);
  };

  const commitRename = () => {
    const panel = renamingId ? findPanel(renamingId) : undefined;
    const value = draftName.trim();
    setRenamingId(null);
    if (!panel || !value) return;
    const sessionId = panelSessionId(panel);
    if (sessionId === undefined) return;
    panel.api.setTitle(value);
    void useDashboardStore.getState().renameSession(sessionId, value);
  };

  return (
    <MobileSessionSwitcher
      items={items}
      sections={sections}
      unreadElsewhere={unreadElsewhere}
      activeId={activePanelId}
      onSelect={selectPanel}
      onSelectRow={(row) => {
        if (row.panelId) {
          selectPanel(row.panelId);
          return;
        }
        const session = pickerSections
          .flatMap((section) => section.rows)
          .find((r) => r.key === row.key)?.session;
        if (session) onOpenSession(session);
      }}
      onClose={(id) => findPanel(id)?.api.close()}
      onNewSession={onNewSession}
      renderActiveActions={() =>
        activePanel && dockviewApi ? (
          <PaneActionsMenu
            api={activePanel.api}
            params={activePanel.params as TerminalPaneParams | undefined}
            containerApi={dockviewApi}
            onRename={() => {
              setDraftName(activePanel.title ?? "");
              setRenamingId(activePanel.id);
            }}
            triggerClassName="mobile-tab-btn"
          />
        ) : null
      }
      renamingId={renamingId}
      renameDraft={draftName}
      renameInputRef={renameInputRef}
      onRenameDraftChange={setDraftName}
      onRenameCommit={commitRename}
      onRenameCancel={() => setRenamingId(null)}
    />
  );
}
