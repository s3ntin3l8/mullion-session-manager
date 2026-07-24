import { create } from "zustand";
import { api, DEFAULT_SETTINGS } from "./api.js";
import type {
  AppSettings,
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  Group,
  Host,
  NotificationEvent,
  Project,
  ProjectUrl,
  Session,
  SettingsPatch,
  Theme as ThemePreference,
  UpdateCheckResult,
  Workspace,
} from "./api.js";
import type { ReorderUpdate } from "./reorder.js";
import { deepMerge, mergePartialPatch } from "./settingsMerge.js";
import { connectEventsStream, type EventsClientHandle } from "./eventsClient.js";
import type { KanbanColumnId } from "./kanban.js";

// Which workspace was last active survives a reload via localStorage (not
// the DB — it's a per-browser UI preference, not shared server state).
const ACTIVE_WORKSPACE_STORAGE_KEY = "crs.activeWorkspaceId";
// How often the live-refresh loop re-fetches sessions so status badges
// (activity/attention/exited) reflect the backend without waiting on a
// mutation. Paused while the tab is hidden (visibilitychange) — no point
// polling a backgrounded tab, and it keeps a laptop-in-a-drawer session from
// hammering the API forever.
export const LIVE_REFRESH_INTERVAL_MS = 4000;
// Bound on each session's own accumulated event list in the store (issue
// #166) — generous headroom above the backend's own ~100-per-session ring
// buffer cap (pty-manager.ts's EVENTS_MAX) since this also has to hold
// whatever a single replay batch delivers on (re)connect.
const EVENTS_PER_SESSION_CAP = 200;
// Consecutive failed session-fetches (from any caller — the live poll,
// Sidebar's own mount fetch, etc.) before the design's "whole backend down"
// banner shows. >1 so a single transient blip doesn't flash it; in
// practice only the frequent live-refresh poll realistically accumulates
// this fast, since one-shot callers would need to independently fail twice
// in a row for the same thing to happen from them alone.
const BACKEND_UNREACHABLE_THRESHOLD = 2;
// Module-scoped (not component state) — refreshSessions() is called from
// many places (the live poll, Sidebar's mount effect, onSessionEnded
// flows), and all of them should share one counter/recovery signal rather
// than each tracking its own.
let consecutiveSessionFetchFailures = 0;
// Dedups overlapping refreshGitStatuses() calls — mirrors git-status.ts's own
// `inFlight` map on the backend. Without this, a tick whose fetches take
// longer than LIVE_REFRESH_INTERVAL_MS (many projects, a slow/unreachable
// remote host) could still be running when the next tick's call starts; the
// later call's `previous` snapshot (captured at ITS OWN start) would then be
// stale relative to whatever the earlier call's `set()` just wrote, and its
// own final `set()` — a wholesale map replacement — could stomp over that
// fresher write with a merge based on the stale snapshot (Hermes review, PR
// #164). Sharing one in-flight promise across overlapping callers, instead
// of each starting its own fetch batch, removes the race entirely rather
// than just narrowing it.
let gitStatusesRefreshInFlight: Promise<void> | null = null;
// Same dedup shape as gitStatusesRefreshInFlight above, for the diff-stats
// batch (issue #202) — a distinct endpoint/cache, so it needs its own guard
// rather than sharing that one.
let gitDiffStatsRefreshInFlight: Promise<void> | null = null;
// Same dedup shape again, for the slower-cadence branches/worktrees + PR
// list refresh (issue #202) — see refreshGitRefs's own doc comment for why
// this runs on a different cadence than the two above.
let gitRefsRefreshInFlight: Promise<void> | null = null;
// Desktop-only persistent collapse (distinct from the mobile-only
// `sidebarOpen` overlay flag App.tsx owns locally — different semantics per
// breakpoint: mobile is a closed-by-default overlay, desktop is an
// open-by-default panel the user can choose to hide).
const SIDEBAR_COLLAPSED_KEY = "crs.sidebarCollapsed";
// Persisted sidebar width (drag-to-resize, same pattern as dock height).
const SIDEBAR_WIDTH_KEY = "crs.sidebarWidth";
export const SIDEBAR_MIN_WIDTH = 288;
export const SIDEBAR_MAX_WIDTH = 500;
function readStoredSidebarWidth(): number {
  const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const parsed = raw ? Number(raw) : NaN;
  if (isNaN(parsed)) return SIDEBAR_MIN_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, parsed));
}
// A thin first-paint mirror of the *resolved* theme only — settings.theme
// itself (dark/light/system) is server-persisted (see hydrateSettings
// below), but waiting on that fetch before the very first render would
// flash the wrong theme. This one key is written every time the resolved
// theme changes and read once, synchronously, at module load.
const THEME_HINT_KEY = "crs.themeHint";
const DISMISSED_UPDATE_KEY = "crs.dismissedUpdateVersion";
// Issue #211's list/Kanban view switcher — a client-only UI preference, same
// localStorage-not-server-settings treatment as sidebarCollapsed/sidebarWidth
// above (there's no backend field for this, and this is a frontend-only PR).
const VIEW_MODE_KEY = "crs.viewMode";

