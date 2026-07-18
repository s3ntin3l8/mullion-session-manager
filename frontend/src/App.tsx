import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Sidebar } from "./Sidebar.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { TerminalPane } from "./TerminalPane.js";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { GitHubPanel } from "./GitHubPanel.js";
import type { GitHubPanelParams } from "./GitHubPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";
import type { BrowserPanelParams } from "./BrowserPanel.js";
import { OpenUrlModal } from "./OpenUrlModal.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Toolbar } from "./Toolbar.js";
import { PaneTab } from "./PaneTab.js";
import { PaneHeaderActions } from "./PaneHeaderActions.js";
import { CommandPalette } from "./CommandPalette.js";
import { Settings } from "./Settings.js";
import type { SettingsSection } from "./Settings.js";
import { Dock } from "./Dock.js";
import { GridIcon, ServerRackIcon } from "./icons.js";
import { useDashboardStore, LIVE_REFRESH_INTERVAL_MS } from "./store.js";
import { api } from "./api.js";
import type { Session } from "./api.js";
import { playNotificationSound } from "./notifySound.js";

// Wrapped per-panel (not once around the whole dockview area) so a crash in
// one session's terminal can't take out sibling panes too. Owns its own
// `resetKey`, bumped by the boundary's "Reload pane" — a class component's
// error state has no way to retry the exact subtree that threw, so the
// fix is remounting a fresh <TerminalPane> under a new key instead.
function TerminalPanelWrapper(props: IDockviewPanelProps<TerminalPaneParams>) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <TerminalPane key={resetKey} params={props.params} />
    </ErrorBoundary>
  );
}

// A crash here is much lower-stakes than a terminal pane (a static status
// fetch, not a live WS/xterm connection), but wrapped the same way for the
// same reason: one project's GitHub panel misbehaving shouldn't blank the
// whole dashboard.
function GitHubPanelWrapper(props: IDockviewPanelProps<GitHubPanelParams>) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <GitHubPanel key={resetKey} params={props.params} />
    </ErrorBoundary>
  );
}

// Same reasoning as GitHubPanelWrapper above — a crashing iframe/preview
// fetch shouldn't blank the whole dashboard either.
function BrowserPanelWrapper(props: IDockviewPanelProps<BrowserPanelParams>) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <BrowserPanel key={resetKey} params={props.params} />
    </ErrorBoundary>
  );
}

const components = {
  terminal: TerminalPanelWrapper,
  github: GitHubPanelWrapper,
  browser: BrowserPanelWrapper,
};

// The custom tab component (PaneTab) carries the redesign's most important
// distinction — close-pane (detach) vs. kill-session (guarded, ends the
// program) — so it only applies to "terminal" panels; "github"/"browser"
// have no session to kill, so they fall back to dockview's own default tab
// (title + plain close), same as this repo's other non-terminal panel
// types would.
const tabComponents = { terminal: PaneTab };

const AUTOSAVE_DEBOUNCE_MS = 800;
const DEFAULT_WORKSPACE_NAME = "Default";
const MOBILE_BREAKPOINT_QUERY = "(max-width: 699px)";

interface PendingSave {
  // Captured at *schedule* time, not read live at fire time — the load-
  // bearing property that keeps a fast A->B workspace switch from writing
  // A's (or a half-formed) layout into B's row, or vice versa. See the
  // flush call in the restore effect below.
  workspaceId: number;
  timer: ReturnType<typeof setTimeout>;
}

interface PaletteState {
  open: boolean;
  scope: "global" | "project";
  projectId: number | null;
}

