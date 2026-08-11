import { create } from "zustand";
import { api, DEFAULT_SETTINGS } from "./api.js";
import type {
  AppSettings,
  CodexHookTrust,
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  Group,
  Host,
  NotificationEvent,
  Project,
  ProjectUrl,
  ServerInfo,
  Session,
  SettingsPatch,
  Task,
  Theme as ThemePreference,
  UpdateCheckResult,
  Workspace,
} from "./api.js";
import type { ReorderUpdate } from "./reorder.js";
import { deepMerge, mergePartialPatch } from "./settingsMerge.js";
import { connectEventsStream, type EventsClientHandle } from "./eventsClient.js";
import { connectTasksStream } from "./tasksClient.js";
import type { KanbanColumnId } from "./kanban.js";
import { resolveTaskMaster } from "./taskConfig.js";

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
// How long the pane-tab / panel-body highlight flash lasts when a session
// is clicked in the sidebar (matches the CSS animation duration + buffer).
const HIGHLIGHT_DURATION_MS = 1200;

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
// Dedups overlapping refreshTasks() calls (same shape as
// gitStatusesRefreshInFlight below). taskMasterEnv (the six deploy-time
// MULLION_TASK_* values) IS server-restart-only, so it's fetched via GET
// /api/server-info once and cached here rather than on every refreshTasks
// tick. taskMasterEnabled itself, however, is no longer restart-only as of
// the Task Master Settings UI follow-up — it's derived fresh from
// settings.taskMaster (which can change at any time via updateSettings)
// combined with this cached env, recomputed in applySettings below rather
// than only here. A failed first env fetch just retries on the next call
// (taskMasterEnvLoaded stays false). clearTaskMasterEnvCacheForTests below
// resets it between test cases — same precedent as agent-detect.ts's
// clearAgentsCacheForTests.
let tasksRefreshInFlight: Promise<void> | null = null;
// Independent review, PR #477 — a plain "return the in-flight promise"
// dedup (refreshGitStatuses's own shape) is wrong for refreshTasks
// specifically: every task mutation (createTask/updateTask/...) calls
// refreshTasks() *after* its own write lands, precisely to pick that write
// up. If a refresh was already in flight when the mutation's PATCH/POST
// resolved, that in-flight GET was very likely issued *before* the write —
// deduping onto it silently drops the mutation's own result, visible for
// up to a full TASKS_REFRESH_EVERY_N_TICKS tick (~60s). Set when a call
// arrives while one is already running; the running call's own loop
// re-fetches once more before resolving, so every caller's returned
// promise reflects state at least as fresh as when IT was called.
let tasksRefreshQueued = false;
let taskMasterEnvLoaded = false;

export function clearTaskMasterEnvCacheForTests(): void {
  taskMasterEnvLoaded = false;
}

// Used to resolve taskMasterEnabled before the real env has ever loaded
// (matches the pre-existing initial state of false: settings.taskMaster's
// own default is "inherit", and this fallback's enabled is false). Once
// GET /api/server-info's taskMasterEnv lands, it's cached in store state
// (see the DashboardState field below) and every subsequent resolution
// uses the real value instead. Exported so Settings.tsx's Task Master
// section can fall back to the same values before its own env fetch
// resolves, rather than duplicating this table.
//
// These six values MUST match src/plugins/env.ts's own MULLION_TASK_*
// defaults (Hermes review, PR #480) — this is a real, if narrow, drift
// risk: a future change to one side isn't caught by anything except a
// human noticing during review. Only matters for the brief pre-load
// window (server-info's own value always wins once fetched), so a
// full cross-cutting fix (e.g. serving these from a shared source) isn't
// worth it for a display-only fallback — just keep the two in sync by hand.
export const FALLBACK_TASK_MASTER_ENV: ServerInfo["taskMasterEnv"] = {
  enabled: false,
  maxConcurrent: 2,
  budgetMinutes: 120,
  progressCommentMinutes: 15,
  skipPermissions: false,
  issueLabel: "mullion-task",
  pollIntervalSeconds: 60,
};
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
// Dismiss-until-next-version, same convention as DISMISSED_UPDATE_KEY above —
// keyed on currentVersion rather than a hookTrust-specific token since
// (post issue #259's stable-path fix) a pending grant is expected to
// correlate with a version bump, not recur within one.
const DISMISSED_CODEX_HOOK_TRUST_KEY = "crs.dismissedCodexHookTrustVersion";
// Issue #211's list/Kanban view switcher — a client-only UI preference, same
// localStorage-not-server-settings treatment as sidebarCollapsed/sidebarWidth
// above (there's no backend field for this, and this is a frontend-only PR).
const VIEW_MODE_KEY = "crs.viewMode";
// Phase 5 (Track B, issue #195 5.5b) — flat (today's tree, all sessions
// independent) vs hierarchical (child sessions nested under their parent).
// Same client-only, localStorage-not-server-settings treatment as
// VIEW_MODE_KEY above — this is a presentation preference, not something a
// second browser/device needs to see synced.
const HIERARCHICAL_VIEW_KEY = "crs.hierarchicalView";

