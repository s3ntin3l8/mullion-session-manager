import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import type { DockviewGroupDropLocation, DockviewGroupPanel, Position } from "dockview";
import { Sidebar } from "./Sidebar.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { TerminalPane } from "./TerminalPane.js";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { repaintAllTerminals } from "./terminalRepaintRegistry.js";
import { GitHubPanel } from "./GitHubPanel.js";
import type { GitHubPanelParams } from "./GitHubPanel.js";
import { GitPanel } from "./GitPanel.js";
import type { GitPanelParams } from "./GitPanel.js";
import { AgentRulesPanel } from "./AgentRulesPanel.js";
import type { AgentRulesPanelParams } from "./AgentRulesPanel.js";
import { SkillsPanel } from "./SkillsPanel.js";
import type { SkillsPanelParams } from "./SkillsPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";
import type { BrowserPanelParams } from "./BrowserPanel.js";
import { BrowserPane } from "./BrowserPane.js";
import type { BrowserPaneParams } from "./BrowserPane.js";
import { SessionTimeline } from "./SessionTimeline.js";
import type { SessionTimelineParams } from "./SessionTimeline.js";
import { TasksPanel } from "./TasksPanel.js";
import type { TasksPanelParams } from "./TasksPanel.js";
import { TaskDetail } from "./TaskDetail.js";
import type { TaskDetailParams } from "./TaskDetail.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Toolbar } from "./Toolbar.js";
import { PaneTab } from "./PaneTab.js";
import { PaneHeaderActions } from "./PaneHeaderActions.js";
import { CommandPalette } from "./CommandPalette.js";
import { Settings } from "./Settings.js";
import type { SettingsSection } from "./Settings.js";
import { Dock } from "./Dock.js";
import { KanbanBoard } from "./KanbanBoard.js";
import { GridIcon, RefreshIcon, ServerRackIcon } from "./icons.js";
import {
  useDashboardStore,
  LIVE_REFRESH_INTERVAL_MS,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from "./store.js";
import type { Session } from "./api.js";
import { getSchemeBackground } from "./terminalTheme.js";
import { playNotificationSound } from "./notifySound.js";
import { randomPanelId } from "./random-id.js";
import { formatPaneTitle, initialPaneTitle } from "./paneTitle.js";
import {
  hasTiledPanels,
  openSessionPanel,
  openTimelinePanel,
  dropSessionPanel,
  serializeForPersist,
  applyMobilePresentation,
  attentionTransitionPanelIds,
  findSessionWorkspace,
  newChildSessionIds,
  childPanelPosition,
  shouldAutoOpenChildPanels,
  openTaskDetailPanel,
} from "./panelUtils.js";
import { describeEvent } from "./eventDescriptions.js";
import {
  pickNewNotifiableEvents,
  notificationChannelEnabled,
  shouldRequestNotificationPermission,
  requestNotificationPermission,
  canShowBrowserNotification,
  isCoalesced,
} from "./desktopNotify.js";
import {
  countAttentionRequired,
  formatDocumentTitle,
  updateFaviconBadge,
} from "./documentBadge.js";

// Wrapped per-panel (not once around the whole dockview area) so a crash in
// one session's terminal can't take out sibling panes too. Owns its own
// `resetKey`, bumped by the boundary's "Reload pane" — a class component's
// error state has no way to retry the exact subtree that threw, so the
// fix is remounting a fresh <TerminalPane> under a new key instead.
function TerminalPanelWrapper(props: IDockviewPanelProps<TerminalPaneParams>) {
  const [resetKey, setResetKey] = useState(0);
  const sessionId = props.params.sessionId;
  const highlightedPanelId = useDashboardStore((s) => s.highlightedPanelId);
  const panelId = `session-${sessionId}`;
  // Real-time tab title tracking (issue #69): TerminalPane stays dockview-
  // agnostic (see its own header comment) and just reports the raw OSC
  // title string up; this wrapper is where props.api.setTitle actually lives.
  // Reads sessions/projects fresh via getState() at call time (rather than
  // useDashboardStore selectors + a dep-array effect) so the always-current
  // nameLocked flag gates every OSC event without re-subscribing TerminalPane
  // on every store change.
  const onTitleChange = useCallback(
    (oscTitle: string) => {
      const { sessions, projects } = useDashboardStore.getState();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session || session.nameLocked) return; // pinned by an explicit rename
      const projectName = projects.find((p) => p.id === session.projectId)?.name;
      props.api.setTitle(formatPaneTitle(oscTitle, projectName));
    },
    [props.api, sessionId],
  );
  return (
    <div
      className={highlightedPanelId === panelId ? "panel-body-highlight" : ""}
      // position: relative anchors .panel-body-highlight::after's absolute
      // overlay (see styles.css) — the highlight itself is drawn as a sibling
      // overlay on top of this div's content, not an inset shadow on this div
      // directly, since TerminalPane's own inner container (issue #132's
      // opaque background) would otherwise paint straight over an inset
      // shadow here.
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
        <TerminalPane key={resetKey} params={props.params} onTitleChange={onTitleChange} />
      </ErrorBoundary>
    </div>
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

// Same reasoning as GitHubPanelWrapper above — a crashing status fetch
// shouldn't blank the whole dashboard either.
function GitPanelWrapper(props: IDockviewPanelProps<GitPanelParams>) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <GitPanel key={resetKey} params={props.params} />
    </ErrorBoundary>
  );
}

// Same reasoning as GitHubPanelWrapper above — a crashing agent-rules fetch
// shouldn't blank the whole dashboard either.
function AgentRulesPanelWrapper(props: IDockviewPanelProps<AgentRulesPanelParams>) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <AgentRulesPanel key={resetKey} params={props.params} />
    </ErrorBoundary>
  );
}

// Same reasoning as GitHubPanelWrapper above — a crashing skills fetch
// shouldn't blank the whole dashboard either.
function SkillsPanelWrapper(props: IDockviewPanelProps<SkillsPanelParams>) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <SkillsPanel key={resetKey} params={props.params} />
    </ErrorBoundary>
  );
}

// Same reasoning as GitHubPanelWrapper above — a crashing iframe/preview
// fetch shouldn't blank the whole dashboard either.
function BrowserPanelWrapper(props: IDockviewPanelProps<BrowserPanelParams>) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <BrowserPanel key={resetKey} params={props.params} api={props.api} />
    </ErrorBoundary>
  );
}

// Same reasoning as GitHubPanelWrapper above — a stream-parsing/canvas
// crash shouldn't blank the whole dashboard either. Reports the Playwright
// page's title up via props.api.setTitle, same shape as
// TerminalPanelWrapper's onTitleChange but simpler (no nameLocked/rename
// concept for this panel type yet).
function BrowserPaneWrapper(props: IDockviewPanelProps<BrowserPaneParams>) {
  const [resetKey, setResetKey] = useState(0);
  const onTitleChange = useCallback(
    (pageTitle: string) => {
      props.api.setTitle(pageTitle ? `Agent Browser: ${pageTitle}` : "Agent Browser");
    },
    [props.api],
  );
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <BrowserPane key={resetKey} params={props.params} onTitleChange={onTitleChange} />
    </ErrorBoundary>
  );
}

// Same reasoning as GitHubPanelWrapper above — SessionTimeline reads
// straight off the store, no fetch of its own, but a bad event payload
// shouldn't blank the whole dashboard either.
function SessionTimelineWrapper(props: IDockviewPanelProps<SessionTimelineParams>) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <SessionTimeline key={resetKey} params={props.params} />
    </ErrorBoundary>
  );
}