export function App() {
  const [dockviewApi, setDockviewApi] = useState<DockviewApi | null>(null);
  // Only meaningful below the mobile breakpoint (see styles.css) — a no-op
  // on desktop, where .sidebar-wrapper ignores this class entirely.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [palette, setPalette] = useState<PaletteState>({
    open: false,
    scope: "global",
    projectId: null,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  // Issue #28's "general-purpose browser tile" entry point — CommandPalette's
  // own "Open URL…" row (project-independent, unlike its Integrations
  // section) triggers this.
  const [openUrlModalOpen, setOpenUrlModalOpen] = useState(false);
  // Bumped on every dockview layout change so the toolbar's pane count and
  // the mobile switcher's tab list re-render off dockviewApi.panels, which
  // dockview itself doesn't expose as reactive state.
  const [panelsVersion, setPanelsVersion] = useState(0);

  const {
    workspaces,
    projects,
    sessions,
    activeWorkspaceId,
    refreshWorkspaces,
    createWorkspace,
    saveWorkspaceLayout,
    setActiveWorkspaceId,
    theme,
    settings,
    notificationsEnabled,
    startLiveRefresh,
    hydrateSettings,
    startThemeWatch,
    sidebarCollapsed,
    setSidebarCollapsed,
    splitRequest,
    clearSplitRequest,
    backendReachable,
    refreshSessions,
  } = useDashboardStore();

  // Guards against auto-creating "Default" twice — both from React
  // StrictMode's dev-mode double-invoke of effects (refs survive that,
  // state-setters don't re-run the check reliably) and from the fetch race
  // below (workspacesLoaded flips exactly once).
  const bootstrappedRef = useRef(false);
  // True only while a programmatic fromJSON() restore is in flight, so the
  // onDidLayoutChange events it fires aren't mistaken for a real edit and
  // echoed back into an autosave.
  const restoringRef = useRef(false);
  const pendingSaveRef = useRef<PendingSave | null>(null);
  // Which workspace id the grid currently reflects a restore for. Lets the
  // restore effect safely list `workspaces` as a dependency (needed so it
  // retries once the initial fetch resolves, if dockviewApi became ready
  // first and saw an empty list) without re-restoring — and blowing away
  // in-progress edits — every time `workspaces` changes for an unrelated
  // reason (e.g. renaming some other workspace).
  const restoredWorkspaceIdRef = useRef<number | null>(null);
  // Which session ids already had `attention` the last time we checked, so
  // the notification effect below only fires on the *transition* into
  // attention, not on every live-refresh tick while it stays true.
  const seenAttentionRef = useRef<Set<number>>(new Set());
  // Same idea for the separate "exited-session alerts" effect below.
  const seenExitedRef = useRef<Set<number>>(new Set());

  const flushPendingSave = useCallback(
    (api: DockviewApi) => {
      const pending = pendingSaveRef.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingSaveRef.current = null;
      // Read *before* the caller clears/replaces the grid — this is still
      // the outgoing workspace's own layout at this point. The API layer
      // treats layouts as opaque Record<string, unknown> (see api.ts); go
      // through `unknown` since SerializedDockview has no index signature.
      void saveWorkspaceLayout(
        pending.workspaceId,
        api.toJSON() as unknown as Record<string, unknown>,
      );
    },
    [saveWorkspaceLayout],
  );

  const scheduleSave = useCallback(
    (api: DockviewApi, workspaceId: number) => {
      if (pendingSaveRef.current) clearTimeout(pendingSaveRef.current.timer);
      const timer = setTimeout(() => {
        pendingSaveRef.current = null;
        void saveWorkspaceLayout(workspaceId, api.toJSON() as unknown as Record<string, unknown>);
      }, AUTOSAVE_DEBOUNCE_MS);
      pendingSaveRef.current = { workspaceId, timer };
    },
    [saveWorkspaceLayout],
  );

  const onReady = useCallback((event: DockviewReadyEvent) => {
    setDockviewApi(event.api);
  }, []);

  // Load the workspace list exactly once on mount.
  useEffect(() => {
    void refreshWorkspaces().then(() => setWorkspacesLoaded(true));
  }, [refreshWorkspaces]);

  // First-ever load (no workspaces exist at all, anywhere) auto-creates
  // "Default" and selects it. Gated on workspacesLoaded so this can't fire
  // on the pre-fetch render where `workspaces` is still `[]` merely because
  // the request hasn't resolved yet. The ref re-arms itself once the list is
  // non-empty (rather than latching permanently true), so deleting every
  // workspace later — e.g. via the sidebar's own delete button — still
  // recovers a fresh "Default" instead of leaving the app with zero
  // workspaces and a dead activeWorkspaceId pointing nowhere.
  useEffect(() => {
    if (!workspacesLoaded) return;
    if (workspaces.length > 0) {
      bootstrappedRef.current = false;
      return;
    }
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void createWorkspace(DEFAULT_WORKSPACE_NAME).then((workspace) => {
      setActiveWorkspaceId(workspace.id);
    });
  }, [workspacesLoaded, workspaces.length, createWorkspace, setActiveWorkspaceId]);

  // If activeWorkspaceId (persisted in localStorage) points at a workspace
  // that no longer exists — deleted, or a stale value from a previous
  // install — fall back to the first available one.
  useEffect(() => {
    if (workspaces.length === 0) return;
    const stillExists = workspaces.some((w) => w.id === activeWorkspaceId);
    if (!stillExists) setActiveWorkspaceId(workspaces[0].id);
  }, [workspaces, activeWorkspaceId, setActiveWorkspaceId]);

  // Restore the active workspace's saved layout whenever it changes
  // (including the first time dockview itself becomes ready). `workspaces`
  // is deliberately in the dependency array — dockviewApi frequently becomes
  // ready before the initial refreshWorkspaces() fetch resolves, and without
  // it this effect would see an empty list, bail out once, and never get a
  // second chance to run once the real data arrived. The
  // restoredWorkspaceIdRef guard is what keeps that from also re-restoring
  // (and fighting in-progress edits) on every unrelated `workspaces` refetch,
  // e.g. after renaming some other workspace.
  useEffect(() => {
    if (!dockviewApi || activeWorkspaceId === null) return;
    if (restoredWorkspaceIdRef.current === activeWorkspaceId) return;
    const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!workspace) return;

    // Flush the OUTGOING workspace's pending autosave synchronously before
    // tearing down its layout below.
    flushPendingSave(dockviewApi);

    restoringRef.current = true;
    try {
      dockviewApi.clear();
      if (workspace.layout) {
        dockviewApi.fromJSON(workspace.layout as unknown as Parameters<DockviewApi["fromJSON"]>[0]);
      }
    } catch (err) {
      // A corrupt or version-incompatible layout blob must never brick the
      // whole dashboard — this runs outside any panel's own ErrorBoundary,
      // since it's not inside a panel at all. Fall back to an empty grid.
      console.error("[workspace] failed to restore layout, resetting to empty grid", err);
      dockviewApi.clear();
    } finally {
      // fromJSON can fire onDidLayoutChange asynchronously for some panel
      // mount events — give it a tick before re-arming autosave so the
      // restore itself is never echoed back as a save.
      setTimeout(() => {
        restoringRef.current = false;
      }, 0);
    }
    restoredWorkspaceIdRef.current = activeWorkspaceId;
  }, [dockviewApi, activeWorkspaceId, workspaces, flushPendingSave]);

  // Any real layout change (add/remove/move panel, or a splitter-drag
  // resize) schedules a debounced autosave, unless it's the restore
  // effect's own echo. Also bumps panelsVersion so the toolbar/mobile-tabs
  // pane count/list re-render (dockview's own panel list isn't otherwise
  // reactive from React's perspective).
  useEffect(() => {
    if (!dockviewApi || activeWorkspaceId === null) return;
    const workspaceId = activeWorkspaceId;
    const disposable = dockviewApi.onDidLayoutChange(() => {
      setPanelsVersion((v) => v + 1);
      if (restoringRef.current) return;
      scheduleSave(dockviewApi, workspaceId);
    });
    return () => disposable.dispose();
  }, [dockviewApi, activeWorkspaceId, scheduleSave]);

  // Mobile breakpoint detection — mirrors the design's own matchMedia usage
  // (699px) rather than duplicating the value as a magic number elsewhere.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const onChange = () => {
      setIsMobile(mq.matches);
      if (!mq.matches) dockviewApi?.exitMaximizedGroup();
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [dockviewApi]);

  const openSettings = useCallback((section: SettingsSection = "appearance") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  // Global keyboard shortcuts: ⌘K/Ctrl+K opens the launcher, ⌘,/Ctrl+, opens
  // settings, Esc closes whichever overlay is open. Registered once,
  // independent of what currently has DOM focus.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => ({ ...p, open: true, scope: "global" }));
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        openSettings();
      } else if (e.key === "Escape") {
        setPalette((p) => ({ ...p, open: false }));
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSettings]);

  // Starts the ~4s session-status poll once (paused while the tab is
  // hidden) so status badges reflect the backend without a mutation.
  useEffect(() => startLiveRefresh(), [startLiveRefresh]);

  // Fetches the server-persisted Settings blob once on mount (store.ts seeds
  // sane defaults synchronously so nothing blocks on this) and starts
  // watching the OS color-scheme preference for as long as the user's Theme
  // setting is "System".
  useEffect(() => void hydrateSettings(), [hydrateSettings]);
  useEffect(() => startThemeWatch(), [startThemeWatch]);

  // Fires a browser Notification on the *transition* into attention (not
  // every poll tick it stays true) when the user has opted in via Settings
  // and granted permission — the client-side half of WS-6's "collect the
  // signals" scope; there's no server push, this is purely reacting to the
  // live-refresh poll above. Each of the two delivery channels
  // (Settings -> Notifications & status) gates independently: browser
  // notification and sound can be toggled on/off separately.
  useEffect(() => {
    const attentionNow = new Set(sessions.filter((s) => s.attention).map((s) => s.id));
    if (notificationsEnabled) {
      const canNotify =
        settings.notifications.channels.browser &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted";
      for (const session of sessions) {
        if (session.attention && !seenAttentionRef.current.has(session.id)) {
          if (canNotify) {
            new Notification(session.name || session.command, { body: "Needs your input" });
          }
          if (settings.notifications.channels.sound) {
            playNotificationSound(settings.notifications.soundName);
          }
        }
      }
    }
    seenAttentionRef.current = attentionNow;
  }, [sessions, notificationsEnabled, settings.notifications]);

  // "Exited-session alerts" (Settings -> Notifications & status) — notifies
  // on the *transition* into "exited" (the reconciler catching a program
  // that ended on its own), same shape as the attention effect above but a
  // separate opt-in and a separate seen-set (a session can go
  // attention -> exited, and each transition should be able to notify
  // independently).
  useEffect(() => {
    const exitedNow = new Set(sessions.filter((s) => s.status === "exited").map((s) => s.id));
    if (settings.notifications.exitedAlerts) {
      const canNotify =
        settings.notifications.channels.browser &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted";
      for (const session of sessions) {
        if (session.status === "exited" && !seenExitedRef.current.has(session.id)) {
          if (canNotify) {
            new Notification(session.name || session.command, { body: "Program exited" });
          }
          if (settings.notifications.channels.sound) {
            playNotificationSound(settings.notifications.soundName);
          }
        }
      }
    }
    seenExitedRef.current = exitedNow;
  }, [sessions, settings.notifications]);

  const onOpenSession = useCallback(
    (session: Session) => {
      if (!dockviewApi) return;
      const panelId = `session-${session.id}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        if (isMobile) dockviewApi.maximizeGroup(existing);
      } else {
        const panel = dockviewApi.addPanel({
          id: panelId,
          component: "terminal",
          tabComponent: "terminal",
          title: session.name || session.command,
          params: { sessionId: session.id },
        });
        if (isMobile) dockviewApi.maximizeGroup(panel);
      }
      setSidebarOpen(false);
    },
    [dockviewApi, isMobile],
  );

  // A session ended via the sidebar's explicit "end session" action (as
  // opposed to just closing its panel, which only detaches) should also
  // close its panel if one happens to be open — otherwise the pane is left
  // showing a terminal for a program that no longer exists.
  const onSessionEnded = useCallback(
    (session: Session) => {
      dockviewApi?.getPanel(`session-${session.id}`)?.api.close();
    },
    [dockviewApi],
  );

  // Opens (or focuses an already-open) GitHub panel for a project — one
  // stable panel id per project, so re-triggering this (Dock widget click,
  // CommandPalette's Integrations entry) never duplicates the tab, same
  // "existing ? focus : addPanel" shape as onOpenSession above.
  const onOpenGitHub = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      const project = projects.find((p) => p.id === projectId);
      const panelId = `github-${projectId}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        if (isMobile) dockviewApi.maximizeGroup(existing);
      } else {
        const panel = dockviewApi.addPanel({
          id: panelId,
          component: "github",
          title: project ? `GitHub: ${project.name}` : "GitHub",
          params: { projectId },
        });
        if (isMobile) dockviewApi.maximizeGroup(panel);
      }
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile],
  );

  // Opens (or focuses) a browser preview pane for a project's dev server
  // (issue #28) — same open-or-focus-by-stable-id shape as onOpenGitHub
  // above. BrowserPanel itself resolves/creates the preview and handles the
  // "not configured"/"not enabled" states, so this handler doesn't need to
  // pre-check anything (see BrowserPanel.tsx's own comment on why params
  // only ever need to carry projectId).
  const onOpenBrowser = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      const project = projects.find((p) => p.id === projectId);
      const panelId = `browser-${projectId}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        if (isMobile) dockviewApi.maximizeGroup(existing);
      } else {
        const panel = dockviewApi.addPanel({
          id: panelId,
          component: "browser",
          title: project ? `Preview: ${project.name}` : "Preview",
          params: { projectId },
        });
        if (isMobile) dockviewApi.maximizeGroup(panel);
      }
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile],
  );

  // Issue #28's general-purpose browser tile: creates an external preview
  // for `url` and opens a new pane for it. Created *here*, not left for
  // BrowserPanel's own effect to do on mount, so a rejected URL (e.g.
  // url-guard.ts blocking a private/loopback target) surfaces its error in
  // OpenUrlModal itself — matching CreateHostModal's own
  // await-then-show-inline-error convention — instead of opening a pane
  // that immediately shows "unavailable". The resulting slug is threaded
  // into params so BrowserPanel's first mount reuses it rather than
  // creating a second, redundant preview row for the same URL.
  //
  // Stable panel id is derived from the slug (unlike onOpenBrowser's
  // projectId-derived id above) since an external URL has no other natural
  // stable identity. Always opens a fresh pane rather than open-or-focus:
  // unlike a project (at most one preview pane makes sense), the same URL
  // opened twice is a reasonable thing to want (e.g. comparing two states
  // of the same page).
  const onOpenExternalUrl = useCallback(
    async (url: string) => {
      if (!dockviewApi) return;
      const preview = await api.createExternalPreview(url);
      const panelId = `browser-ext-${preview.slug}`;
      const panel = dockviewApi.addPanel({
        id: panelId,
        component: "browser",
        title: "Preview",
        params: { kind: "external", url, slug: preview.slug },
      });
      if (isMobile) dockviewApi.maximizeGroup(panel);
      setSidebarOpen(false);
    },
    [dockviewApi, isMobile],
  );

  const openGlobalLauncher = useCallback(() => {
    setPalette({ open: true, scope: "global", projectId: null });
  }, []);

  const openProjectLauncher = useCallback((projectId: number) => {
    setPalette({ open: true, scope: "project", projectId });
  }, []);

  // A split-right/split-down click (PaneHeaderActions.tsx) signals intent
  // via the store's `splitRequest` (that component can't receive props from
  // here — dockview owns its render). Rather than an effect that computes
  // the reference panel's project and then calls setPalette (the same
  // setState-in-effect anti-pattern already worked around elsewhere in this
  // file — see CommandPalette/Dock/Settings in Phase 4b), derive whether the
  // palette should be open, and for which project, directly in render. A
  // splitRequest whose reference panel/session can no longer be resolved
  // (e.g. the pane was closed between the click and this render) simply
  // fails to open a palette for it — inert until overwritten by a fresh
  // request or cleared by the palette's own close handler.
  const splitRequestProjectId = useMemo(() => {
    if (!splitRequest || !dockviewApi) return null;
    const panel = dockviewApi.getPanel(splitRequest.referencePanelId);
    const sessionId = (panel?.params as TerminalPaneParams | undefined)?.sessionId;
    return sessions.find((s) => s.id === sessionId)?.projectId ?? null;
  }, [splitRequest, dockviewApi, sessions]);
  const paletteOpen = palette.open || (splitRequest !== null && splitRequestProjectId !== null);
  const paletteScope = splitRequest ? "project" : palette.scope;
  const paletteProjectId = splitRequest ? splitRequestProjectId : palette.projectId;

  // The palette's actual launch handler: if this launch was requested via a
  // split action, add the new panel positioned next to the reference panel
  // instead of the normal open-or-focus path (an already-open session for
  // that id just gets focused — dockview panel ids are unique, and split's
  // whole point is launching a *new* session, so this collision is rare).
  // Falls back to the normal `onOpenSession` path for a non-split launch.
  const handleLaunched = useCallback(
    (session: Session) => {
      if (!dockviewApi || !splitRequest) {
        onOpenSession(session);
        return;
      }
      const req = splitRequest;
      clearSplitRequest();
      const panelId = `session-${session.id}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
      } else {
        const referencePanel = dockviewApi.getPanel(req.referencePanelId);
        dockviewApi.addPanel({
          id: panelId,
          component: "terminal",
          tabComponent: "terminal",
          title: session.name || session.command,
          params: { sessionId: session.id },
          ...(referencePanel ? { position: { referencePanel, direction: req.direction } } : {}),
        });
      }
      setSidebarOpen(false);
    },
    [dockviewApi, splitRequest, clearSplitRequest, onOpenSession],
  );

  // One toggle, two meanings depending on breakpoint: mobile's `sidebarOpen`
  // is a closed-by-default overlay flag (App.tsx-local, not persisted —
  // resets to closed every navigation, which is the right default for an
  // overlay); desktop's `sidebarCollapsed` is a persisted, open-by-default
  // panel-visibility preference (store-owned, survives reload). Same button,
  // same handler, branch on the existing `isMobile` state.
  const toggleSidebar = useCallback(() => {
    if (isMobile) setSidebarOpen((v) => !v);
    else setSidebarCollapsed(!sidebarCollapsed);
  }, [isMobile, sidebarCollapsed, setSidebarCollapsed]);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-derives off panelsVersion, not a real dependency
  const paneCount = useMemo(() => dockviewApi?.panels.length ?? 0, [dockviewApi, panelsVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mobilePanels = useMemo(() => dockviewApi?.panels ?? [], [dockviewApi, panelsVersion]);
  const activePanelId = dockviewApi?.activePanel?.id;
  const defaultDockProjectId = projects[0]?.id ?? null;

  return (
    <div
      className={`app cmux-root${theme === "light" ? " light" : ""}${sidebarOpen ? " sb-open" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}${settings.sidebarDensity === "compact" ? " density-compact" : ""}`}
    >
      <Toolbar
        onToggleSidebar={toggleSidebar}
        onOpenSession={onOpenSession}
        onOpenLauncher={openGlobalLauncher}
        onOpenSettings={() => openSettings()}
        activeWorkspaceName={activeWorkspace?.name ?? null}
        paneCount={paneCount}
      />
      <div className="app-body">
        <div className="cmux-scrim" onClick={() => setSidebarOpen(false)} />
        <div className="sidebar-wrapper cmux-scroll">
          <WorkspaceSwitcher />
          <Sidebar
            onOpenSession={onOpenSession}
            onSessionEnded={onSessionEnded}
            onOpenProjectLauncher={openProjectLauncher}
            onOpenSettingsProjects={() => openSettings("projects")}
          />
        </div>
        <div className="grid-area">
          {/* Whole-backend-down — design States doc section 04. Docked at
              the top of the grid area, rest of the UI dimmed (not
              disabled) beneath it via .grid-area-body.dimmed, matching the
              design's "frozen body" — a visual cue, not an actual input
              lock, so nothing gets destructively stuck if this signal
              itself turns out wrong. Reuses the existing live-refresh poll
              (store.ts) rather than a separate health-check mechanism. */}
          {!backendReachable && (
            <div className="backend-down-banner">
              <ServerRackIcon size={16} style={{ color: "var(--r)" }} />
              <span className="backend-down-title">Tessera server unreachable</span>
              <span className="backend-down-subtext">
                unix socket · retry in {LIVE_REFRESH_INTERVAL_MS / 1000}s…
              </span>
              <button className="backend-down-reconnect" onClick={() => void refreshSessions()}>
                Reconnect
              </button>
            </div>
          )}
          <div className={`grid-area-body${!backendReachable ? " dimmed" : ""}`}>
            {isMobile && mobilePanels.length > 0 && (
              <div className="mobile-tabs">
                {mobilePanels.map((panel) => {
                  const sessionId = (panel.params as TerminalPaneParams | undefined)?.sessionId;
                  const session = sessions.find((s) => s.id === sessionId);
                  let dotColor = "var(--dim)";
                  if (session?.attention) dotColor = "var(--ring)";
                  else if (session?.activity === "working") dotColor = "var(--g)";
                  return (
                    <button
                      key={panel.id}
                      className={`mobile-tab${panel.id === activePanelId ? " active" : ""}`}
                      onClick={() => {
                        panel.api.setActive();
                        dockviewApi?.maximizeGroup(panel);
                      }}
                    >
                      <span className="mobile-tab-dot" style={{ background: dotColor }} />
                      {panel.title}
                    </button>
                  );
                })}
              </div>
            )}
            <button className="sidebar-toggle" onClick={toggleSidebar}>
              ☰
            </button>
            <div className="dockview-container">
              <DockviewReact
                className={theme === "light" ? "dockview-theme-light" : "dockview-theme-dark"}
                components={components}
                tabComponents={tabComponents}
                rightHeaderActionsComponent={PaneHeaderActions}
                onReady={onReady}
                // A lone tab is otherwise sized to its own content, leaving
                // most of the tab strip empty and the title/status cramped
                // — full-width mode stretches a single tab to fill the
                // group instead.
                singleTabMode="fullwidth"
              />
              {/* Empty tiled grid (design States doc §1D) — an overlay, not a
                  conditionally-mounted replacement, so dockview's own API
                  instance stays alive underneath even at zero panes (unmounting
                  <DockviewReact/> would drop dockviewApi and break future
                  addPanel/restore calls). Desktop-only — mobile shows its own
                  switcher instead of the tiled grid entirely. */}
              {!isMobile && paneCount === 0 && (
                <div className="empty-grid-dropzone" style={{ position: "absolute", inset: 0 }}>
                  <GridIcon size={26} style={{ color: "var(--dim)" }} />
                  <span className="empty-grid-title">Nothing tiled here yet</span>
                  <span className="empty-grid-hint">
                    ⌘K to launch · pick a session from the sidebar
                  </span>
                </div>
              )}
            </div>
            <Dock
              projectId={defaultDockProjectId}
              onOpenGitHub={onOpenGitHub}
              onOpenBrowser={onOpenBrowser}
            />
          </div>
        </div>
      </div>
      {paletteOpen && (
        <CommandPalette
          scope={paletteScope}
          projectId={paletteProjectId}
          onClose={() => {
            setPalette((p) => ({ ...p, open: false }));
            clearSplitRequest();
          }}
          onLaunched={handleLaunched}
          onOpenGitHub={onOpenGitHub}
          onOpenBrowser={onOpenBrowser}
          onOpenIntegrationsSettings={() => openSettings("integrations")}
          onOpenUrlModal={() => setOpenUrlModalOpen(true)}
        />
      )}
      {settingsOpen && (
        <Settings onClose={() => setSettingsOpen(false)} initialSection={settingsSection} />
      )}
      {openUrlModalOpen && (
        <OpenUrlModal onClose={() => setOpenUrlModalOpen(false)} onOpen={onOpenExternalUrl} />
      )}
    </div>
  );
}
