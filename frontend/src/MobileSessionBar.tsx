import { useEffect, useRef, useState } from "react";
import type { DockviewApi, IDockviewPanel } from "dockview";
import { useDashboardStore } from "./store/index.js";
import { PaneActionsMenu } from "./PaneActionsMenu.js";
import { MobileSessionSwitcher } from "./MobileSessionSwitcher.js";
import type { MobileSessionItem } from "./MobileSessionSwitcher.js";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { panelSessionId } from "./panelUtils.js";
import { resolveAgentLogo } from "./cliLogos.js";
import { unreadEventSummary } from "./eventDescriptions.js";

// Phone-only glue between App's dockview panels and MobileSessionSwitcher
// (which App renders into the toolbar in place of the old `.mobile-tabs`
// strip): derives each tiled panel's status dot / agent logo / unread count,
// switches by activating + maximizing a panel (phone shows one maximized
// group at a time), and owns the inline rename — PaneActionsMenu can't host
// the rename UI itself (see its own comment), so each host of the menu owns
// an equivalent inline swap, same as PaneTab.tsx's renaming/draftName pair.
export function MobileSessionBar({
  panels,
  activePanelId,
  dockviewApi,
  onNewSession,
}: {
  // Tiled panels only: maximizeGroup on a floating panel throws.
  panels: IDockviewPanel[];
  activePanelId: string | null;
  dockviewApi: DockviewApi | null;
  onNewSession: () => void;
}) {
  const sessions = useDashboardStore((s) => s.sessions);
  const events = useDashboardStore((s) => s.events);
  const lastSeenSeq = useDashboardStore((s) => s.lastSeenSeq);
  const dismissedEventKeys = useDashboardStore((s) => s.dismissedEventKeys);
  const theme = useDashboardStore((s) => s.theme);

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

  const items: MobileSessionItem[] = panels.map((panel) => {
    const sessionId = panelSessionId(panel);
    const session = sessions.find((s) => s.id === sessionId);
    let dotColor = "var(--dim)";
    if (session?.attention) dotColor = "var(--ring)";
    else if (session?.activity === "working") dotColor = "var(--g)";
    return {
      id: panel.id,
      title: panel.title ?? "",
      dotColor,
      agentLogo: session ? resolveAgentLogo(session.command, theme) : null,
      // Same unread derivation as PaneTab.tsx's own tab badge.
      unreadCount:
        sessionId === undefined
          ? 0
          : unreadEventSummary(
              sessionId,
              events[sessionId],
              lastSeenSeq[sessionId] ?? 0,
              dismissedEventKeys,
            ).count,
    };
  });

  const findPanel = (id: string) => panels.find((panel) => panel.id === id);
  const activePanel = activePanelId ? findPanel(activePanelId) : undefined;

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
      activeId={activePanelId}
      onSelect={(id) => {
        const panel = findPanel(id);
        if (!panel) return;
        panel.api.setActive();
        dockviewApi?.maximizeGroup(panel);
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