function readStoredActiveWorkspaceId(): number | null {
  const raw = localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

// "list" is today's per-project sidebar tree (Sidebar.tsx); "kanban" is
// issue #211's Running/Needs Attention/Exited board (KanbanBoard.tsx),
// rendered as an overlay over the dockview grid area (App.tsx) — see that
// file's own comment for why it lives there rather than inside the sidebar
// (a global, cross-project board needs more width than the sidebar's
// SIDEBAR_MAX_WIDTH affords).
export type ViewMode = "list" | "kanban";

function readStoredViewMode(): ViewMode {
  return localStorage.getItem(VIEW_MODE_KEY) === "kanban" ? "kanban" : "list";
}

// The *resolved* theme — what's actually painted (dockview class, root
// `.light` class, xterm palette). Distinct from `AppSettings["theme"]`
// (imported above as `ThemePreference`), which additionally allows
// `"system"` — this is always one of the two concrete values that
// preference resolves to. Exported under the pre-existing name so
// cliLogos.ts's `import type { Theme } from "./store.js"` (and any other
// consumer expecting only "dark" | "light") keeps working unchanged.
export type Theme = "dark" | "light";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

function resolveTheme(pref: ThemePreference): Theme {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

function readThemeHint(): Theme {
  return localStorage.getItem(THEME_HINT_KEY) === "light" ? "light" : "dark";
}

// Back-compat alias other files already import from store.ts.
export interface TerminalPrefs {
  fontSize: number;
  cursorStyle: AppSettings["terminal"]["cursorStyle"];
  scrollback: number;
}

function deriveTerminalPrefs(settings: AppSettings): TerminalPrefs {
  return {
    fontSize: settings.terminal.fontSize,
    cursorStyle: settings.terminal.cursorStyle,
    scrollback: settings.terminal.scrollback,
  };
}

// A pane's split-right/split-down action (PaneHeaderActions.tsx, a dockview
// `rightHeaderActionsComponent`) can't receive custom props from App.tsx —
// dockview owns that component's render — so it signals intent through the
// store instead (same reason PaneTab.tsx already reads/writes the store
// directly). App.tsx reacts to a new `splitRequest` by opening the command
// palette scoped to the reference panel's project; the palette's own launch
// handler reads it back to decide whether to add the new panel via a normal
// open-or-focus or as a real split (`position: {referencePanel, direction}`).
// Cleared on launch or on palette close, whichever comes first.
export interface SplitRequest {
  referencePanelId: string;
  direction: "right" | "below";
}

// The composite key `dismissedEventKeys` (below) and PaneTab.tsx's own
// dismissed-filter are keyed on — `seq` alone isn't unique across sessions
// (it's a per-session monotonic counter, see api.ts's NotificationEvent
// doc comment), so any per-event state keyed just by seq would collide
// across sessions. Exported so PaneTab.tsx's badge filter and
// NotificationBell.tsx's feed use the exact same key shape as
// dismissEvent() writes.
export function eventKey(sessionId: number, seq: number): string {
  return `${sessionId}:${seq}`;
}

interface DashboardState {
  projects: Project[];
  sessions: Session[];
  // Per-project saved URLs (issue #109), keyed by project id.
  projectUrls: Record<number, ProjectUrl[]>;
  // Per-project git status (issue #76), keyed by project id — powers the
  // GitPanel's own live re-poll plus the sidebar dirty badge and pane-tab
  // branch label's dirty ("*") marker. `null` means "fetched, not
  // applicable" (not a repo, or an unreachable remote host); a missing key
  // means "not fetched yet" (e.g. right after a project is created, before
  // the next tick). Absent entirely from the "whole backend down" failure
  // counter (refreshSessions' own consecutiveSessionFetchFailures) — a
  // single project's git status being unavailable is routine, not a signal
  // the backend itself is down.
  gitStatuses: Record<number, GitStatus | null>;
  // Per-session git status (issue #202) — same semantics as gitStatuses
  // above, keyed by session id instead of project id. Most sessions share
  // their project's own cwd (and therefore its status); a session running
  // in a distinct worktree gets its own entry here, computed against its
  // own effective cwd server-side (routes/projects.ts's
  // resolveSessionCwdTargets). Powers SessionRow's row 3.
  sessionGitStatuses: Record<number, GitStatus | null>;
  // Per-session diff stats (issue #202, greenfield) — files-changed +
  // insertions/deletions against HEAD for a session's own effective cwd.
  // Same "missing key = not fetched yet, null = fetched but nothing to
  // show" convention as gitStatuses/sessionGitStatuses above.
  gitDiffStats: Record<number, GitDiffStats | null>;
  // Branches + worktrees per project (issue #162/#202), keyed by project
  // id — fetched on the slower refreshGitRefs cadence (see that action's
  // own doc comment), not the 4s git-status tick, since a worktree/branch
  // list changes far less often than working-tree status (git-refs.ts's
  // own on-demand-fetch comment). Powers SessionRow's worktree label:
  // matching a session's effective cwd against this project's own
  // `worktrees` array. `undefined` means "not fetched yet, or genuinely not
  // a git repo" — this feature only ever treats both as "nothing to show,"
  // so unlike gitStatuses there's no need for a separate `null` state here.
  gitBranchesByProject: Record<number, GitBranchesResult | undefined>;
  // Per-project open-PR list (issue #102/#202), same refreshGitRefs cadence
  // as gitBranchesByProject above. SessionRow matches a session's own
  // branch (from its GitStatus) against this array's `headBranch` fields
  // client-side, rather than firing one filtered `?branch=` request per
  // session (see api.ts's getProjectGitHubPRs doc comment).
  prsByProject: Record<number, GitHubPRsStatus | undefined>;
  // Phase 1's notification event model (issue #166) — accumulated events
  // from the /ws/events push channel (eventsClient.ts), keyed by sessionId
  // and bounded per session (EVENTS_PER_SESSION_CAP). Deduped by `seq` so a
  // reconnect's replay batch (which can re-deliver events this store
  // already has — see startEventsStream) never double-counts. Fed
  // independently of, and in addition to, the existing 4s poll — see
  // startLiveRefresh, which stays exactly as-is.
  events: Record<number, NotificationEvent[]>;
  // Client-side half of the 1.1 read cursor (issue #166's `lastSeenSeq`,
  // server-side in pty-manager.ts) — PR1 wired the WS "seen" send
  // (markEventSeen below) but never tracked what was actually marked seen on
  // this side, so nothing could compute unread counts. Keyed by sessionId;
  // a missing key means "nothing seen yet" (unread = every buffered event).
  // Advanced only via markEventSeen, never decremented — mirrors the
  // server's own monotonic-only `lastSeenSeq`. Not persisted (localStorage
  // or otherwise): a reload legitimately re-shows the badge for events the
  // user technically already saw last session — the same tradeoff the old
  // localStorage-backed acknowledgedAttention overlay (removed for #169;
  // see NotificationBell.tsx's history) used to accept. A real fix needs
  // the server to expose its cursor on connect/replay, which PR1 didn't
  // build — out of scope here.
  lastSeenSeq: Record<number, number>;
  // Issue #169's other half of per-event state: an explicit "dismiss" —
  // remove from the notification panel's feed, never resurface — which is
  // deliberately NOT the same operation as "read". `lastSeenSeq` above
  // answers "has the user seen this" (monotonic, coexists with the tab
  // badge); this answers "should this even still be listed" and can flag an
  // individual event anywhere in a session's history, in any order, without
  // touching the read cursor. Keyed by `eventKey(sessionId, seq)` (below)
  // since `seq` alone isn't unique across sessions. In-memory only, same as
  // `events`/`lastSeenSeq` — a reload re-shows a dismissed event, which is
  // an acceptable degrade given the underlying event itself isn't persisted
  // past the backend's own ring buffer + replay-on-connect window either.
  dismissedEventKeys: Record<string, true>;
  workspaces: Workspace[];
  groups: Group[];
  // Registered hosts (issue #26) — includes the always-present "local" row.
  // Fetched independently of projects/sessions since it's needed wherever a
  // host picker renders (CreateProjectModal, Sidebar's discovery flow),
  // not just Settings -> Hosts.
  hosts: Host[];
  // The full server-persisted preferences blob (Settings modal's "Everything
  // wired now" rework — see .claude/plans/i-want-to-rework-delegated-bonbon.md).
  // Seeded with DEFAULT_SETTINGS synchronously at store creation so every
  // consumer has a sane value immediately; hydrateSettings() overwrites it
  // with the server's copy once GET /api/settings resolves.
  settings: AppSettings;
  settingsLoaded: boolean;
  // Derived read-only slices of `settings`, kept as real state fields (not
  // getters) so existing `useDashboardStore((s) => s.theme)`-style reactive
  // selectors across the app keep working unchanged.
  theme: Theme;
  terminalPrefs: TerminalPrefs;
  hideEndedSessions: boolean;
  notificationsEnabled: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  // Issue #211 — see ViewMode's own doc comment above.
  viewMode: ViewMode;
  // Local-only presentation order for Kanban cards within a column (issue
  // #211) — there's no backend field for card order in Phase 1 (a session
  // has no `position` column, unlike workspaces/groups), so this is kept as
  // in-memory UI state only, not persisted to localStorage or the server: a
  // reload legitimately re-shows a column's sessions in their natural order,
  // the same tradeoff `lastSeenSeq`/`dismissedEventKeys` above already
  // accept for other in-memory-only state. Keyed by KanbanBoard's column id
  // ("working" | "attention" | "idle" | "exited"), each value an ordered array of
  // session ids — sessions not yet present in the array (new arrivals) are
  // appended at the end by KanbanBoard's own ordering helper, not stored
  // here until the user actually drags them.
  kanbanOrder: Partial<Record<KanbanColumnId, number[]>>;
  // Design's "whole backend down" state (States doc section 04) — flips
  // false after BACKEND_UNREACHABLE_THRESHOLD consecutive session-fetch
  // failures, true again the moment one succeeds. See
  // consecutiveSessionFetchFailures above for why this lives outside any
  // one specific call site.
  backendReachable: boolean;
  currentVersion: string | null;
  updateCheck: UpdateCheckResult | null;
  dismissedUpdateVersion: string | null;
  checkForUpdates: () => Promise<void>;
  dismissUpdate: () => void;
  splitRequest: SplitRequest | null;
  // Issue #170: a desktop notification's click handler (App.tsx) can't reach
  // into NotificationBell.tsx's own component-local `open`/position state
  // directly — same reason `splitRequest` above exists rather than a prop
  // (PaneHeaderActions.tsx can't receive one either; dockview owns that
  // component's render). Bumped (not a boolean) so requesting "open" while
  // it's already open still re-triggers NotificationBell.tsx's effect — a
  // plain boolean toggled true->true wouldn't change.
  notificationsPanelOpenRequest: number;
  // May reference a workspace that no longer exists (deleted in another
  // tab, or a stale localStorage value) — App.tsx is responsible for
  // falling back to first-available/create-default when that happens.
  activeWorkspaceId: number | null;
  refreshProjects: () => Promise<void>;
  refreshGitStatuses: () => Promise<void>;
  // Issue #202's other two git-refresh actions — see their own
  // implementations below for the cadence each runs on.
  refreshGitDiffStats: () => Promise<void>;
  refreshGitRefs: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  refreshGroups: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  createProject: (name: string, cwd: string, hostId?: string) => Promise<Project>;
  updateProject: (
    id: number,
    patch: Partial<Pick<Project, "name" | "cwd" | "devServerUrl">>,
  ) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
  refreshProjectUrls: (projectId: number) => Promise<void>;
  addProjectUrl: (
    projectId: number,
    label: string,
    url: string,
    favorite?: boolean,
  ) => Promise<ProjectUrl>;
  updateProjectUrl: (
    projectId: number,
    urlId: number,
    patch: Partial<Pick<ProjectUrl, "label" | "url" | "favorite">>,
  ) => Promise<void>;
  deleteProjectUrl: (projectId: number, urlId: number) => Promise<void>;
  createHost: (name: string, baseUrl: string, token: string) => Promise<Host>;
  updateHost: (
    id: string,
    patch: Partial<{ name: string; baseUrl: string; token: string }>,
  ) => Promise<void>;
  // Rejects with the same conflict Error api.deleteHost throws (still-owns-
  // projects) unless `cascade` is passed — the caller (Settings -> Hosts) is
  // responsible for catching that and offering the cascade retry, matching
  // the design of the underlying DELETE /api/hosts/:id endpoint.
  deleteHost: (id: string, opts?: { cascade?: boolean }) => Promise<void>;
  pingHost: (id: string) => Promise<boolean>;
  createSession: (
    projectId: number,
    command: string,
    opts?: {
      name?: string;
      cwd?: string;
      kind?: "terminal" | "dock";
      worktree?: { baseRef: string; branchName?: string };
    },
  ) => Promise<Session>;
  renameSession: (id: number, name: string) => Promise<void>;
  deleteSession: (id: number) => Promise<void>;
  promoteSession: (
    id: number,
    opts: { baseRef: string; branchName?: string; seedPrompt?: string },
  ) => Promise<Session>;
  declinePromote: (id: number, reason?: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace>;
  renameWorkspace: (id: number, name: string) => Promise<void>;
  deleteWorkspace: (id: number) => Promise<void>;
  setWorkspaceGroup: (id: number, groupId: number | null, position?: number) => Promise<void>;
  // Batched drag-and-drop commit (Phase 4d) — one PATCH per row that
  // actually changed (see reorder.ts's computeReorder), applied
  // optimistically to local state before the PATCHes resolve so a dropped
  // row doesn't visually snap back to its pre-drop order for the
  // round-trip duration, then a single refresh once every PATCH settles.
  // Deliberately NOT implemented by looping setWorkspaceGroup — that would
  // refetch once per row instead of once total.
  reorderWorkspaces: (updates: ReorderUpdate[]) => Promise<void>;
  // Fire-and-forget from App.tsx's debounced autosave — saves the layout
  // and patches the local workspaces array with the server's response so
  // the restore effect (App.tsx:281) reads fresh data on workspace switch.
  // Does NOT trigger a full workspaces refresh (called frequently).
  saveWorkspaceLayout: (id: number, layout: Record<string, unknown>) => Promise<void>;
  setActiveWorkspaceId: (id: number | null) => void;
  createGroup: (name: string, color?: string) => Promise<Group>;
  updateGroup: (
    id: number,
    patch: Partial<Pick<Group, "name" | "icon" | "color" | "collapsed" | "position">>,
  ) => Promise<void>;
  deleteGroup: (id: number) => Promise<void>;
  // Fetches GET /api/settings once (App.tsx's mount effect, alongside
  // startLiveRefresh) and merges it into `settings` + the derived fields
  // above. Safe to call more than once — always just re-syncs from the
  // server's current copy.
  hydrateSettings: () => Promise<void>;
  // The one write path for every preference: deep-merges `patch` into local
  // `settings` optimistically (so the UI reflects it immediately), then
  // fires a debounced PATCH /api/settings so a slider/number-field drag
  // sends one request instead of one per tick. toggleTheme/setTerminalPrefs/
  // etc. below are thin wrappers over this for call sites that predate the
  // unified settings object.
  updateSettings: (patch: SettingsPatch) => void;
  // Cycles dark<->light (never lands on "system") — the Toolbar/legacy quick
  // toggle. The Settings modal's Theme segmented control (Dark/Light/System)
  // calls updateSettings({ theme: ... }) directly instead.
  toggleTheme: () => void;
  setTerminalPrefs: (patch: Partial<TerminalPrefs>) => void;
  setHideEndedSessions: (value: boolean) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setSidebarWidth: (value: number) => void;
  setViewMode: (value: ViewMode) => void;
  // Replaces one column's whole order array (KanbanBoard.tsx computes the
  // new array via its own computeKanbanReorder, reusing reorder.ts's
  // computeReorder for the actual reindex math) — mirrors setSidebarWidth's
  // "component computes, store just stores" shape above.
  setKanbanColumnOrder: (columnId: KanbanColumnId, order: number[]) => void;
  requestSplit: (referencePanelId: string, direction: "right" | "below") => void;
  clearSplitRequest: () => void;
  // Issue #170's counterpart to `notificationsPanelOpenRequest` above — a
  // desktop notification's onclick handler calls this instead of setting
  // NotificationBell.tsx's local state directly.
  openNotificationsPanel: () => void;
  // Starts the ~4s session-status poll (paused while the tab is hidden) and
  // returns a cleanup function — called once from App.tsx's mount effect.
  // Kept as a store action (rather than plain App.tsx setInterval) so any
  // consumer of `sessions` gets the same live-refresh guarantee.
  startLiveRefresh: () => () => void;
  // Connects the single /ws/events channel once (App.tsx's mount effect,
  // alongside startLiveRefresh/startThemeWatch) and returns a cleanup
  // function. Not per-pane — one connection covers every session.
  startEventsStream: () => () => void;
  // Advances a session's read cursor — both the local `lastSeenSeq` (so
  // unread counts recompute immediately, even while the events channel is
  // momentarily disconnected) and the server's own cursor via the "seen" WS
  // message (a no-op while disconnected — see eventsClient.ts's sendSeen doc
  // comment). The shared primitive 1.3's tab badges (PaneTab.tsx) and 1.4's
  // event feed both consume; only ever advances (a smaller `seq` than what's
  // already recorded is ignored), mirroring the server's own monotonic
  // `lastSeenSeq`.
  markEventSeen: (sessionId: number, seq: number) => void;
  // Issue #169's "dismiss" action — flags one event as permanently removed
  // from the notification feed (see `dismissedEventKeys` above for why this
  // is deliberately separate from markEventSeen/lastSeenSeq). Idempotent;
  // dismissing an already-dismissed (sessionId, seq) is a no-op re-set.
  dismissEvent: (sessionId: number, seq: number) => void;
  // Re-resolves `theme` whenever the OS-level color-scheme preference
  // changes, but only while settings.theme === "system" — a no-op the rest
  // of the time. Returns a cleanup function; called once from App.tsx
  // alongside startLiveRefresh.
  startThemeWatch: () => () => void;
}

// How long to wait after the last updateSettings() call before firing the
// PATCH — long enough that a slider/number-field drag collapses into one
// request, short enough that a toggle click still feels instant on the
// network (well under the live-refresh poll interval).
const SETTINGS_PATCH_DEBOUNCE_MS = 400;

export const useDashboardStore = create<DashboardState>((set, get) => {
  // Closure-scoped (not React/store state) — accumulates across rapid
  // updateSettings() calls between debounce windows, same pattern
  // startLiveRefresh()'s own timer/cleanup closures already use below.
  let pendingPatch: SettingsPatch | null = null;
  let patchTimer: ReturnType<typeof setTimeout> | null = null;
  // Set once startEventsStream() connects (App.tsx's mount effect) — the
  // handle markEventSeen() below sends "seen" messages through. Stays null
  // until then (and after cleanup), matching eventsClient.ts's own
  // "no-op while disconnected" semantics rather than throwing.
  let eventsClientHandle: EventsClientHandle | null = null;

  // Merges one incoming NotificationEvent into the per-session accumulated
  // list, deduped by seq (a reconnect's replay batch can re-deliver an
  // event this store already holds — see startEventsStream) and capped at
  // EVENTS_PER_SESSION_CAP, oldest evicted first.
  function addEvent(
    events: Record<number, NotificationEvent[]>,
    event: NotificationEvent,
  ): Record<number, NotificationEvent[]> {
    const existing = events[event.sessionId] ?? [];
    if (existing.some((e) => e.seq === event.seq)) return events;
    const next = [...existing, event].sort((a, b) => a.seq - b.seq).slice(-EVENTS_PER_SESSION_CAP);
    return { ...events, [event.sessionId]: next };
  }

  function flushPendingPatch() {
    if (!pendingPatch) return;
    const patch = pendingPatch;
    pendingPatch = null;
    patchTimer = null;
    // Fire-and-forget: the optimistic local state is already correct: a
    // failure here just means the next hydrateSettings()/reload sees the
    // pre-patch server value, which is an acceptable degrade for a
    // preferences PATCH (no user-facing error surface for this exists yet).
    void api.patchSettings(patch).catch((err) => {
      console.error("Failed to persist settings", err);
    });
  }

  function applySettings(next: AppSettings) {
    set({
      settings: next,
      theme: resolveTheme(next.theme),
      terminalPrefs: deriveTerminalPrefs(next),
      hideEndedSessions: next.sessions.hideEndedSessions,
      notificationsEnabled: next.notifications.attentionAlerts,
    });
    localStorage.setItem(THEME_HINT_KEY, resolveTheme(next.theme));
  }

  return {
    projects: [],
    sessions: [],
    gitStatuses: {},
    sessionGitStatuses: {},
    gitDiffStats: {},
    gitBranchesByProject: {},
    prsByProject: {},
    events: {},
    lastSeenSeq: {},
    dismissedEventKeys: {},
    projectUrls: {},
    workspaces: [],
    groups: [],
    hosts: [],
    settings: DEFAULT_SETTINGS,
    settingsLoaded: false,
    theme: readThemeHint(),
    terminalPrefs: deriveTerminalPrefs(DEFAULT_SETTINGS),
    hideEndedSessions: DEFAULT_SETTINGS.sessions.hideEndedSessions,
    notificationsEnabled: DEFAULT_SETTINGS.notifications.attentionAlerts,
    sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
    sidebarWidth: readStoredSidebarWidth(),
    viewMode: readStoredViewMode(),
    kanbanOrder: {},
    splitRequest: null,
    notificationsPanelOpenRequest: 0,
    backendReachable: true,
    currentVersion: null,
    updateCheck: null,
    dismissedUpdateVersion: localStorage.getItem(DISMISSED_UPDATE_KEY),
    activeWorkspaceId: readStoredActiveWorkspaceId(),

    refreshProjects: async () => {
      set({ projects: await api.listProjects() });
      // Fire-and-forget: a project list change (create/rename/delete, or
      // just this tick's poll) shouldn't make every refreshProjects() caller
      // wait on N additional git-status round trips too.
      void get().refreshGitStatuses();
      // Same fire-and-forget shape as refreshGitStatuses above — branches/
      // worktrees/PRs (issue #202) only need to be current as of "whenever
      // the project list last changed," not this exact await.
      void get().refreshGitRefs();
    },

    // Batch git-status fetch: replaces N parallel per-project requests with
    // a single request to GET /api/projects/git-statuses (which replaces N
    // `git status` shell-outs with one batch that still benefits from the
    // server-side 5s in-memory cache). Projects whose git status was
    // transiently unavailable (the per-project endpoint's 503-equivalent)
    // are omitted from the response, so the frontend preserves its
    // last-known-good for those — only the durable "not a repo" (the per-
    // project endpoint's 204-equivalent, returned as a null entry) clears
    // a previously-known status. If the entire batch request fails
    // (network error, whole-backend outage), all previous entries are kept.
    //
    // Also requests per-session status (issue #202) in the same batch —
    // scoped to visible (non-killed, terminal-kind) sessions, same filter
    // Sidebar.tsx itself applies — and merges it into `sessionGitStatuses`
    // with the identical last-known-good/pruning behavior as `gitStatuses`.
    refreshGitStatuses: () => {
      if (gitStatusesRefreshInFlight) return gitStatusesRefreshInFlight;

      const run = async () => {
        const projectIds = get().projects.map((p) => p.id);
        // Same "still active or exited, never killed" scope as Sidebar.tsx's
        // own session-row filter — deliberately NOT further narrowed by
        // hideEndedSessions, which is a display-only toggle a user can flip
        // back on without this data needing a fresh fetch first.
        const sessionIds = get()
          .sessions.filter((s) => s.kind === "terminal" && s.status !== "killed")
          .map((s) => s.id);
        if (projectIds.length === 0 && sessionIds.length === 0) {
          set({ gitStatuses: {}, sessionGitStatuses: {} });
          return;
        }

        try {
          const result = await api.getProjectGitStatuses(projectIds, sessionIds);
          set({
            gitStatuses: {
              ...Object.fromEntries(projectIds.map((id) => [id, get().gitStatuses[id] ?? null])),
              ...result.projects,
            },
            sessionGitStatuses: {
              ...Object.fromEntries(
                sessionIds.map((id) => [id, get().sessionGitStatuses[id] ?? null]),
              ),
              ...result.sessions,
            },
          });
        } catch (err) {
          console.warn("[GitPanel] refreshGitStatuses batch failed", err);
        }
      };

      gitStatusesRefreshInFlight = run().finally(() => {
        gitStatusesRefreshInFlight = null;
      });
      return gitStatusesRefreshInFlight;
    },

    // Batch diff-stats fetch (issue #202, greenfield) — same shape/dedup/
    // last-known-good pattern as refreshGitStatuses above, but its own
    // separate endpoint/cache and in-flight guard (gitDiffStatsRefreshInFlight).
    refreshGitDiffStats: () => {
      if (gitDiffStatsRefreshInFlight) return gitDiffStatsRefreshInFlight;

      const run = async () => {
        const sessionIds = get()
          .sessions.filter((s) => s.kind === "terminal" && s.status !== "killed")
          .map((s) => s.id);
        if (sessionIds.length === 0) {
          set({ gitDiffStats: {} });
          return;
        }

        try {
          const stats = await api.getSessionGitDiffStats(sessionIds);
          set({
            gitDiffStats: {
              ...Object.fromEntries(sessionIds.map((id) => [id, get().gitDiffStats[id] ?? null])),
              ...stats,
            },
          });
        } catch (err) {
          console.warn("[GitPanel] refreshGitDiffStats batch failed", err);
        }
      };

      gitDiffStatsRefreshInFlight = run().finally(() => {
        gitDiffStatsRefreshInFlight = null;
      });
      return gitDiffStatsRefreshInFlight;
    },

    // Branches + worktrees + open-PR list per project (issue #202) — unlike
    // the two batch endpoints above, there's no single batched route for
    // this (git-branches and github/prs are both per-project, existing
    // routes — see the plan's "no new schema/endpoint needed here" note), so
    // this fires one pair of requests per project, in parallel across
    // projects. Deliberately run on a slower cadence than the 4s git-status
    // tick (called from refreshProjects, plus a throttled call from
    // startLiveRefresh below) — branch/worktree lists change rarely
    // (git-refs.ts's own on-demand-fetch reasoning) and the PR list already
    // rides its own 60s-ish server-side cache/poller, so refetching it every
    // 4s would just be wasted round trips for data that hasn't moved.
    refreshGitRefs: () => {
      if (gitRefsRefreshInFlight) return gitRefsRefreshInFlight;

      const run = async () => {
        const projectList = get().projects;
        if (projectList.length === 0) {
          set({ gitBranchesByProject: {}, prsByProject: {} });
          return;
        }

        const results = await Promise.allSettled(
          projectList.map(async (p) => {
            const [branches, prs] = await Promise.all([
              api.getProjectGitBranches(p.id).catch(() => undefined),
              api.getProjectGitHubPRs(p.id).catch(() => undefined),
            ]);
            return { id: p.id, branches, prs };
          }),
        );

        const gitBranchesByProject: Record<number, GitBranchesResult | undefined> = {};
        const prsByProject: Record<number, GitHubPRsStatus | undefined> = {};
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          gitBranchesByProject[result.value.id] = result.value.branches;
          prsByProject[result.value.id] = result.value.prs;
        }
        set({ gitBranchesByProject, prsByProject });
      };

      gitRefsRefreshInFlight = run().finally(() => {
        gitRefsRefreshInFlight = null;
      });
      return gitRefsRefreshInFlight;
    },

    refreshSessions: async () => {
      try {
        const sessions = await api.listSessions();
        set({ sessions });
        if (consecutiveSessionFetchFailures > 0 || !get().backendReachable) {
          consecutiveSessionFetchFailures = 0;
          set({ backendReachable: true });
        }
      } catch (err) {
        consecutiveSessionFetchFailures += 1;
        if (consecutiveSessionFetchFailures >= BACKEND_UNREACHABLE_THRESHOLD) {
          set({ backendReachable: false });
        }
        throw err;
      }
    },

    createProject: async (name, cwd, hostId) => {
      const project = await api.createProject(name, cwd, hostId);
      await get().refreshProjects();
      return project;
    },

    updateProject: async (id, patch) => {
      await api.updateProject(id, patch);
      await get().refreshProjects();
    },

    deleteProject: async (id) => {
      await api.deleteProject(id);
      await Promise.all([get().refreshProjects(), get().refreshSessions()]);
    },

    createSession: async (projectId, command, opts) => {
      const session = await api.createSession(projectId, command, opts);
      await get().refreshSessions();
      return session;
    },

    renameSession: async (id, name) => {
      // Set nameLocked optimistically (same pattern as reorderWorkspaces
      // above) — closes the narrow window between PaneTab's immediate
      // `props.api.setTitle(value)` and this PATCH+refresh resolving, during
      // which a live OSC title event (issue #69) would otherwise still see
      // nameLocked: false in the store and override the just-committed rename.
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, name, nameLocked: true } : s)),
      }));
      await api.renameSession(id, name);
      await get().refreshSessions();
    },

    deleteSession: async (id) => {
      await api.deleteSession(id);
      await get().refreshSessions();
    },

    promoteSession: async (id, opts) => {
      const session = await api.promoteSession(id, opts);
      await get().refreshSessions();
      return session;
    },

    declinePromote: async (id, reason) => {
      await api.declinePromote(id, reason);
      await get().refreshSessions();
    },

    refreshWorkspaces: async () => {
      set({ workspaces: await api.listWorkspaces() });
    },

    createWorkspace: async (name) => {
      const workspace = await api.createWorkspace(name);
      await get().refreshWorkspaces();
      return workspace;
    },

    renameWorkspace: async (id, name) => {
      await api.renameWorkspace(id, name);
      await get().refreshWorkspaces();
    },

    deleteWorkspace: async (id) => {
      await api.deleteWorkspace(id);
      await get().refreshWorkspaces();
    },

    setWorkspaceGroup: async (id, groupId, position) => {
      await api.setWorkspaceGroup(id, groupId, position);
      await get().refreshWorkspaces();
    },

    reorderWorkspaces: async (updates) => {
      if (updates.length === 0) return;
      set((state) => ({
        workspaces: state.workspaces.map((w) => {
          const u = updates.find((x) => x.id === w.id);
          return u ? { ...w, groupId: u.groupId, position: u.position } : w;
        }),
      }));
      await Promise.all(updates.map((u) => api.setWorkspaceGroup(u.id, u.groupId, u.position)));
      await get().refreshWorkspaces();
    },

    saveWorkspaceLayout: async (id, layout) => {
      try {
        const updated = await api.saveWorkspaceLayout(id, layout);
        set((state) => ({
          workspaces: state.workspaces.map((w) => (w.id === id ? updated : w)),
        }));
      } catch (err) {
        console.error("[store] failed to save workspace layout:", err);
      }
    },

    setActiveWorkspaceId: (id) => {
      set({ activeWorkspaceId: id });
      if (id === null) {
        localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
      } else {
        localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, String(id));
      }
    },

    refreshGroups: async () => {
      set({ groups: await api.listGroups() });
    },

    createGroup: async (name, color) => {
      const group = await api.createGroup(name, color);
      await get().refreshGroups();
      return group;
    },

    updateGroup: async (id, patch) => {
      await api.updateGroup(id, patch);
      await get().refreshGroups();
    },

    deleteGroup: async (id) => {
      await api.deleteGroup(id);
      // A group's member workspaces get groupId set null server-side (ON
      // DELETE SET NULL) — refresh both so they reappear ungrouped instead of
      // looking like they vanished with the group.
      await Promise.all([get().refreshGroups(), get().refreshWorkspaces()]);
    },

    refreshProjectUrls: async (projectId) => {
      const urls = await api.listProjectUrls(projectId);
      set((state) => ({
        projectUrls: { ...state.projectUrls, [projectId]: urls },
      }));
    },

    addProjectUrl: async (projectId, label, url, favorite) => {
      const created = await api.createProjectUrl(projectId, label, url, favorite);
      set((state) => ({
        projectUrls: {
          ...state.projectUrls,
          [projectId]: [...(state.projectUrls[projectId] ?? []), created],
        },
      }));
      return created;
    },

    updateProjectUrl: async (projectId, urlId, patch) => {
      await api.updateProjectUrl(projectId, urlId, patch);
      set((state) => ({
        projectUrls: {
          ...state.projectUrls,
          [projectId]:
            state.projectUrls[projectId]?.map((u) => (u.id === urlId ? { ...u, ...patch } : u)) ??
            [],
        },
      }));
    },

    deleteProjectUrl: async (projectId, urlId) => {
      await api.deleteProjectUrl(projectId, urlId);
      set((state) => ({
        projectUrls: {
          ...state.projectUrls,
          [projectId]: state.projectUrls[projectId]?.filter((u) => u.id !== urlId) ?? [],
        },
      }));
    },

    refreshHosts: async () => {
      set({ hosts: await api.listHosts() });
    },

    createHost: async (name, baseUrl, token) => {
      const host = await api.createHost(name, baseUrl, token);
      await get().refreshHosts();
      return host;
    },

    updateHost: async (id, patch) => {
      await api.updateHost(id, patch);
      await get().refreshHosts();
    },

    deleteHost: async (id, opts) => {
      await api.deleteHost(id, opts);
      // A cascade delete also removes the host's projects/sessions
      // server-side — refresh all three so the sidebar doesn't keep
      // showing now-deleted rows until the next unrelated refresh.
      await Promise.all([get().refreshHosts(), get().refreshProjects(), get().refreshSessions()]);
    },

    pingHost: async (id) => {
      const { online } = await api.pingHost(id);
      return online;
    },

    hydrateSettings: async () => {
      const settings = await api.getSettings();
      applySettings(settings);
      set({ settingsLoaded: true });
    },

    updateSettings: (patch) => {
      const next = deepMerge(get().settings, patch);
      applySettings(next);

      pendingPatch = pendingPatch ? mergePartialPatch(pendingPatch, patch) : patch;
      if (patchTimer) clearTimeout(patchTimer);
      patchTimer = setTimeout(flushPendingPatch, SETTINGS_PATCH_DEBOUNCE_MS);
    },

    toggleTheme: () => {
      const next: Theme = get().theme === "dark" ? "light" : "dark";
      get().updateSettings({ theme: next });
    },

    setTerminalPrefs: (patch) => {
      get().updateSettings({ terminal: patch });
    },

    setHideEndedSessions: (value) => {
      get().updateSettings({ sessions: { hideEndedSessions: value } });
    },

    setNotificationsEnabled: (value) => {
      get().updateSettings({ notifications: { attentionAlerts: value } });
    },

    setSidebarCollapsed: (value) => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? "1" : "0");
      set({ sidebarCollapsed: value });
    },

    setSidebarWidth: (value) => {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(value));
      set({ sidebarWidth: value });
    },

    setViewMode: (value) => {
      localStorage.setItem(VIEW_MODE_KEY, value);
      set({ viewMode: value });
    },

    setKanbanColumnOrder: (columnId, order) => {
      set((state) => ({ kanbanOrder: { ...state.kanbanOrder, [columnId]: order } }));
    },

    requestSplit: (referencePanelId, direction) => {
      set({ splitRequest: { referencePanelId, direction } });
    },

    clearSplitRequest: () => {
      set({ splitRequest: null });
    },

    openNotificationsPanel: () => {
      set((state) => ({ notificationsPanelOpenRequest: state.notificationsPanelOpenRequest + 1 }));
    },

    startLiveRefresh: () => {
      let timer: ReturnType<typeof setInterval> | null = null;
      let tickCount = 0;
      // ~60s at the 4s tick interval — throttles refreshGitRefs (branches/
      // worktrees/PRs) onto this same timer instead of a second dedicated
      // interval, at a cadence appropriate for data that changes far less
      // often than working-tree status (see that action's own doc comment).
      const GIT_REFS_REFRESH_EVERY_N_TICKS = 15;

      const tick = () => {
        void get().refreshSessions();
        void get().refreshGitStatuses();
        void get().refreshGitDiffStats();
        tickCount++;
        if (tickCount % GIT_REFS_REFRESH_EVERY_N_TICKS === 0) {
          void get().refreshGitRefs();
        }
      };

      const start = () => {
        if (timer !== null) return;
        tick();
        timer = setInterval(tick, LIVE_REFRESH_INTERVAL_MS);
      };
      const stop = () => {
        if (timer === null) return;
        clearInterval(timer);
        timer = null;
      };

      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") start();
        else stop();
      };

      if (document.visibilityState === "visible") start();
      document.addEventListener("visibilitychange", onVisibilityChange);

      return () => {
        stop();
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    },

    startEventsStream: () => {
      const handle = connectEventsStream((event) => {
        set((state) => ({ events: addEvent(state.events, event) }));
      });
      eventsClientHandle = handle;
      return () => {
        handle.close();
        if (eventsClientHandle === handle) eventsClientHandle = null;
      };
    },

    markEventSeen: (sessionId, seq) => {
      set((state) => {
        const current = state.lastSeenSeq[sessionId] ?? 0;
        if (seq <= current) return state;
        return { lastSeenSeq: { ...state.lastSeenSeq, [sessionId]: seq } };
      });
      eventsClientHandle?.sendSeen(sessionId, seq);
    },

    dismissEvent: (sessionId, seq) => {
      set((state) => ({
        dismissedEventKeys: { ...state.dismissedEventKeys, [eventKey(sessionId, seq)]: true },
      }));
    },

    startThemeWatch: () => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => {
        if (get().settings.theme !== "system") return;
        const resolved = resolveTheme("system");
        set({ theme: resolved });
        localStorage.setItem(THEME_HINT_KEY, resolved);
      };
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },

    checkForUpdates: async () => {
      try {
        const result = await api.checkForUpdate();
        set({
          currentVersion: result.currentVersion,
          updateCheck: result,
        });
      } catch {
        // Fail silently — network/rate-limit errors shouldn't surface.
      }
    },

    dismissUpdate: () => {
      const version = get().updateCheck?.latestVersion;
      if (version) {
        localStorage.setItem(DISMISSED_UPDATE_KEY, version);
      }
      set({ dismissedUpdateVersion: version ?? null });
    },
  };
});
