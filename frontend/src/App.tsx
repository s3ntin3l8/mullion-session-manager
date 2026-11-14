import { ProjectPreviewPicker } from "./ProjectPreviewMenu.js";
import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewApi, DockviewReadyEvent } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { SidebarShell } from "./sidebar/SidebarShell.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { PhoneNavigatorPanel } from "./PhoneNavigator.js";
import { sidebarPhoneSection } from "./lib/phoneNavSection.js";
import type { PhoneNavTab } from "./PhoneNavigator.js";
import { usePhoneBackStack } from "./hooks/usePhoneBackStack.js";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { useHalfActions } from "./fold/useHalfActions.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Toolbar } from "./Toolbar.js";
import { LeftRail } from "./LeftRail.js";
import { RailWorkspaceSection } from "./rail/RailWorkspaceSection.js";
import { RailPanes } from "./rail/RailPaneList.js";
import { HalfHeader } from "./fold/HalfHeader.js";
import { RightHalfPane } from "./fold/RightHalfPane.js";
import { preferredPaneFor, useFoldHalves } from "./hooks/useFoldHalves.js";
import { canGoRight, EMPTY_FOLD_HALVES, halfOf, splitByHalf } from "./lib/foldHalves.js";
import type { Half } from "./lib/foldHalves.js";
import { sessionPaneTitle } from "./lib/sessionDisplay.js";
import type { LayoutPresentation } from "./lib/layoutTier.js";
import type { RailPaneInput } from "./lib/railPanes.js";
import { MobileKeyBar } from "./MobileKeyBar.js";
import { PhoneModeBar } from "./PhoneModeBar.js";
import { PaneHeaderActions } from "./PaneHeaderActions.js";
import { CommandPalette } from "./CommandPalette.js";
import { SessionLauncherHost } from "./launchers/SessionLauncher.js";
import type { SettingsSection } from "./Settings.js";
import { SettingsLoadingFallback } from "./SettingsLoadingFallback.js";
import { Dock } from "./Dock.js";
import { GridIcon, RefreshIcon, ServerRackIcon, WarningTriangleIcon } from "./ui/icons.js";
import { ToastHost } from "./ui/ToastHost.js";
import {
  useDashboardStore,
  LIVE_REFRESH_INTERVAL_MS,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from "./store/index.js";
import { themeClassName } from "./store/theme.js";
import { useShallow } from "zustand/react/shallow";
import type { Session } from "./api/index.js";
import { getSchemeBackground } from "./terminalTheme.js";
import { initialPaneTitle } from "./paneTitle.js";
import { components, tabComponents, KanbanBoardOverlay } from "./panels/registry.js";
import {
  isTiledPanel,
  canLaunchTerminal,
  shouldShowCodexHookTrustBanner,
  workspaceProjectIdsFromPanels,
  openTerminalSessionIds,
  openSessionPanel,
  focusPanelForTier,
  panelSessionId,
} from "./panelUtils.js";
import { useVisualViewportInset } from "./hooks/useVisualViewportInset.js";
import { useDragResize } from "./hooks/useDragResize.js";
import { useReportTerminalPalette } from "./hooks/useReportTerminalPalette.js";
import { RightSidebar } from "./right-sidebar/RightSidebar.js";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence.js";
import {
  isCompactTier,
  resolveLayoutTier,
  useCoarsePointer,
  useLayoutBand,
} from "./lib/layoutTier.js";
import type { LayoutTier, LayoutContext } from "./lib/layoutTier.js";
import { MobileSessionBar } from "./MobileSessionBar.js";
import { useSessionDeepLink } from "./hooks/useSessionDeepLink.js";
import { useOpenSessionRequest } from "./hooks/useOpenSessionRequest.js";
import { useTaskNotificationOpen } from "./hooks/useTaskNotificationOpen.js";
import { useOpenTaskRequest } from "./hooks/useOpenTaskRequest.js";
import { useOpenPreviewRequest } from "./hooks/useOpenPreviewRequest.js";
import { useLayoutPresentation } from "./hooks/useLayoutPresentation.js";
import { useBalanceOnDrop } from "./hooks/useBalanceOnDrop.js";
import { useDockviewDrop } from "./hooks/useDockviewDrop.js";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts.js";
import { useAppStreams } from "./hooks/useAppStreams.js";
import { useAttentionNotifications } from "./hooks/useAttentionNotifications.js";
import { usePanelOpener } from "./hooks/usePanelOpener.js";
import { usePolling } from "./hooks/usePolling.js";
import { useDockviewFloatingClamp } from "./hooks/useDockviewFloatingClamp.js";
import { useActivePanelTracking } from "./hooks/useActivePanelTracking.js";
import { useWorkspaceLoadRetry } from "./hooks/useWorkspaceLoadRetry.js";
import { useDefaultWorkspaceBootstrap } from "./hooks/useDefaultWorkspaceBootstrap.js";
import { useActiveWorkspaceFallback } from "./hooks/useActiveWorkspaceFallback.js";
import { useTerminalRepaintOnPanelAdd } from "./hooks/useTerminalRepaintOnPanelAdd.js";
import { useHydrateSettings } from "./hooks/useHydrateSettings.js";
import { useThemeWatch } from "./hooks/useThemeWatch.js";
import { useAutoFocusOnAttention } from "./hooks/useAutoFocusOnAttention.js";
import { useAutoOpenChildPanels } from "./hooks/useAutoOpenChildPanels.js";
import { useCloseKilledSessionPanels } from "./hooks/useCloseKilledSessionPanels.js";
import { useCloseMissingDevicePanels } from "./hooks/useCloseMissingDevicePanels.js";
import { useCloseStaleProjectPanels } from "./hooks/useCloseStaleProjectPanels.js";
import { useSyncSessionOpenerRefs } from "./hooks/useSyncSessionOpenerRefs.js";
import { usePushSessionOpen } from "./hooks/usePushSessionOpen.js";
import { usePushResync } from "./hooks/usePushResync.js";
import { usePostWorkspaceSwitchHighlight } from "./hooks/usePostWorkspaceSwitchHighlight.js";
import { useSidebarOpenTierReset } from "./hooks/useSidebarOpenTierReset.js";
import { useSidebarSwipe } from "./hooks/useSidebarSwipe.js";
import { useRetriableLazy } from "./lib/retriableLazy.js";
import { ResourceAlertBanner } from "./ResourceAlertBanner.js";

// B2 — code-split Settings' ~2,700-line modal out of the initial bundle via
// React.lazy (the two browser/preview panes and the Kanban board get the
// same treatment, but live in panels/registry.tsx alongside the rest of the
// dockview panel registrations — see that module's own header comment).
// dockview and xterm+webgl stay eager — a terminal pane is what the app
// shows first, so splitting those would only move the cost, not remove it.
// Resolves `{ default }` because Settings.tsx uses a named export, not a
// default export.
//
// This is a loader FUNCTION, not a `lazy()` call — the actual `lazy()`
// payload is built inside App() by useRetriableLazy, keyed on
// settingsRetryKey. A module-level `lazy()` singleton here would latch a
// rejected dynamic import forever (see useRetriableLazy's own comment for
// the full trace), leaving Settings' own "Reload pane" unable to ever
// retry a chunk-load failure on a later reopen.
const loadSettings = () => import("./Settings.js").then((m) => ({ default: m.Settings }));

// Mirrors src/services/hook-adapters/codex.ts's CODEX_COMMAND_RE — used only
// to decide whether to surface the hook-trust banner (issue #259) for a
// currently-active session, never to make any backend decision. The
// backend's own match against the actual spawned command is authoritative.
const CODEX_COMMAND_RE = /^(?:\S*\/)?codex(?:\s|$)/;

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
  // Issue #1638 — giving up on the initial load used to be console-only.
  // Stays false until a later round succeeds. Distinct from workspacesLoaded:
  // that flag must not flip true on an unknown list, or the bootstrap below
  // would create a second "Default".
  const [workspaceLoadFailed, setWorkspaceLoadFailed] = useState(false);
  // Bumped by the banner's Retry. The load effect restarts a fresh bounded
  // round; the online/visibility re-arm stays inside the effect.
  const [workspaceLoadNonce, setWorkspaceLoadNonce] = useState(0);
  // Tablet tier plan, PR 4 — replaces the old phone-only `isMobile` boolean.
  // `isMobile` below is now a derived `layoutTier === "phone"` local const
  // (not its own state) so every "stays phone-only" call site the plan
  // enumerates (phone session switcher, empty-grid dropzone suppression,
  // toggleSidebar's dual semantics) keeps working unchanged, while
  // tier-aware call sites (session-opening's positioning, applyLayoutPresentation)
  // read `layoutTier` directly.
  // Seeded synchronously from the live width (not a "desktop" placeholder) so
  // a cold load on a phone/tablet doesn't paint desktop chrome for one frame
  // and run the restore effect with the wrong tier. The store is read directly
  // because `settings` isn't destructured until further down; before the
  // server responds `layoutMode` is "auto". A server-side override still
  // corrects itself via useLayoutPresentation's effect.
  const [layoutTier, setLayoutTier] = useState<LayoutTier>(() =>
    resolveLayoutTier(useDashboardStore.getState().settings.layoutMode),
  );
  // The finer five-way band, exposed as `data-band` for later slices; nothing
  // reads it yet. Independent of `isCoarsePointer` below.
  const layoutBand = useLayoutBand(useDashboardStore((s) => s.settings.layoutMode));
  const isMobile = layoutTier === "phone";
  const compact = isCompactTier(layoutTier);
  // Touch affordances (key bar, tab-strip panning) are gated on pointer
  // coarseness, not layout tier — see lib/layoutTier.ts's own doc comment on
  // COARSE_POINTER_QUERY for why a tier check alone is wrong here.
  const isCoarsePointer = useCoarsePointer();
  // Mobile UI/UX overhaul, item B.2 — writes the keyboard's on-screen height
  // (0 when closed) directly onto `document.documentElement`'s own
  // `--kb-inset` custom property, plus the visual viewport's pan as
  // `--kb-offset-top` (issue #1387; no React state — see the hook's own
  // comment on why), which the `.app { top/bottom }` rule
  // (tablet.css, gated on `(pointer: coarse)` — any touch device, not just
  // the phone breakpoint) inherits to shrink the fixed-position shell above
  // the keyboard instead of letting it overlay the terminal's active line.
  // Called unconditionally: a no-op wherever the consuming rule doesn't
  // apply (mouse-driven desktop), not scoped to a single breakpoint itself.
  useVisualViewportInset();
  const [palette, setPalette] = useState<PaletteState>({
    open: false,
    scope: "global",
    projectId: null,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  // Set when a section was picked from the phone navigator's own Settings
  // list, so Settings opens straight into it (see Settings.tsx).
  const [settingsStartInContent, setSettingsStartInContent] = useState(false);
  // Which tab of the phone navigator is showing; remembered across closes.
  const [navTab, setNavTab] = useState<PhoneNavTab>("projects");
  // Bumped on the Settings ErrorBoundary's own reset — see loadSettings'
  // header comment for why a fresh lazy() payload (not just remounting)
  // is what actually lets a later reopen retry a chunk-load failure.
  const [settingsRetryKey, setSettingsRetryKey] = useState(0);
  const LazySettings = useRetriableLazy(loadSettings, settingsRetryKey);
  // Bumped on every dockview layout change so the toolbar's pane count and
  // the mobile switcher's tab list re-render off dockviewApi.panels, which
  // dockview itself doesn't expose as reactive state.
  const [panelsVersion, setPanelsVersion] = useState(0);
  const [sidebarWidth, setSidebarWidthLocal] = useState(
    () => useDashboardStore.getState().sidebarWidth,
  );

  // P1 perf fix — this used to be a single bare `useDashboardStore()` call
  // (no selector), subscribing to the ENTIRE store: an unrelated write to
  // ANY field (settings, tasks, gitStatuses, the 4s sessions poll tick, …)
  // re-rendered this whole 2000+-line component and, via plain React
  // parent->child re-invocation (Sidebar/Toolbar/WorkspaceSwitcher/Dock
  // aren't memoized — see this PR's own notes on why that's a separate,
  // larger refactor), every child under it too.
  //
  // App genuinely reads a lot of these for rendering (sessions for session-
  // derived UI, events for the desktop-notification effect, settings for
  // pane defaults, etc.) — those stay real selectors, grouped here via
  // useShallow so this is one subscription instead of nineteen, shallow-
  // compared field-by-field against the previous render's snapshot. This
  // does NOT stop App from re-rendering on the 4s sessions tick specifically
  // (sessions gets a fresh array identity every poll regardless of content —
  // see store.ts's refreshSessions — and App legitimately needs that value),
  // but it DOES stop App from re-rendering on every OTHER unrelated store
  // write, which is the actual anti-pattern this fixes. Every action below
  // (refreshWorkspaces, createWorkspace, …) is deliberately NOT selected
  // here — see the useDashboardStore.getState().xxx() calls at each call
  // site instead, App's own pre-existing pattern for pure action-callers
  // (getState() reads the current value without subscribing at all; a
  // store action's identity never changes anyway, so this is purely about
  // not paying for a subscription these call sites don't need).
  const {
    workspaces,
    projects,
    sessions,
    sessionsLoaded,
    events,
    activeWorkspaceId,
    theme,
    settings,
    settingsLoaded,
    sidebarCollapsed,
    splitRequest,
    backendReachable,
    sessionExpired,
    currentVersion,
    updateCheck,
    dismissedUpdateVersion,
    codexHookTrust,
    dismissedCodexHookTrustVersion,
    viewMode,
    activePanelId,
    devices,
    devicesLoaded,
    projectsLoaded,
    projectsError,
  } = useDashboardStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      projects: s.projects,
      sessions: s.sessions,
      sessionsLoaded: s.sessionsLoaded,
      events: s.events,
      activeWorkspaceId: s.activeWorkspaceId,
      theme: s.theme,
      settings: s.settings,
      settingsLoaded: s.settingsLoaded,
      sidebarCollapsed: s.sidebarCollapsed,
      splitRequest: s.splitRequest,
      backendReachable: s.backendReachable,
      sessionExpired: s.sessionExpired,
      currentVersion: s.currentVersion,
      updateCheck: s.updateCheck,
      dismissedUpdateVersion: s.dismissedUpdateVersion,
      codexHookTrust: s.codexHookTrust,
      dismissedCodexHookTrustVersion: s.dismissedCodexHookTrustVersion,
      viewMode: s.viewMode,
      activePanelId: s.activePanelId,
      // devices/devicesLoaded — the device-panel prune sweep below. `devices`
      // gets a fresh array identity every DEVICES_POLL_MS just like sessions
      // does, so this costs the same already-acknowledged periodic
      // re-render sessions costs (the two polls start together, so in
      // practice they land on the same tick rather than doubling up).
      devices: s.devices,
      devicesLoaded: s.devicesLoaded,
      projectsLoaded: s.projectsLoaded,
      projectsError: s.projectsError,
    })),
  );

  // Pending state for the "Mullion server unreachable" banner's Reconnect
  // button (design States doc section 04) — the click handler used to just
  // `void` the refreshSessions() promise with no feedback at all, so a
  // click during a genuine outage looked identical to a dead button. Also
  // means the click's rejection is now actually caught here instead of
  // becoming an unhandled promise rejection.
  const [reconnecting, setReconnecting] = useState(false);

  // Guards against auto-creating "Default" twice — both from React
  // StrictMode's dev-mode double-invoke of effects (refs survive that,
  // state-setters don't re-run the check reliably) and from the fetch race
  // below (workspacesLoaded flips exactly once).
  const bootstrappedRef = useRef(false);
  // restoringRef/restoredWorkspaceIdRef used to be declared here, but now
  // come from useWorkspacePersistence's return value (see the hook call
  // further down, at the exact position the restore/autosave effects used
  // to occupy) — several effects further down in this file (auto-open-
  // child-panel, deep-link, push-message) still read them.
  // notifiedThroughSeqRef/notifyStreamStartRef/permissionRequestedRef/
  // lastNotifiedAtRef used to be declared here — Issue #170's per-session
  // "already considered" bookkeeping for the desktop-notification effect,
  // keyed by the /ws/events channel's own monotonic seq
  // (desktopNotify.ts's pickNewNotifiableEvents) — but now live inside
  // useAttentionNotifications (hooks/useAttentionNotifications.ts), which
  // owns that effect; see that hook's own header comment.
  // The #98 auto-focus effect below is deliberately NOT part of that
  // migration — it stays on the poll-diff `sessions.attention` snapshot
  // (own Set, independent of the moved refs above) rather than the
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

  // deepLinkHandledRef/deepLinkRetryTick used to be declared here — Issue
  // #95 prerequisite bookkeeping for the `?session=<id>` deep-link effect —
  // but now live inside useSessionDeepLink (hooks/useSessionDeepLink.ts),
  // which owns that effect; see the hook call further down (right after
  // useWorkspacePersistence) and that hook's own header comment for the
  // ordering/coupling contract with restoringRef/restoredWorkspaceIdRef.
  // Keyed by panel id (not a boolean) so the post-workspace-switch highlight
  // effect below only acts once per highlight, not on every dependency
  // change (e.g. a live-refresh poll tick) that happens to land inside the
  // highlight's own ~1200ms window — see that effect's own comment.
  const lastHandledHighlightRef = useRef<string | null>(null);

  const dockviewContainerRef = useRef<HTMLDivElement>(null);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    setDockviewApi(event.api);
  }, []);

  // Clamps a floating group's height into the grid. Extracted to
  // useDockviewFloatingClamp; called here, where the effect was.
  useDockviewFloatingClamp({ dockviewApi, dockviewContainerRef });

  // Tracks the active dockview panel for notification suppression.
  // Extracted to useActivePanelTracking; called here, where the effect was.
  useActivePanelTracking({ dockviewApi, panelsVersion });

  // Bounded retry for the initial workspace list (issue #1618). Extracted
  // to useWorkspaceLoadRetry; called here, where the effect was.
  useWorkspaceLoadRetry({ workspaceLoadNonce, setWorkspacesLoaded, setWorkspaceLoadFailed });

  // First-ever empty list auto-creates "Default". Extracted to
  // useDefaultWorkspaceBootstrap; called here, where the effect was.
  useDefaultWorkspaceBootstrap({ workspacesLoaded, workspaces, bootstrappedRef });

  // Stale activeWorkspaceId falls back to the first workspace. Extracted to
  // useActiveWorkspaceFallback; called here, where the effect was.
  useActiveWorkspaceFallback({ workspaces, activeWorkspaceId });

  // Restores the active workspace's saved dockview layout on mount/
  // workspace-switch, and autosaves layout changes back as they happen —
  // extracted to useWorkspacePersistence (hooks/useWorkspacePersistence.ts).
  // Called here, at the EXACT position its two effects previously occupied
  // in this component's body, so their execution order relative to every
  // other effect in this file (in particular the auto-open-child-panel,
  // deep-link, and push-message effects further down, which read
  // restoringRef/restoredWorkspaceIdRef and depend on a restore having
  // already run) is unchanged — see that hook's own header comment.
  const { restoringRef, restoredWorkspaceIdRef, liftPhoneTaint } = useWorkspacePersistence({
    dockviewApi,
    activeWorkspaceId,
    workspaces,
    layoutTier,
    setPanelsVersion,
  });

  // Repaints every other terminal after a panel is added (issue #107).
  // Extracted to useTerminalRepaintOnPanelAdd; called here, where the effect was.
  useTerminalRepaintOnPanelAdd({ dockviewApi });

  // Keeps dockview's presentation in sync with the resolved layout tier —
  // extracted to useLayoutPresentation (hooks/useLayoutPresentation.ts).
  // Called here, at the EXACT position its two effects previously occupied
  // in this component's body, so their execution order relative to every
  // other effect in this file — in particular, running AFTER the
  // useWorkspacePersistence restore effect above on the commit where
  // dockviewApi first becomes non-null — is unchanged. `layoutTier` itself
  // stays owned by this component's own useState (rather than being
  // returned from the hook) specifically because it's read EARLIER in this
  // render body, at the useWorkspacePersistence call above — see that hook's
  // own `setLayoutTier` param comment for why returning it here instead
  // would be a real ordering regression, not just a style difference.
  useLayoutPresentation({
    dockviewApi,
    layoutMode: settings.layoutMode,
    setLayoutTier,
    onUnfold: liftPhoneTaint,
    preferPanel: preferredPaneFor,
  });

  // #3010 — the two halves between 800 and 1099px: one pane per half, a
  // device-local view of the workspace (see useFoldHalves). Workspace mode
  // only for the UI; the presentation itself also holds under the board.
  const layoutPresentation: LayoutPresentation = isMobile
    ? "phone"
    : layoutBand === "rails-halves"
      ? "halves"
      : "grid";
  const foldHalves = layoutPresentation === "halves" && viewMode !== "kanban";
  const halvesState = useDashboardStore((s) =>
    s.activeWorkspaceId === null
      ? EMPTY_FOLD_HALVES
      : (s.foldHalves[s.activeWorkspaceId] ?? EMPTY_FOLD_HALVES),
  );
  const focusedHalf = useDashboardStore((s) => s.focusedHalf);
  const rightSidebarOpen = useDashboardStore((s) => s.rightSidebarOpen);

  // Sidebar session drag-to-dock — dragging a session row out of the Sidebar
  // and dropping it onto the dockview grid to open/dock its panel —
  // extracted to useDockviewDrop (hooks/useDockviewDrop.ts). Called here, at
  // the position its three effects previously occupied in this component's
  // body (right before the global keyboard shortcuts effect below). Unlike
  // useWorkspacePersistence/useLayoutPresentation above, this position is NOT
  // load-bearing: none of the three extracted effects share state with any
  // other effect in this file, or with each other beyond the ref the hook
  // now owns internally — see that hook's own header comment.
  const { dockviewRef } = useDockviewDrop({ dockviewApi, setSidebarOpen });
  useBalanceOnDrop({ dockviewApi, enabled: settings.balancePanesOnDrop });

  const openSettings = useCallback((section: SettingsSection = "appearance") => {
    setSettingsSection(section);
    setSettingsStartInContent(false);
    setSettingsOpen(true);
  }, []);
  // Phone navigator's Settings tab: open the picked section directly and
  // close the navigator behind it.
  const openSettingsFromNavigator = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsStartInContent(true);
    setSettingsOpen(true);
    setSidebarOpen(false);
  }, []);

  // Opens the global command palette. The single enforcement point for
  // "terminals only launch from a workspace" (issue #730): gated on viewMode
  // so both the toolbar/global-launcher button path and the ⌘K keyboard
  // shortcut (useGlobalShortcuts.ts, which calls this) consult the same
  // `canLaunchTerminal` check rather than each re-implementing it. Defined
  // here (ahead of the `useGlobalShortcuts` call below) so it can be passed
  // in as the keyboard handler's launcher.
  const openGlobalLauncher = useCallback(() => {
    if (!canLaunchTerminal(useDashboardStore.getState().viewMode)) return;
    setPalette({ open: true, scope: "global", projectId: null });
  }, []);

  // Global keyboard shortcuts: ⌘K/Ctrl+K opens the launcher, ⌘,/Ctrl+, opens
  // settings, Esc closes whichever overlay is open. Registered once,
  // independent of what currently has DOM focus — extracted to
  // useGlobalShortcuts (hooks/useGlobalShortcuts.ts). Called here, at the
  // EXACT position this effect previously occupied in this component's body
  // — not because it's load-bearing (see that hook's own header comment for
  // the ordering/coupling analysis proving this effect is independent of
  // every other effect in this file), but to keep the diff minimal and the
  // file's effect ordering easy to audit.
  useGlobalShortcuts({
    setPalette,
    setSettingsOpen,
    openSettings,
    openGlobalLauncher,
    rightSidebarEnabled: !isMobile,
    modeSwitchEnabled: !isMobile,
  });

  // Check for updates on mount and re-check every 30 minutes.
  // The backend caches results for 1h, so most re-checks are no-ops.
  // Every store call below is deliberately via getState() — a mount-once
  // effect action-caller, not a value this component reacts to (see this
  // component's own selector block above for why).
  usePolling(() => useDashboardStore.getState().checkForUpdates(), 30 * 60 * 1000);

  // Codex `/hooks` trust check (issue #259) — same on-mount + poll shape as
  // the update check above, but on a much shorter cadence: unlike an update,
  // this state can flip the moment the user runs `/hooks` in an open Codex
  // session, and there's no reason to make them wait 30 minutes (or reopen
  // Settings, which force-refreshes on demand) to see the banner clear. The
  // backend's own agent-detect cache (60s) already bounds how often this
  // actually re-probes the filesystem.
  usePolling(() => useDashboardStore.getState().checkCodexHookTrust(), 60 * 1000);

  // Starts this app's live data feeds from the backend once on mount: the
  // ~4s session-status poll plus the /ws/events, /ws/tasks, and /ws/github
  // push channels — extracted to useAppStreams (hooks/useAppStreams.ts).
  // Called here, at the position its four effects previously occupied in
  // this component's body (right after the global keyboard shortcuts effect
  // above, right before the update-check poll below), though — like
  // useDockviewDrop/useGlobalShortcuts before it — this position is NOT
  // load-bearing: none of the four extracted effects share state with any
  // other effect in this file, or with each other — see that hook's own
  // header comment for the full ordering/coupling analysis.
  useAppStreams();

  // Settings hydration and the OS color-scheme watch. Extracted to
  // useHydrateSettings and useThemeWatch; called here, in that order.
  useHydrateSettings();
  useThemeWatch();
  useReportTerminalPalette({
    settingsLoaded,
    colorScheme: settings.terminal.colorScheme,
    theme,
  });

  // Fires a browser Notification (+ sound) on a notification-worthy
  // /ws/events arrival (issue #170), and keeps the backgrounded-tab
  // document.title/favicon badge current — extracted to
  // useAttentionNotifications (hooks/useAttentionNotifications.ts). Called
  // here, at the desktop-notification effect's original position in this
  // component's body, purely to keep the diff minimal and the file's effect
  // ordering easy to audit — like useDockviewDrop/useGlobalShortcuts/
  // useAppStreams before it, this call-site position is NOT load-bearing.
  // See that hook's own header comment for the full ordering/coupling
  // analysis, including why the title/favicon effect's own position
  // (originally further down this file) safely moved here too.
  useAttentionNotifications({ events, sessions, settings, activePanelId });

  // #98 auto-bring-into-focus on the attention transition. Extracted to
  // useAutoFocusOnAttention; called here, where the effect was.
  useAutoFocusOnAttention({
    sessions,
    settings,
    dockviewApi,
    layoutTier,
    seenAttentionForFocusRef,
  });

  // Auto-open a spawned child's panel (issue #194). Extracted to
  // useAutoOpenChildPanels; called here, after useWorkspacePersistence, so it
  // still observes that hook's restoringRef/restoredWorkspaceIdRef.
  useAutoOpenChildPanels({
    sessions,
    sessionsLoaded,
    settings,
    dockviewApi,
    activeWorkspaceId,
    projects,
    restoringRef,
    restoredWorkspaceIdRef,
    seenChildSessionIdsRef,
    hasSeededChildSessionsRef,
  });

  // The backgrounded-tab document.title/favicon-badge effect used to be
  // declared here — moved into useAttentionNotifications above (called
  // higher up in this file); see that hook's own header comment for why
  // moving its execution position earlier is safe (it shares no ref/state
  // with anything between its old and new position).

  // Issue #87 — apple-mobile-web-app-status-bar-style: iOS reads this once
  // at standalone launch and does NOT re-read it on later DOM mutations, so
  // a React effect here would be a no-op on the one platform it matters for.
  // The real fix is an inline script in index.html's <head>, which runs
  // synchronously during initial parse, before iOS's read.

  // Closes panels whose session was killed. Extracted to
  // useCloseKilledSessionPanels; called here, where the effect was.
  useCloseKilledSessionPanels({ sessions, dockviewApi });

  // Closes device panels whose row is gone. Extracted to
  // useCloseMissingDevicePanels; called here, where the effect was.
  useCloseMissingDevicePanels({ devices, devicesLoaded, dockviewApi });

  // Closes project panels whose project is gone. Extracted to
  // useCloseStaleProjectPanels; called here, where the effect was.
  useCloseStaleProjectPanels({ projects, projectsLoaded, projectsError, dockviewApi });

  // The 12 `onOpen*` panel-opening callbacks (session/session-as-float/
  // timeline/GitHub/Git/Agent Rules/Dock Config/Skills/Browser/Tasks/
  // Browser-URL/Blank-Browser) used to be declared individually here and
  // further down (immediately before the split-launch handler) — extracted
  // to usePanelOpener (hooks/usePanelOpener.ts). Called here, at
  // onOpenSession's own former position, because that's a closure-order
  // requirement, not an effect-ordering one: this hook registers no effects
  // at all (every value it returns is a useCallback), so unlike
  // useWorkspacePersistence/useLayoutPresentation/useSessionDeepLink above, WHERE
  // in this component's body it's called doesn't affect behavior — but
  // onOpenSession itself must still be defined before useSessionDeepLink's
  // call and the onOpenSessionRef mirroring effect below, both of which
  // read it. See that hook's own header comment for the full design
  // rationale (why 6 of the 12 share one generic helper and 6 don't, and
  // why the actual count is 12 rather than the roadmap's estimated 16).
  // Memoized so the onOpen* callbacks below (each lists `layout` in its own
  // useCallback dependency array — see usePanelOpener's own header comment)
  // don't get a fresh identity every render, only when the tier changes.
  const layout: LayoutContext = useMemo(() => ({ tier: layoutTier }), [layoutTier]);

  // #3010 — after `layout`, which reopening a remembered pane needs.
  useFoldHalves({
    dockviewApi,
    presentation: layoutPresentation,
    activeWorkspaceId,
    panelsVersion,
    isRestored: () =>
      !restoringRef.current &&
      activeWorkspaceId !== null &&
      restoredWorkspaceIdRef.current === activeWorkspaceId,
    sessionsLoaded,
    reopenSession: (sessionId) => {
      const session = useDashboardStore.getState().sessions.find((x) => x.id === sessionId);
      if (!dockviewApi || !session || session.status === "killed") return false;
      openSessionPanel(dockviewApi, session, layout, useDashboardStore.getState().projects);
      return true;
    },
  });
  const {
    onOpenSession,
    onOpenSessionAsFloat,
    onOpenTimeline,
    onOpenGitHub,
    onOpenGit,
    onOpenAgentRules,
    onOpenFileEditor,
    onOpenExternalFile,
    onOpenFile,
    onOpenProjectBriefing,
    onOpenProjectSetup,
    onOpenDockConfig,
    onOpenSkills,
    onOpenBrowser,
    onOpenTasks,
    onOpenTask,
    onOpenBrowserUrl,
    onOpenBlankBrowser,
    onOpenPreviewTargets,
    onOpenPreview,
    onOpenDevice,
  } = usePanelOpener({
    dockviewApi,
    layout,
    projects,
    workspaces,
    activeWorkspaceId,
    setSidebarOpen,
  });

  // `?session=<id>` deep-link effect (issue #95 prerequisite) — extracted to
  // useSessionDeepLink (hooks/useSessionDeepLink.ts). Called here rather than
  // right after useWorkspacePersistence's own call further up, because it
  // needs onOpenSession (defined above) in closure — but the ordering
  // guarantee that matters (this hook's effect registering AFTER
  // useWorkspacePersistence's restore effect, so their same-delay
  // setTimeout(0)s fire in scheduling order) only requires this call to come
  // AFTER useWorkspacePersistence(...) in render-body order, which it does.
  // restoringRef/restoredWorkspaceIdRef passed through are the exact same ref
  // objects useWorkspacePersistence's own restore effect writes to — see
  // that hook's UseWorkspacePersistenceResult doc comments and this hook's
  // own header comment for the full ordering/coupling contract.
  useSessionDeepLink({
    dockviewApi,
    activeWorkspaceId,
    sessionsLoaded,
    sessions,
    workspaces,
    onOpenSession,
    restoringRef,
    restoredWorkspaceIdRef,
  });

  // Issue #95 — public/push-sw.js's notificationclick handler posts this
  // message to an already-open window instead of navigate()-ing it (that
  // would tear down every live xterm WebSocket). This is deliberately a
  // separate listener from the ?session= deep-link effect above rather than
  // reusing it: deepLinkHandledRef is one-shot per page load by design,
  // while a focused tab can legitimately receive many of these over its
  // lifetime.
  //
  // Ref-backed (rather than sessions/onOpenSession in the dependency array)
  // so the listener isn't torn down and re-attached on every sessions
  // replacement (a new array reference each live-refresh tick) — an
  // independent reviewer's nit on this PR.
  const sessionsRef = useRef(sessions);
  const onOpenSessionRef = useRef(onOpenSession);
  useSyncSessionOpenerRefs({ sessionsRef, onOpenSessionRef, sessions, onOpenSession });
  // Service-worker notification click → open the session (issue #95).
  // The pending-session refs stay here, at their original hook positions;
  // the effect moved to usePushSessionOpen, called here so it still runs
  // after the ref mirror above and after useWorkspacePersistence.
  const pendingPushSessionIdRef = useRef<number | null>(null);
  const pushRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  usePushSessionOpen({
    dockviewApi,
    activeWorkspaceId,
    sessionsLoaded,
    sessionsRef,
    onOpenSessionRef,
    restoringRef,
    restoredWorkspaceIdRef,
    pendingPushSessionIdRef,
    pushRetryTimerRef,
  });

  // Issue #1429 — resolves store/slices/ui.ts's requestOpenSession
  // (useAttentionNotifications.ts's in-app Notification onclick has no
  // direct access to onOpenSession). Same "AFTER useWorkspacePersistence,
  // same restoringRef/restoredWorkspaceIdRef objects" ordering contract as
  // useSessionDeepLink above — see that hook's own header comment, and this
  // one's, for the full argument.
  useOpenSessionRequest({
    dockviewApi,
    activeWorkspaceId,
    sessionsLoaded,
    sessions,
    onOpenSession,
    restoringRef,
    restoredWorkspaceIdRef,
  });

  // #2149 — a task push notification click opens that task in the sidebar's
  // Tasks detail (#3011), which the phone shows full screen (#3014).
  useTaskNotificationOpen();

  // Issue #2020 — resolves requestOpenTask (the desktop Tasks detail's
  // pop-out, useCanPopOutTask; every other "show me this task" opens the
  // sidebar's own detail, #3011, #3014; the sidebar has no dockview API of its
  // own). Same ordering contract as the hook above.
  useOpenTaskRequest({
    dockviewApi,
    activeWorkspaceId,
    onOpenTask,
    restoringRef,
    restoredWorkspaceIdRef,
  });
  // Issues #2016/#2018 — resolves requestOpenPreview, same contract again.
  useOpenPreviewRequest({
    dockviewApi,
    activeWorkspaceId,
    onOpenPreview,
    restoringRef,
    restoredWorkspaceIdRef,
  });

  // Re-sync a push subscription once per page load (issue #95). The ref
  // stays here, at its original hook position; the effect moved to usePushResync.
  const pushResyncAttemptedRef = useRef(false);
  usePushResync({ pushResyncAttemptedRef, settingsLoaded, settings });

  // Focus the post-workspace-switch highlight once per panel id. Extracted
  // to usePostWorkspaceSwitchHighlight; called here, where the effect was.
  usePostWorkspaceSwitchHighlight({
    dockviewApi,
    activeWorkspaceId,
    sessions,
    layout,
    projects,
    lastHandledHighlightRef,
  });

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

  // Issue #3013 — New session controls open the launcher (⌘K and the command
  // box stay the palette). A sidebar project's "+" preselects its project.
  const openProjectLauncher = useCallback((projectId: number) => {
    if (!canLaunchTerminal(useDashboardStore.getState().viewMode)) return;
    useDashboardStore.getState().openLauncher({ projectId });
  }, []);
  const openNewSessionLauncher = useCallback(() => {
    if (!canLaunchTerminal(useDashboardStore.getState().viewMode)) return;
    useDashboardStore.getState().openLauncher();
  }, []);
  // #3010 — the "+" under a half's sessions: the launcher, targeting that half.
  const openNewSessionOnHalf = useCallback((half: Half) => {
    if (!canLaunchTerminal(useDashboardStore.getState().viewMode)) return;
    useDashboardStore.getState().openLauncher({ half });
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
  // #3010 — a session launched or opened from a half's "+" lands on that
  // half: assigned before it opens, so the open path's router places it.
  // In a workspace with no tiled pane yet, the right half's "+" lands on the
  // left: the left half is never empty while a pane is open (moveToHalf).
  const openSessionOnHalf = useCallback(
    (session: Session, target: { half?: Half } | null) => {
      if (foldHalves && target?.half && dockviewApi) {
        useDashboardStore.getState().moveToHalf(
          `session-${session.id}`,
          target.half,
          dockviewApi.panels.filter(isTiledPanel).map((p) => p.id),
        );
      }
      onOpenSession(session);
    },
    [foldHalves, dockviewApi, onOpenSession],
  );

  const handleLaunched = useCallback(
    (session: Session) => {
      if (!dockviewApi || !splitRequest) {
        onOpenSession(session);
        return;
      }
      const req = splitRequest;
      useDashboardStore.getState().clearSplitRequest();
      const panelId = `session-${session.id}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        focusPanelForTier(dockviewApi, existing, layoutTier);
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
    [dockviewApi, splitRequest, onOpenSession, projects, layoutTier],
  );

  const handleSelectWorkspace = useCallback((workspaceId: number) => {
    useDashboardStore.getState().showWorkspace(workspaceId);
    setSidebarOpen(false);
  }, []);

  // One toggle, two meanings depending on breakpoint: phone/tablet's
  // `sidebarOpen` is a closed-by-default overlay flag (App.tsx-local, not
  // persisted — resets to closed every navigation, which is the right
  // default for an overlay); desktop's `sidebarCollapsed` is a persisted,
  // open-by-default panel-visibility preference (store-owned, survives
  // reload). Same button, same handler.
  //
  // Floating-sidebar redesign — was phone-only (`isMobile`) under the
  // tablet tier plan, with tablet deliberately kept on desktop's docked
  // collapse behavior ("it has room for the docked sidebar"). Reversed:
  // tablet's sidebar was pushing and resizing the live dockview grid on
  // open (`sidebar.css`'s `.sidebar-wrapper` was an in-flow `flex-shrink: 0`
  // item there), which is both the wrong feel (Apple's own
  // `UISplitViewController` floats the sidebar as an overlay below the
  // regular/compact width threshold, never resizing content) and a second,
  // independent trigger for the dockview pane-skew bug fixed separately —
  // any grid-width change while a group is maximized replays that same
  // clamp. `layoutTier !== "desktop"` (not `isMobile`) now drives
  // `sidebarOpen`, so tablet gets the same floating overlay as phone.
  const toggleSidebar = useCallback(() => {
    // The phone has no drawer (#3014): its sessions are the top bar's picker.
    if (isMobile) return;
    if (compact) setSidebarOpen((v) => !v);
    else useDashboardStore.getState().setSidebarCollapsed(!sidebarCollapsed);
  }, [isMobile, compact, sidebarCollapsed]);

  // Floating-sidebar redesign — edge-swipe open/dismiss (lib/sidebarSwipeGesture.ts's
  // own header comment covers the design: discrete threshold+commit, not a
  // live drag-follow, and no separate overlay hit-target so touches starting
  // in the edge slice still reach a terminal rendered flush against it
  // first). Two independent attachments, only one live at a time per state:
  // `.app-body` with an edge-zone filter drives open (only relevant while
  // closed), the sidebar panel itself (draggable from anywhere on it,
  // matching Files/Notes on iPad) drives dismiss (only relevant while open).
  // Desktop is excluded entirely — the docked sidebar has no swipe gesture.
  const appBodyRef = useRef<HTMLDivElement>(null);
  const sidebarWrapperRef = useRef<HTMLDivElement>(null);
  // Drop a stale open drawer when leaving the compact tier. Extracted to
  // useSidebarOpenTierReset; called here, where the effect was — before
  // usePhoneBackStack.
  // Tasks mode from 700px (#3009): the board takes the grid and the left
  // sidebar is hidden, so the tablet drawer is closed and cannot be swiped open.
  const boardOverGrid = !isMobile && viewMode === "kanban";
  useSidebarOpenTierReset({ compact, boardOverGrid, setSidebarOpen });
  // Phone + tablet: Android back / the back gesture closes the topmost overlay (see
  // hooks/usePhoneBackStack.ts). Settings and the session/notification
  // sheets register themselves; the navigator and the Tasks board live here.
  usePhoneBackStack(compact && !isMobile && sidebarOpen, () => setSidebarOpen(false));
  // Phone (#3014): after "Open session in Workspace" took a task's session to
  // Workspace, back returns to Tasks (design 9.3). The only back that changes
  // mode; it is registered while the switch it undoes is still in effect.
  const crossLinkReturn = useDashboardStore((s) => s.crossLinkReturn);
  usePhoneBackStack(isMobile && crossLinkReturn !== null && viewMode === "list", () =>
    useDashboardStore.getState().returnFromCrossLink(),
  );
  // Edge-swipe to open/dismiss the compact sidebar. Extracted to
  // useSidebarSwipe; called here, where the effect was. Not on the phone,
  // which has no drawer (#3014).
  useSidebarSwipe({
    compact: compact && !isMobile && !boardOverGrid,
    sidebarOpen,
    setSidebarOpen,
    appBodyRef,
    sidebarWrapperRef,
  });

  // ---- Sidebar width drag (same pattern as Dock's height drag) ----
  // Persists on drag end only, via the store action (not a direct
  // `writeNumber` call the way Dock/UnifiedBoard persist — `setSidebarWidth`
  // already does that internally).
  const { dragging: sidebarResizing, onMouseDown: onSidebarResizeMouseDown } = useDragResize({
    axis: "x",
    min: SIDEBAR_MIN_WIDTH,
    getMax: () => SIDEBAR_MAX_WIDTH,
    value: sidebarWidth,
    onChange: setSidebarWidthLocal,
    onCommit: (w) => useDashboardStore.getState().setSidebarWidth(w),
    cursor: "col-resize",
  });

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
    () => dockviewApi?.panels.filter(isTiledPanel).length ?? 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-derives off panelsVersion, not a real dependency
    [dockviewApi, panelsVersion],
  );
  // Filtered to tiled panels only, same as tiledPaneCount above and for the
  // same reason (independent code review): a leftover floating panel would
  // otherwise get a row in the phone session switcher, and choosing it calls
  // dockviewApi.maximizeGroup(panel) (MobileSessionBar.tsx) — maximizeGroup
  // on a floating panel throws (see applyMobilePresentation's own comment in
  // panelUtils.ts), so that tap would crash.
  // Only feeds the phone session switcher — Hermes review, PR #727: workspaceProjectIds
  // below deliberately does NOT reuse this array, since it also drives the
  // desktop Dock and a tiled-only filter there would silently drop a project
  // whose only open session is a floating (peeked) panel.
  const mobilePanels = useMemo(
    () => dockviewApi?.panels.filter(isTiledPanel) ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-derives off panelsVersion, not a real dependency
    [dockviewApi, panelsVersion],
  );
  // Every pane open in the active workspace, floating ones included, for the
  // left rail's pane list (#3009). Floating is safe there: focusPanelForTier
  // maximizes only on the phone, which has no rail, and in the halves, whose
  // router leaves a float to the ordinary path and whose moves count tiled
  // panes only (tiledLeftCount below).
  const railPanes = useMemo<RailPaneInput[]>(
    () =>
      (dockviewApi?.panels ?? []).map((panel) => ({
        id: panel.id,
        title: panel.title ?? "",
        sessionId: panelSessionId(panel),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-derives off panelsVersion, not a real dependency
    [dockviewApi, panelsVersion],
  );
  const focusRailPane = useCallback(
    (panelId: string) => {
      const panel = dockviewApi?.getPanel(panelId);
      if (dockviewApi && panel) focusPanelForTier(dockviewApi, panel, layoutTier);
    },
    [dockviewApi, layoutTier],
  );
  // #3010 — the halves' panes: the left rail lists the left half's, the
  // right rail the right half's.
  const railSplit = useMemo(() => splitByHalf(halvesState, railPanes), [halvesState, railPanes]);
  // The left half only ever shows a tiled pane (a float cannot be maximized),
  // so a float is not something the left half can fall back on: the guard
  // that keeps the left half non-empty counts tiled panes only.
  const tiledLeftCount = useMemo(() => {
    const tiled = new Set(dockviewApi?.panels.filter(isTiledPanel).map((p) => p.id));
    return railSplit.left.filter((p) => tiled.has(p.id)).length;
  }, [dockviewApi, railSplit.left]);
  const { moveToHalf, toggleRightRailPane, renderHalfActions, renameHalfPane, halfMenuItems } =
    useHalfActions(dockviewApi, layoutTier, tiledLeftCount);
  // Projects with a session open in the active workspace, derived from the
  // live dockview panels (panel.params.sessionId -> session.projectId) —
  // reactive via panelsVersion, bumped on every ordinary dockview layout
  // change via the onDidLayoutChange effect above, AND on a workspace-switch
  // fromJSON() restore via that same restore effect's own explicit
  // `setPanelsVersion` call. The restore needs its own call rather than
  // relying on onDidLayoutChange to notice: `activeWorkspaceId` is in BOTH
  // effects' dep arrays, so a switch disposes/re-subscribes
  // onDidLayoutChange in the same commit as the restore's own
  // clear()/fromJSON() calls, and dockview's onDidLayoutChange is an
  // AsapEvent whose subscribers gate on a fire-count captured at subscribe
  // time — a subscriber created after the restore's fires (but before the
  // deferred microtask drains) never sees them. Without the restore's own
  // call, this memo — and therefore the Dock's project columns — stayed on
  // the PREVIOUS workspace until some unrelated cause (usually the next 4s
  // sessions poll) bumped panelsVersion for its own reasons. Deduped,
  // first-seen order kept so the Dock's columns don't reshuffle on every
  // render. There's no workspace<->project link in the DB (workspaces.layout
  // is an opaque dockview blob) — this is what makes a "per-workspace dock"
  // possible without a schema change.
  //
  // The walk itself lives in workspaceProjectIdsFromPanels so there is one
  // loop, not a second copy (issue #1877). What the sidebar and the Dock
  // actually receive is the readiness gate below — this memo is the known
  // set, and it is not handed through while it is still unknowable. Manual
  // "+ Add project" pins are NOT folded in here: the Dock still has to tell
  // a pin-only column from a tiled one (its remove button). The sidebar
  // unions those pins itself, through the same dockColumnProjectIds helper
  // the Dock's columns use.
  //
  // Hermes review, PR #727 — deliberately walks ALL panels, not
  // `mobilePanels` (which is tiled-only). `<Dock>` below renders on desktop
  // too, and a project whose only open session is a floating (peeked) panel
  // should still get a Dock column there — mobilePanels' tiled-only filter
  // exists solely to keep the phone session switcher's maximizeGroup safe
  // (App.tsx's own comment on that array), a mobile-crash concern that
  // shouldn't also silently drop a desktop Dock column.
  const workspaceProjectIds = useMemo(
    () => workspaceProjectIdsFromPanels(dockviewApi?.panels ?? [], sessions),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-derives off panelsVersion, not a real dependency
    [dockviewApi, sessions, panelsVersion],
  );
  // Same panels, the terminal panes specifically. The sidebar marks these
  // sessions; activating one goes through onOpenSession, which focuses the
  // existing `session-<id>` pane instead of opening a second one. Not passed
  // on the phone tier (no workspaces) — see the Sidebar props below.
  const openSessionIds = useMemo(
    () => openTerminalSessionIds(dockviewApi?.panels ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panelsVersion, same reason as workspaceProjectIds above
    [dockviewApi, panelsVersion],
  );

  // Mobile UI/UX overhaul, item C.2 — the key bar only makes sense while a
  // terminal session is the active mobile pane (not the timeline/Agent
  // Browser/task-detail/git/github panels, which don't accept keystrokes).
  // `session-${id}` is the terminal panel's own id format everywhere else in
  // this file (e.g. the `#98 item 4` auto-focus effect's own
  // `` `session-${s.id}` === panelId `` lookup above) — reused here rather
  // than inspecting dockview's internal component-type metadata. Also
  // requires `status === "active"` (Hermes
  // review, PR #616 round 1): a killed/exited session's pane can still be
  // the active one (closing is a separate, explicit action from the program
  // exiting — see PaneTab.tsx's own close-vs-kill distinction), and there's
  // nothing left alive on the other end of a key-bar tap at that point.
  //
  // Also requires `viewMode !== "kanban"` (Hermes review, PR #616 round 2):
  // KanbanBoardOverlay renders as a visual overlay ON TOP of the dockview
  // container without changing activePanelId (it's a "toggled view", not a
  // panel switch — see its own render site further down) — without this,
  // the bar would keep showing and sending keys to a terminal the Kanban
  // board is currently covering, with no way to see what a tap even did.
  //
  // #3010 — with two halves on screen, the key bar addresses the focused
  // half: the right half's session while it has focus (and no view covers
  // it), the left half's otherwise.
  // Only while its pane is open in the grid: the assignment can outlive a
  // pane for a moment (a reload, before the remembered panes reopen).
  const rightHalfPanelId =
    foldHalves &&
    halvesState.shownRight !== null &&
    railPanes.some((p) => p.id === halvesState.shownRight)
      ? halvesState.shownRight
      : null;
  const rightHalfSession = rightHalfPanelId
    ? sessions.find((s) => `session-${s.id}` === rightHalfPanelId)
    : undefined;
  const rightHalfOnScreen = !!rightHalfSession && !rightSidebarOpen;
  // The left half's pane, for its header.
  const leftHalfPane = (() => {
    // Only a left-half pane: the active panel can be a right-half one for a
    // moment (or for good, with no tiled pane left to show on the left).
    if (!foldHalves || !activePanelId || halfOf(halvesState, activePanelId) !== "left") {
      return null;
    }
    const pane = railPanes.find((p) => p.id === activePanelId);
    if (!pane) return null;
    const session =
      pane.sessionId === undefined ? undefined : sessions.find((x) => x.id === pane.sessionId);
    return {
      id: pane.id,
      title: session ? sessionPaneTitle(session) : pane.title,
      projectName: session
        ? (projects.find((p) => p.id === session.projectId)?.name ?? null)
        : null,
    };
  })();
  const onUseLeftHalf = useCallback(() => {
    const store = useDashboardStore.getState();
    store.setFocusedHalf("left");
    const id = store.activePanelId;
    if (id) store.noteHalfUsed({ kind: "pane", panelId: id });
  }, []);
  const activeTerminalSession =
    viewMode === "kanban"
      ? undefined
      : rightHalfOnScreen && focusedHalf === "right"
        ? rightHalfSession?.status === "active"
          ? rightHalfSession
          : undefined
        : activePanelId
          ? sessions.find((s) => `session-${s.id}` === activePanelId && s.status === "active")
          : undefined;

  // Dockview ships its own hardcoded light/dark chrome colors, unaware of
  // the selected terminal color scheme — so a scheme's background (e.g.
  // Dracula's off-white) visibly seams against dockview's fixed white/black
  // panel and tab-bar surfaces (issue #132). Exposing the scheme's
  // background as a custom property here lets the CSS in styles.css
  // override just those `--dv-*` surfaces to match, without touching
  // dockview's tab text colors.
  const dockviewChromeBg = getSchemeBackground(settings.terminal.colorScheme, theme);

  // Phone has no right sidebar, so only there does the palette's "Edit project
  // files" still open the full file-editor panel.
  const onOpenFilesFromPalette = useCallback(
    (projectId: number) => {
      if (isMobile) onOpenFileEditor(projectId);
      else useDashboardStore.getState().openRightSidebarView("files", projectId);
    },
    [isMobile, onOpenFileEditor],
  );

  const rightSidebarActions = useMemo(
    () => ({
      onOpenGit,
      onOpenGitHub,
      onOpenFileEditor,
      onOpenFile,
      onOpenAgentRules,
      onOpenProjectBriefing,
      onOpenProjectSetup,
      onOpenDockConfig,
      onOpenSkills,
      onOpenTasks,
      onOpenDevice,
    }),
    [
      onOpenGit,
      onOpenGitHub,
      onOpenFileEditor,
      onOpenFile,
      onOpenAgentRules,
      onOpenProjectBriefing,
      onOpenProjectSetup,
      onOpenDockConfig,
      onOpenSkills,
      onOpenTasks,
      onOpenDevice,
    ],
  );

  // Issue #1877 — one scope for the sidebar tree and the Dock columns.
  // Phone has no workspaces, so it stays null (the full project list).
  // Desktop and tablet scope to the panel-derived ids, but only once that
  // set is knowable. `sessions` starts as `[]` and the layout restores
  // without waiting for GET /api/sessions (see the auto-open-child effect
  // above), so the memo resolves every panel against an empty list and
  // comes back `[]` on a cold start — and forever if that fetch errors,
  // because `sessionsLoaded` flips only on success. Passing that `[]`
  // paints "Nothing tiled in this workspace" in the sidebar and "No
  // projects tiled in this workspace yet" in the Dock when the workspace
  // isn't empty, it just hasn't loaded. `null` is unscoped: both surfaces
  // show every project and neither claims the workspace is empty. `[]` is
  // a known-empty workspace. Same gates the deep-link and push effects
  // already use, including `activeWorkspaceId !== null` — `null === null`
  // is not a restored workspace.
  const scopedWorkspaceProjectIds =
    isMobile ||
    !(
      dockviewApi &&
      sessionsLoaded &&
      activeWorkspaceId !== null &&
      // The restore effect writes this ref, then bumps panelsVersion —
      // that setState is what re-renders, so this read sees the
      // workspace that was just restored. The other gates read the same
      // ref from effects; there is no state copy of it to subscribe to.
      // eslint-disable-next-line react-hooks/refs -- ref is the restore record; panelsVersion re-renders after it is written
      restoredWorkspaceIdRef.current === activeWorkspaceId
    )
      ? null
      : workspaceProjectIds;

  const sidebar = (
    <SidebarShell
      showSourceControl={isMobile}
      phoneSection={compact ? sidebarPhoneSection(navTab) : undefined}
      workspaceProjectIds={scopedWorkspaceProjectIds}
      openSessionIds={isMobile ? null : openSessionIds}
      onOpenSession={onOpenSession}
      onOpenSessionAsFloat={onOpenSessionAsFloat}
      onSessionEnded={onSessionEnded}
      onOpenProjectLauncher={openProjectLauncher}
      onOpenGlobalLauncher={openNewSessionLauncher}
      onOpenSettingsProjects={() => openSettings("projects")}
      onOpenTasks={onOpenTasks}
      onOpenGit={onOpenGit}
      onOpenProjectSetup={onOpenProjectSetup}
      onOpenDevice={onOpenDevice}
    />
  );

  // Whether the left sidebar shows: the docked one on desktop unless
  // collapsed, the drawer below 1280px only while open. The rail lists the
  // open panes when it does not (#3009).
  const leftSidebarShown = compact ? sidebarOpen : !sidebarCollapsed;

  // Phone session switcher — rendered into the phone's top bar in place of the
  // old `.mobile-tabs` strip. `mobilePanels` is tiled-only (see its comment).
  // From 700px there is no top bar (#3009): the left rail lists the open
  // panes while the left sidebar is not showing.
  const mobileSessionSwitcher = isMobile ? (
    <MobileSessionBar
      tier={layoutTier}
      panels={mobilePanels}
      activePanelId={activePanelId}
      dockviewApi={dockviewApi}
      onNewSession={openNewSessionLauncher}
      onOpenSession={onOpenSession}
      // Issue #1882 — the phone tier has no workspace switcher, so a picker
      // row that names another workspace is the way back to it.
      onSelectWorkspace={handleSelectWorkspace}
    />
  ) : null;

  return (
    <div
      data-tier={layoutTier}
      data-band={layoutBand}
      // Workspace or Tasks (#3009); left-rail.css hides the left sidebar in
      // Tasks mode from 700px.
      data-mode={viewMode === "kanban" ? "tasks" : "workspace"}
      className={themeClassName(
        theme,
        "app",
        sidebarOpen && "sb-open",
        isMobile && "mode-bar",
        sidebarCollapsed && "sidebar-collapsed",
        foldHalves && "fold-halves",
        // The two halves' widths hold in Tasks mode too: the board on the
        // left half, the task sidebar docked on the right (frame 2b).
        layoutPresentation === "halves" && "halves-band",
        sidebarResizing && "sidebar-resizing",
        settings.sidebarDensity === "compact" && "density-compact",
        isCoarsePointer && activeTerminalSession && "key-bar",
      )}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      {/* The app has no visible title, but a document with no top-level
          heading gives a screen-reader user nothing to orient by when they
          tab into it. Visually hidden, not absent. */}
      <h1 className="visually-hidden">Mullion</h1>
      {/* The app-wide toast host. Mounted here, at the top of the tree, so
          every surface's failure has somewhere to land — including ones
          rendered inside a modal or a panel further down. */}
      <ToastHost />
      {/* The top bar is the phone's only (#3009). From 700px its controls
          live on the left rail below: the board toggle is the mode switch,
          the command box, bell and settings are the rail's bottom cluster,
          the sidebar toggle sits under the mode switch, New session is each
          sidebar project's "+" (the launcher, #3013) and the command box (the
          ⌘K palette), and the theme is in Settings → Appearance.
          The top bar's version label is in Settings → Server. */}
      {isMobile && (
        <Toolbar
          onOpenSession={onOpenSession}
          onOpenTimeline={onOpenTimeline}
          onOpenBrowser={onOpenBrowser}
          onOpenLauncher={openGlobalLauncher}
          onOpenSettings={openSettings}
          activeWorkspaceName={activeWorkspace?.name ?? null}
          paneCount={paneCount}
          currentVersion={currentVersion}
          mobileSessionSlot={mobileSessionSwitcher}
          phone
        />
      )}
      <div className="app-body" ref={appBodyRef}>
        {!isMobile && (
          <LeftRail
            onToggleSidebar={toggleSidebar}
            sidebarShown={leftSidebarShown}
            middle={
              <RailWorkspaceSection
                onSelectWorkspace={handleSelectWorkspace}
                sheet={isCoarsePointer}
                showPanes={!leftSidebarShown}
                panes={foldHalves ? railSplit.left : railPanes}
                activePanelId={activePanelId}
                onFocusPane={focusRailPane}
                onNewSession={
                  foldHalves ? () => openNewSessionOnHalf("left") : openNewSessionLauncher
                }
                menuItems={foldHalves ? halfMenuItems("left") : undefined}
              />
            }
            onOpenLauncher={openGlobalLauncher}
            onOpenSettings={openSettings}
            onOpenSession={onOpenSession}
            onOpenTimeline={onOpenTimeline}
            onOpenBrowser={onOpenBrowser}
            notificationSheet={compact && isCoarsePointer}
          />
        )}
        {/* The phone has no drawer (#3014): Projects is the top bar's
            session picker, Tasks the mode bar, Devices and Settings the mode
            bar's "more" sheet. The sidebar still mounts, hidden, as it did
            inside the closed drawer: its mount loads projects, sessions,
            hosts and tasks, and it owns each project's live GitHub
            subscription, which the picker and the "more" views rely on. */}
        {isMobile && (
          <div className="phone-sidebar-host" hidden inert>
            {sidebar}
          </div>
        )}
        {!isMobile && (
          <>
            <div className="cmux-scrim" onClick={() => setSidebarOpen(false)} />
            <div
              className="sidebar-wrapper cmux-scroll"
              ref={sidebarWrapperRef}
              /* The compact tier's drawer is closed by sliding it off-screen
                 (styles/sidebar.css's `transform: translateX(-101%)`), which
                 leaves every control inside it — session rows, the filter
                 input, the per-row kebab menus — focusable and in the
                 accessibility tree while they sit off-screen. A keyboard user
                 tabbing through the app would land on controls they cannot
                 see, and a screen reader would read the whole hidden tree.

                 `inert` removes the subtree from both the tab order and the
                 accessibility tree in one attribute. It is applied only on the
                 compact tier: the desktop sidebar is always visible, so making
                 it inert when `sidebarOpen` is false (the desktop default)
                 would hide a permanently-visible panel.

                 styles/sidebar.css pairs this with `visibility: hidden` for
                 the closed state, which is the fallback for browsers without
                 `inert` support — an element with `visibility: hidden` is not
                 focusable either. */
              inert={compact && !sidebarOpen}
            >
              {/* Desktop-only (review finding, floating-sidebar redesign): the
                  overlay's own `width: min(310px, 84vw) !important`
                  (sidebar.css's phone/tablet `data-tier` block) outranks
                  `--sidebar-width`, the custom property this drag actually
                  writes to, so below desktop width the handle used to render,
                  respond to mousedown, and update state/localStorage while
                  visibly doing nothing — a resize-by-mouse gesture doesn't fit
                  a touch-first floating overlay anyway. */}
              {layoutTier === "desktop" && !sidebarCollapsed && (
                <div className="sidebar-resize-handle" onMouseDown={onSidebarResizeMouseDown} />
              )}
              {/* Phone: workspaces don't exist as a concept — the session picker
                  lists every session — and the drawer is a full-screen navigator
                  with tabs instead of one long scroll. */}
              {compact ? (
                <>
                  <PhoneNavigatorPanel
                    tablet={!isMobile}
                    workspaces={
                      isMobile ? undefined : (
                        <WorkspaceSwitcher onSelectWorkspace={handleSelectWorkspace} />
                      )
                    }
                    navTab={navTab}
                    setNavTab={setNavTab}
                    onOpenTasks={onOpenTasks}
                    onClose={() => setSidebarOpen(false)}
                    onSelectSetting={openSettingsFromNavigator}
                    sidebar={sidebar}
                    onOpenSession={onOpenSession}
                    onSessionEnded={onSessionEnded}
                  />
                </>
              ) : (
                <>
                  <WorkspaceSwitcher onSelectWorkspace={handleSelectWorkspace} />
                  {sidebar}
                </>
              )}
            </div>
          </>
        )}
        <div
          className={`grid-area${foldHalves ? " fold-half fold-half-left" : ""}${
            foldHalves && rightHalfOnScreen && focusedHalf === "left" ? " focused" : ""
          }`}
          // #3010 — a press or focus in the left half gives it the key bar
          // and makes its pane the one used last (for the phone after
          // folding).
          onPointerDownCapture={foldHalves ? onUseLeftHalf : undefined}
          onFocusCapture={foldHalves ? onUseLeftHalf : undefined}
        >
          {/* Whole-backend-down — design States doc section 04. Docked at
              the top of the grid area, rest of the UI dimmed (not
              disabled) beneath it via .grid-area-body.dimmed, matching the
              design's "frozen body" — a visual cue, not an actual input
              lock, so nothing gets destructively stuck if this signal
              itself turns out wrong. Reuses the existing live-refresh poll
              (store.ts) rather than a separate health-check mechanism.
              Gated on !sessionExpired below it: a gateway forward-auth
              session expiry (self-hosted behind Traefik + Authentik or
              similar) also fails every request this poll makes, but it
              isn't "the backend is down" — the process is fine, only the
              gateway is rejecting the request — so it gets its own banner
              instead of this one asserting a cause that isn't true. */}
          {!backendReachable && !sessionExpired && (
            <div className="backend-down-banner">
              <ServerRackIcon size={16} style={{ color: "var(--r)" }} />
              <span className="backend-down-title">Mullion server unreachable</span>
              <span className="backend-down-subtext">
                retry in {LIVE_REFRESH_INTERVAL_MS / 1000}s…
              </span>
              <button
                className="backend-down-reconnect"
                disabled={reconnecting}
                onClick={() => {
                  setReconnecting(true);
                  useDashboardStore
                    .getState()
                    .refreshSessions()
                    .catch(() => {
                      // Surfaced through backendReachable/sessionExpired
                      // themselves (both already drive their own banner) —
                      // nothing further to do with the rejection here,
                      // just don't let it become an unhandled rejection.
                    })
                    .finally(() => setReconnecting(false));
                }}
              >
                {reconnecting ? "Reconnecting…" : "Reconnect"}
              </button>
            </div>
          )}
          {/* A gateway forward-auth session expiry that survived
              api/client.ts's own silent top-level reload attempt (its
              guard already fired once this session — see
              AuthExpiredError's doc comment) — the one case where recovery
              genuinely needs the user, so it gets an explicit action
              rather than another silent reload. */}
          {sessionExpired && (
            <div className="backend-down-banner">
              <WarningTriangleIcon size={16} style={{ color: "var(--o)" }} />
              <span className="backend-down-title">Session expired</span>
              <span className="backend-down-subtext">sign in again to continue</span>
              <button className="backend-down-reconnect" onClick={() => window.location.reload()}>
                Sign in
              </button>
            </div>
          )}
          {/* Issue #1638 — the mount load gave up. workspacesLoaded stays
              false (an unknown list must not bootstrap a second Default),
              so without this the grid is just empty. Not .backend-down-banner:
              a dead backend already shows that red bar, and its Reconnect
              does not retry this load, so this stays but reads as secondary. */}
          {workspaceLoadFailed && (
            <div className="workspace-load-banner" role="alert">
              <WarningTriangleIcon size={16} style={{ color: "var(--o)", flexShrink: 0 }} />
              <span className="backend-down-title">Couldn't load workspaces</span>
              <span className="backend-down-subtext">retry, or come back online</span>
              <button
                className="workspace-load-retry"
                onClick={() => setWorkspaceLoadNonce((n) => n + 1)}
              >
                Retry
              </button>
            </div>
          )}
          <ResourceAlertBanner onOpenStorage={() => openSettings("storage")} />
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
                  useDashboardStore.getState().dismissUpdate();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    useDashboardStore.getState().dismissUpdate();
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
          {shouldShowCodexHookTrustBanner({
            codexSessionActive,
            codexHookTrust,
            dismissedCodexHookTrustVersion,
            currentVersion,
          }) && (
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
                Run /hooks in a Codex session to enable status updates · Click for details
              </span>
              <span
                className="update-banner-dismiss"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  useDashboardStore.getState().dismissCodexHookTrust();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    useDashboardStore.getState().dismissCodexHookTrust();
                  }
                }}
                title="Dismiss until next version"
              >
                ×
              </span>
            </div>
          )}
          <div className={`grid-area-body${!backendReachable || sessionExpired ? " dimmed" : ""}`}>
            {foldHalves && leftHalfPane && (
              <HalfHeader
                side="left"
                title={leftHalfPane.title}
                projectName={leftHalfPane.projectName}
                onMove={
                  canGoRight(leftHalfPane.id) && tiledLeftCount > 1
                    ? () => moveToHalf(leftHalfPane.id, "right")
                    : null
                }
                focused={rightHalfOnScreen && focusedHalf === "left"}
                renderActions={renderHalfActions(leftHalfPane.id)}
                onRenameCommit={(value) => renameHalfPane(leftHalfPane.id, value)}
              />
            )}
            <div
              ref={dockviewContainerRef}
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
                // Keep floating panels' position inside the grid area (the
                // default only keeps 100px in view). Height is clamped by the
                // ResizeObserver effect above — this option never resizes.
                floatingGroupBounds="boundedWithinViewport"
                // A lone tab is otherwise sized to its own content, leaving
                // most of the tab strip empty and the title/status cramped
                // — full-width mode stretches a single tab to fill the
                // group instead.
                singleTabMode="fullwidth"
                // Independent code review + Hermes, PR #723 — see
                // xterm.css's own `@media (pointer: coarse)` block for the
                // full root-cause writeup (dockview's default 'custom' mode
                // wraps the strip in `.dv-scrollable`, whose `overflow:
                // hidden` blocked touch panning). Scoped to coarse pointers
                // only — Hermes review: unscoped, this also swaps desktop's
                // subtle on-hover custom overlay thumb for an always-visible
                // native scrollbar, a needless mouse-facing side effect for
                // a touch-only fix. Tablet tier plan, PR 4 (independent
                // review) — reads the same live `isCoarsePointer` state the
                // key bar above uses, not its own one-shot matchMedia()
                // snapshot: this used to only reflect pointer type at mount,
                // so a runtime pointer-type change (a 2-in-1 laptop's
                // keyboard attach/detach, a devtools emulation toggle)
                // wouldn't update it until next remount, unlike every other
                // pointer-coarse-gated affordance this plan added.
                scrollbars={isCoarsePointer ? "native" : "custom"}
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
              {/* The unified task/session board (formerly issue #211's
                  session-only KanbanBoard and 6.5/#218's TasksPanel dockview
                  panel, now merged — see UnifiedBoard.tsx) — same "overlay,
                  not a conditionally-mounted replacement" reasoning as the
                  empty grid dropzone above: dockview's own API instance (and
                  every open panel) stays alive underneath while viewMode is
                  "kanban", so switching back to Workspace restores exactly
                  what was there before. This is Tasks mode (#3009), entered
                  from the left rail's mode switch, its shortcut, Sidebar.tsx's
                  own entry or the command palette, and on the phone from the
                  mode bar (#3014), where it shows one lane at a time. */}
              {viewMode === "kanban" && (
                <KanbanBoardOverlay
                  onOpenSession={onOpenSession}
                  onSessionEnded={onSessionEnded}
                  phone={isMobile}
                  columnCount={isMobile ? 1 : undefined}
                />
              )}
            </div>
            {/* Not in Tasks mode from 700px (#3009): the board takes the
                grid area full height. Unmounted rather than hidden so its
                monitors are not fitted to an empty box; its rows and
                heights are persisted, so it comes back as it was. */}
            {viewMode !== "kanban" && (
              <Dock
                workspaceProjectIds={scopedWorkspaceProjectIds}
                onOpenGitHub={onOpenGitHub}
                onOpenBrowser={onOpenBrowser}
                onOpenBlankBrowser={onOpenBlankBrowser}
                onManagePreviews={(id) => onOpenDockConfig(id, "previews")}
                onOpenSession={onOpenSession}
              />
            )}
            {/* Mobile UI/UX overhaul, item C.2 — last child of
                .grid-area-body (a flex column), so it sits at the bottom of
                the already-`bottom: var(--kb-inset)`-shrunk .app shell —
                i.e. directly above the keyboard — with no position:fixed or
                separate inset tracking of its own needed. Tablet tier plan,
                PR 4 — gated on pointer coarseness (not the phone-only
                `isMobile`) so a tablet's touch-primary input gets the key
                bar too; a touchscreen laptop at desktop width gets it as
                well, for the same reason. */}
            {isCoarsePointer && activeTerminalSession && (
              <MobileKeyBar sessionId={activeTerminalSession.id} />
            )}
          </div>
        </div>
        <RightSidebar
          tier={layoutTier}
          actions={rightSidebarActions}
          workspaceProjectIds={scopedWorkspaceProjectIds}
          halves={layoutPresentation === "halves"}
          band={layoutBand}
          rightHalf={
            rightHalfSession && rightHalfPanelId ? (
              <RightHalfPane
                // #3015 — keyed by the session, so a session arriving on the
                // right half mounts fresh and plays its arrival (motion.css).
                key={rightHalfSession.id}
                sessionId={rightHalfSession.id}
                title={sessionPaneTitle(rightHalfSession)}
                projectName={
                  projects.find((p) => p.id === rightHalfSession.projectId)?.name ?? null
                }
                focused={focusedHalf === "right"}
                onMoveLeft={() => moveToHalf(rightHalfPanelId, "left")}
                onClose={() => {
                  useDashboardStore.getState().showRightPane(null);
                  useDashboardStore.getState().setFocusedHalf("left");
                }}
                onUse={() => {
                  const store = useDashboardStore.getState();
                  store.setFocusedHalf("right");
                  store.noteHalfUsed({ kind: "pane", panelId: rightHalfPanelId });
                }}
                renderActions={renderHalfActions(rightHalfPanelId)}
                onRenameCommit={(value) => renameHalfPane(rightHalfPanelId, value)}
              />
            ) : null
          }
          railSessions={
            foldHalves ? (
              <>
                <span className="left-rail-sep" aria-hidden="true" />
                <RailPanes
                  panes={railSplit.right}
                  activePanelId={rightHalfOnScreen ? rightHalfPanelId : null}
                  onFocus={toggleRightRailPane}
                  onAdd={() => openNewSessionOnHalf("right")}
                  label="Right half"
                  menuItems={halfMenuItems("right")}
                />
              </>
            ) : null
          }
        />
      </div>
      {/* Phone (#3014): the mode bar, last in .app's column so it sits under
          the key bar, at the bottom edge. */}
      {isMobile && <PhoneModeBar onOpenSettings={() => openSettings()} />}
      <ProjectPreviewPicker
        onOpenDefault={onOpenBrowser}
        onBlank={onOpenBlankBrowser}
        onManage={(projectId) => onOpenDockConfig(projectId, "previews")}
      />
      {/* Issue #3013 — "New session" opens this launcher; ⌘K stays the palette. */}
      <SessionLauncherHost
        phone={isMobile}
        panels={mobilePanels}
        onLaunched={openSessionOnHalf}
        onOpenSession={openSessionOnHalf}
      />
      {paletteOpen && (
        <CommandPalette
          scope={paletteScope}
          layoutTier={layoutTier}
          projectId={paletteProjectId}
          onClose={() => {
            setPalette((p) => ({ ...p, open: false }));
            useDashboardStore.getState().clearSplitRequest();
          }}
          onLaunched={handleLaunched}
          onOpenSession={onOpenSession}
          onOpenGitHub={onOpenGitHub}
          onOpenAgentRules={onOpenAgentRules}
          onOpenFileEditor={onOpenFilesFromPalette}
          onOpenExternalFile={onOpenExternalFile}
          onOpenProjectBriefing={onOpenProjectBriefing}
          onOpenProjectSetup={onOpenProjectSetup}
          onOpenDockConfig={onOpenDockConfig}
          onOpenSkills={onOpenSkills}
          onOpenBrowser={onOpenPreviewTargets}
          onOpenSettingsSection={(section) => openSettings(section)}
          onOpenDevices={() => openSettings("devices")}
          onOpenHosts={() => openSettings("hosts")}
          onOpenSettings={() => openSettings()}
          onOpenTimeline={onOpenTimeline}
          onOpenBlankBrowser={onOpenBlankBrowser}
          onToggleRightSidebar={
            isMobile ? undefined : () => useDashboardStore.getState().toggleRightSidebar()
          }
          onOpenBrowserUrl={onOpenBrowserUrl}
          onShowWorkspace={handleSelectWorkspace}
          onOpenTasks={onOpenTasks}
        />
      )}
      {settingsOpen && (
        // ErrorBoundary's fallback (.crashed-pane, styles.css) has no
        // positioning of its own — it depends entirely on its parent. .app
        // is a column flex container (styles.css), so without this wrapper
        // .crashed-pane would render as a squeezed item in that flex flow
        // (alongside the toolbar/.app-body) on a Settings chunk-load
        // failure, not a centered full-screen crash state — unlike the
        // other three lazy boundaries, which each already sit inside a
        // sized/positioned container (dockview's own panel content div for
        // BrowserPanel/BrowserPane, KanbanBoardOverlay's own position:
        // absolute; inset: 0 div). This position: fixed; inset: 0 wrapper
        // gives .crashed-pane the same kind of dedicated full-viewport box.
        // Not a visual change for the normal load/success path: LazySettings'
        // and SettingsLoadingFallback's own `.settings-backdrop` (position:
        // absolute; inset: 0) already resolved against `.app` (also fixed;
        // inset: 0) before this wrapper existed, and resolve against this
        // wrapper the same way now — same full-viewport coverage either way.
        //
        // zIndex: 60 is load-bearing, not decoration: `position: fixed`
        // makes this div its own stacking context, so without an explicit
        // z-index it paints at the implicit "auto" level among .app's other
        // children — losing to any sibling with its own explicit z-index
        // above 0 (e.g. the mobile sidebar drawer at 45, `.overlay-backdrop`
        // at 50), regardless of DOM order. `.settings-backdrop`'s own
        // z-index: 60 (styles.css) is what correctly out-ranks those today;
        // matching it here keeps that ordering unchanged now that this
        // wrapper — not `.settings-backdrop` directly — is what competes in
        // `.app`'s stacking context.
        <div style={{ position: "fixed", inset: 0, zIndex: 60 }}>
          <ErrorBoundary
            onReset={() => {
              setSettingsOpen(false);
              setSettingsRetryKey((k) => k + 1);
            }}
          >
            <Suspense fallback={<SettingsLoadingFallback onClose={() => setSettingsOpen(false)} />}>
              {/* useRetriableLazy deliberately returns a NEW component
                  identity per settingsRetryKey — that's the whole retry
                  mechanism (see its own comment) — so this intentionally
                  isn't the stable once-per-render component reference the
                  rule expects. */}
              {/* eslint-disable-next-line react-hooks/static-components */}
              <LazySettings
                onClose={() => setSettingsOpen(false)}
                initialSection={settingsSection}
                startInContent={settingsStartInContent}
                phone={isMobile}
                backStack={compact}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}
