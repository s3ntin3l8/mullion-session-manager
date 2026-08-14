import type {
  AppSettings,
  CodexHookTrust,
  CreateProjectDirOptions,
  CreateProjectResult,
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
  UpdateCheckResult,
  Workspace,
} from "../api/index.js";
import type { ReorderUpdate } from "../reorder.js";
import type { KanbanColumnId } from "../kanban.js";

// "list" is today's per-project sidebar tree (Sidebar.tsx); "kanban" is the
// unified task/session board (UnifiedBoard.tsx — originally issue #211's
// session-only Working/Needs Attention/Finished/Idle/Exited board, later
// merged with 6.5/#218's TasksPanel), rendered as an overlay over the
// dockview grid area (App.tsx) — see that file's own comment for why it
// lives there rather than inside the sidebar (a global, cross-project board
// needs more width than the sidebar's SIDEBAR_MAX_WIDTH affords). Client-only
// UI preference (localStorage, no backend field) — same for
// hierarchicalView below (Phase 5 Track B, issue #195 5.5b: flat
// vs hierarchical child-session nesting).
export type ViewMode = "list" | "kanban";

// The *resolved* theme — what's actually painted (dockview class, root
// `.light` class, xterm palette). Distinct from `AppSettings["theme"]`
// (imported as `ThemePreference` in store/helpers.ts, where resolveTheme()
// converts one to the other), which additionally allows `"system"` — this
// is always one of the two concrete values that preference resolves to.
// Exported under the pre-existing name so cliLogos.ts's
// `import type { Theme } from "./store/index.js"` (and any other consumer
// expecting only "dark" | "light") keeps working unchanged.
export type Theme = "dark" | "light";