// Phase 6 (6.5/#218) — the first global panel: constant id "tasks", no
// per-instance params, so opening it is just an open-or-focus by that
// stable id (see the toolbar/CommandPalette wiring below). Opens task
// detail panels itself via props.containerApi — same "a panel can reach
// the full DockviewApi to open another panel" pattern PaneTab.tsx's own
// openTimelinePanel/openBrowserPanePanel calls already use — rather than
// threading an App()-level callback through dockview's JSON-serializable
// panel params.
function TasksPanelWrapper(props: IDockviewPanelProps<TasksPanelParams>) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <TasksPanel
        key={resetKey}
        onOpenTask={(task) => openTaskDetailPanel(props.containerApi, task)}
      />
    </ErrorBoundary>
  );
}

// Same reasoning as GitHubPanelWrapper above. Resolves onOpenSession via
// props.containerApi too (see TasksPanelWrapper's own comment) rather than
// needing App()'s own onOpenSession closure threaded down.
function TaskDetailWrapper(props: IDockviewPanelProps<TaskDetailParams>) {
  const [resetKey, setResetKey] = useState(0);
  const projects = useDashboardStore((s) => s.projects);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <TaskDetail
        key={resetKey}
        params={props.params}
        onOpenSession={(session) => {
          const isMobile = window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
          openSessionPanel(props.containerApi, session, isMobile, projects);
        }}
      />
    </ErrorBoundary>
  );
}

const components = {
  terminal: TerminalPanelWrapper,
  github: GitHubPanelWrapper,
  git: GitPanelWrapper,
  "agent-rules": AgentRulesPanelWrapper,
  skills: SkillsPanelWrapper,
  browser: BrowserPanelWrapper,
  browserPane: BrowserPaneWrapper,
  timeline: SessionTimelineWrapper,
  tasks: TasksPanelWrapper,
  "task-detail": TaskDetailWrapper,
};

// The custom tab component (PaneTab) carries the redesign's most important
// distinction — close-pane (detach) vs. kill-session (guarded, ends the
// program) — so it only applies to "terminal" panels; "github"/"browser"/
// "browserPane" have no session to kill (browserPane's underlying Chromium
// is owned by BrowserManager, not this panel — closing the pane doesn't
// kill it, same "detach only" model as terminal), so they fall back to
// dockview's own default tab (title + plain close), same as this repo's
// other non-terminal panel types would.
const tabComponents = { terminal: PaneTab };

