import { useEffect, useMemo, useRef, useState } from "react";
import type { DockviewPanelApi } from "dockview-react";
import type { Session } from "./api/index.js";
import type { BrowserPanelParams } from "./BrowserPanel.js";
import { BrowserShell } from "./BrowserShell.js";
import { useServerInfo } from "./settings/useServerInfo.js";
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
  /** Bumped by each explicit open of the session's browser (openBrowserPanePanel). */
  openRev?: number;
  /** #3373 — bumped by an opener that resets the preview to these params,
   * dropping a target ⇄ opened in it. */
  previewRev?: number;
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
  // BROWSER_ENABLED: null until the server answers; no switch until then.
  const serverInfo = useServerInfo();
  const browserFeature = serverInfo ? Boolean(serverInfo.features?.browser) : null;

  const ownSession =
    params.sessionId != null ? sessions.find((s) => s.id === params.sessionId) : undefined;
  // A `browser` pane names its project; a `browserPane` pane's project is its
  // session's, written into the params once known so the pane can still show
  // the project's preview after the session is gone.
  const projectId = params.projectId ?? ownSession?.projectId ?? null;
  const project = projectId != null ? projects.find((p) => p.id === projectId) : undefined;

  // Mode and session are the pane's own state, written back to the params
  // (the effect below) rather than read from them: dockview hands the new
  // params over a render later, and a pane that read them back would act on
  // the old ones in between.
  const paramPin = params.agentSessionId ?? params.sessionId ?? null;
  const [pinnedId, setPinnedId] = useState<number | null>(paramPin);
  const pinnedSession = pinnedId != null ? sessions.find((s) => s.id === pinnedId) : undefined;
  const pinnedLive = isLive(pinnedSession) ? pinnedSession : null;

  // The session a switch to Agent's browser would fix: the project's focused
  // session, else its last-focused one (the store remembers focus from before
  // this pane opened and took focus itself), else its newest live one.
  // useFollowedSession skips killed sessions only; an exited one cannot be
  // attached either, so it is not a candidate.
  const followedSession = useFollowedSession(projectId ?? -1);
  const followed = isLive(followedSession ?? undefined) ? followedSession : null;
  const recentSessionIds = useDashboardStore((s) => s.recentSessionIds);
  const fallback = useMemo(() => {
    if (projectId == null) return null;
    const eligible = (s: Session | undefined): s is Session =>
      s != null && s.projectId === projectId && s.kind !== "dock" && isLive(s);
    for (const id of recentSessionIds) {
      const s = sessions.find((x) => x.id === id);
      if (eligible(s)) return s;
    }
    let newest: Session | null = null;
    for (const s of sessions) {
      if (eligible(s) && (newest == null || s.id > newest.id)) newest = s;
    }
    return newest;
  }, [sessions, projectId, recentSessionIds]);
  const candidate = followed ?? fallback;

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

  // An opener that focuses this pane can ask for a mode and session through
  // the params (openBrowserPanePanel asks for Agent's browser of its session).
  // Only a change in the params counts, and the pane's own write-back always
  // matches its state, so only a request from outside changes anything here.
  // `openRev` is bumped by every explicit open of the session's browser, so
  // a second open of a pane that already says "agent" still attaches.
  const [seen, setSeen] = useState({ mode: params.mode, pin: paramPin, rev: params.openRev });
  if (params.mode !== seen.mode || paramPin !== seen.pin || params.openRev !== seen.rev) {
    setSeen({ mode: params.mode, pin: paramPin, rev: params.openRev });
    if (params.openRev != null && params.openRev !== seen.rev && paramPin != null) {
      setPinnedId(paramPin);
      setMode("agent");
      setExplicit((prev) => new Set(prev).add(paramPin));
    } else {
      if (paramPin !== seen.pin && paramPin !== pinnedId) setPinnedId(paramPin);
      if (params.mode != null && params.mode !== seen.mode && params.mode !== mode) {
        setMode(params.mode);
        if (params.mode === "agent" && paramPin != null) {
          setExplicit((prev) => new Set(prev).add(paramPin));
        }
      }
    }
  }

  // The pinned session is gone: a pane with a project shows its preview, and
  // one without is closed (the effect below).
  const sessionGone = mode === "agent" && sessionsLoaded && pinnedLive == null;
  if (sessionGone && projectId != null) setMode("preview");
  useEffect(() => {
    if (sessionGone && projectId == null) api?.close();
  }, [sessionGone, projectId, api]);

  // Without BROWSER_ENABLED there is no switch and no agent's browser to
  // show, so a pane saved or opened in Agent's browser shows Preview, and lets
  // go of any attachment it made before the server answered.
  const featureOff = browserFeature === false && mode === "agent" && projectId != null;
  // An explicit open (the pane menu, the palette) asked for the agent's
  // browser: say why it got Preview instead of renaming itself silently.
  // Recorded with the switch to Preview, since that render is discarded.
  const [deniedOpen, setDeniedOpen] = useState(false);
  if (featureOff) {
    setMode("preview");
    if (pinnedId != null && explicit.has(pinnedId)) setDeniedOpen(true);
  }
  const toldRef = useRef(false);
  useEffect(() => {
    if (!deniedOpen || toldRef.current) return;
    toldRef.current = true;
    useDashboardStore.getState().pushToast({
      kind: "info",
      message:
        "The agent's browser is off on this server (BROWSER_ENABLED), so this shows Preview.",
    });
  }, [deniedOpen]);

  const changeMode = (next: BrowserMode) => {
    if (next === mode) return;
    if (next === "agent") {
      const target = pinnedLive ?? candidate;
      if (target == null) return;
      setPinnedId(target.id);
    }
    setMode(next);
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
  // #3373 — ⇄ opened another target in the preview: the title names that.
  const [retargetLabel, setRetargetLabel] = useState<string | null>(null);
  const [seenPreviewRev, setSeenPreviewRev] = useState(params.previewRev);
  if (params.previewRev !== seenPreviewRev) {
    // An opener reset the preview; the title names what it opened.
    setSeenPreviewRev(params.previewRev);
    setRetargetLabel(null);
  }
  const previewTarget = (retargetLabel ?? titleTarget) || project?.name || "";

  const agentSession =
    browserFeature === false ? null : mode === "agent" ? pinnedLive : (pinnedLive ?? candidate);
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
    if (pinnedId != null && paramPin !== pinnedId) patch.agentSessionId = pinnedId;
    if (params.projectId == null && projectId != null) patch.projectId = projectId;
    if (
      previewTarget &&
      params.previewTarget !== previewTarget &&
      (params.previewTarget == null || retargetLabel != null)
    ) {
      patch.previewTarget = previewTarget;
    }
    if (Object.keys(patch).length > 0) api.updateParameters(patch);
  }, [
    api,
    mode,
    params.mode,
    pinnedId,
    paramPin,
    params.projectId,
    projectId,
    params.previewTarget,
    previewTarget,
    retargetLabel,
  ]);

  const previewParams = useMemo<BrowserPanelParams>(() => {
    // BrowserPanel spreads the params it is given into its own write-back;
    // the host's keys stay out of it so that write can never undo a switch.
    const preview: BrowserHostParams = { ...params };
    delete preview.mode;
    delete preview.agentSessionId;
    delete preview.previewTarget;
    delete preview.sessionId;
    delete preview.openRev;
    delete preview.previewRev;
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
      onPreviewRetarget={setRetargetLabel}
      previewRev={params.previewRev}
    />
  );
}
