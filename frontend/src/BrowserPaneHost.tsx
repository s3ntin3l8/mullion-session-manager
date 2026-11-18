import { useEffect, useMemo, useState } from "react";
import type { DockviewPanelApi } from "dockview-react";
import type { Session } from "./api/index.js";
import type { BrowserPanelParams } from "./BrowserPanel.js";
import { BrowserShell } from "./BrowserShell.js";
import { useBrowserFeatureEnabled } from "./hooks/useBrowserFeatureEnabled.js";
import { useFollowedSession } from "./hooks/useFollowedSession.js";
import { selectSessionTitle } from "./lib/sessionDisplay.js";
import { useDashboardStore } from "./store/index.js";
import {
  browserAgentTitle,
  browserPreviewTitle,
  previewTargetFromTitle,
} from "./lib/browserTitles.js";
import type { BrowserMode } from "./lib/browserTitles.js";

// The grid's Browser pane (#3371): BrowserShell in a dockview panel. Both
// panel components a saved layout can hold load here: `browser` (a preview,
// opened by the Dock, the palette, a branch row) starts in Preview, and
// `browserPane` (`browserPane-<sessionId>`, the pane menu's agent's browser)
// starts in Agent's browser. A switch changes the mode inside the panel and
// never renames it.
//
// What this adds over BrowserShell is the grid's rules:
// - The mode is written to the panel's params, so a saved layout and a reload
//   keep it. An opener that focuses an existing pane can set it too.
// - The session is fixed when the pane switches to Agent's browser (decision
//   4): the project's focused or last-focused session at that moment, kept in
//   `agentSessionId`. Later focus changes do not move it.
// - A killed or exited session switches the pane to Preview if it has a
//   project, and closes it if not.
// - The title follows the mode (decision 5).

export interface BrowserHostParams extends BrowserPanelParams {
  /** A `browserPane-<id>` panel's own session, the one it was opened for. */
  sessionId?: number;
  /** The session fixed by the last switch to Agent's browser; wins over `sessionId`. */
  agentSessionId?: number;
  mode?: BrowserMode;
  /** What "Browser · Preview: <target>" names. */
  previewTarget?: string;
}

export type BrowserHostComponent = "browser" | "browserPane";

function isLive(session: Session | undefined): session is Session {
  return session != null && session.status !== "killed" && session.status !== "exited";
}

