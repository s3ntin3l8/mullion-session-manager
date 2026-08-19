import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewApi, DockviewReadyEvent } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Sidebar } from "./Sidebar.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import type { TerminalPaneParams } from "./TerminalPane.js";
import { repaintAllTerminals } from "./terminalRepaintRegistry.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Toolbar } from "./Toolbar.js";
import { PaneActionsMenu } from "./PaneActionsMenu.js";
import { MobileKeyBar } from "./MobileKeyBar.js";
import { PaneHeaderActions } from "./PaneHeaderActions.js";
import { CommandPalette } from "./CommandPalette.js";
import type { SettingsSection } from "./Settings.js";
import { Dock } from "./Dock.js";
import {
  GridIcon,
  RefreshIcon,
  ServerRackIcon,
  CloseIcon,
  WarningTriangleIcon,
} from "./ui/icons.js";
import { Spinner } from "./ui/Spinner.js";
import {
  useDashboardStore,
  LIVE_REFRESH_INTERVAL_MS,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from "./store/index.js";
import { useShallow } from "zustand/react/shallow";
import type { Session } from "./api/index.js";
import { getSchemeBackground } from "./terminalTheme.js";
import { initialPaneTitle } from "./paneTitle.js";
import { resolveAgentLogo } from "./cliLogos.js";
import { components, tabComponents, KanbanBoardOverlay } from "./panels/registry.js";
import {
  openSessionPanel,
  attentionTransitionPanelIds,
  newChildSessionIds,
  childPanelPosition,
  shouldAutoOpenChildPanels,
  panelSessionId,
} from "./panelUtils.js";
import { unreadEventSummary } from "./eventDescriptions.js";
import { useVisualViewportInset } from "./hooks/useVisualViewportInset.js";
import { useDragResize } from "./hooks/useDragResize.js";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence.js";
import { useSessionDeepLink } from "./hooks/useSessionDeepLink.js";
import { useMobileLayout } from "./hooks/useMobileLayout.js";
import { useDockviewDrop } from "./hooks/useDockviewDrop.js";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts.js";
import { useAppStreams } from "./hooks/useAppStreams.js";
import { useAttentionNotifications } from "./hooks/useAttentionNotifications.js";
import { usePanelOpener } from "./hooks/usePanelOpener.js";
import { usePolling } from "./hooks/usePolling.js";
import { ensurePushSubscribed } from "./pushClient.js";

// B2 — code-split Settings' ~2,700-line modal out of the initial bundle via
// React.lazy (the two browser/preview panes and the Kanban board get the
// same treatment, but live in panels/registry.tsx alongside the rest of the
// dockview panel registrations — see that module's own header comment).
// dockview and xterm+webgl stay eager — a terminal pane is what the app
// shows first, so splitting those would only move the cost, not remove it.
// Resolves `{ default }` because Settings.tsx uses a named export, not a
// default export.
const LazySettings = lazy(() => import("./Settings.js").then((m) => ({ default: m.Settings })));

// Settings-specific Suspense fallback — the modal shell (backdrop + a
// centered spinner in place of the panel body) so clicking the gear icon
// shows immediate feedback while the chunk loads, rather than nothing
// happening for a beat. Keeps the backdrop clickable (onClose), matching
// Settings.tsx's own click-outside-to-close behavior, so a slow chunk load
// doesn't strand the user unable to dismiss it.
function SettingsLoadingFallback({ onClose }: { onClose: () => void }) {
  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <Spinner variant="connecting" />
      </div>
    </div>
  );
}