function readStoredActiveWorkspaceId(): number | null {
  const raw = localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

// "list" is today's per-project sidebar tree (Sidebar.tsx); "kanban" is the
// unified task/session board (UnifiedBoard.tsx — originally issue #211's
// session-only Working/Needs Attention/Finished/Idle/Exited board, later
// merged with 6.5/#218's TasksPanel), rendered as an overlay over the
// dockview grid area (App.tsx) — see that file's own comment for why it
// lives there rather than inside the sidebar (a global, cross-project board
// needs more width than the sidebar's SIDEBAR_MAX_WIDTH affords).
export type ViewMode = "list" | "kanban";

function readStoredViewMode(): ViewMode {
  return localStorage.getItem(VIEW_MODE_KEY) === "kanban" ? "kanban" : "list";
}

function readStoredHierarchicalView(): boolean {
  return localStorage.getItem(HIERARCHICAL_VIEW_KEY) === "1";
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
  // Phase 6 Task Master (6.5/#218) — the full task board's backing list.
  // taskMasterEnabled (server-info's flag) no longer gates whether this is
  // fetched at all (6.9/#233: the local board works regardless — see the
  // roadmap's Flag semantics decision); it only gates whether Claim/
  // Approve/Reject render as enabled in the UI.
  tasks: Task[];
  taskMasterEnabled: boolean;
  // Deploy-time MULLION_TASK_* values (Settings UI follow-up) — cached in
  // state (not just a module closure var) so Settings' Task Master section
  // can read it reactively for its "Environment default: N" hints. `null`
  // until the first refreshTasks() call's server-info fetch lands (see
  // taskMasterEnvLoaded/FALLBACK_TASK_MASTER_ENV above).
  taskMasterEnv: ServerInfo["taskMasterEnv"] | null;
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
  // Independent review finding (PR #430) — the auto-open-child-panel effect
  // in App.tsx needs to distinguish "sessions is [] because nothing has
  // loaded yet" from "sessions is [] because there are none," the same
  // reason settingsLoaded exists above. Without it, that effect's one-time
  // seed could latch against an empty list on the very first render (before
  // the initial GET /api/sessions resolves), then treat every real
  // pre-existing child as newly-arrived on the next tick and force-open all
  // of their panels.
  sessionsLoaded: boolean;
  // Same "distinguish not-yet-loaded from genuinely empty" reasoning as
  // sessionsLoaded above, for UnifiedBoard.tsx's task board specifically:
  // without it, its "No tasks yet." empty state (tasks.length === 0) flashed
  // on every single board open, since refreshTasks() is called fresh on
  // mount and tasks starts as []. Flips true on the first refreshTasks()
  // ATTEMPT, not the first success — see that function's own comment for
  // why that has to differ from sessionsLoaded's success-only semantics.
  tasksLoaded: boolean;
  // Derived read-only slices of `settings`, kept as real state fields (not
  // getters) so existing `useDashboardStore((s) => s.theme)`-style reactive
  // selectors across the app keep working unchanged.
  theme: Theme;
  terminalPrefs: TerminalPrefs;
  hideEndedSessions: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  // Issue #211 — see ViewMode's own doc comment above.
  viewMode: ViewMode;
  // Phase 5 (Track B, issue #195 5.5b) — see HIERARCHICAL_VIEW_KEY's own
  // doc comment above. Only meaningful in "list" viewMode — the unified
  // board's ad-hoc lane cards (UnifiedBoard.tsx) always render flat
  // regardless of this flag.
  hierarchicalView: boolean;
  // Local-only presentation order for Kanban cards within a column (issue
  // #211) — there's no backend field for card order in Phase 1 (a session
  // has no `position` column, unlike workspaces/groups), so this is kept as
  // in-memory UI state only, not persisted to localStorage or the server: a
  // reload legitimately re-shows a column's sessions in their natural order,
  // the same tradeoff `lastSeenSeq`/`dismissedEventKeys` above already
  // accept for other in-memory-only state. Keyed by KanbanBoard's column id
  // ("working" | "attention" | "finished" | "idle" | "exited"), each value
  // an ordered array of session ids — sessions not yet present in the array
  // (new arrivals) are appended at the end by KanbanBoard's own ordering
  // helper, not stored here until the user actually drags them.
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
  // Codex `/hooks` trust status (issue #259) — null until the first check
  // resolves, same "haven't looked yet" convention as updateCheck above.
  codexHookTrust: CodexHookTrust | null;
  dismissedCodexHookTrustVersion: string | null;
  checkCodexHookTrust: () => Promise<void>;
  dismissCodexHookTrust: () => void;
  splitRequest: SplitRequest | null;
  // Issue #170: a desktop notification's click handler (App.tsx) can't reach
  // into NotificationBell.tsx's own component-local `open`/position state
  // directly — same reason `splitRequest` above exists rather than a prop
  // (PaneHeaderActions.tsx can't receive one either; dockview owns that
  // component's render). Bumped (not a boolean) so requesting "open" while
  // it's already open still re-triggers NotificationBell.tsx's effect — a
  // plain boolean toggled true->true wouldn't change.
  notificationsPanelOpenRequest: number;
  // Panel id to show a brief highlight flash on (set via triggerPanelHighlight,
  // auto-clears after HIGHLIGHT_DURATION_MS). Both the tab (PaneTab.tsx) and
  // the panel body (TerminalPanelWrapper) read this to apply the flash.
  highlightedPanelId: string | null;
  triggerPanelHighlight: (id: string) => void;
  activePanelId: string | null;
  setActivePanelId: (id: string | null) => void;
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
  fetchProjectGit: (projectId: number) => Promise<void>;
  toggleAutoFetch: (projectId: number, value: boolean | null) => Promise<void>;
  refreshSessions: () => Promise<void>;
  // Counter bumped by GitHub WS onmessage so components can re-fetch
  // PR/CI data when an event arrives from the backend.
  prsRefreshTrigger: number;
  // U4 — same "bump a counter, let subscribers refetch" shape as
  // prsRefreshTrigger above, just component- rather than WS-triggered:
  // DockConfigPanel calls bumpDockConfigRefreshTrigger() after a successful
  // save, and Dock.tsx's own per-project column effect (which otherwise
  // only re-fetches GET .../dock on its own ~15s poll — see docs/dock.md's
  // troubleshooting note) includes this value in its dependency array so a
  // save takes effect immediately, without waiting out the poll or a page
  // reload. Deliberately a single global counter, not a per-project map:
  // prsRefreshTrigger already establishes "one shared counter, every
  // mounted consumer re-fetches its own project's data" as this app's
  // precedent, and a dock save is rare enough that every OTHER mounted
  // column doing one harmless extra fetch isn't worth a per-project map's
  // added complexity.
  dockConfigRefreshTrigger: number;
  bumpDockConfigRefreshTrigger: () => void;
  // Phase 2 — GitHub WebSocket connection and project subscription for
  // real-time PR/CI updates.
  githubWSConnected: boolean;
  connectGitHubWS: () => () => void;
  subscribeToGitHubProject: (projectId: number) => void;
  unsubscribeFromGitHubProject: (projectId: number) => void;
  // Phase 6 Task Master (6.5/#218) — refreshes the task list (always) and,
  // once per page load, taskMasterEnv (see tasksRefreshInFlight's own doc
  // comment above for why that isn't re-fetched every call).
  refreshTasks: () => Promise<void>;
  // Local-board CRUD (6.9/#233) — works regardless of taskMasterEnabled.
  createTask: (projectId: number, title: string, body?: string | null) => Promise<Task>;
  updateTask: (
    id: number,
    patch: {
      title?: string;
      body?: string | null;
      status?: "backlog" | "ready";
      boardOrder?: number;
    },
  ) => Promise<Task>;
  deleteTask: (id: number) => Promise<void>;
  // Claims a ready task (spawns a session into an isolated worktree, seeds
  // it with the issue/task as its prompt) and returns the spawned Session so
  // the caller can open it, mirroring createSession's own return shape.
  claimTask: (id: number) => Promise<Session>;
  // reviewing -> done: pushes the branch, opens a PR, closes the issue.
  approveTask: (id: number) => Promise<Task>;
  // reviewing -> in_progress: optional feedback, re-seeds the worker if its
  // session already exited.
  rejectTask: (id: number, feedback?: string) => Promise<Task>;
  // #483 — failed -> claimed: resumes on the preserved branch, spawning a
  // new session there. Same return shape as claimTask.
  retryTask: (id: number) => Promise<Session>;
  // #483 — reviewing -> failed: the other resolver of a reviewing task.
  giveUpTask: (id: number, reason?: string) => Promise<Task>;
  refreshWorkspaces: () => Promise<void>;
  refreshGroups: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  createProject: (name: string, cwd: string, hostId?: string) => Promise<Project>;
  updateProject: (
    id: number,
    patch: Partial<
      Pick<Project, "name" | "cwd" | "devServerUrl" | "defaultAgent" | "defaultReviewAgent">
    >,
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
      worktree?: { baseRef: string; branchName?: string } | { branch: string };
      worktreeRefresh?: boolean;
      skipPermissions?: boolean;
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
  setSidebarCollapsed: (value: boolean) => void;
  setSidebarWidth: (value: number) => void;
  setViewMode: (value: ViewMode) => void;
  setHierarchicalView: (value: boolean) => void;
  // Replaces one severity sub-group's whole order array (UnifiedBoard.tsx's
  // ad-hoc lane computes the new array via kanban.ts's computeKanbanReorder,
  // reusing reorder.ts's computeReorder for the actual reindex math) —
  // mirrors setSidebarWidth's "component computes, store just stores" shape
  // above.
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
  // #488 — connects the single /ws/tasks channel once (App.tsx's mount
  // effect, alongside startEventsStream), triggering a debounced
  // refreshTasks() on every live transition event. Not a data channel like
  // startEventsStream — see tasksClient.ts's own doc comment.
  startTasksStream: () => () => void;
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
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;
  let gitHubWS: WebSocket | null = null;
  const gitHubWSSubscriptions: Set<number> = new Set();
  // #488 — debounces a burst of task-transition events (e.g. several tasks
  // reconciling on the same reconciler tick) into a single refreshTasks()
  // call, rather than one refetch per event.
  let tasksEventRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const TASKS_EVENT_REFRESH_DEBOUNCE_MS = 250;
  // Hermes review, PR #577/#580 — connectGitHubWS's onmessage below calls
  // refreshGitRefs() on every /ws/github event with a projectId (push, PR
  // sync, CI started/completed); a single check suite can fire several in
  // quick succession. Same debounce shape as startTasksStream's own above.
  let gitRefsEventRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const GIT_REFS_EVENT_REFRESH_DEBOUNCE_MS = 250;

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

  // P6 perf/correctness fix — `events`, `lastSeenSeq`, and
  // `dismissedEventKeys` are keyed by session id and, unlike `gitStatuses`
  // (which refreshGitStatuses rebuilds fresh from the live session id list
  // every cycle), nothing ever removed a key from any of them: a long-lived
  // dashboard accumulates one entry per session id it has EVER seen,
  // unbounded. Pruned here (alongside every successful refreshSessions()
  // call) rather than at kill/delete time directly: per this repo's own
  // CLAUDE.md ("the sessions DB row records intent... live process state
  // lives only in PtyManager's in-memory map"), a killed session's DB row
  // survives and GET /api/sessions keeps returning it — Sidebar's
  // hideEndedSessions toggle can still show a killed/exited row — so pruning
  // on kill would delete event history a still-visible row needs. The one
  // case that's genuinely safe (and the only one this prunes): a session id
  // that no longer appears in the live list AT ALL, which — verified against
  // routes/sessions.ts's GET /api/sessions (no status filter; killed/exited
  // rows are returned same as active ones) — only happens when the DB row
  // itself is gone (its project, or the project's host, was deleted; FK
  // cascade removes the row outright). That is the remediation plan's own
  // conservative boundary: "prune only ids that no longer appear in the
  // sessions API response at all, not ids that are merely killed."
  function pruneSessionKeyedRecord<T>(
    record: Record<number, T>,
    liveIds: ReadonlySet<number>,
  ): Record<number, T> {
    const keys = Object.keys(record);
    // Fast path returns the SAME reference (not a fresh shallow copy) when
    // there's nothing to prune — a no-op prune must not itself manufacture a
    // new identity every tick for whatever's selecting this slice, which
    // would undo this same PR's P1 fine-grained-selector work for any
    // events/lastSeenSeq subscriber.
    if (keys.every((k) => liveIds.has(Number(k)))) return record;
    const next: Record<number, T> = {};
    for (const key of keys) {
      const id = Number(key);
      if (liveIds.has(id)) next[id] = record[id];
    }
    return next;
  }

  // Same shape as pruneSessionKeyedRecord above, but `dismissedEventKeys` is
  // keyed by the composite `eventKey(sessionId, seq)` string (`seq` alone
  // isn't unique across sessions — see that function's own doc comment), so
  // the session id has to be parsed out of the key's prefix rather than used
  // directly.
  function pruneDismissedEventKeys(
    record: Record<string, true>,
    liveIds: ReadonlySet<number>,
  ): Record<string, true> {
    const keys = Object.keys(record);
    const isLive = (key: string): boolean => {
      // Every key in this map is written by dismissEvent() via eventKey()
      // below, so this should always parse — but a key this prune pass
      // can't confidently attribute to a session id is kept, not dropped:
      // this pass only removes keys it can PROVE belong to a gone session.
      const sep = key.indexOf(":");
      if (sep <= 0) return true;
      const sessionId = Number(key.slice(0, sep));
      if (!Number.isFinite(sessionId)) return true;
      return liveIds.has(sessionId);
    };
    if (keys.every(isLive)) return record;
    const next: Record<string, true> = {};
    for (const key of keys) {
      if (isLive(key)) next[key] = record[key];
    }
    return next;
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
      // Task Master Settings UI follow-up — recomputed on every settings
      // change (hydrate AND every updateSettings patch), not just once on
      // env load, so toggling Settings -> Task Master's Enable switch takes
      // effect immediately rather than only after the next refreshTasks()
      // tick. Order-independent w.r.t. when taskMasterEnv itself loads: this
      // runs against whatever's cached so far (real value or the fallback),
      // and refreshTasks's own env-load path (below) re-triggers this same
      // computation against the settings already in state at that point.
      taskMasterEnabled: resolveTaskMaster(
        next.taskMaster,
        get().taskMasterEnv ?? FALLBACK_TASK_MASTER_ENV,
      ).enabled,
    });
    localStorage.setItem(THEME_HINT_KEY, resolveTheme(next.theme));
  }

  return {
    projects: [],
    sessions: [],
    tasks: [],
    taskMasterEnabled: false,
    taskMasterEnv: null,
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
    sessionsLoaded: false,
    tasksLoaded: false,
    theme: readThemeHint(),
    terminalPrefs: deriveTerminalPrefs(DEFAULT_SETTINGS),
    hideEndedSessions: DEFAULT_SETTINGS.sessions.hideEndedSessions,
    sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
    sidebarWidth: readStoredSidebarWidth(),
    viewMode: readStoredViewMode(),
    hierarchicalView: readStoredHierarchicalView(),
    kanbanOrder: {},
    splitRequest: null,
    githubWSConnected: false,
    prsRefreshTrigger: 0,
    dockConfigRefreshTrigger: 0,
    bumpDockConfigRefreshTrigger: () =>
      set((state) => ({ dockConfigRefreshTrigger: state.dockConfigRefreshTrigger + 1 })),
    notificationsPanelOpenRequest: 0,
    backendReachable: true,
    currentVersion: null,
    updateCheck: null,
    dismissedUpdateVersion: localStorage.getItem(DISMISSED_UPDATE_KEY),
    codexHookTrust: null,
    dismissedCodexHookTrustVersion: localStorage.getItem(DISMISSED_CODEX_HOOK_TRUST_KEY),
    highlightedPanelId: null,
    activePanelId: null,
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
        // Prune the three per-session-id maps down to only currently-live
        // session ids — see pruneSessionKeyedRecord's own doc comment above
        // for the exact boundary (gone-from-the-API-entirely, not merely
        // killed) and why this runs only on the success path: a transient
        // fetch failure must never be read as "every session is gone" and
        // wipe event history that's still valid.
        const liveIds = new Set(sessions.map((s) => s.id));
        set((state) => ({
          sessions,
          sessionsLoaded: true,
          events: pruneSessionKeyedRecord(state.events, liveIds),
          lastSeenSeq: pruneSessionKeyedRecord(state.lastSeenSeq, liveIds),
          dismissedEventKeys: pruneDismissedEventKeys(state.dismissedEventKeys, liveIds),
        }));
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

    // Phase 6 Task Master (6.5/#218) — hardened to refreshGitStatuses's own
    // pattern (in-flight dedup, swallow-and-keep-prior-state on failure).
    // Unlike the Phase 2.5 thin slice, GET /api/tasks is always fetched —
    // 6.9's local board works regardless of taskMasterEnabled — and
    // server-info's taskMasterEnv is only fetched once per page load (see
    // taskMasterEnvLoaded's own doc comment above) rather than on every
    // tick, since it's genuinely restart-only. taskMasterEnabled itself is
    // NOT restart-only anymore (Settings UI follow-up) — it's recomputed
    // here against the settings already in state, and independently
    // recomputed by applySettings whenever settings change.
    refreshTasks: () => {
      if (tasksRefreshInFlight) {
        // See tasksRefreshQueued's own doc comment above — this makes the
        // running call loop once more instead of just deduping onto a fetch
        // that may already be stale relative to this call.
        tasksRefreshQueued = true;
        return tasksRefreshInFlight;
      }

      const fetchOnce = async () => {
        if (!taskMasterEnvLoaded) {
          try {
            const info = await api.getServerInfo();
            set({
              taskMasterEnv: info.taskMasterEnv,
              taskMasterEnabled: resolveTaskMaster(get().settings.taskMaster, info.taskMasterEnv)
                .enabled,
            });
            taskMasterEnvLoaded = true;
          } catch (err) {
            console.warn("[tasks] failed to load taskMasterEnv", err);
          }
        }
        try {
          const tasks = await api.listTasks();
          set({ tasks, tasksLoaded: true });
        } catch (err) {
          console.warn("[tasks] refreshTasks failed", err);
          // Swallow — keep the last-known-good list rather than blanking it
          // to [] on a transient failure (same posture as refreshGitStatuses).
          // tasksLoaded still flips to true here, on the FIRST ATTEMPT
          // rather than the first success — deliberately different from
          // sessionsLoaded above, which only flips on success. Gating
          // UnifiedBoard.tsx's "No tasks yet." empty state on this flag
          // means a dead backend has to fall through to that empty state
          // (same as an empty task list would) rather than being stuck on a
          // permanent loading skeleton with no success and no error ever
          // reaching the UI.
          set({ tasksLoaded: true });
        }
      };

      const run = async () => {
        do {
          tasksRefreshQueued = false;
          await fetchOnce();
        } while (tasksRefreshQueued);
      };

      tasksRefreshInFlight = run().finally(() => {
        tasksRefreshInFlight = null;
      });
      return tasksRefreshInFlight;
    },

    createTask: async (projectId, title, body) => {
      const task = await api.createTask(projectId, title, body);
      void get().refreshTasks();
      return task;
    },

    updateTask: async (id, patch) => {
      const task = await api.updateTask(id, patch);
      void get().refreshTasks();
      return task;
    },

    deleteTask: async (id) => {
      await api.deleteTask(id);
      void get().refreshTasks();
    },

    claimTask: async (id) => {
      const session = await api.claimTask(id);
      // Best-effort (Hermes review, PR #281): the claim itself already
      // succeeded and the caller already has `session` to open directly —
      // a transient failure in these follow-up refreshes must not surface
      // as "claim failed" when it actually succeeded, which would show a
      // contradictory "session opened AND claim failed" UI.
      void Promise.all([get().refreshSessions(), get().refreshTasks()]).catch(() => {});
      return session;
    },

    approveTask: async (id) => {
      const task = await api.approveTask(id);
      void get().refreshTasks();
      return task;
    },

    rejectTask: async (id, feedback) => {
      const task = await api.rejectTask(id, feedback);
      // A reject can re-seed a fresh session in the same worktree
      // (routes/tasks.ts's reseedIfSessionExited) — refresh sessions too so
      // the task detail's embedded timeline picks up the new session id.
      void Promise.all([get().refreshSessions(), get().refreshTasks()]).catch(() => {});
      return task;
    },

    retryTask: async (id) => {
      const session = await api.retryTask(id);
      // Same dual-refresh reasoning as claimTask above — a new session was
      // just spawned, so the sessions list needs it too.
      void Promise.all([get().refreshSessions(), get().refreshTasks()]).catch(() => {});
      return session;
    },

    giveUpTask: async (id, reason) => {
      const task = await api.giveUpTask(id, reason);
      void get().refreshTasks();
      return task;
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

    triggerPanelHighlight: (id) => {
      set({ highlightedPanelId: id });
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        if (get().highlightedPanelId === id) {
          set({ highlightedPanelId: null });
        }
        highlightTimer = null;
      }, HIGHLIGHT_DURATION_MS);
    },

    setActivePanelId: (id) => set({ activePanelId: id }),

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

    // Manual git fetch for a project — runs `git fetch origin` now.
    fetchProjectGit: async (projectId: number) => {
      await api.postProjectGitFetch(projectId);
    },

    // Toggle auto-fetch for a project (null = inherit from global setting).
    toggleAutoFetch: async (projectId: number, value: boolean | null) => {
      await api.updateProject(projectId, { autoFetch: value });
      await get().refreshProjects();
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

    setHierarchicalView: (value) => {
      localStorage.setItem(HIERARCHICAL_VIEW_KEY, value ? "1" : "0");
      set({ hierarchicalView: value });
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
      // Same ~60s cadence as git refs — the task watcher's own server-side
      // poll interval defaults to 60s (MULLION_TASK_POLL_INTERVAL), so
      // polling the list faster than that here wouldn't surface anything
      // new anyway. Sidebar's own mount effect covers the immediate load.
      const TASKS_REFRESH_EVERY_N_TICKS = 15;

      const tick = () => {
        void get().refreshSessions();
        void get().refreshGitStatuses();
        void get().refreshGitDiffStats();
        tickCount++;
        if (tickCount % GIT_REFS_REFRESH_EVERY_N_TICKS === 0) {
          void get().refreshGitRefs();
        }
        if (tickCount % TASKS_REFRESH_EVERY_N_TICKS === 0) {
          void get().refreshTasks();
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

    startTasksStream: () => {
      // Debounced refetch, not payload-driven patching — refreshTasks()
      // already has queue-once-more semantics (tasksRefreshQueued, above)
      // that make a refetch safe to call from here without a second dedup
      // mechanism. The 60s poll (startLiveRefresh) stays as the fallback
      // for whenever this channel is disconnected or reconnecting.
      const handle = connectTasksStream(() => {
        if (tasksEventRefreshTimer) clearTimeout(tasksEventRefreshTimer);
        tasksEventRefreshTimer = setTimeout(() => {
          tasksEventRefreshTimer = null;
          void get().refreshTasks();
        }, TASKS_EVENT_REFRESH_DEBOUNCE_MS);
      });
      return () => {
        handle.close();
        if (tasksEventRefreshTimer) {
          clearTimeout(tasksEventRefreshTimer);
          tasksEventRefreshTimer = null;
        }
      };
    },

    connectGitHubWS: () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws/github`;
      const ws = new WebSocket(wsUrl);
      gitHubWS = ws;
      set({ githubWSConnected: false });

      ws.onopen = () => {
        set({ githubWSConnected: true });
        for (const projectId of gitHubWSSubscriptions) {
          ws.send(JSON.stringify({ type: "subscribe", projectId }));
        }
      };

      ws.onclose = () => {
        set({ githubWSConnected: false });
        if (gitHubWS === ws) gitHubWS = null;
      };

      ws.onerror = () => {
        if (gitHubWS === ws) gitHubWS = null;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data.projectId != null) {
            set((state) => ({ prsRefreshTrigger: state.prsRefreshTrigger + 1 }));
            // prsRefreshTrigger alone only reaches GitHubPanel (its own
            // effect dependency) — prsByProject itself, which every OTHER
            // consumer (Sidebar's SessionRow, UnifiedBoard's TaskCard,
            // TaskDetail) reads directly, stays on refreshGitRefs' own
            // ~60s throttle otherwise. Refreshing it here too means a real
            // GitHub push (a check completing, a new PR) reaches every
            // consumer within one WS round trip, not up to a minute later.
            // Debounced (not called directly) — refreshGitRefs itself has
            // no time throttle of its own, only in-flight dedup, so a check
            // suite's burst of started/completed events would otherwise
            // fire one refetch per event.
            if (gitRefsEventRefreshTimer) clearTimeout(gitRefsEventRefreshTimer);
            gitRefsEventRefreshTimer = setTimeout(() => {
              gitRefsEventRefreshTimer = null;
              void get().refreshGitRefs();
            }, GIT_REFS_EVENT_REFRESH_DEBOUNCE_MS);
          }
        } catch (err) {
          console.warn("[GitHubWS] failed to parse message:", err);
        }
      };

      return () => {
        ws.close();
        if (gitRefsEventRefreshTimer) {
          clearTimeout(gitRefsEventRefreshTimer);
          gitRefsEventRefreshTimer = null;
        }
        if (gitHubWS === ws) {
          gitHubWS = null;
          set({ githubWSConnected: false });
        }
      };
    },

    subscribeToGitHubProject: (projectId: number) => {
      gitHubWSSubscriptions.add(projectId);
      if (gitHubWS?.readyState === WebSocket.OPEN) {
        gitHubWS.send(JSON.stringify({ type: "subscribe", projectId }));
      }
    },

    unsubscribeFromGitHubProject: (projectId: number) => {
      gitHubWSSubscriptions.delete(projectId);
      // P12 — this used to be local-cleanup-only: the server kept pushing
      // events for a project whose UI section had already unmounted,
      // because nothing ever told it to stop. Mirrors subscribeToGitHubProject
      // above (same guard, same frame shape, same send mechanism).
      //
      // NOTE for reviewers: as of this PR, `src/routes/ws-github.ts` only
      // recognizes `{type: "subscribe", projectId}` — there is no server-side
      // handler for `"unsubscribe"` at all, and
      // `src/services/github-ws-broadcast.ts`'s `subscribeToProject` only
      // ever removes a socket from a project's subscriber set on the
      // socket's own `close`/`error` (i.e. the whole shared `/ws/github`
      // connection closing), not on a per-project unsubscribe. So this frame
      // is inert until the backend grows a handler for it — a separate,
      // backend-side, out-of-scope change for this frontend-only PR (see the
      // plan's P12 finding). Sending it now means the fix is a pure backend
      // addition later, with nothing left to do frontend-side.
      if (gitHubWS?.readyState === WebSocket.OPEN) {
        gitHubWS.send(JSON.stringify({ type: "unsubscribe", projectId }));
      }
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

    checkCodexHookTrust: async () => {
      try {
        const agents = await api.listAgents();
        const codex = agents.find((a) => a.id === "agent:codex");
        set({ codexHookTrust: codex?.hookTrust ?? null });
      } catch {
        // Fail silently — same posture as checkForUpdates above; a missed
        // check just means the banner stays at its last-known state.
      }
    },

    dismissCodexHookTrust: () => {
      const version = get().currentVersion;
      if (version) {
        localStorage.setItem(DISMISSED_CODEX_HOOK_TRUST_KEY, version);
      }
      set({ dismissedCodexHookTrustVersion: version ?? null });
    },
  };
});