// Back-compat alias other files already import from store.ts.
export interface TerminalPrefs {
  fontSize: number;
  cursorStyle: AppSettings["terminal"]["cursorStyle"];
  scrollback: number;
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

export interface ProjectsSlice {
  projects: Project[];
  // Per-project saved URLs (issue #109), keyed by project id.
  projectUrls: Record<number, ProjectUrl[]>;
  refreshProjects: () => Promise<void>;
  createProject: (
    name: string,
    cwd: string,
    hostId?: string,
    opts?: CreateProjectDirOptions,
  ) => Promise<CreateProjectResult>;
  updateProject: (
    id: number,
    patch: Partial<
      Pick<Project, "name" | "cwd" | "devServerUrl" | "defaultAgent" | "defaultReviewAgent">
    > &
      CreateProjectDirOptions,
  ) => Promise<CreateProjectResult>;
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
}

export interface SessionsSlice {
  sessions: Session[];
  // Independent review finding (PR #430) — the auto-open-child-panel effect
  // in App.tsx needs to distinguish "sessions is [] because nothing has
  // loaded yet" from "sessions is [] because there are none," the same
  // reason settingsLoaded exists. Without it, that effect's one-time
  // seed could latch against an empty list on the very first render (before
  // the initial GET /api/sessions resolves), then treat every real
  // pre-existing child as newly-arrived on the next tick and force-open all
  // of their panels.
  sessionsLoaded: boolean;
  // Design's "whole backend down" state (States doc section 04) — flips
  // false after BACKEND_UNREACHABLE_THRESHOLD consecutive session-fetch
  // failures, true again the moment one succeeds. See
  // consecutiveSessionFetchFailures (slices/sessions.ts) for why this lives
  // outside any one specific call site.
  backendReachable: boolean;
  refreshSessions: () => Promise<void>;
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
  // Starts the ~4s session-status poll (paused while the tab is hidden) and
  // returns a cleanup function — called once from App.tsx's mount effect.
  // Kept as a store action (rather than plain App.tsx setInterval) so any
  // consumer of `sessions` gets the same live-refresh guarantee. Also
  // throttles the git-refs and tasks refreshes onto this same tick (see the
  // implementation's own doc comment) — cross-slice, but the session-status
  // poll is the natural owner of "what runs on every tick."
  startLiveRefresh: () => () => void;
}

export interface GitSlice {
  // Per-project git status (issue #76), keyed by project id — powers the
  // GitPanel's own live re-poll plus the sidebar dirty badge and pane-tab
  // branch label's dirty ("*") marker. `null` means "fetched, not
  // applicable" (not a repo, or an unreachable remote host); a missing key
  // means "not fetched yet" (e.g. right after a project is created, before
  // the next tick). Absent entirely from the "whole backend down" failure
  // counter (SessionsSlice's own consecutiveSessionFetchFailures) — a
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
  refreshGitStatuses: () => Promise<void>;
  // Issue #202's other two git-refresh actions — see their own
  // implementations for the cadence each runs on.
  refreshGitDiffStats: () => Promise<void>;
  // `projectIds` omitted refreshes every project (and prunes ones that no
  // longer exist); passed, it scopes the refetch to just those — see this
  // action's own implementation in slices/git.ts for why.
  refreshGitRefs: (projectIds?: number[]) => Promise<void>;
  fetchProjectGit: (projectId: number) => Promise<void>;
  toggleAutoFetch: (projectId: number, value: boolean | null) => Promise<void>;
}

export interface GithubSlice {
  // Counter bumped by GitHub WS onmessage so components can re-fetch
  // PR/CI data when an event arrives from the backend.
  prsRefreshTrigger: number;
  // Phase 2 — GitHub WebSocket connection and project subscription for
  // real-time PR/CI updates.
  githubWSConnected: boolean;
  connectGitHubWS: () => () => void;
  subscribeToGitHubProject: (projectId: number) => void;
  unsubscribeFromGitHubProject: (projectId: number) => void;
}

export interface TasksSlice {
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
  // slices/tasks.ts's own taskMasterEnvLoaded/FALLBACK_TASK_MASTER_ENV).
  taskMasterEnv: ServerInfo["taskMasterEnv"] | null;
  // Same "distinguish not-yet-loaded from genuinely empty" reasoning as
  // sessionsLoaded, for UnifiedBoard.tsx's task board specifically:
  // without it, its "No tasks yet." empty state (tasks.length === 0) flashed
  // on every single board open, since refreshTasks() is called fresh on
  // mount and tasks starts as []. Flips true on the first refreshTasks()
  // ATTEMPT, not the first success — see that function's own comment for
  // why that has to differ from sessionsLoaded's success-only semantics.
  tasksLoaded: boolean;
  // Phase 6 Task Master (6.5/#218) — refreshes the task list (always) and,
  // once per page load, taskMasterEnv (see slices/tasks.ts's own
  // tasksRefreshInFlight doc comment for why that isn't re-fetched every
  // call).
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
  // #488 — connects the single /ws/tasks channel once (App.tsx's mount
  // effect, alongside startEventsStream), triggering a debounced
  // refreshTasks() on every live transition event. Not a data channel like
  // startEventsStream — see tasksClient.ts's own doc comment.
  startTasksStream: () => () => void;
}

export interface EventsSlice {
  // Phase 1's notification event model (issue #166) — accumulated events
  // from the /ws/events push channel (eventsClient.ts), keyed by sessionId
  // and bounded per session (EVENTS_PER_SESSION_CAP). Deduped by `seq` so a
  // reconnect's replay batch (which can re-deliver events this store
  // already has — see startEventsStream) never double-counts. Fed
  // independently of, and in addition to, the existing 4s poll — see
  // SessionsSlice's startLiveRefresh, which stays exactly as-is.
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
  // touching the read cursor. Keyed by `eventKey(sessionId, seq)` since
  // `seq` alone isn't unique across sessions. In-memory only, same as
  // `events`/`lastSeenSeq` — a reload re-shows a dismissed event, which is
  // an acceptable degrade given the underlying event itself isn't persisted
  // past the backend's own ring buffer + replay-on-connect window either.
  dismissedEventKeys: Record<string, true>;
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
}

export interface WorkspacesSlice {
  workspaces: Workspace[];
  groups: Group[];
  refreshWorkspaces: () => Promise<void>;
  refreshGroups: () => Promise<void>;
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
  createGroup: (name: string, color?: string) => Promise<Group>;
  updateGroup: (
    id: number,
    patch: Partial<Pick<Group, "name" | "icon" | "color" | "collapsed" | "position">>,
  ) => Promise<void>;
  deleteGroup: (id: number) => Promise<void>;
}

export interface HostsSlice {
  // Registered hosts (issue #26) — includes the always-present "local" row.
  // Fetched independently of projects/sessions since it's needed wherever a
  // host picker renders (CreateProjectModal, Sidebar's discovery flow),
  // not just Settings -> Hosts.
  hosts: Host[];
  refreshHosts: () => Promise<void>;
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
}

export interface UiSlice {
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
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  // Issue #211 — see ViewMode's own doc comment.
  viewMode: ViewMode;
  // Phase 5 (Track B, issue #195 5.5b) — see ViewMode's own doc comment.
  // Only meaningful in "list" viewMode — the unified board's ad-hoc lane
  // cards (UnifiedBoard.tsx) always render flat regardless of this flag.
  hierarchicalView: boolean;
  // Local-only presentation order for Kanban cards within a column (issue
  // #211) — there's no backend field for card order in Phase 1 (a session
  // has no `position` column, unlike workspaces/groups), so this is kept as
  // in-memory UI state only, not persisted to localStorage or the server: a
  // reload legitimately re-shows a column's sessions in their natural order,
  // the same tradeoff `lastSeenSeq`/`dismissedEventKeys` already accept for
  // other in-memory-only state. Keyed by KanbanBoard's column id
  // ("working" | "attention" | "finished" | "idle" | "exited"), each value
  // an ordered array of session ids — sessions not yet present in the array
  // (new arrivals) are appended at the end by KanbanBoard's own ordering
  // helper, not stored here until the user actually drags them.
  kanbanOrder: Partial<Record<KanbanColumnId, number[]>>;
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
  // falling back to first-available/create-default when that happens. Kept
  // in the ui slice (not workspaces) — it's a client-only preference
  // (localStorage-backed set/read, no server round trip), the same shape as
  // sidebarWidth/viewMode/hierarchicalView below rather than the
  // workspaces slice's server-backed CRUD.
  activeWorkspaceId: number | null;
  setActiveWorkspaceId: (id: number | null) => void;
  // U4 — same "bump a counter, let subscribers refetch" shape as
  // prsRefreshTrigger (GithubSlice), just component- rather than WS-triggered:
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
  // added complexity. Kept in ui (not workspaces/hosts) as a generic
  // cross-cutting UI refresh signal, the same bucket splitRequest/
  // notificationsPanelOpenRequest live in.
  dockConfigRefreshTrigger: number;
  bumpDockConfigRefreshTrigger: () => void;
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
  // Re-resolves `theme` whenever the OS-level color-scheme preference
  // changes, but only while settings.theme === "system" — a no-op the rest
  // of the time. Returns a cleanup function; called once from App.tsx
  // alongside startLiveRefresh.
  startThemeWatch: () => () => void;
}

// Stays one store object, so every `useDashboardStore(s => s.x)` selector
// is unchanged — see slices/index (store/index.ts)'s own doc comment for
// why this is what caps the risk of the slice split. Cross-slice `get()`/
// `set()` calls inside any one slice's actions type-check against this
// full combined shape, not just that slice's own piece of it — that's the
// whole point of threading DashboardState (not e.g. ProjectsSlice) as the
// first generic parameter of every `StateCreator<DashboardState, [], [],
// XSlice>` in slices/*.ts.
export type DashboardState = ProjectsSlice &
  SessionsSlice &
  GitSlice &
  GithubSlice &
  TasksSlice &
  EventsSlice &
  WorkspacesSlice &
  HostsSlice &
  UiSlice;