export function BrowserPaneHost({
  params,
  api,
  component,
}: {
  params: BrowserHostParams;
  api?: DockviewPanelApi;
  component: BrowserHostComponent;
}) {
  const sessions = useDashboardStore((s) => s.sessions);
  const sessionsLoaded = useDashboardStore((s) => s.sessionsLoaded);
  const projects = useDashboardStore((s) => s.projects);
  const browserFeature = useBrowserFeatureEnabled();

  const ownSession =
    params.sessionId != null ? sessions.find((s) => s.id === params.sessionId) : undefined;
  // A `browser` pane names its project; a `browserPane` pane's project is its
  // session's, written into the params once known so the pane can still show
  // the project's preview after the session is gone.
  const projectId = params.projectId ?? ownSession?.projectId ?? null;
  const project = projectId != null ? projects.find((p) => p.id === projectId) : undefined;

  const pinnedId = params.agentSessionId ?? params.sessionId ?? null;
  const pinnedSession = pinnedId != null ? sessions.find((s) => s.id === pinnedId) : undefined;
  const pinnedLive = isLive(pinnedSession) ? pinnedSession : null;

  // The session a switch to Agent's browser would fix: the project's focused
  // or last-focused one while this pane is open, else its newest live one (a
  // pane opened after focus already left the session has no memory of it).
  const followed = useFollowedSession(projectId ?? -1);
  const newest = useMemo(() => {
    if (projectId == null) return null;
    let best: Session | null = null;
    for (const s of sessions) {
      if (s.projectId !== projectId || s.kind === "dock" || !isLive(s)) continue;
      if (best == null || s.id > best.id) best = s;
    }
    return best;
  }, [sessions, projectId]);
  const candidate = followed ?? newest;

  const [mode, setMode] = useState<BrowserMode>(
    () => params.mode ?? (component === "browserPane" ? "agent" : "preview"),
  );
  // Sessions an explicit open asked to attach without a probe: the session a
  // `browserPane` pane was opened for, and an opener's later retarget.
  const [explicit, setExplicit] = useState<ReadonlySet<number>>(() =>
    component === "browserPane" && mode === "agent" && params.sessionId != null
      ? new Set([params.sessionId])
      : new Set(),
  );

  // An opener that focuses this pane can ask for a mode through the params
  // (openBrowserPanePanel asks for Agent's browser). The pane's own switch
  // writes the params too, and records what it wrote here first, so only a
  // change from outside reaches the second branch.
  const [seenParamMode, setSeenParamMode] = useState(params.mode);
  if (params.mode !== seenParamMode) {
    setSeenParamMode(params.mode);
    if (params.mode != null && params.mode !== mode) {
      setMode(params.mode);
      if (params.mode === "agent" && pinnedId != null) {
        setExplicit((prev) => new Set(prev).add(pinnedId));
      }
    }
  }

  // The pinned session is gone: a pane with a project shows its preview, and
  // one without is closed (the effect below).
  const sessionGone = mode === "agent" && sessionsLoaded && pinnedLive == null;
  if (sessionGone && projectId != null) {
    setMode("preview");
    setSeenParamMode("preview");
  }
  useEffect(() => {
    if (sessionGone && projectId == null) api?.close();
  }, [sessionGone, projectId, api]);

  const changeMode = (next: BrowserMode) => {
    if (next === mode) return;
    if (next === "agent") {
      const target = pinnedLive ?? candidate;
      if (target == null) return;
      setMode("agent");
      setSeenParamMode("agent");
      api?.updateParameters(
        target.id === pinnedId ? { mode: "agent" } : { mode: "agent", agentSessionId: target.id },
      );
      return;
    }
    setMode("preview");
    setSeenParamMode("preview");
    api?.updateParameters({ mode: "preview" });
  };

  // What the preview names. A pane opened as a preview reads it once from the
  // title it was opened or saved with; a `browserPane` pane previews its
  // session's project.
  const [titleTarget] = useState<string | undefined>(() =>
    params.previewTarget !== undefined
      ? params.previewTarget
      : component === "browser"
        ? previewTargetFromTitle(api?.title)
        : undefined,
  );
  const previewTarget = titleTarget || project?.name || "";

  const agentSession = mode === "agent" ? pinnedLive : (pinnedLive ?? candidate);
  const agentSessionTitle = useDashboardStore((s) =>
    agentSession ? selectSessionTitle(s, agentSession) : "",
  );

  const title =
    mode === "agent" ? browserAgentTitle(agentSessionTitle) : browserPreviewTitle(previewTarget);
  useEffect(() => {
    if (api && api.title !== title) api.setTitle(title);
  }, [api, title]);

  // Writes what a reload needs back into the layout: the mode, and the
  // project and preview target where they were only derived.
  useEffect(() => {
    if (!api) return;
    const patch: Partial<BrowserHostParams> = {};
    if (params.mode !== mode) patch.mode = mode;
    if (params.projectId == null && projectId != null) patch.projectId = projectId;
    if (params.previewTarget == null && previewTarget) patch.previewTarget = previewTarget;
    if (Object.keys(patch).length > 0) api.updateParameters(patch);
  }, [api, mode, params.mode, params.projectId, projectId, params.previewTarget, previewTarget]);

  const previewParams = useMemo<BrowserPanelParams>(() => {
    // BrowserPanel spreads the params it is given into its own write-back;
    // the host's keys stay out of it so that write can never undo a switch.
    const preview: BrowserHostParams = { ...params };
    delete preview.mode;
    delete preview.agentSessionId;
    delete preview.previewTarget;
    delete preview.sessionId;
    if (preview.projectId == null && projectId != null) preview.projectId = projectId;
    return preview;
  }, [params, projectId]);

  let agentDisabledReason: string | null = null;
  if (projectId == null) {
    agentDisabledReason = "Open a session's browser from the palette or its pane";
  } else if (pinnedLive == null && candidate == null) {
    agentDisabledReason = "No session in this project";
  }

  if (mode === "agent" && !sessionsLoaded) {
    return <div className="browser-panel-empty">Loading…</div>;
  }

  return (
    <BrowserShell
      mode={mode}
      onModeChange={changeMode}
      browserEnabled={browserFeature === true}
      previewParams={previewParams}
      previewApi={api}
      agentSession={agentSession}
      agentSessionTitle={agentSessionTitle}
      agentDisabledReason={agentDisabledReason}
      attachSessionIds={explicit}
    />
  );
}