const DEFAULT_WORKSPACE_NAME = "Default";
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
  const [isMobile, setIsMobile] = useState(false);
  // Mobile UI/UX overhaul, item B.2 — writes the keyboard's on-screen height
  // (0 when closed) directly onto `document.documentElement`'s own
  // `--kb-inset` custom property (no React state — see the hook's own
  // comment on why), which the mobile-only `.app { bottom: var(--kb-inset) }`
  // rule (styles.css) inherits to shrink the fixed-position shell above the
  // keyboard instead of letting it overlay the terminal's active line. A
  // no-op on desktop: the CSS that reads this variable is scoped to the
  // mobile breakpoint, same as every other mobile-only rule in that file.
  useVisualViewportInset();
  // Mobile UI/UX overhaul, item A.5 — the mobile pane bar's own inline
  // rename, mirroring PaneTab.tsx's renaming/draftName pair (the actual
  // rename UI can't move into the shared PaneActionsMenu — see that
  // component's own comment on why — so each host of the menu owns an
  // equivalent inline swap). Keyed by panel id (not a boolean) since the bar
  // renders every panel, not just the active one.
  const [mobileRenamingPanelId, setMobileRenamingPanelId] = useState<string | null>(null);
  const [mobileDraftName, setMobileDraftName] = useState("");
  const mobileRenameInputRef = useRef<HTMLInputElement>(null);
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
    lastSeenSeq,
    dismissedEventKeys,
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
  } = useDashboardStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      projects: s.projects,
      sessions: s.sessions,
      sessionsLoaded: s.sessionsLoaded,
      events: s.events,
      lastSeenSeq: s.lastSeenSeq,
      dismissedEventKeys: s.dismissedEventKeys,
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

  const onReady = useCallback((event: DockviewReadyEvent) => {
    setDockviewApi(event.api);
  }, []);

  // Issue #322: track which dockview panel is currently active so the
  // notification effect below can suppress desktop notifications for the
  // pane the user is currently looking at, even when the tab is visible.
  useEffect(() => {
    if (!dockviewApi) return;
    const setActivePanelId = useDashboardStore.getState().setActivePanelId;
    setActivePanelId(dockviewApi.activePanel?.id ?? null);
    const sub = dockviewApi.onDidActivePanelChange((e) => {
      useDashboardStore.getState().setActivePanelId(e.panel?.id ?? null);
    });
    return () => sub.dispose();
  }, [dockviewApi, panelsVersion]);

  // Load the workspace list exactly once on mount.
  useEffect(() => {
    void useDashboardStore
      .getState()
      .refreshWorkspaces()
      .then(() => setWorkspacesLoaded(true));
  }, []);

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
    void useDashboardStore
      .getState()
      .createWorkspace(DEFAULT_WORKSPACE_NAME)
      .then((workspace) => {
        useDashboardStore.getState().setActiveWorkspaceId(workspace.id);
      });
  }, [workspacesLoaded, workspaces.length]);

  // If activeWorkspaceId (persisted in localStorage) points at a workspace
  // that no longer exists — deleted, or a stale value from a previous
  // install — fall back to the first available one.
  useEffect(() => {
    if (workspaces.length === 0) return;
    const stillExists = workspaces.some((w) => w.id === activeWorkspaceId);
    if (!stillExists) useDashboardStore.getState().setActiveWorkspaceId(workspaces[0].id);
  }, [workspaces, activeWorkspaceId]);

  // Restores the active workspace's saved dockview layout on mount/
  // workspace-switch, and autosaves layout changes back as they happen —
  // extracted to useWorkspacePersistence (hooks/useWorkspacePersistence.ts).
  // Called here, at the EXACT position its two effects previously occupied
  // in this component's body, so their execution order relative to every
  // other effect in this file (in particular the auto-open-child-panel,
  // deep-link, and push-message effects further down, which read
  // restoringRef/restoredWorkspaceIdRef and depend on a restore having
  // already run) is unchanged — see that hook's own header comment.
  const { restoringRef, restoredWorkspaceIdRef } = useWorkspacePersistence({
    dockviewApi,
    activeWorkspaceId,
    workspaces,
    isMobile,
    setPanelsVersion,
  });

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

  // Keeps dockview's presentation in sync with the mobile breakpoint —
  // extracted to useMobileLayout (hooks/useMobileLayout.ts). Called here, at
  // the EXACT position its two effects previously occupied in this
  // component's body, so their execution order relative to every other
  // effect in this file — in particular, running AFTER the
  // useWorkspacePersistence restore effect above on the commit where
  // dockviewApi first becomes non-null — is unchanged. `isMobile` itself
  // stays owned by this component's own useState (rather than being
  // returned from the hook) specifically because it's read EARLIER in this
  // render body, at the useWorkspacePersistence call above — see that hook's
  // own `setIsMobile` param comment for why returning it here instead would
  // be a real ordering regression, not just a style difference.
  useMobileLayout({ dockviewApi, setIsMobile });

  // Focuses the mobile pane bar's inline rename input the moment it opens —
  // same "explicit transition, not a bare mount effect" shape as
  // TerminalPane.tsx's find-bar focus (see that file's own comment on why
  // that distinction matters).
  useEffect(() => {
    if (mobileRenamingPanelId) {
      mobileRenameInputRef.current?.focus();
      mobileRenameInputRef.current?.select();
    }
  }, [mobileRenamingPanelId]);

  // Code review finding on PR #613 — `isRenaming` (below, in the mobile bar's
  // render) is keyed only by `mobileRenamingPanelId`, independent of
  // `activePanelId`. Nothing normally moves `activePanelId` away from the
  // tab being renamed without also stealing DOM focus (which would already
  // fire the input's own onBlur commit) — except the auto-focus-on-attention
  // effect further down, which calls `panel.api.setActive()` programmatically
  // with no click/focus involved. Without this guard, that could leave a
  // stale rename input rendered on a now-background tab, still holding DOM
  // focus, while a *different* tab shows as active. Cancels rather than
  // commits: silently persisting a half-typed name off an external focus
  // steal would be a worse surprise than losing the in-progress edit. Direct
  // setState is genuinely needed here (canceling in response to an
  // externally-driven activePanelId change, not a pure render-time
  // derivation) — same shape as TerminalPane.tsx's own findQuery-clear
  // effect, which this repo's react-hooks/set-state-in-effect rule also
  // flags as a cascading-render risk without the disable.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileRenamingPanelId((current) =>
      current !== null && current !== activePanelId ? null : current,
    );
  }, [activePanelId]);

  // Sidebar session drag-to-dock — dragging a session row out of the Sidebar
  // and dropping it onto the dockview grid to open/dock its panel —
  // extracted to useDockviewDrop (hooks/useDockviewDrop.ts). Called here, at
  // the position its three effects previously occupied in this component's
  // body (right after the mobile pane bar's rename-cancel effect, right
  // before the global keyboard shortcuts effect below). Unlike
  // useWorkspacePersistence/useMobileLayout above, this position is NOT
  // load-bearing: none of the three extracted effects share state with any
  // other effect in this file, or with each other beyond the ref the hook
  // now owns internally — see that hook's own header comment.
  const { dockviewRef } = useDockviewDrop({ dockviewApi, setSidebarOpen });

  const openSettings = useCallback((section: SettingsSection = "appearance") => {
    setSettingsSection(section);
    setSettingsOpen(true);
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
  useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings });

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

  // Fetches the server-persisted Settings blob once on mount (store.ts seeds
  // sane defaults synchronously so nothing blocks on this) and starts
  // watching the OS color-scheme preference for as long as the user's Theme
  // setting is "System".
  useEffect(() => void useDashboardStore.getState().hydrateSettings(), []);
  useEffect(() => useDashboardStore.getState().startThemeWatch(), []);

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
    // restoringRef/restoredWorkspaceIdRef now come from
    // useWorkspacePersistence's return value rather than a bare useRef() in
    // this component, so eslint's exhaustive-deps rule can no longer
    // statically prove they're stable ref identities and flags them as
    // missing — listed here purely to satisfy the lint rule; both are
    // ordinary refs (mutated in place, never reassigned), so including them
    // has no effect on when this effect re-runs.
    restoringRef,
    restoredWorkspaceIdRef,
  ]);

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

  // The 12 `onOpen*` panel-opening callbacks (session/session-as-float/
  // timeline/GitHub/Git/Agent Rules/Dock Config/Skills/Browser/Tasks/
  // Browser-URL/Blank-Browser) used to be declared individually here and
  // further down (immediately before the split-launch handler) — extracted
  // to usePanelOpener (hooks/usePanelOpener.ts). Called here, at
  // onOpenSession's own former position, because that's a closure-order
  // requirement, not an effect-ordering one: this hook registers no effects
  // at all (every value it returns is a useCallback), so unlike
  // useWorkspacePersistence/useMobileLayout/useSessionDeepLink above, WHERE
  // in this component's body it's called doesn't affect behavior — but
  // onOpenSession itself must still be defined before useSessionDeepLink's
  // call and the onOpenSessionRef mirroring effect below, both of which
  // read it. See that hook's own header comment for the full design
  // rationale (why 6 of the 12 share one generic helper and 6 don't, and
  // why the actual count is 12 rather than the roadmap's estimated 16).
  const {
    onOpenSession,
    onOpenSessionAsFloat,
    onOpenTimeline,
    onOpenGitHub,
    onOpenGit,
    onOpenAgentRules,
    onOpenDockConfig,
    onOpenSkills,
    onOpenBrowser,
    onOpenTasks,
    onOpenBrowserUrl,
    onOpenBlankBrowser,
  } = usePanelOpener({
    dockviewApi,
    isMobile,
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
  useEffect(() => {
    sessionsRef.current = sessions;
    onOpenSessionRef.current = onOpenSession;
  }, [sessions, onOpenSession]);
  // A message that arrives before the app is actually ready to open a panel
  // would otherwise be silently dropped or raced (Hermes review): gating on
  // dockviewApi alone isn't enough — if sessions are still loading, the
  // pending id would be cleared without ever finding a match once they
  // arrive; if it lands mid workspace-restore, opening immediately would
  // get wiped right back out by the restore effect's own clear()+fromJSON().
  // Reuses the exact same three gates as the ?session= deep-link effect
  // above (workspaceRestored/sessionsLoaded/!restoringRef.current).
  //
  // Owns its own retry timer (pushRetryTimerRef) rather than riding on the
  // deep-link effect's deepLinkRetryTick, as an earlier version of this
  // comment claimed (Hermes review, sixth pass — a real bug, not just a
  // stale comment): deepLinkHandledRef flips true unconditionally the
  // first time the deep-link effect clears its gates, whether or not a
  // ?session= param was even present, and every later run of that effect
  // short-circuits before ever reaching the code that bumps
  // deepLinkRetryTick. That tick is therefore only alive during the
  // initial-mount race and permanently dead afterward — a push click
  // landing during a LATER workspace-switch restore had no retry source at
  // all. This effect's own timer re-arms itself directly (scheduled for
  // the next macrotask, by which point restoringRef.current has settled,
  // same reasoning as the deep-link effect's own timer) regardless of
  // anything the deep-link effect does or doesn't do.
  const pendingPushSessionIdRef = useRef<number | null>(null);
  const pushRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const tryOpenPendingSession = () => {
      const sessionId = pendingPushSessionIdRef.current;
      if (sessionId == null) return;
      const workspaceRestored =
        activeWorkspaceId !== null && restoredWorkspaceIdRef.current === activeWorkspaceId;
      if (!dockviewApi || !workspaceRestored || !sessionsLoaded) return;
      if (restoringRef.current) {
        if (pushRetryTimerRef.current == null) {
          pushRetryTimerRef.current = setTimeout(() => {
            pushRetryTimerRef.current = null;
            tryOpenPendingSession();
          }, 0);
        }
        return;
      }
      // Once every gate above passes, a session id that still isn't found
      // (killed/reaped between push delivery and click, or a stale click on
      // an id that never existed) is dropped here rather than kept pending
      // indefinitely — deliberately matching the ?session= deep-link
      // effect's own equivalent lookup, which has the same drop semantics
      // once its gates are satisfied (Hermes review, third pass).
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      pendingPushSessionIdRef.current = null;
      if (session && session.status !== "killed") onOpenSessionRef.current(session);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "mullion-open-session") return;
      pendingPushSessionIdRef.current = event.data.sessionId;
      tryOpenPendingSession();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    tryOpenPendingSession();
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      // Each effect incarnation owns its own timer — clearing here (both on
      // unmount and whenever a dependency change re-runs this effect) so a
      // stale timer never fires a tryOpenPendingSession closure built from
      // an outdated dockviewApi/activeWorkspaceId/sessionsLoaded.
      if (pushRetryTimerRef.current != null) {
        clearTimeout(pushRetryTimerRef.current);
        pushRetryTimerRef.current = null;
      }
    };
  }, [
    dockviewApi,
    activeWorkspaceId,
    sessionsLoaded,
    // See the auto-open-child-panel effect's own comment above on why
    // these two are listed here despite never changing identity.
    restoringRef,
    restoredWorkspaceIdRef,
  ]);

  // Issue #95 — re-syncs a push subscription on load (settings.notifications
  // .channels.push is the source of truth, not the presence of a live
  // browser subscription) so a subscription lost to a pushsubscriptionchange
  // the service worker missed, or to the browser clearing site data, gets
  // recreated without the user having to notice and re-toggle it. Gated on
  // settingsLoaded so this never fires against store.ts's synchronous
  // pre-hydration default (channels.push always false there).
  // ensurePushSubscribed itself never prompts for permission — see its own
  // doc comment.
  //
  // pushResyncAttemptedRef makes this run at most once per page load —
  // this effect's job is app-load recovery only, not the toggle path,
  // which stays Settings.tsx's alone. It does NOT by itself prevent a
  // concurrent duplicate run (Hermes review, sixth pass — an earlier
  // version of this comment overstated that): on a first-time toggle-on
  // (channels.push starts false, so this ref was never set), flipping the
  // switch in Settings still re-fires this effect at the same moment
  // Settings.tsx calls its own enablePush() — the ref only stops it from
  // firing a SECOND time after that. What actually makes the resulting
  // overlap harmless is pushClient.ts's module-level subscribeInFlight
  // guard, which both call sites route through regardless of which
  // component triggered them.
  const pushResyncAttemptedRef = useRef(false);
  useEffect(() => {
    if (pushResyncAttemptedRef.current) return;
    if (settingsLoaded && settings.notifications.channels.push) {
      pushResyncAttemptedRef.current = true;
      void ensurePushSubscribed();
    }
  }, [settingsLoaded, settings.notifications.channels.push]);

  // Post-workspace-switch highlight: after a workspace restore creates the
  // target panel, focus it so the highlight flash is visible. Guarded by
  // lastHandledHighlightRef (keyed on the panel id itself, not just a
  // boolean) so the fallback's own sessions/isMobile/projects dependencies
  // — needed to call openSessionPanel with fresh data — don't also make
  // this effect re-run setActive()/openSessionPanel on every 4s live-refresh
  // poll tick that happens to land inside the ~1200ms highlight window
  // (store.ts's HIGHLIGHT_DURATION_MS); a fresh, different highlight still
  // has a different id and proceeds normally.
  useEffect(() => {
    if (!dockviewApi) return;
    const id = useDashboardStore.getState().highlightedPanelId;
    if (!id) {
      lastHandledHighlightRef.current = null;
      return;
    }
    if (lastHandledHighlightRef.current === id) return;
    const panel = dockviewApi.getPanel(id);
    if (panel) {
      panel.api.setActive();
      lastHandledHighlightRef.current = id;
      return;
    }
    // onOpenSession's cross-workspace branch only guarantees SOME panel
    // referencing this session existed in the target workspace's saved
    // layout — findSessionWorkspace matches any panel type
    // (panelUtils.ts's extractSessionIds also walks timeline/browserPane's
    // own `sessionIds`), not necessarily this session's own terminal panel.
    // If the restore just completed and the terminal panel still isn't
    // there (e.g. the session was only ever referenced via a timeline
    // panel in that workspace), open it explicitly rather than leaving the
    // user on a workspace that switched but shows nothing for the session
    // they asked for. Safe to call even if a panel materializes moments
    // later from an unrelated cause: openSessionPanel focuses an existing
    // panel instead of duplicating it.
    const match = id.match(/^session-(\d+)$/);
    if (!match) return;
    const sessionId = Number(match[1]);
    const session = sessions.find((s) => s.id === sessionId);
    // Deliberately NOT marked handled when the session isn't found yet —
    // lets a later `sessions` update retry instead of giving up for the
    // rest of this highlight's window.
    if (session) {
      openSessionPanel(dockviewApi, session, isMobile, projects);
      lastHandledHighlightRef.current = id;
    }
  }, [activeWorkspaceId, dockviewApi, sessions, isMobile, projects]);

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
      useDashboardStore.getState().clearSplitRequest();
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
    [dockviewApi, splitRequest, onOpenSession, projects],
  );

  // One toggle, two meanings depending on breakpoint: mobile's `sidebarOpen`
  // is a closed-by-default overlay flag (App.tsx-local, not persisted —
  // resets to closed every navigation, which is the right default for an
  // overlay); desktop's `sidebarCollapsed` is a persisted, open-by-default
  // panel-visibility preference (store-owned, survives reload). Same button,
  // same handler, branch on the existing `isMobile` state.
  const toggleSidebar = useCallback(() => {
    if (isMobile) setSidebarOpen((v) => !v);
    else useDashboardStore.getState().setSidebarCollapsed(!sidebarCollapsed);
  }, [isMobile, sidebarCollapsed]);

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
    () => dockviewApi?.panels.filter((p) => p.api.location.type === "grid").length ?? 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-derives off panelsVersion, not a real dependency
    [dockviewApi, panelsVersion],
  );
  // Filtered to tiled panels only, same as tiledPaneCount above and for the
  // same reason (independent code review): a leftover floating panel would
  // otherwise get a tab in the mobile bar, and tapping it calls
  // dockviewApi.maximizeGroup(panel) below — maximizeGroup on a floating
  // panel throws (see applyMobilePresentation's own comment in
  // panelUtils.ts), so that tap would crash inside this click handler.
  const mobilePanels = useMemo(
    () => dockviewApi?.panels.filter((p) => p.api.location.type === "grid") ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-derives off panelsVersion, not a real dependency
    [dockviewApi, panelsVersion],
  );
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
  const activeTerminalSession =
    activePanelId && viewMode !== "kanban"
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

  return (
    <div
      className={`app cmux-root${theme === "light" ? " light" : ""}${sidebarOpen ? " sb-open" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}${sidebarResizing ? " sidebar-resizing" : ""}${settings.sidebarDensity === "compact" ? " density-compact" : ""}${isMobile && activeTerminalSession ? " key-bar" : ""}`}
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
            {/* Mobile UI/UX overhaul, item A — the single mobile pane
                switcher (dockview's own tab strip is now hidden here, via
                applyMobilePresentation's header.hidden sync in
                panelUtils.ts, so the two no longer double up). The active
                pane also gets a close (×) + kebab (PaneActionsMenu) here,
                since dockview's per-tab actions are unreachable with its
                header hidden — same actions the desktop tab strip offers
                (close/rename/kill/promote/timeline/Agent Browser), just
                surfaced through this bar instead. The toolbar's own sidebar
                toggle (Toolbar.tsx) is the only one left at this breakpoint
                — the second, redundant ☰ that used to render here is gone. */}
            {isMobile && mobilePanels.length > 0 && (
              <div className="mobile-tabs">
                {mobilePanels.map((panel) => {
                  const sessionId = panelSessionId(panel);
                  const session = sessions.find((s) => s.id === sessionId);
                  const isActive = panel.id === activePanelId;
                  const isRenaming = mobileRenamingPanelId === panel.id;
                  let dotColor = "var(--dim)";
                  if (session?.attention) dotColor = "var(--ring)";
                  else if (session?.activity === "working") dotColor = "var(--g)";
                  const agentLogo = session ? resolveAgentLogo(session.command, theme) : null;
                  // Same unread derivation as PaneTab.tsx's own tab badge —
                  // shared via eventDescriptions.ts's unreadEventSummary
                  // (Hermes review, PR #613) rather than a third copy.
                  const unreadCount =
                    sessionId === undefined
                      ? 0
                      : unreadEventSummary(
                          sessionId,
                          events[sessionId],
                          lastSeenSeq[sessionId] ?? 0,
                          dismissedEventKeys,
                        ).count;
                  const commitMobileRename = () => {
                    const value = mobileDraftName.trim();
                    setMobileRenamingPanelId(null);
                    if (!value || sessionId === undefined) return;
                    panel.api.setTitle(value);
                    void useDashboardStore.getState().renameSession(sessionId, value);
                  };
                  return (
                    <div key={panel.id} className="mobile-tab-wrap">
                      {isRenaming ? (
                        <input
                          ref={mobileRenameInputRef}
                          className="mobile-tab-rename-input"
                          value={mobileDraftName}
                          onChange={(e) => setMobileDraftName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitMobileRename();
                            else if (e.key === "Escape") setMobileRenamingPanelId(null);
                          }}
                          onBlur={commitMobileRename}
                        />
                      ) : (
                        <button
                          className={`mobile-tab${isActive ? " active" : ""}`}
                          onClick={() => {
                            panel.api.setActive();
                            dockviewApi?.maximizeGroup(panel);
                          }}
                        >
                          <span className="mobile-tab-dot" style={{ background: dotColor }} />
                          {agentLogo && (
                            <img
                              src={agentLogo}
                              alt=""
                              width={14}
                              height={14}
                              className="mobile-tab-agent-logo"
                            />
                          )}
                          <span className="mobile-tab-title">{panel.title}</span>
                          {unreadCount > 0 && (
                            <span className="mobile-tab-unread-badge">{unreadCount}</span>
                          )}
                        </button>
                      )}
                      {isActive && !isRenaming && dockviewApi && (
                        <>
                          <button
                            className="mobile-tab-btn"
                            title="Close pane — detaches your view, session keeps running"
                            aria-label="Close pane"
                            onClick={() => panel.api.close()}
                          >
                            <CloseIcon size={13} />
                          </button>
                          <PaneActionsMenu
                            api={panel.api}
                            params={panel.params as TerminalPaneParams | undefined}
                            containerApi={dockviewApi}
                            onRename={() => {
                              setMobileDraftName(panel.title ?? "");
                              setMobileRenamingPanelId(panel.id);
                            }}
                            triggerClassName="mobile-tab-btn"
                          />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
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
                // Independent code review + Hermes, PR #723 — see
                // xterm.css's own `@media (pointer: coarse)` block for the
                // full root-cause writeup (dockview's default 'custom' mode
                // wraps the strip in `.dv-scrollable`, whose `overflow:
                // hidden` blocked touch panning). Scoped to coarse pointers
                // only — Hermes review: unscoped, this also swaps desktop's
                // subtle on-hover custom overlay thumb for an always-visible
                // native scrollbar, a needless mouse-facing side effect for
                // a touch-only fix.
                scrollbars={window.matchMedia("(pointer: coarse)").matches ? "native" : "custom"}
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
                  "kanban", so leaving Tasks via Toolbar.tsx's own "Back to
                  workspace" button restores exactly what was there before.
                  Tasks is a top-level destination, not a workspace view mode
                  — entering it now only happens from Sidebar.tsx's own
                  entry or the command palette, not a toggle that implied it
                  was a peer of the tiled workspace grid. Unlike the empty
                  grid dropzone (still desktop-only), this renders on mobile
                  too — UnifiedBoard.tsx/styles.css carry their own mobile
                  layout (stacked columns, a full-bleed detail sheet), since
                  removing the "tasks" dockview panel means mobile has no
                  other way to reach the task board (the Toolbar's own "Back"
                  button renders on mobile too — see mobile.css's
                  .toolbar-back-to-workspace override). */}
              {viewMode === "kanban" && (
                <KanbanBoardOverlay onOpenSession={onOpenSession} onSessionEnded={onSessionEnded} />
              )}
            </div>
            <Dock
              workspaceProjectIds={workspaceProjectIds}
              onOpenGitHub={onOpenGitHub}
              onOpenBrowser={onOpenBrowser}
            />
            {/* Mobile UI/UX overhaul, item C.2 — last child of
                .grid-area-body (a flex column), so it sits at the bottom of
                the already-`bottom: var(--kb-inset)`-shrunk .app shell —
                i.e. directly above the keyboard — with no position:fixed or
                separate inset tracking of its own needed. */}
            {isMobile && activeTerminalSession && (
              <MobileKeyBar sessionId={activeTerminalSession.id} />
            )}
          </div>
        </div>
      </div>
      {paletteOpen && (
        <CommandPalette
          scope={paletteScope}
          projectId={paletteProjectId}
          onClose={() => {
            setPalette((p) => ({ ...p, open: false }));
            useDashboardStore.getState().clearSplitRequest();
          }}
          onLaunched={handleLaunched}
          onOpenSession={onOpenSession}
          onOpenTasks={onOpenTasks}
          onOpenGitHub={onOpenGitHub}
          onOpenGit={onOpenGit}
          onOpenAgentRules={onOpenAgentRules}
          onOpenDockConfig={onOpenDockConfig}
          onOpenSkills={onOpenSkills}
          onOpenBrowser={onOpenBrowser}
          onOpenIntegrationsSettings={() => openSettings("integrations")}
          onOpenBlankBrowser={onOpenBlankBrowser}
          onOpenBrowserUrl={onOpenBrowserUrl}
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
          <ErrorBoundary onReset={() => setSettingsOpen(false)}>
            <Suspense fallback={<SettingsLoadingFallback onClose={() => setSettingsOpen(false)} />}>
              <LazySettings
                onClose={() => setSettingsOpen(false)}
                initialSection={settingsSection}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}
