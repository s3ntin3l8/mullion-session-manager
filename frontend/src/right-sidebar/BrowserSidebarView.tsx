import { useMemo } from "react";
import { useDashboardStore } from "../store/index.js";
import { BrowserShell } from "../BrowserShell.js";
import type { BrowserShellProps } from "../BrowserShell.js";
import type { BrowserPanelParams } from "../BrowserPanel.js";
import { useFollowedSession } from "../hooks/useFollowedSession.js";
import { selectSessionTitle } from "../lib/sessionDisplay.js";
import { useServerInfo } from "../settings/useServerInfo.js";
import type { RightSidebarViewProps } from "./views.js";

// The right sidebar's Browser view (#3012), registered only below 1100px (the
// rails bands and the phone; see viewBands.ts). It is the Browser pane's
// BrowserShell (#3372, decision 2 of docs/design/one-browser-pane/note.md):
// the same Preview / Agent's browser switch, with the rail's own rules.
//
// - Agent's browser follows the session the rail follows (decision 4), where
//   the grid pane fixes one at the switch. BrowserShell probes the session's
//   bindings before attaching, since attaching launches its browser.
// - Preview works on the rail's project, or on the target a preview entry
//   point opened (every one of them opens this view below 1100px).
// - Mode and preview live in the store (`railBrowser`), not in this view: the
//   view unmounts when the rail closes, shows another view, or the window
//   crosses 1100px, and comes back as it was left. The first time it is in
//   Agent's browser.

const NO_SESSION_NOTE = "No session in focus. Focus a session of this project to see its browser.";

export function BrowserSidebarView({ projectId }: RightSidebarViewProps) {
  const session = useFollowedSession(projectId);
  // The title the sidebar gives this session (#3285).
  const title = useDashboardStore((s) => (session ? selectSessionTitle(s, session) : ""));
  const rail = useDashboardStore((s) => s.railBrowser);
  const setMode = useDashboardStore((s) => s.setRailBrowserMode);
  // BROWSER_ENABLED: null until the server answers. Without it there is no
  // switch and no agent's browser, so the view is Preview only.
  const serverInfo = useServerInfo();
  const featureOff = serverInfo != null && !serverInfo.features?.browser;
  const mode = featureOff ? "preview" : rail.mode;

  // A project target follows the rail's project: one opened for another
  // project gives way to this project's own preview. An external address
  // (a saved URL, a blank preview) stays whatever project the rail shows.
  const stored = rail.preview;
  const previewParams = useMemo<BrowserPanelParams>(
    () =>
      stored != null && (stored.kind === "external" || stored.projectId === projectId)
        ? stored
        : { projectId },
    [stored, projectId],
  );
  // BrowserPanel writes its address back here, as it does to a grid pane's
  // params, so the address outlives the view.
  const previewApi = useMemo<NonNullable<BrowserShellProps["previewApi"]>>(
    () => ({
      updateParameters: (params) =>
        useDashboardStore.getState().setRailBrowserPreview(params as BrowserPanelParams),
    }),
    [],
  );
  // BrowserPanel reads its target once, on mount: an entry point opening a
  // target (`rev`), or the preview moving to another project, mounts afresh.
  const previewKey = `${rail.rev}:${previewParams.kind === "external" ? "url" : previewParams.projectId}`;

  return (
    <div className="browser-sidebar-view rs-fill">
      <BrowserShell
        key={previewKey}
        mode={mode}
        onModeChange={setMode}
        browserEnabled={!featureOff}
        previewParams={previewParams}
        previewApi={previewApi}
        // Off, there is no agent's browser to show: a null session also lets
        // go of one attached before the server answered, as the grid pane does.
        agentSession={featureOff ? null : session}
        agentSessionTitle={title}
        // With no session in focus, Agent's browser shows this note; the
        // switch's tooltip gives the same reason from Preview.
        agentDisabledReason={session == null ? NO_SESSION_NOTE : null}
      />
    </div>
  );
}