const AUTOSAVE_DEBOUNCE_MS = 800;
const DEFAULT_WORKSPACE_NAME = "Default";
const MOBILE_BREAKPOINT_QUERY = "(max-width: 699px)";
// Mirrors src/services/hook-adapters/codex.ts's CODEX_COMMAND_RE — used only
// to decide whether to surface the hook-trust banner (issue #259) for a
// currently-active session, never to make any backend decision. The
// backend's own match against the actual spawned command is authoritative.
const CODEX_COMMAND_RE = /^(?:\S*\/)?codex(?:\s|$)/;

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
  // Bumped on every dockview layout change so the toolbar's pane count and
  // the mobile switcher's tab list re-render off dockviewApi.panels, which
  // dockview itself doesn't expose as reactive state.
  const [panelsVersion, setPanelsVersion] = useState(0);
  const [sidebarWidth, setSidebarWidthLocal] = useState(
    () => useDashboardStore.getState().sidebarWidth,
  );

  const {
    workspaces,
    projects,
    sessions,
    sessionsLoaded,
    events,
    activeWorkspaceId,
    refreshWorkspaces,
    createWorkspace,
    saveWorkspaceLayout,
    setActiveWorkspaceId,
    triggerPanelHighlight,
    theme,
    settings,
    startLiveRefresh,
    startEventsStream,
    startTasksStream,
    connectGitHubWS,
    hydrateSettings,
    startThemeWatch,
    sidebarCollapsed,
    setSidebarCollapsed,
    setSidebarWidth,
    splitRequest,
    clearSplitRequest,
    backendReachable,
    currentVersion,
    updateCheck,
    dismissedUpdateVersion,
    checkForUpdates,
    dismissUpdate,
    codexHookTrust,
    dismissedCodexHookTrustVersion,
    checkCodexHookTrust,
    dismissCodexHookTrust,
    refreshSessions,
    openNotificationsPanel,
    viewMode,
    activePanelId,
    setActivePanelId,
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
  // Issue #170's per-session "already considered" bookkeeping for the
  // desktop-notification effect below — the event-stream equivalent of the
  // old seenAttentionRef/seenExitedRef poll-diff Sets (removed), just keyed
  // by the /ws/events channel's own monotonic seq (desktopNotify.ts's
  // pickNewNotifiableEvents) instead of Set membership.
  const notifiedThroughSeqRef = useRef<Map<number, number>>(new Map());
  // The moment the desktop-notification effect below first ran — passed as
  // `notBefore` to pickNewNotifiableEvents so the /ws/events channel's
  // on-connect replay of each session's buffered event *history* (store.ts's
  // `events` slice — "live + replayed events") doesn't get misclassified as
  // a burst of fresh notifications on every page load; only events at/after
  // this instant (genuinely new, not backlog) can fire. See that function's
  // own doc comment for why `alreadyProcessed` alone can't substitute for
  // this. Lazily set inside the effect itself (not `useRef(Date.now())`) —
  // reading the clock belongs in an effect, not render.
  const notifyStreamStartRef = useRef<number | null>(null);
  // Whether Notification permission has already been requested this page
  // session — gates desktopNotify.ts's shouldRequestNotificationPermission
  // to the FIRST attention event only (issue #170), independent of
  // Settings.tsx's own request-on-toggle path.
  const permissionRequestedRef = useRef(false);
  // Rich statuses (issue: extend surfaced session statuses) — per-session
  // notification coalescing (desktopNotify.ts's isCoalesced), so a burst of
  // notifiable events for the same session in quick succession fires at
  // most one sound/desktop-notification every NOTIFICATION_COALESCE_MS,
  // not one per event.
  const lastNotifiedAtRef = useRef<Map<number, number>>(new Map());
  // The #98 auto-focus effect below is deliberately NOT part of this
  // migration — it stays on the poll-diff `sessions.attention` snapshot
  // (own Set, independent of notifiedThroughSeqRef above) rather than the
  // /ws/events stream; see that effect's own comment for why.
  const seenAttentionForFocusRef = useRef<Set<number>>(new Set());
  // Phase 5 (Track B, issue #194 5.4) — same "poll-diff, own Set" shape as
  // seenAttentionForFocusRef above, for the auto-open-child-panel effect
  // below.
  const seenChildSessionIdsRef = useRef<Set<number>>(new Set());
  // Independent review finding (PR #430) — without this, the FIRST tick
  // where `sessions` and the restored-workspace gate are both satisfied
  // would compare against an empty `seenChildSessionIdsRef`, so every
  // pre-existing live child (not just a newly-spawned one) would look "new"
  // and get its panel force-opened. Seeds the baseline on that first
  // qualifying tick without acting; only a transition AFTER that counts.
  const hasSeededChildSessionsRef = useRef(false);

  // Ref to the dockview container element for native DnD event handling
  // (sidebar session drag-to-dock — Task 3).
  const dockviewRef = useRef<HTMLDivElement>(null);
  const lastDropTargetRef = useRef<{
    group: DockviewGroupPanel | undefined;
    location: DockviewGroupDropLocation;
    position: Position;
  } | null>(null);

  const flushPendingSave = useCallback(
    (api: DockviewApi) => {
      const pending = pendingSaveRef.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingSaveRef.current = null;
      // Read *before* the caller clears/replaces the grid — this is still
      // the outgoing workspace's own layout at this point. Issue #85: goes
      // through serializeForPersist (not raw api.toJSON()) so a
      // workspace-switch save strips floating panels AND maximization the
      // same way the debounced scheduleSave below does — this previously
      // wrote the raw blob and leaked both.
      void saveWorkspaceLayout(
        pending.workspaceId,
        serializeForPersist(api) as unknown as Record<string, unknown>,
      );
    },
    [saveWorkspaceLayout],
  );

  const scheduleSave = useCallback(
    (api: DockviewApi, workspaceId: number) => {
      if (pendingSaveRef.current) clearTimeout(pendingSaveRef.current.timer);
      const timer = setTimeout(() => {
        pendingSaveRef.current = null;
        const serialized = serializeForPersist(api);
        void saveWorkspaceLayout(workspaceId, serialized as unknown as Record<string, unknown>);
      }, AUTOSAVE_DEBOUNCE_MS);
      pendingSaveRef.current = { workspaceId, timer };
    },
    [saveWorkspaceLayout],
  );

  const onReady = useCallback((event: DockviewReadyEvent) => {
    setDockviewApi(event.api);
  }, []);

  // Issue #322: track which dockview panel is currently active so the
  // notification effect below can suppress desktop notifications for the
  // pane the user is currently looking at, even when the tab is visible.
  useEffect(() => {
    if (!dockviewApi) return;
    setActivePanelId(dockviewApi.activePanel?.id ?? null);
    const sub = dockviewApi.onDidActivePanelChange((e) => {
      setActivePanelId(e.panel?.id ?? null);
    });
    return () => sub.dispose();
  }, [dockviewApi, setActivePanelId, panelsVersion]);

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
    let closedKilledPanels = false;
    try {
      dockviewApi.clear();
      if (workspace.layout) {
        dockviewApi.fromJSON(workspace.layout as unknown as Parameters<DockviewApi["fromJSON"]>[0]);
      }
      // Remove any panels that reference killed sessions — the restored
      // layout may have been saved before those sessions were killed.  This
      // catches stale layouts; the reactive `useEffect` below (commented
      // "Close any dockview panel whose session has been killed") catches
      // the case where sessions haven't loaded yet at this point.
      const currentSessions = useDashboardStore.getState().sessions;
      const stalePanelIds: string[] = [];
      for (const panel of dockviewApi.panels) {
        let sessionId = (panel.params as { sessionId?: number } | undefined)?.sessionId;
        if (sessionId == null) {
          const match = panel.id.match(/^(?:timeline|browserPane)-(\d+)$/);
          if (match) sessionId = parseInt(match[1], 10);
        }
        if (sessionId != null) {
          const session = currentSessions.find((s) => s.id === sessionId);
          if (panel.id.startsWith("session-")) {
            if (session?.status === "killed") {
              stalePanelIds.push(panel.id);
            }
          } else if (panel.id.startsWith("timeline-") || panel.id.startsWith("browserPane-")) {
            if (!session || session.status === "killed" || session.status === "exited") {
              stalePanelIds.push(panel.id);
            }
          }
        }
      }
      if (stalePanelIds.length > 0) {
        closedKilledPanels = true;
        for (const id of stalePanelIds) {
          dockviewApi.getPanel(id)?.api.close();
        }
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
      // restore itself is never echoed back as a save.  If the post-restore
      // cleanup above closed any killed panels, persist the cleaned layout
      // explicitly (the close events were suppressed by restoringRef being
      // true, so the killed panels would otherwise stay in the blob).
      setTimeout(() => {
        restoringRef.current = false;
        if (closedKilledPanels) {
          scheduleSave(dockviewApi, activeWorkspaceId);
        }
      }, 0);
    }
    // Issue #85 — a layout restored from a blob saved on a different
    // breakpoint (desktop -> mobile, or a stale pre-#85 blob that still
    // carries a persisted maximizedNode) must present per the CURRENT
    // breakpoint, not whatever the blob implies. Deliberately OUTSIDE the
    // try/catch above: if this ever threw, landing in the catch would
    // dockviewApi.clear() and wipe a layout that had just restored
    // successfully. Placed here it's also safe on the error path — clear()
    // leaves an empty grid, and applyMobilePresentation no-ops on that.
    // Safe regardless of whether restoringRef suppresses this call's own
    // onDidLayoutChange echo, since serializeForPersist strips
    // maximizedNode unconditionally on every future save.
    applyMobilePresentation(dockviewApi, isMobile);
    restoredWorkspaceIdRef.current = activeWorkspaceId;
  }, [dockviewApi, activeWorkspaceId, workspaces, flushPendingSave, isMobile]);

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

  // Issue #107: opening a new panel (dockview's addPanel/floating-group path)
  // corrupts the already-rendered WebGL canvas pixels of every OTHER live
  // terminal — confirmed live: scrolling only heals the rows it repaints,
  // while the static input/status band stays garbled until a full resize
  // forces every row to re-raster. Reproduce that here instead of waiting for
  // the user to resize: one frame after a panel is added, force every other
  // mounted terminal through the same full repaint a resize would trigger.
  // One rAF (not immediate) so this runs after the new panel's own layout/
  // paint has settled, matching how the corruption is actually observed.
  //
  // Deliberately NOT gated on `panel` actually being a terminal: whether the
  // corruption is caused by the new panel's own WebGL context or by dockview's
  // new composited floating-group layer was never conclusively pinned down
  // (see issue #107) — a non-terminal panel (GitHub/browser) could still be
  // the compositing-layer case. Repainting on every panel add is the safe,
  // mechanism-agnostic choice; the extra repaint work when it turns out to be
  // unnecessary is cheap (a texture-atlas clear + a row refresh per terminal).
  //
  // This hook alone doesn't cover every terminal mount, though: it only fires
  // for dockview `addPanel` events, so `Dock.tsx`'s inline `<TerminalPane>`
  // (rendered outside dockview entirely, with no real panel) never triggers
  // it — leaving existing terminals' shared WebGL glyph atlas corrupted with
  // nothing to heal them. `TerminalPane`'s own mount effect now schedules an
  // equivalent sibling repaint on every mount, mount-site-agnostic, so this
  // hook only needs to keep covering the non-terminal-panel case above.
  useEffect(() => {
    if (!dockviewApi) return;
    const disposable = dockviewApi.onDidAddPanel((panel) => {
      const newSessionId = (panel.params as TerminalPaneParams | undefined)?.sessionId;
      requestAnimationFrame(() => repaintAllTerminals(newSessionId));
    });
    return () => disposable.dispose();
  }, [dockviewApi]);

  // Mobile breakpoint detection — mirrors the design's own matchMedia usage
  // (699px) rather than duplicating the value as a magic number elsewhere.
  // Issue #85: applyMobilePresentation (not a bare exitMaximizedGroup) so
  // this is symmetric — entering mobile now maximizes too, not just leaving
  // it. onChange() already runs immediately on mount, and this effect
  // re-runs when dockviewApi transitions from null to non-null, so "first
  // mount while already mobile" is covered without a separate call.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const onChange = () => {
      setIsMobile(mq.matches);
      if (dockviewApi) applyMobilePresentation(dockviewApi, mq.matches);
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [dockviewApi]);

  // Sidebar drag-to-dock: subscribe to dockview's external drag-over events
  // so it shows drop indicators when a session row is dragged over the
  // workspace (the drag source sets application/x-mullion-session in dataTransfer).
  useEffect(() => {
    if (!dockviewApi) return;
    const disposable = dockviewApi.onUnhandledDragOver((event) => {
      const dt = event.nativeEvent instanceof DragEvent ? event.nativeEvent.dataTransfer : null;
      if (!dt || !dt.types.includes("application/x-mullion-session")) return;
      event.accept();
      lastDropTargetRef.current = {
        group: event.group,
        location: event.target,
        position: event.position,
      };
    });
    return () => disposable.dispose();
  }, [dockviewApi]);

  // Sidebar drag-to-dock onto an existing group: dockview's own droptarget
  // (the quadrant overlay shown while dragging over a pane) calls
  // stopPropagation() on the native `drop` event once it handles it, so the
  // native listener below never sees drops onto a group — only drops onto
  // empty grid space. dockview re-surfaces those handled drops via
  // onDidDrop, which is the only way to actually dock a session dragged onto
  // a pane (issue #121: "drag-and-drop onto a pane silently does nothing").
  // event.position is dockview's own quadrant classification for the drop:
  // "center" (including any drop on the tab bar) means add as a tab within
  // the group; any edge quadrant means split.
  useEffect(() => {
    if (!dockviewApi) return;
    const disposable = dockviewApi.onDidDrop((event) => {
      const dt = event.nativeEvent instanceof DragEvent ? event.nativeEvent.dataTransfer : null;
      const sessionIdStr = dt?.getData("application/x-mullion-session");
      if (!sessionIdStr) return;
      const sessionId = Number(sessionIdStr);
      if (isNaN(sessionId)) return;

      const panelId = `session-${sessionId}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        return;
      }

      const { sessions, projects } = useDashboardStore.getState();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;

      dropSessionPanel(dockviewApi, session, projects, {
        group: event.group,
        location: event.position === "center" ? "content" : "edge",
        position: event.position,
      });
      lastDropTargetRef.current = null;
      setSidebarOpen(false);
    });
    return () => disposable.dispose();
  }, [dockviewApi, setSidebarOpen]);

  // Handle the native drop event for sidebar session drag-to-dock onto
  // *empty grid space* (dockview has no group there to intercept the drop, so
  // it reaches this listener rather than onDidDrop above). Reads the session
  // ID from dataTransfer and places the panel at the position tracked by
  // onUnhandledDragOver above, or docks into the grid when there's no target.
  useEffect(() => {
    const el = dockviewRef.current;
    if (!el) return;

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("application/x-mullion-session")) {
        e.preventDefault();
      }
    };

    const onDragEndOrLeave = (e: DragEvent) => {
      if (
        e.type === "dragleave" &&
        e.relatedTarget &&
        (e.currentTarget as Node)?.contains(e.relatedTarget as Node)
      ) {
        return;
      }
      lastDropTargetRef.current = null;
    };

    const onDrop = (e: DragEvent) => {
      const sessionIdStr = e.dataTransfer?.getData("application/x-mullion-session");
      if (!sessionIdStr) {
        e.preventDefault();
        lastDropTargetRef.current = null;
        return;
      }
      const sessionId = Number(sessionIdStr);
      if (isNaN(sessionId) || !dockviewApi) {
        e.preventDefault();
        lastDropTargetRef.current = null;
        return;
      }

      const panelId = `session-${sessionId}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        e.preventDefault();
        existing.api.setActive();
        lastDropTargetRef.current = null;
        return;
      }

      const { sessions, projects } = useDashboardStore.getState();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        e.preventDefault();
        lastDropTargetRef.current = null;
        return;
      }

      dropSessionPanel(dockviewApi, session, projects, lastDropTargetRef.current);
      lastDropTargetRef.current = null;
      setSidebarOpen(false);
    };

    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragend", onDragEndOrLeave);
    el.addEventListener("dragleave", onDragEndOrLeave);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragend", onDragEndOrLeave);
      el.removeEventListener("dragleave", onDragEndOrLeave);
    };
  }, [dockviewApi, setSidebarOpen]);

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

  // Check for updates on mount and re-check every 30 minutes.
  // The backend caches results for 1h, so most re-checks are no-ops.
  useEffect(() => {
    checkForUpdates();
    const timer = setInterval(checkForUpdates, 30 * 60 * 1000);
    return () => clearInterval(timer);
  }, [checkForUpdates]);

  // Codex `/hooks` trust check (issue #259) — same on-mount + poll shape as
  // the update check above, but on a much shorter cadence: unlike an update,
  // this state can flip the moment the user runs `/hooks` in an open Codex
  // session, and there's no reason to make them wait 30 minutes (or reopen
  // Settings, which force-refreshes on demand) to see the banner clear. The
  // backend's own agent-detect cache (60s) already bounds how often this
  // actually re-probes the filesystem.
  useEffect(() => {
    checkCodexHookTrust();
    const timer = setInterval(checkCodexHookTrust, 60 * 1000);
    return () => clearInterval(timer);
  }, [checkCodexHookTrust]);

  // Starts the ~4s session-status poll once (paused while the tab is
  // hidden) so status badges reflect the backend without a mutation.
  useEffect(() => startLiveRefresh(), [startLiveRefresh]);

  // Connects the single /ws/events push channel once (issue #166) — not
  // per-pane, unlike TerminalPane.tsx's own per-session WS. Additive
  // alongside the poll above, which stays exactly as-is; nothing in this PR
  // yet renders from the resulting `events` store slice.
  useEffect(() => startEventsStream(), [startEventsStream]);

  // #488 — connects the /ws/tasks push channel once on mount so the Tasks
  // panel picks up a transition within ~1s instead of on the next 60s poll
  // tick. Additive alongside that poll, which stays as the fallback.
  useEffect(() => startTasksStream(), [startTasksStream]);

  // Phase 2 GitHub WS — connects the /ws/github push channel once on mount
  // so real-time PR/CI/issue updates from webhooks reach the store.
  useEffect(() => connectGitHubWS(), [connectGitHubWS]);

  // Fetches the server-persisted Settings blob once on mount (store.ts seeds
  // sane defaults synchronously so nothing blocks on this) and starts
  // watching the OS color-scheme preference for as long as the user's Theme
  // setting is "System".
  useEffect(() => void hydrateSettings(), [hydrateSettings]);
  useEffect(() => startThemeWatch(), [startThemeWatch]);

  // Issue #170: fires a browser Notification (and/or the notification
  // sound) when the live /ws/events channel (issue #166, store.ts's
  // `events` slice) delivers a genuinely notification-worthy event —
  // desktopNotify.ts's pickNewNotifiableEvents, which reuses
  // eventDescriptions.ts's notifyKind (the exact same "attention actually
  // ringing, or a program exited" filter the tab badge (#168) and
  // notification panel feed (#169) already use, so all three surfaces agree
  // on what counts). Replaces the old poll-diff seenAttentionRef/
  // seenExitedRef effects (removed above) that diffed polled SessionInfo
  // snapshots each live-refresh tick — leaving both live would double-fire
  // during the migration. The backend's attention state machine (#171)
  // already debounces per-kind before an `attention` event is ever emitted,
  // so this deliberately does not add a second debounce layer on top: one
  // NotificationEvent is one candidate notification.
  useEffect(() => {
    if (notifyStreamStartRef.current === null) notifyStreamStartRef.current = Date.now();
    const { notifiable, processedThrough } = pickNewNotifiableEvents(
      events,
      notifiedThroughSeqRef.current,
      notifyStreamStartRef.current,
    );
    notifiedThroughSeqRef.current = processedThrough;

    for (const { sessionId, event, kind } of notifiable) {
      // Issue #404 — every OTHER notifyKind-classified event kind has a
      // matching SessionStatus that's simultaneously true when it fires
      // (e.g. a permission_request event and session.sessionStatus ===
      // "awaiting_permission" land together), which is what makes gating
      // this loop by session.sessionStatus below meaningful: the matrix
      // entry checked is actually the entry FOR this event. dev_server_detected
      // deliberately has no SessionStatus of its own (see sessionStatus.ts —
      // this is a background housekeeping signal, not an agent-state
      // transition), so that same lookup would instead check whatever ELSE
      // the session happens to be doing right now (idle/working/etc) —
      // orthogonal to this event, and in practice almost always notify:false
      // by default, silently defeating the feature. Skipped here entirely:
      // it still gets the in-app treatment (bell icon, panel row with
      // accept/dismiss, tab badge via PaneTab.tsx's own notifyKind use) —
      // just never an OS-level Notification/sound/auto-focus, which would be
      // gated by the wrong axis anyway.
      if (event.kind === "dev_server_detected") continue;
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) continue;
      if (!notificationChannelEnabled(session.sessionStatus, settings.notifications)) continue;

      const now = Date.now();
      if (isCoalesced(sessionId, now, lastNotifiedAtRef.current)) continue;
      lastNotifiedAtRef.current.set(sessionId, now);

      const permission = typeof Notification !== "undefined" ? Notification.permission : "denied";
      if (shouldRequestNotificationPermission(kind, permission, permissionRequestedRef.current)) {
        permissionRequestedRef.current = true;
        requestNotificationPermission();
      }

      // Per-status sound: the global channels.sound toggle AND the
      // per-status matrix column must both be on for a sound to fire.
      if (
        settings.notifications.channels.sound &&
        settings.notifications.notificationMatrix[session.sessionStatus]?.sound
      ) {
        playNotificationSound(settings.notifications.soundName);
      }

      // Issue #170's Page Visibility requirement: only actually raise the
      // desktop notification while the tab is hidden/unfocused — a visible
      // tab already surfaces the change some other way (status line, tab
      // badge, the bell itself). Issue #322: also fires for backgrounded
      // dockview panes in a visible tab — only the currently-active pane
      // (the one the user is looking at) is suppressed.
      const sessionIsActive = activePanelId === `session-${sessionId}`;
      if (
        !canShowBrowserNotification({
          browserChannelEnabled: settings.notifications.channels.browser,
          permission,
          documentHidden: document.visibilityState !== "visible",
          sessionIsActive,
        })
      ) {
        continue;
      }

      const described = describeEvent(event);
      const notification = new Notification(session.name || session.command || "Mullion", {
        body: described?.text ?? "Needs your attention",
      });
      notification.onclick = () => {
        window.focus();
        openNotificationsPanel();
        notification.close();
      };
    }
  }, [events, sessions, settings.notifications, openNotificationsPanel, activePanelId]);

  // #98 item 4 — auto-bring-into-focus on the attention transition, opt-in
  // via Settings -> Notifications & status (default off — see api.ts's
  // autoFocusOnAttention doc comment). Deliberately still poll-diff
  // (`sessions.attention`, not the /ws/events stream the desktop-
  // notification effect above migrated to for issue #170): this is a
  // separate feature with its own settled implementation from #98/PR4, and
  // moving it to the event stream too isn't this PR's scope — only the
  // desktop-notification firing was called out for the migration. The
  // transition-detection itself lives in panelUtils.ts's
  // attentionTransitionPanelIds (unit tested there); this effect is just the
  // Settings gate plus the dockviewApi calls.
  useEffect(() => {
    const attentionNow = new Set(sessions.filter((s) => s.attention).map((s) => s.id));
    if (dockviewApi && settings.notifications.autoFocusOnAttention) {
      for (const panelId of attentionTransitionPanelIds(
        sessions,
        seenAttentionForFocusRef.current,
      )) {
        // Per-status autoFocus: the global autoFocusOnAttention toggle AND
        // the per-status matrix column must both be on to auto-focus.
        const session = sessions.find((s) => `session-${s.id}` === panelId);
        if (
          session &&
          !settings.notifications.notificationMatrix[session.sessionStatus]?.autoFocus
        ) {
          continue;
        }
        dockviewApi.getPanel(panelId)?.api.setActive();
      }
    }
    seenAttentionForFocusRef.current = attentionNow;
  }, [sessions, settings.notifications, dockviewApi]);

  // Phase 5 (Track B, issue #194 5.4) — this codebase's first
  // backend-state-driven panel ADD (every other effect here only
  // setActive()s or close()s an already-open panel; see the killed-session
  // cleanup effect below for that pattern). Opt-in via
  // settings.sessions.autoOpenChildPanels (default false) — a spawned child
  // always shows in the sidebar regardless of this flag; this only governs
  // whether ITS PANEL opens with no user gesture behind it. Detection
  // itself lives in panelUtils.ts's newChildSessionIds (unit tested there,
  // same "poll-diff transition, own Set" shape as attentionTransitionPanelIds
  // above) — this effect is just the Settings gate plus the dockviewApi
  // calls, with no local state of its own (no setState anywhere in this
  // effect body — see this repo's react-hooks/set-state-in-effect lint rule).
  //
  // Independent review finding (PR #430) — gated on the workspace-restore
  // effect above having already applied the CURRENT workspace's saved
  // layout (restoredWorkspaceIdRef.current === activeWorkspaceId), not just
  // on dockviewApi existing. Without this, a panel opened here in the
  // narrow window before restore completes gets silently wiped by that
  // effect's dockviewApi.clear()+fromJSON() a moment later — and since this
  // child's id is already recorded as "seen", it would never be retried.
  // Issue #447 fix — `restoredWorkspaceIdRef` is set synchronously at the
  // end of that effect's body, one render before its OWN
  // `restoringRef.current = false` fires (deferred via `setTimeout`) — so
  // `workspaceRestored` can read true for one tick while
  // `restoringRef.current` is still true. On a workspace SWITCH, if a
  // brand-new child happens to arrive in that exact same tick, its
  // `addPanel()` call here would otherwise fire while the "any real layout
  // change" autosave effect below still treats every change as the
  // restore's own echo (`restoringRef.current`), so the panel's addition
  // would never persist and the child's panel would silently not survive a
  // reload. `shouldAutoOpenChildPanels` (panelUtils.ts) folds in
  // `!restoringRef.current` to skip entirely during that window. This
  // self-heals with no extra bookkeeping: `seenChildSessionIdsRef` is only
  // advanced inside this same gated branch (see below), so a child skipped
  // here is still
  // correctly detected as new the next tick once restoring flips false.
  //
  // Independent review finding #2 (PR #430) — also gated on `sessionsLoaded`.
  // `sessions` starts as `[]` before the first GET /api/sessions resolves,
  // and that has nothing to do with workspace restore or dockviewApi
  // readiness — all three gates can line up true on a render where
  // `sessions` just hasn't arrived yet. Seeding against that empty list
  // would make every pre-existing live child look "new" the very next tick
  // (once the real list loads) and force-open all of their panels at once,
  // reproducing the bug this seed exists to prevent.
  useEffect(() => {
    const workspaceRestored =
      activeWorkspaceId !== null && restoredWorkspaceIdRef.current === activeWorkspaceId;
    if (
      shouldAutoOpenChildPanels({
        workspaceRestored,
        hasDockviewApi: dockviewApi !== null,
        autoOpenChildPanels: settings.sessions.autoOpenChildPanels,
        sessionsLoaded,
        restoring: restoringRef.current,
      })
    ) {
      // dockviewApi is guaranteed non-null once shouldAutoOpenChildPanels
      // returns true (hasDockviewApi check above), but its own narrowing
      // doesn't propagate through the helper call — assert it once here so
      // every use below stays non-nullable without a redundant local check.
      const api = dockviewApi!;
      if (!hasSeededChildSessionsRef.current) {
        hasSeededChildSessionsRef.current = true;
      } else {
        for (const childId of newChildSessionIds(sessions, seenChildSessionIdsRef.current)) {
          const child = sessions.find((s) => s.id === childId);
          if (!child || child.parentSessionId === null) continue;
          const panelId = `session-${child.id}`;
          if (api.getPanel(panelId)) continue;
          const position = childPanelPosition(api, child.parentSessionId);
          // Independent review finding #2 (PR #430) — skip entirely rather
          // than falling back to a position-less addPanel() when the
          // parent's own panel isn't part of the CURRENT dockview instance
          // (different/inactive workspace, or the parent was simply never
          // opened). A bare addPanel() with no position lands in whichever
          // group is currently active, silently injecting an unrelated
          // session's terminal into whatever the user happens to be
          // looking at right now — and onDidLayoutChange then persists it
          // into that (wrong) workspace's saved layout. The child still
          // shows in the sidebar regardless (this effect only ever governs
          // whether its panel auto-opens); the user can open it manually.
          if (!position) continue;
          const projectName = projects.find((p) => p.id === child.projectId)?.name ?? undefined;
          api.addPanel({
            id: panelId,
            component: "terminal",
            tabComponent: "terminal",
            title: initialPaneTitle(child, projectName),
            params: { sessionId: child.id },
            position,
          });
        }
      }
      // Hermes review finding (PR #430) — only advance the "seen" set when
      // this tick actually evaluated the current sessions against the gate
      // above. Updating it unconditionally (the previous version of this
      // effect did, on every render regardless of the gate) would mark a
      // child that arrived while the gate was transiently down (workspace
      // mid-restore, dockviewApi not yet ready, or the setting itself off)
      // as already "seen" without ever having been considered — so once the
      // gate later became true, `newChildSessionIds` would no longer see it
      // as new and its panel would never open, permanently, until a manual
      // open. Leaving the ref stale while the gate is down means a child
      // that arrived during that window is still correctly detected as new
      // the next time the gate is true.
      seenChildSessionIdsRef.current = new Set(sessions.map((s) => s.id));
    }
  }, [
    sessions,
    sessionsLoaded,
    settings.sessions.autoOpenChildPanels,
    dockviewApi,
    activeWorkspaceId,
    projects,
  ]);

  // Rich statuses (issue: extend surfaced session statuses) — a backgrounded
  // tab previously gave no signal at all that something happened (static
  // favicon, document.title never assigned — see documentBadge.ts's own
  // header comment). Runs unconditionally (no Settings gate): unlike a sound
  // or a desktop notification, a tab title/favicon change is not disruptive
  // and costs nothing to always keep current.
  useEffect(() => {
    const count = countAttentionRequired(sessions);
    document.title = formatDocumentTitle(count);
    updateFaviconBadge(count);
  }, [sessions]);

  // Issue #87 — apple-mobile-web-app-status-bar-style: iOS reads this once
  // at standalone launch and does NOT re-read it on later DOM mutations, so
  // a React effect here would be a no-op on the one platform it matters for.
  // The real fix is an inline script in index.html's <head>, which runs
  // synchronously during initial parse, before iOS's read.

  // Close any dockview panel whose session has been killed — catches cases
  // where the layout was saved before the kill and then restored (workspace
  // switch, page reload), causing the killed session's panel to reappear.
  // Harmless no-op when the panel was already closed via the normal kill
  // flow (PaneTab's sync close before the API call in armOrKill).  Pairs
  // with the post-restore cleanup in the workspace restore effect (above,
  // in the `try` block that removes stale panels after `fromJSON`) — when
  // sessions haven't loaded yet during restore, this effect takes over once
  // `sessions` populates.
  useEffect(() => {
    if (!dockviewApi) return;
    for (const session of sessions) {
      if (session.status === "killed") {
        dockviewApi.getPanel(`session-${session.id}`)?.api.close();
      }
    }

    const staleTimelineOrBrowserPane: string[] = [];
    for (const panel of dockviewApi.panels) {
      if (panel.id.startsWith("timeline-") || panel.id.startsWith("browserPane-")) {
        let sessionId = (panel.params as { sessionId?: number } | undefined)?.sessionId;
        if (sessionId == null) {
          const match = panel.id.match(/^(?:timeline|browserPane)-(\d+)$/);
          if (match) sessionId = parseInt(match[1], 10);
        }
        if (sessionId != null) {
          const session = sessions.find((s) => s.id === sessionId);
          if (!session || session.status === "killed" || session.status === "exited") {
            staleTimelineOrBrowserPane.push(panel.id);
          }
        }
      }
    }
    for (const id of staleTimelineOrBrowserPane) {
      dockviewApi.getPanel(id)?.api.close();
    }
  }, [sessions, dockviewApi]);

  const onOpenSession = useCallback(
    (session: Session) => {
      if (!dockviewApi) return;
      const panelId = `session-${session.id}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        triggerPanelHighlight(panelId);
      } else {
        const wsId = findSessionWorkspace(session.id, workspaces);
        if (wsId != null && wsId !== activeWorkspaceId) {
          triggerPanelHighlight(panelId);
          setActiveWorkspaceId(wsId);
        } else {
          openSessionPanel(dockviewApi, session, isMobile, projects);
        }
      }
      setSidebarOpen(false);
    },
    [
      dockviewApi,
      isMobile,
      projects,
      workspaces,
      activeWorkspaceId,
      triggerPanelHighlight,
      setActiveWorkspaceId,
    ],
  );

  // Sidebar kebab "Open as new window" — always opens as float in the
  // current workspace regardless of which workspace the session belongs to.
  const onOpenSessionAsFloat = useCallback(
    (session: Session) => {
      if (!dockviewApi) return;
      openSessionPanel(dockviewApi, session, isMobile, projects);
      setSidebarOpen(false);
    },
    [dockviewApi, isMobile, projects],
  );

  // Issue #270 — notification-row click opens the timeline instead of the
  // terminal (see NotificationBell.tsx's own onOpenTimeline doc). Hoisted
  // into a stable useCallback, same shape as onOpenSession/
  // onOpenSessionAsFloat above, specifically so it doesn't skip
  // setSidebarOpen(false) the way an inline JSX-computed closure did in an
  // earlier version of this change — on mobile the notification bell stays
  // reachable above the open sidebar's scrim, so a row tap without this
  // left the timeline opening BEHIND the still-open sidebar overlay.
  const onOpenTimeline = useCallback(
    (session: Session) => {
      if (!dockviewApi) return;
      openTimelinePanel(dockviewApi, session);
      setSidebarOpen(false);
    },
    [dockviewApi],
  );

  // Post-workspace-switch highlight: after a workspace restore creates the
  // target panel, focus it so the highlight flash is visible.
  useEffect(() => {
    if (!dockviewApi) return;
    const id = useDashboardStore.getState().highlightedPanelId;
    if (!id) return;
    const panel = dockviewApi.getPanel(id);
    if (panel) panel.api.setActive();
  }, [activeWorkspaceId, dockviewApi]);

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
          ...(!isMobile &&
            (hasTiledPanels(dockviewApi)
              ? { floating: true }
              : { position: { direction: "right" } })),
        });
        if (isMobile) dockviewApi.maximizeGroup(panel);
      }
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile],
  );

  // Opens (or focuses) the git status panel for a project (issue #76) —
  // same open-or-focus-by-stable-id shape as onOpenGitHub above, just a
  // distinct "git-<projectId>" panel id/component so it never collides with
  // the GitHub integration's own panel for the same project.
  const onOpenGit = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      const project = projects.find((p) => p.id === projectId);
      const panelId = `git-${projectId}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        if (isMobile) dockviewApi.maximizeGroup(existing);
      } else {
        const panel = dockviewApi.addPanel({
          id: panelId,
          component: "git",
          title: project ? `Git: ${project.name}` : "Git",
          params: { projectId },
          ...(!isMobile &&
            (hasTiledPanels(dockviewApi)
              ? { floating: true }
              : { position: { direction: "right" } })),
        });
        if (isMobile) dockviewApi.maximizeGroup(panel);
      }
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile],
  );

  // Opens (or focuses) the agent-rules editor for a project (issue #431) —
  // same open-or-focus-by-stable-id shape as onOpenGit above.
  const onOpenAgentRules = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      const project = projects.find((p) => p.id === projectId);
      const panelId = `agent-rules-${projectId}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        if (isMobile) dockviewApi.maximizeGroup(existing);
      } else {
        const panel = dockviewApi.addPanel({
          id: panelId,
          component: "agent-rules",
          title: project ? `Agent Rules: ${project.name}` : "Agent Rules",
          params: { projectId },
          ...(!isMobile &&
            (hasTiledPanels(dockviewApi)
              ? { floating: true }
              : { position: { direction: "right" } })),
        });
        if (isMobile) dockviewApi.maximizeGroup(panel);
      }
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile],
  );

  // Opens (or focuses) the (read-only) skills panel for a project (issue
  // #432) — same open-or-focus-by-stable-id shape as onOpenAgentRules above.
  const onOpenSkills = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      const project = projects.find((p) => p.id === projectId);
      const panelId = `skills-${projectId}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        if (isMobile) dockviewApi.maximizeGroup(existing);
      } else {
        const panel = dockviewApi.addPanel({
          id: panelId,
          component: "skills",
          title: project ? `Skills: ${project.name}` : "Skills",
          params: { projectId },
          ...(!isMobile &&
            (hasTiledPanels(dockviewApi)
              ? { floating: true }
              : { position: { direction: "right" } })),
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

  // Phase 6 (6.5/#218) — opens (or focuses) the task board. The first
  // global panel: a single constant "tasks" id/title, no per-project
  // params, so unlike every handler above this takes no argument.
  const onOpenTasks = useCallback(() => {
    if (!dockviewApi) return;
    const panelId = "tasks";
    const existing = dockviewApi.getPanel(panelId);
    if (existing) {
      existing.api.setActive();
      if (isMobile) dockviewApi.maximizeGroup(existing);
    } else {
      const panel = dockviewApi.addPanel({
        id: panelId,
        component: "tasks",
        title: "Tasks",
        params: {},
        ...(!isMobile &&
          (hasTiledPanels(dockviewApi)
            ? { floating: true }
            : { position: { direction: "right" } })),
      });
      if (isMobile) dockviewApi.maximizeGroup(panel);
    }
    setSidebarOpen(false);
  }, [dockviewApi, isMobile]);

  // Issue #109: opens a browser pane for a specific favorited URL. Creates
  // an external pane pre-filled with the URL, same shape as onOpenBlankBrowser
  // but with a specific target and label so there's nothing to type.
  const onOpenBrowserUrl = useCallback(
    (projectId: number, url: string, label: string) => {
      if (!dockviewApi) return;
      const panel = dockviewApi.addPanel({
        id: `browser-url-${projectId}-${randomPanelId()}`,
        component: "browser",
        title: label,
        params: { kind: "external", url, projectId },
      });
      if (isMobile) dockviewApi.maximizeGroup(panel);
      setSidebarOpen(false);
    },
    [dockviewApi, isMobile],
  );

  // Issue #28's general-purpose browser tile: the CommandPalette's "New
  // browser tab" entry — an empty external browser pane (nothing typed
  // into its address bar yet; BrowserPanel's own "empty" state, address
  // bar auto-focused), reachable straight from +/⌘K. No preview to
  // pre-create (there's no URL yet, and the subdomain proxy — when
  // configured — only ever gets involved once BrowserPanel's own mount
  // effect creates one for whatever URL the user navigates to), so this
  // never touches the network itself. Always opens a fresh pane rather than
  // open-or-focus: unlike a project (at most one preview pane makes sense),
  // opening a second blank tab is a reasonable, ordinary thing to want; id
  // has no natural stable identity to derive from, so it's random —
  // randomPanelId() rather than a bare crypto.randomUUID() since this pane
  // exists specifically to support the plain-http LAN/Tailscale deployment
  // docs/browser-previews.md documents, which is not a secure context (see
  // that helper's own comment).
  const onOpenBlankBrowser = useCallback(() => {
    if (!dockviewApi) return;
    const panel = dockviewApi.addPanel({
      id: `browser-ext-${randomPanelId()}`,
      component: "browser",
      title: "Preview",
      params: { kind: "external" },
    });
    if (isMobile) dockviewApi.maximizeGroup(panel);
    setSidebarOpen(false);
  }, [dockviewApi, isMobile]);

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
        const projectName = projects.find((p) => p.id === session.projectId)?.name;
        dockviewApi.addPanel({
          id: panelId,
          component: "terminal",
          tabComponent: "terminal",
          title: initialPaneTitle(session, projectName),
          params: { sessionId: session.id },
          ...(referencePanel ? { position: { referencePanel, direction: req.direction } } : {}),
        });
      }
      setSidebarOpen(false);
    },
    [dockviewApi, splitRequest, clearSplitRequest, onOpenSession, projects],
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

  // ---- Sidebar width drag (same pattern as Dock's height drag) ----
  const sidebarWidthRef = useRef(sidebarWidth);
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);

  const onSidebarResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDragRef.current = { startX: e.clientX, startW: sidebarWidthRef.current };
    setSidebarResizing(true);
  }, []);

  useEffect(() => {
    if (!sidebarResizing) return;
    const onMove = (e: MouseEvent) => {
      const d = sidebarDragRef.current;
      if (!d) return;
      const w = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, d.startW + (e.clientX - d.startX)),
      );
      sidebarWidthRef.current = w;
      setSidebarWidthLocal(w);
    };
    const onUp = () => {
      const w = sidebarWidthRef.current;
      setSidebarWidth(w);
      setSidebarResizing(false);
      sidebarDragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [sidebarResizing, setSidebarWidth, setSidebarWidthLocal]);

  // Keep the ref in sync with the local state (initial load, reload, etc.)
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-derives off panelsVersion, not a real dependency
  // Whether any active session is Codex — gates the hook-trust banner below
  // (issue #259) so it only appears when it's actually relevant, not on
  // every load of a machine that merely has Codex installed.
  const codexSessionActive = useMemo(
    () => sessions.some((s) => s.status === "active" && CODEX_COMMAND_RE.test(s.command.trim())),
    [sessions],
  );
  const paneCount = useMemo(() => dockviewApi?.panels.length ?? 0, [dockviewApi, panelsVersion]);
  // Tiled-only count, for the empty-grid dropzone: paneCount above includes
  // floating (peek) panels, so a lone floating panel would otherwise hide the
  // "nothing tiled here" hint even though the grid itself is empty (#121).
  const tiledPaneCount = useMemo(
    () => dockviewApi?.panels.filter((p) => p.api.location.type === "grid").length ?? 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-derives off panelsVersion, not a real dependency
    [dockviewApi, panelsVersion],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mobilePanels = useMemo(() => dockviewApi?.panels ?? [], [dockviewApi, panelsVersion]);
  // Projects with a session tiled in the active workspace, derived from the
  // live dockview panels the same way mobilePanels above walks them for the
  // mobile tab bar (panel.params.sessionId -> session.projectId) — reactive
  // via mobilePanels (which itself carries panelsVersion, bumped on every
  // dockview layout change, including a workspace-switch fromJSON() restore;
  // see the onDidLayoutChange effect above). Deduped, first-seen order kept
  // so the Dock's columns don't reshuffle on every render. There's no
  // workspace<->project link in the DB (workspaces.layout is an opaque
  // dockview blob) — this is what makes a "per-workspace dock" possible
  // without a schema change.
  const workspaceProjectIds = useMemo(() => {
    const ids: number[] = [];
    for (const panel of mobilePanels) {
      const sessionId = (panel.params as TerminalPaneParams | undefined)?.sessionId;
      if (sessionId == null) continue;
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) continue;
      if (!ids.includes(session.projectId)) ids.push(session.projectId);
    }
    return ids;
  }, [mobilePanels, sessions]);

  // Dockview ships its own hardcoded light/dark chrome colors, unaware of
  // the selected terminal color scheme — so a scheme's background (e.g.
  // Dracula's off-white) visibly seams against dockview's fixed white/black
  // panel and tab-bar surfaces (issue #132). Exposing the scheme's
  // background as a custom property here lets the CSS in styles.css
  // override just those `--dv-*` surfaces to match, without touching
  // dockview's tab text colors.
  const dockviewChromeBg = getSchemeBackground(settings.terminal.colorScheme, theme);

  return (
    <div
      className={`app cmux-root${theme === "light" ? " light" : ""}${sidebarOpen ? " sb-open" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}${sidebarResizing ? " sidebar-resizing" : ""}${settings.sidebarDensity === "compact" ? " density-compact" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <Toolbar
        onToggleSidebar={toggleSidebar}
        onOpenSession={onOpenSession}
        onOpenTimeline={onOpenTimeline}
        onOpenBrowser={onOpenBrowser}
        onOpenLauncher={openGlobalLauncher}
        onOpenSettings={openSettings}
        activeWorkspaceName={activeWorkspace?.name ?? null}
        paneCount={paneCount}
        currentVersion={currentVersion}
      />
      <div className="app-body">
        <div className="cmux-scrim" onClick={() => setSidebarOpen(false)} />
        <div className="sidebar-wrapper cmux-scroll">
          {!sidebarCollapsed && (
            <div className="sidebar-resize-handle" onMouseDown={onSidebarResizeMouseDown} />
          )}
          <WorkspaceSwitcher />
          <Sidebar
            onOpenSession={onOpenSession}
            onOpenSessionAsFloat={onOpenSessionAsFloat}
            onSessionEnded={onSessionEnded}
            onOpenProjectLauncher={openProjectLauncher}
            onOpenSettingsProjects={() => openSettings("projects")}
            onOpenTasks={onOpenTasks}
            onOpenGit={onOpenGit}
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
              <span className="backend-down-title">Mullion server unreachable</span>
              <span className="backend-down-subtext">
                unix socket · retry in {LIVE_REFRESH_INTERVAL_MS / 1000}s…
              </span>
              <button className="backend-down-reconnect" onClick={() => void refreshSessions()}>
                Reconnect
              </button>
            </div>
          )}
          {updateCheck?.updateAvailable && updateCheck.latestVersion !== dismissedUpdateVersion && (
            <div
              className="update-banner"
              onClick={() => openSettings("server")}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") openSettings("server");
              }}
            >
              <RefreshIcon size={16} style={{ color: "var(--o)", flexShrink: 0 }} />
              <span className="update-banner-title">
                v{currentVersion} → v{updateCheck.latestVersion} available
              </span>
              <span className="update-banner-subtext">Click for details</span>
              <span
                className="update-banner-dismiss"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  dismissUpdate();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    dismissUpdate();
                  }
                }}
                title="Dismiss until next version"
              >
                ×
              </span>
            </div>
          )}
          {/* Codex `/hooks` trust pending (issue #259) — same dismissible,
              click-through-to-Settings shape as the update banner above.
              Mullion cannot grant this trust on the user's behalf (that's
              the whole point of Codex's gate), so this only informs and
              links to the one-time manual step. */}
          {codexSessionActive &&
            codexHookTrust === "pending" &&
            dismissedCodexHookTrustVersion !== currentVersion && (
              <div
                className="update-banner"
                onClick={() => openSettings("launchers")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") openSettings("launchers");
                }}
              >
                <RefreshIcon size={16} style={{ color: "var(--o)", flexShrink: 0 }} />
                <span className="update-banner-title">Codex hooks not yet trusted</span>
                <span className="update-banner-subtext">
                  Run /hooks in a Codex session to enable structured events · Click for details
                </span>
                <span
                  className="update-banner-dismiss"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissCodexHookTrust();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      dismissCodexHookTrust();
                    }
                  }}
                  title="Dismiss until next version"
                >
                  ×
                </span>
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
            <div
              className="dockview-container"
              style={{ "--mullion-chrome-bg": dockviewChromeBg } as CSSProperties}
            >
              <DockviewReact
                ref={dockviewRef}
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
                  switcher instead of the tiled grid entirely. Gated on
                  tiledPaneCount (not paneCount) so a floating peek panel
                  doesn't hide this hint while the grid itself is empty (#121). */}
              {!isMobile && tiledPaneCount === 0 && (
                <div className="empty-grid-dropzone" style={{ position: "absolute", inset: 0 }}>
                  <GridIcon size={26} style={{ color: "var(--dim)" }} />
                  <span className="empty-grid-title">Nothing tiled here yet</span>
                  <span className="empty-grid-hint">
                    ⌘K to launch · pick a session from the sidebar
                  </span>
                </div>
              )}
              {/* Issue #211's Kanban board — same "overlay, not a
                  conditionally-mounted replacement" reasoning as the empty
                  grid dropzone above: dockview's own API instance (and every
                  open panel) stays alive underneath while toggled to Kanban,
                  so switching back to list view via ViewModeToggle.tsx
                  restores exactly what was there before. Desktop-only, same
                  gating as the dropzone — mobile has no room for a 3-column
                  board and shows its own switcher instead. */}
              {!isMobile && viewMode === "kanban" && (
                <div className="kanban-board-overlay" style={{ position: "absolute", inset: 0 }}>
                  <KanbanBoard onOpenSession={onOpenSession} onSessionEnded={onSessionEnded} />
                </div>
              )}
            </div>
            <Dock
              workspaceProjectIds={workspaceProjectIds}
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
          onOpenTasks={onOpenTasks}
          onOpenGitHub={onOpenGitHub}
          onOpenGit={onOpenGit}
          onOpenAgentRules={onOpenAgentRules}
          onOpenSkills={onOpenSkills}
          onOpenBrowser={onOpenBrowser}
          onOpenIntegrationsSettings={() => openSettings("integrations")}
          onOpenBlankBrowser={onOpenBlankBrowser}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
      )}
      {settingsOpen && (
        <Settings onClose={() => setSettingsOpen(false)} initialSection={settingsSection} />
      )}
    </div>
  );
}
