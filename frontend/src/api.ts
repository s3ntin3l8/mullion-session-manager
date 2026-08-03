// Mirrors src/routes/auth.ts's GET /api/auth/me response. `methods` reports
// each in-process auth mechanism independently (not a single mode string)
// since issue #19's shared token and issue #30's OIDC login are additive —
// both can be configured at once, and AuthGate.tsx renders whichever
// controls apply. Both false means in-process auth isn't configured at all
// — AuthGate renders the dashboard unconditionally, the same behavior as
// before this feature existed. `user` is only present once authenticated
// via OIDC (a token-only session has no identity to report).
export interface AuthStatus {
  methods: { token: boolean; oidc: boolean };
  authenticated: boolean;
  user?: { sub: string; email?: string; name?: string; groups?: string[] };
}

export interface Project {
  id: number;
  name: string;
  cwd: string;
  // The host this project's files (and therefore its sessions) live on —
  // "local" for this same process, or a registered remote host's id (issue
  // #26). Every session under a project inherits its host.
  hostId: string;
  // Where this project's dev server listens (issue #28) — a bare port
  // ("5173") or a full URL. The authoritative, manually-set fallback the
  // preview proxy resolves against; null when unconfigured.
  devServerUrl: string | null;
  // Derived, not persisted (issue #28 phase 7) — a port the backend spotted
  // in a running dock session's own startup banner (Vite/Next/CRA/Astro all
  // print one), offered as a suggestion only. Never overrides devServerUrl;
  // null whenever nothing was detected (no dock session, no banner yet, or
  // a remote-hosted project — see dev-server-detect.ts).
  detectedDevServerPort: string | null;
  // Always-on branch label (issue #96) — the project's current checkout, a
  // short detached-HEAD SHA, or null when it's not a git repo (or, for a
  // remote-hosted project, its host is unreachable). Cheap enough to ride
  // along on every GET /api/projects rather than needing its own fetch —
  // see PaneTab.tsx/Sidebar.tsx for where this renders.
  currentBranch: string | null;
  // Per-project auto-fetch override — null means "inherit from global
  // setting" (src/plugins/git-fetcher.ts). Mirrors the DB column 1:1.
  autoFetch: boolean | null;
  // Issue #431 — which project-scope agent-rules filenames exist for this
  // project (CLAUDE.md, AGENTS.md, AGENTS.override.md, GEMINI.md), deduped
  // across agents. Same "cheap enough to ride along on every GET
  // /api/projects" reasoning as currentBranch above — see
  // listExistingProjectRuleFileNames's own doc comment. Never includes
  // global-scope files (a sidebar row is about one project, not this host's
  // whole config).
  ruleFiles: string[];
  createdAt: string;
  // Phase 6 Task Master (6.2/#215) agent-selection precedence tier 2 — an
  // optional per-project override of settings.launchers.defaultAgent, used
  // to resolve which agent a claimed task spawns. Null means "fall through
  // to the global default." Mirrors src/db/schema.ts's projects.defaultAgent.
  defaultAgent: string | null;
  // Same precedence shape as defaultAgent, for the optional advisory review
  // agent spawned when a task enters "reviewing" (see task-state.ts). Unlike
  // defaultAgent there is no global-settings fallback — null means "no
  // review agent configured," the unchanged pre-Phase-6 behavior.
  defaultReviewAgent: string | null;
}

// Mirrors src/services/host-registry.ts's HostSummary 1:1 — never carries a
// token, just whether one is set (hasToken), same "no secrets over the API"
// rule AppSettings/ServerInfo above already follow.
export interface Host {
  id: string;
  name: string;
  baseUrl: string | null;
  isLocal: boolean;
  hasToken: boolean;
  createdAt: string;
}

export const LOCAL_HOST_ID = "local";

// Mirrors src/services/github-integration.ts's GitHubIntegrationSummary 1:1
// — never carries the token itself, same "hasToken-only" rule as Host above
// (there `hasToken`, here `connected`).
export interface GitHubIntegration {
  connected: boolean;
  tokenType: "pat" | "oauth" | null;
  login: string | null;
  scopes: string[] | null;
  connectedAt: string | null;
  deviceFlowAvailable: boolean;
  webhookEnabled: boolean;
  webhookBaseUrl: string;
  webhookRegisteredCount: number;
}

// Mirrors src/services/github-device-flow.ts's DeviceFlowSummary 1:1 — never
// carries the device_code, only what the user needs to see (the
// user_code/verification_uri) and the current status.
export type DeviceFlowState = "pending" | "connected" | "expired" | "denied" | "error";

export interface DeviceFlowStatus {
  status: DeviceFlowState;
  userCode: string;
  verificationUri: string;
  errorMessage?: string;
}

// Mirrors src/services/browser-cookies.ts's CookieProfileSummary 1:1 — never
// carries the cookie values themselves, only a summary (see that file's own
// comment on why).
export interface BrowserCookieProfile {
  id: number;
  projectId: number;
  label: string;
  browser: "chrome" | "firefox";
  cookieCount: number;
  importedAt: string;
}

// Phase 5 (Track A) — mirrors src/services/pty-manager.ts's SubagentInfo
// 1:1. One named subagent, built from agentId-bearing hook messages.
export interface SubagentInfo {
  agentId: string;
  agentType: string | null;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  fileChanges: number;
  toolFailures: number;
  eventCount: number;
}

// Issue #428 — mirrors src/services/hook-protocol.ts's BackgroundTask 1:1.
// Claude Code's own Stop/SubagentStop hook field — a bash job, MCP-backed
// task, or background subagent still outstanding when the turn ended.
export interface BackgroundTask {
  id: string;
  type: string;
  status: string;
  description: string;
  command?: string;
  agent_type?: string;
  server?: string;
  tool?: string;
  name?: string;
}

export interface Session {
  id: number;
  projectId: number;
  // Phase 5 (Track B, issue #193 5.3b) — set only for a session spawned via
  // the sessions.spawn_child control-socket op, never by a launcher/dock/
  // promote. Mirrors src/db/schema.ts's sessions.parentSessionId 1:1 (a raw
  // DB column, so it reaches REST automatically via withLiveInfo's `...row`
  // spread — no SessionInfo/LiveInfoKey change needed on the backend).
  parentSessionId: number | null;
  name: string | null;
  // True once the user has explicitly renamed this session (PATCH
  // /api/sessions/:id) — false for a launch-time name pattern (see
  // CommandPalette's expandSessionNamePattern). The tab-title-tracking effect
  // (issue #69) pins the title against live OSC updates only when this is
  // true, so an auto-launch name stays overridable while a real rename doesn't.
  nameLocked: boolean;
  command: string;
  cwd: string | null;
  // "dock" sessions are spawned from a project's dock controls (persistent
  // monitors) rather than a one-shot launcher/manual "+ Session" — kept out
  // of the normal per-project session list, rendered in the Dock region.
  kind: "terminal" | "dock";
  // "exited" = the program ended on its own (caught by the backend's
  // reconciler), distinct from "killed" (explicit user action).
  status: "active" | "killed" | "exited";
  createdAt: string;
  lastAttachedAt: string | null;
  alive: boolean;
  subscriberCount: number;
  // Live-only fields (in-memory PtyManager state, same philosophy as
  // alive/subscriberCount above — reset to idle/no-signal defaults for a
  // session this process hasn't tracked since its own last restart).
  activity: "working" | "idle";
  lastActivityAt: number | null;
  // The shell's current working directory as last announced via OSC 7
  // (backend's attention-detect.ts detectCwdChange), or null if none has
  // arrived yet. Distinct from `cwd` above (the static launch cwd): a
  // session whose shell `cd`s into a git worktree after launch keeps `cwd`
  // pointing at the original directory, while this tracks where the shell
  // actually is now — see Sidebar.tsx's effectiveCwd.
  liveCwd: string | null;
  // The branch a dock-preview worktree (PR #341) was created for; non-null
  // only for a session whose cwd is a `.mullion-worktrees/dock-preview-*`
  // worktree. Those worktrees are checked out with a DETACHED HEAD, so
  // neither `cwd` nor git itself can tell us which branch is being
  // previewed — this is the only way to map the session back to one, which
  // Dock.tsx needs to resolve its branch selector to the right option after
  // a page reload. In-memory backend state (git-worktree.ts's
  // previewWorktrees), so it resets to null across a server restart for a
  // still-running preview session — the same restart that already loses
  // that session's sync tick and cleanup tracking. Mirrors
  // routes/sessions.ts's withLiveInfo 1:1.
  previewBranch: string | null;
  browserUrl?: string | null;
  attention: boolean;
  attentionAt: number | null;
  lastTitle: string | null;
  // Minimal review gate (Phase 2, issue #178) — mirrors
  // src/services/pty-manager.ts's SessionInfo.gateState/gatePrompt 1:1. Live
  // in-memory state, same fallback-to-defaults posture as every other live
  // field above.
  gateState: "idle" | "waiting" | "approved" | "denied";
  gatePrompt: string | null;
  // Hook signal states (issue #259) — live in-memory fields mirroring
  // PtyManager's per-session hook state, same fallback-to-defaults posture.
  permissionState: "idle" | "pending";
  planState: "idle" | "pending";
  errorState: "idle" | "api_error" | "tool_failure";
  endedReason: string | null;
  // Rich statuses (issue: extend surfaced session statuses) — mirror
  // src/services/pty-manager.ts's matching SessionInfo fields 1:1, same
  // live-only/fallback-to-defaults posture as everything else on this type.
  exitCode: number | null;
  attentionKind: string | null;
  errorDetail: string | null;
  lastAssistantMessage: string | null;
  compactState: "idle" | "compacting";
  subagentCount: number;
  /** Phase 5 (Track A) — mirrors pty-manager.ts's SessionInfo.subagents 1:1.
   * May be shorter than subagentCount when an adapter can't supply identity
   * (see SubagentInfo's own doc comment) — "count known, detail
   * unavailable," not an inconsistency to reconcile. */
  subagents: SubagentInfo[];
  elicitationState: "idle" | "pending";
  elicitationServer: string | null;
  lastTurnEndedAt: number | null;
  /** Issue #428 — mirrors pty-manager.ts's SessionInfo.outstandingBackgroundTasks
   * 1:1: already filtered to non-terminal entries server-side (see
   * background-tasks.ts's own predicate) — the frontend never re-derives,
   * same "presentation only" posture session-status.ts's derivation keeps
   * for everything else on this type. Row 6 in Sidebar.tsx renders this
   * list verbatim. */
  outstandingBackgroundTasks: BackgroundTask[];
  // The single derived rich status (src/services/session-status.ts) — see
  // sessionStatus.ts's STATUS_PRESENTATION table for how each value renders.
  // Deliberately separate keys from the raw `status` column above (which
  // other code may still read for its narrower active/killed/exited
  // meaning) rather than overloading it with this much richer union.
  sessionStatus: SessionStatus;
  sessionStatusSeverity: SessionSeverity;
  sessionStatusDetail: string | null;
  sessionStatusAttentionRequired: boolean;
  // Issue #271, option 2 — mirrors SessionInfo.promoteState/promoteSummary/
  // promoteSuggestedBaseRef 1:1. Same live-only, fallback-to-defaults
  // posture as gateState/gatePrompt above. "pending" means a model-invoked
  // `promote_to_worktree` MCP tool call is blocked on this session waiting
  // for a human decision — the promote dialog auto-opens for it.
  promoteState: "idle" | "pending" | "accepted" | "declined";
  promoteSummary: string | null;
  promoteSuggestedBaseRef: string | null;
  // Issue: sidebar worktree detection — the best-known branch for this
  // session, sourced from hook-reported `git_branch` messages (opencode's
  // vcs.branch.updated, or git worktree detection from any agent's
  // PostToolUse/PreToolUse intercept). null when no hook has reported a
  // branch yet — the frontend falls back to per-session git status or the
  // project's currentBranch.
  liveBranch: string | null;
  // Issue #323: whether this session's rich state was restored from a
  // persisted state file after a server restart. False for a brand-new
  // session, or when the state file was missing or corrupt — the UI should
  // show an "awaiting data" indicator rather than silently reading "idle".
  stateRestored: boolean;
  // Issue #323: whether the session was launched with a different version of
  // Mullion than is currently running. When true, the session's hook set may
  // be stale (frozen at launch time) — the UI should show a clock/restart
  // indicator.
  staleHooks: boolean;
  // Issue #323: the Mullion version the session was launched under, read from
  // the state file (or null when no state file was present). Displayed to
  // help users decide whether to restart the session for new capabilities.
  restoredVersion: string | null;
  /** The matched hook adapter's static `emits` capability list for this
   * session's launch command (empty for shells/unmatched). Computed once at
   * launch from the same adapter.matches() call that decides whether to wire
   * hooks. Mirrors pty-manager.ts's SessionInfo.hookEmits 1:1. */
  hookEmits: string[];
  /** Issue #404 — the port most recently detected in this (non-dock)
   * session's scrollback and not yet accepted or dismissed, or null when
   * nothing is currently pending. Mirrors pty-manager.ts's SessionInfo.
   * pendingDevServerPort 1:1 — keying the accept/dismiss action row's
   * visibility off this LIVE field (not the immutable historical
   * `dev_server_detected` event payload) mirrors gateState's own role for
   * review_gate's GateActions in NotificationBell.tsx. */
  pendingDevServerPort: string | null;
}

// Mirrors src/services/session-status.ts's SessionStatus/SessionSeverity 1:1
// — see that file's own doc comments for what each value means and the
// precedence order between them. frontend/src/sessionStatus.ts's
// STATUS_PRESENTATION table is the ONE place these render into a color/icon/
// label; nothing else should re-derive a status from the raw live fields
// above (that's what stopped this codebase's twelve-plus parallel status
// enums from growing a thirteenth — see the plan doc's Context section).
export type SessionStatus =
  | "exited"
  | "api_error"
  | "tool_failure"
  | "awaiting_permission"
  | "awaiting_plan"
  | "awaiting_review_gate"
  | "awaiting_promote"
  | "awaiting_question"
  | "awaiting_elicitation"
  | "finished"
  | "needs_input"
  | "compacting"
  | "subagent"
  | "background"
  | "working"
  | "idle";

export type SessionSeverity =
  "gone" | "failed" | "blocked" | "done" | "waiting" | "busy" | "dormant";

// Phase 1's notification event model (issue #166) — mirrors
// src/services/pty-manager.ts's NotificationEvent 1:1. `seq` is per-session
// (not globally unique — two different sessions can both have `seq: 1`), so
// a consumer keys read/unread state off (sessionId, seq) together, never
// seq alone. Streamed over the new /ws/events channel (eventsClient.ts);
// the existing `attention`/`activity`/`lastTitle` fields on Session above
// stay poll-derived and unchanged — this is purely additive. `file_change`
// and `review_gate` (Phase 2, issue #176) are the first two kinds sourced
// from the structured agent hook channel rather than PTY parsing.
export interface NotificationEvent {
  seq: number;
  sessionId: number;
  kind:
    | "attention"
    | "status_change"
    | "title_change"
    | "file_change"
    | "review_gate"
    | "promote_request"
    | "permission_request"
    | "stop_failure"
    | "tool_failure"
    | "session_end"
    | "plan_ready"
    // Rich statuses — the one new NotificationEvent kind added alongside
    // this feature (see pty-manager.ts's matching doc comment for why
    // turn_start/compact/subagent are routed through "status_change"
    // instead of getting their own kinds).
    | "elicitation"
    | "question"
    | "todo"
    | "session_diff"
    // Issue #404 — mirrors src/services/pty-manager.ts's NotificationEvent
    // 1:1 (see that file's matching doc comment).
    | "dev_server_detected";
  ts: number;
  payload: Record<string, unknown>;
}

export interface Workspace {
  id: number;
  name: string;
  // Opaque dockview api.toJSON() blob — this client never inspects its
  // shape either, just round-trips it through App.tsx's fromJSON()/toJSON().
  layout: Record<string, unknown> | null;
  groupId: number | null;
  position: number;
  createdAt: string;
}

export interface Group {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  collapsed: boolean;
  position: number;
  createdAt: string;
}

export type LauncherKind = "shell" | "agent" | "npm-script" | "task" | "custom";

export interface Launcher {
  id: string;
  title: string;
  command: string;
  cwd?: string;
  icon?: string;
  kind: LauncherKind;
  skipPermissions?: boolean;
}

export type CodexHookTrust = "trusted" | "pending" | "not-installed";

export interface Agent {
  id: string;
  title: string;
  command: string;
  kind: "shell" | "agent";
  available: boolean;
  path: string | null;
  /** Codex's `/hooks` trust status for Mullion's merged hooks (issue #259).
   * Only present on the "codex" agent. */
  hookTrust?: CodexHookTrust;
  /** Rich statuses (issue: extend surfaced session statuses) — the
   * hook-protocol `kind`s this agent's launch can ever produce (mirrors
   * src/services/agent-detect.ts's DetectedAgent.emits 1:1). Empty for
   * shells and for any agent with no hook adapter at all — those reach only
   * the byte-heuristic working/idle/needs_input/exited states. Drives
   * sessionStatus.ts's capability filtering so the UI never offers a status
   * legend entry/filter a given agent can never reach. */
  emits: string[];
}

export interface DiscoveredProject {
  name: string;
  cwd: string;
  isGitRepo: boolean;
  isRegistered: boolean;
}

// Mirrors src/services/github.ts's GitHubRepoStatus 1:1 (issue #27).
// GET /api/projects/:id/github returns 204 (no body) for every
// "not applicable" case (no github.com remote, no account connected, a
// GitHub API error) — callers treat that identically to `null`, never as
// an error to surface.
export interface GitHubIssueOrPr {
  number: number;
  title: string;
  htmlUrl: string;
  author: string | null;
}

// Issue #27 phase 5 — the default branch's latest Actions run per workflow.
export interface GitHubActionsRun {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headSha: string;
}

export type GitHubCiStatus = "success" | "failure" | "in_progress" | null;

// Per-PR CI status (issue #102) — mirrors src/services/github.ts's
// PROrWithChecks 1:1.
export interface GitHubPROrWithChecks {
  number: number;
  title: string;
  htmlUrl: string;
  author: string | null;
  headSha: string;
  headBranch: string;
  baseBranch: string;
  ciStatus: GitHubCiStatus;
  actionsRuns: GitHubActionsRun[];
}

export interface GitHubPRsStatus {
  prs: GitHubPROrWithChecks[];
  prSummary: { total: number; pass: number; fail: number; pending: number; unknown: number };
}

export interface GitHubStatus {
  repo: { owner: string; repo: string; htmlUrl: string };
  openIssues: number;
  openPRs: number;
  pulls: GitHubIssueOrPr[];
  issues: GitHubIssueOrPr[];
  actionsRuns: GitHubActionsRun[];
  ciStatus: GitHubCiStatus;
}

export interface GitHubJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string;
  steps: GitHubStep[];
}

export interface GitHubStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

export interface GitHubLogResponse {
  log: string | null;
  job: GitHubJob | null;
  truncated: boolean;
  lineCount: number;
}

export interface WebhookRegistrationResult {
  reposSucceeded: number;
  reposFailed: number;
}

// Mirrors src/services/git-status.ts's GitStatus 1:1 (issue #76).
// GET /api/projects/:id/git-status returns 204 (no body) for every "not
// applicable" case (not a git repo, or `git` itself failed) — callers treat
// that identically to `null`, same rule as GitHubStatus above.
export type GitFileStatusCode = "M" | "A" | "D" | "U" | "?";

export interface GitFileStatus {
  path: string;
  status: GitFileStatusCode;
}

export interface GitStatus {
  branch: string;
  hash: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  isClean: boolean;
  hasConflicts: boolean;
}

// Mirrors src/services/git-refs.ts's GitBranchInfo/GitWorktreeInfo 1:1 (issue
// #162). GET /api/projects/:id/git-branches returns 204 for the same "not
// applicable" cases as git-status above — fetched on demand when the
// GitPanel opens, not on the sidebar's 4s live-refresh tick (branch/worktree
// lists change far less often than working-tree status).
export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  // Issue #442 — GitPanel branch-management enrichment. All optional, same
  // "old primary / new agent (or the reverse) must degrade" reasoning as
  // the rest of this interface — see src/services/git-refs.ts's own doc
  // comment.
  upstream?: string;
  ahead?: number;
  behind?: number;
  upstreamGone?: boolean;
  lastCommitRelative?: string;
  // Only populated when fetched with `detail: true` (GET .../git-branches
  // ?detail=1) — undefined both when detail wasn't requested and when the
  // base-ref chain fell through to plain HEAD (no remote configured).
  isMerged?: boolean;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface GitBranchesResult {
  branches: GitBranchInfo[];
  worktrees: GitWorktreeInfo[];
  // Remote-tracking branch names (issue #271), e.g. "origin/main" — for the
  // base-ref picker's "not one hardcoded rule" requirement (a human present
  // may want to branch off a remote branch, not just a local one). Kept
  // separate from `branches` rather than merged in — see
  // src/services/git-refs.ts's listRemoteBranches doc comment.
  remoteBranches: string[];
}

// Mirrors src/services/git-branch-delete.ts's DeleteBranchResult, plus the
// "task-branch" reason routes/projects.ts's guard adds on top (the service
// itself is DB-less and never produces it) — issue #442.
export type DeleteBranchReason =
  | "not-a-repo"
  | "invalid-name"
  | "no-such-branch"
  | "current-branch"
  | "checked-out"
  | "unmerged"
  | "delete-failed"
  | "task-branch";

export interface DeleteBranchResult {
  deleted: boolean;
  reason?: DeleteBranchReason;
  detail?: string;
}

// Mirrors src/services/git-worktree.ts's RemoveListedWorktreeResult, plus
// the "sessions-active" reason routes/projects.ts's guard adds on top
// (same DB-less-service reasoning as DeleteBranchResult above) — issue #442.
export type RemoveWorktreeReason =
  | "not-listed"
  | "is-main"
  | "dirty"
  | "conflicts"
  | "not-a-repo"
  | "remove-failed"
  | "sessions-active"
  | "directory-gone";

export interface RemoveWorktreeResult {
  removed: boolean;
  reason?: RemoveWorktreeReason;
  detail?: string;
}

// Mirrors src/services/agent-rules.ts's AgentRuleTarget 1:1 (issue #431).
// `id` is the only thing PUT/DELETE ever send back — a fixed, server-owned
// enum, never a filename or path (see resolveTarget()'s own doc comment on
// why). `status` is null when the file doesn't exist; when it does,
// "shadowed" means a higher-precedence file for the SAME agent already
// wins (currently only Codex's AGENTS.override.md over AGENTS.md) — it says
// nothing about another agent sharing the same absolutePath.
export type AgentRuleAgent = "claude-code" | "codex" | "opencode" | "agy";
export type AgentRuleScope = "project" | "global";
export type AgentRuleStatus = "active" | "shadowed";

export interface AgentRuleTarget {
  id: string;
  agent: AgentRuleAgent;
  agentLabel: string;
  scope: AgentRuleScope;
  fileName: string;
  absolutePath: string;
  exists: boolean;
  size: number | null;
  mtimeMs: number | null;
  status: AgentRuleStatus | null;
  content: string | null;
  truncated: boolean;
  isSymlink: boolean;
}

// Mirrors src/services/skills.ts's SkillInfo 1:1 (issue #432, discovery
// slice; issue #463 added enabledByAgent). No `content`/body field,
// deliberately — the backend never reads a skill's body past its
// frontmatter, only name/description (see that module's own header comment
// on why).
export type SkillAgent = "claude-code" | "codex" | "opencode" | "agy";
export type SkillScope = "builtin" | "global" | "project";

export interface SkillInfo {
  name: string;
  description: string;
  sourceDir: string;
  scope: SkillScope;
  agents: SkillAgent[];
  // `null` means "not toggleable for this agent" — see skills.ts's own doc
  // comment on SkillInfo.enabledByAgent for every reason that can be true
  // (agent not supported yet, ambiguous name, unreadable config).
  enabledByAgent: Partial<Record<SkillAgent, boolean | null>>;
}

// Mirrors src/services/git-diff.ts's GitDiffStats 1:1 (issue #202,
// greenfield) — files-changed + insertions/deletions against HEAD for a
// session's own effective cwd (its own cwd override, or its project's).
export interface GitDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

// Mirrors GET /api/projects/git-file-diff's response (issue #262) — the raw
// unified diff patch for a single file in a session's working tree, or null
// when there's no change to show (clean file, not a repo, not found).
export interface GitFileDiffResponse {
  patch: string | null;
}

// GET /api/projects/git-statuses' response shape (issue #202): project
// statuses and per-session (worktree-aware) statuses are kept in separate
// maps rather than merged into one flat object — project ids and session
// ids are both plain positive integers from different id spaces, so a
// single merged map would be ambiguous about which space a given key
// belongs to.
export interface GitStatusesBatchResult {
  projects: Record<string, GitStatus | null>;
  sessions: Record<string, GitStatus | null>;
}

export interface DockControl {
  id: string;
  title: string;
  command: string;
  cwd?: string;
  height?: number;
  env?: Record<string, string>;
  worktreeRefresh?: boolean;
}

// Mirrors src/services/preview-registry.ts's PreviewSummary 1:1 (issue #28).
// `slug` is the "preview-<slug>" subdomain label the browser pane's iframe
// resolves against (see server-info's previewBaseHost below) — opaque and
// random, never a decodable target.
export interface Preview {
  slug: string;
  kind: "project" | "external";
  projectId: number | null;
  externalUrl: string | null;
  createdAt: string;
}

// Saved URLs per project — quick-access bookmarks in the built-in browser
// (issue #109). `favorite` flags a URL to also surface in the command
// palette's Integrations section.
export interface ProjectUrl {
  id: number;
  projectId: number;
  label: string;
  url: string;
  favorite: boolean;
  order: number;
  createdAt: string;
}

export interface ServerInfo {
  version: string;
  role: "primary" | "agent";
  nodeEnv: string;
  port: number;
  encryptionEnabled: boolean;
  sessionsDir: string;
  dbPath: string;
  uptimeSeconds: number;
  rateLimit: { max: number; window: string };
  projectsRoots: string;
  crsConfigDir: string;
  // Issue #28 — whether the subdomain preview proxy is configured at all
  // (PREVIEW_BASE_HOST set server-side), and if so the base host a browser
  // pane builds its iframe src from: `preview-<slug>.${previewBaseHost}`.
  previewsEnabled: boolean;
  previewBaseHost: string;
  // Issue #383 — whether preview-proxy.ts's bootstrap-token/cookie gate is
  // active; BrowserPanel.tsx mints a bootstrap token (POST
  // /api/previews/:slug/token) and appends it to a preview iframe's URL only
  // when this is true.
  previewAuthRequired: boolean;
  // Phase 2.5 Task Master (Thin Slice) — the single source of truth for
  // whether autonomous behavior (claim/approve/reject) is available; the
  // Tasks panel and local board always render regardless (see
  // src/routes/tasks.ts's own doc comment). Settings UI follow-up: this is
  // now the *resolved* value (env default, overridable via
  // settings.taskMaster.enabled — see taskConfig.ts), not the raw env var,
  // so it changes without a page reload once settings hydrate.
  taskMasterEnabled: boolean;
  // Read-only Task Master deploy-time env values, mirroring
  // src/routes/server-info.ts's taskMasterEnv 1:1 — used by Settings' Task
  // Master section for its "Environment default: N" hints and by
  // taskConfig.ts's resolver. issueLabel/pollIntervalSeconds are shown
  // read-only in the section (see settings.ts's taskMaster doc comment for
  // why they're not settings-overridable).
  taskMasterEnv: {
    enabled: boolean;
    maxConcurrent: number;
    budgetMinutes: number;
    progressCommentMinutes: number;
    issueLabel: string;
    pollIntervalSeconds: number;
  };
}

// Mirrors src/services/task-state.ts's TASK_TRANSITIONS keys (and
// src/db/schema.ts's TASK_STATUSES) 1:1 — Phase 6 Task Master (6.2/#215).
// A closed union so an unhandled status is a `tsc` failure in tasksBoard.ts's
// exhaustive switches, not a runtime surprise (same convention as
// kanban.ts's SessionSeverity switch).
export const TASK_STATUSES = [
  "backlog",
  "ready",
  "claimed",
  "in_progress",
  "reviewing",
  "done",
  "failed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// Mirrors src/routes/tasks.ts's TASK_ROW_COLUMNS (GET /api/tasks and GET
// /api/tasks/:id) 1:1 — issue #214/#219, extended through Phase 6 (#233,
// #215, #217, #220, #283).
export interface Task {
  id: number;
  projectId: number;
  projectName: string;
  // Null for a locally-created task (6.9/#233) — GitHub is an optional
  // synced projection, not a requirement for a task to exist.
  issueNumber: number | null;
  title: string;
  body: string | null;
  htmlUrl: string | null;
  status: TaskStatus;
  // Render/ordering tier within a status column — local-only, never pushed
  // to GitHub. See tasksBoard.ts.
  boardOrder: number;
  sessionId: number | null;
  // The optional advisory review agent's session, when one was configured
  // and this task has reached "reviewing" at least once. Never the same
  // session as sessionId (the worker's own) — see TaskDetail.tsx's separate
  // "Review (advisory)" card.
  reviewSessionId: number | null;
  // #487 — null when no review agent was spawned; true/false once one was,
  // recording whether its adapter could actually receive the review prompt
  // (some agents, e.g. OpenCode, can't — the session still spawns, just
  // with no instructions). See TaskDetail.tsx's review card.
  reviewSeedDelivered: boolean | null;
  worktreePath: string | null;
  branchName: string | null;
  // #491 — the commit SHA the worktree was actually branched from, pinned
  // at claim time (local-hosted projects only; null on remote hosts and on
  // tasks claimed before this column existed). Drives the diff-stat shown
  // on the reviewing issue comment; not otherwise rendered in the UI.
  baseSha: string | null;
  // The resolved launch command actually used for the worker session (issue
  // `Agent:` line -> projects.defaultAgent -> settings.launchers.defaultAgent),
  // recorded once at claim time.
  agentCommand: string | null;
  prUrl: string | null;
  assignee: string | null;
  // Why a task went "failed" — session death, budget exceeded, or spawn
  // failure. Also carries the human's reject feedback while the task is
  // in_progress (only rendered in the UI when status === "failed" — see
  // TaskDetail.tsx). NOT a GitHub sync/scope error — see githubSyncError.
  failureReason: string | null;
  // #485 — the most recent GitHub sync or promotion failure (e.g. an
  // under-scoped token's 403), independent of task status and cleared the
  // next time any sync for this task succeeds. Null means no known problem,
  // not "never synced."
  githubSyncError: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  reviewingAt: string | null;
  completedAt: string | null;
}

// Mirrors src/services/update-checker.ts's UpdateCheckResult.
export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  assetUrl: string | null;
  checksumUrl: string | null;
  // Whether POST /api/updates/apply would even work — false on a dev
  // checkout (MULLION_HOME unset), true on a versioned-release install.
  applyAvailable: boolean;
  // Epoch ms of when GitHub was actually last queried for this result —
  // unchanged across a backend cache hit, so it reflects real staleness
  // rather than "when this response happened to arrive" (issue #123).
  checkedAt: number;
}

// Phases self-update.sh writes to $MULLION_HOME/.update-status.json as it
// runs (see src/routes/updates.ts) — "unavailable" is server-side-only
// (MULLION_HOME unset), "idle" means MULLION_HOME is set but no update has
// run yet.
export type UpdatePhase =
  | "unavailable"
  | "idle"
  | "downloading"
  | "installing"
  | "verifying"
  | "restarting"
  | "done"
  | "failed";

export interface UpdateStatus {
  phase: UpdatePhase;
  version?: string;
  updatedAt?: number;
  error?: string;
}

// Mirrors src/services/settings.ts's AppSettings 1:1 — duplicated rather
// than shared across the workspace boundary (frontend/ is its own npm
// workspace with its own tsconfig), same pattern as Project/Session/etc.
// above already being independent copies of the backend's row shapes.
export type Theme = "dark" | "light" | "system";
export type CursorStyle = "block" | "bar" | "underline";
export type SidebarDensity = "comfortable" | "compact";
export type SoundName = "ping" | "chime" | "blip";

export interface AppSettings {
  theme: Theme;
  terminal: {
    fontFamily: string;
    fontSize: number;
    // Inner inset (px) between the dockview panel edge and the rendered
    // terminal content, applied on all four sides — issue #91: xterm.js
    // renders flush against the panel edge by default (unlike CLIs such as
    // opencode that reserve their own internal margin), so this gives every
    // CLI the same breathing room a real terminal emulator already provides.
    padding: number;
    colorScheme: string;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    scrollback: number;
    copyOnSelect: boolean;
    pasteOnRightClick: boolean;
    // Mirrors settings.ts's DEFAULT_SETTINGS — honors OSC 52 clipboard-write
    // requests from the foreground program (Claude Code / opencode both copy
    // this way). See TerminalPane.tsx for the handler and the read-side
    // security note (OSC 52 reads are never answered, regardless of this).
    clipboardWrite: boolean;
    reconnect: {
      enabled: boolean;
      maxAttempts: number;
    };
    keyCapture: {
      ctrlR: boolean;
      ctrlL: boolean;
      ctrlK: boolean;
    };
    // Mirrors settings.ts's DEFAULT_SETTINGS — opt-in clipboard chords (issue
    // #67 follow-up). See TerminalPane.tsx's attachKeyConflictHandler for the
    // vim/readline Ctrl+V tradeoff and the Ctrl+C selection-vs-SIGINT logic.
    clipboardKeys: {
      ctrlV: boolean;
      ctrlC: boolean;
    };
  };
  sidebarDensity: SidebarDensity;
  projectRoots: string[];
  launchers: {
    defaultShell: string;
    defaultAgent: string;
    hiddenAgents: string[];
    skipPermissionsAgents: string[];
  };
  notifications: {
    channels: {
      browser: boolean;
      sound: boolean;
    };
    soundName: SoundName;
    idleThresholdSeconds: number;
    // #98 item 4 — auto-bring-into-focus on an attention transition
    // (App.tsx's autoFocusAttentionRef effect). Default false, per the
    // issue's own "could be optional" framing — unlike a sound/desktop
    // notification, this reaches into the grid and changes what's on
    // screen, which is disruptive if the user is mid-task in a different
    // pane. Combined with `notificationMatrix`'s own `autoFocus` column
    // (both must be true for a given status to auto-focus) — see App.tsx.
    autoFocusOnAttention: boolean;
    /** Per-status notification matrix. Rows = status keys, columns =
     * notify/sound/autoFocus. Seeded from DEFAULT_SETTINGS on first read;
     * mirrors settings.ts 1:1. Replaces the old flat attentionAlerts/
     * exitedAlerts/finishedAlerts toggles (issue #318) — see
     * sessionStatus.ts's STATUS_PRESENTATION.defaultNotify for the
     * per-status rationale these defaults mirror. */
    notificationMatrix: Record<
      SessionStatus,
      { notify: boolean; sound: boolean; autoFocus: boolean }
    >;
  };
  dock: {
    defaultWorktreeRefresh: boolean;
    // Issue #404 — mirrors src/services/settings.ts's AppSettings.dock.
    // autoDetectDevServer 1:1. "ask" (default) surfaces a detected dev
    // server in a plain session as a dev_server_detected notification the
    // user can accept/dismiss; "off" disables the background scan.
    autoDetectDevServer: "ask" | "off";
  };
  sessions: {
    namePattern: string;
    confirmBeforeKill: boolean;
    hideEndedSessions: boolean;
    reconcileIntervalSeconds: number;
    // Rich statuses (fix: transient status clearing) — TTL backstop for a
    // session's errorState; mirrors src/services/settings.ts 1:1. Surfaced
    // in Settings.tsx as "Stale error timeout" (fix: status-clearing-
    // semantics).
    staleErrorSeconds: number;
    // Issue #320 follow-up — separate, longer-default TTL backstop for the
    // busy latches (compactState/subagentCount); mirrors
    // src/services/settings.ts 1:1. Surfaced in Settings.tsx as "Stale busy
    // timeout".
    staleBusySeconds: number;
    // How often the background git-fetcher runs for autoFetch-enabled projects
    // (src/plugins/git-fetcher.ts). 0 disables auto-fetch entirely.
    gitAutoFetchIntervalSeconds: number;
    // Issue #213 (roadmap 4.7) — opt-in persistence of notification events to
    // the session_events table. Default off, matching Phase 1's in-memory-only
    // event model. Primary-local only: only sessions this process itself
    // spawned are ever captured.
    eventPersistence: boolean;
    // Age (in days) past which persisted session_events rows are swept.
    // 0 = unlimited/no sweep, same "0 disables" convention as
    // gitAutoFetchIntervalSeconds above. Server clamps to [0, 3650].
    eventRetentionDays: number;
    // Issue #405 — mirrors src/services/settings.ts 1:1. Gates only the
    // SessionStart auto-inject pointer to the per-session agent guide copy
    // (src/plugins/hooks.ts), never the per-session file write itself.
    // Surfaced in Settings.tsx's Sessions section.
    injectAgentGuide: boolean;
    // Phase 5 (Track B, issue #193 5.3b) — mirrors src/services/settings.ts
    // 1:1. Surfaced in Settings.tsx's Sessions section ("Max child sessions
    // per parent").
    maxChildSessionsPerParent: number;
    // Phase 5 (Track B, issue #194 5.4) — mirrors src/services/settings.ts
    // 1:1. Gates ONLY whether a spawned child's panel auto-opens
    // (App.tsx); the child itself always appears in the sidebar regardless.
    // Surfaced in Settings.tsx's Sessions section ("Auto-open child session
    // panels").
    autoOpenChildPanels: boolean;
  };
  // Mirrors src/services/settings.ts's AppSettings.taskMaster 1:1 — see its
  // doc comment for the full sentinel rationale. enabled/maxConcurrent/
  // budgetMinutes/progressCommentMinutes each override the matching
  // MULLION_TASK_* env default at runtime; -1 / "inherit" means "no
  // override, use the env default" (see taskConfig.ts's resolveTaskMaster,
  // the frontend mirror of the backend's own resolver). Surfaced in
  // Settings.tsx's Task Master section.
  taskMaster: {
    autoClaimPaused: boolean;
    enabled: "inherit" | "on" | "off";
    maxConcurrent: number;
    budgetMinutes: number;
    progressCommentMinutes: number;
  };
}

// A recursive partial — every level of AppSettings is independently
// patchable (e.g. `{ terminal: { fontSize: 18 } }` without also sending
// `terminal.cursorStyle`), matching the backend's deep-merge PATCH. Arrays
// (projectRoots) are a leaf, not recursed into — the backend replaces them
// outright rather than merging element-wise.
type DeepPartial<T> =
  T extends Array<unknown> ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export type SettingsPatch = DeepPartial<AppSettings>;

// Mirrors src/services/settings.ts's DEFAULT_SETTINGS 1:1 — the store seeds
// its `settings` state with this synchronously at module load (before the
// GET /api/settings hydration resolves), so every consumer always has a
// sane value instead of racing an async fetch on first paint.
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  terminal: {
    fontFamily: "Geist Mono",
    fontSize: 14,
    // Mirrors settings.ts's DEFAULT_SETTINGS.
    padding: 4,
    colorScheme: "default",
    cursorStyle: "block",
    cursorBlink: true,
    // Mirrors settings.ts's DEFAULT_SETTINGS — raised from 1000 (issue #83),
    // see that file's comment for why.
    scrollback: 5000,
    copyOnSelect: true,
    pasteOnRightClick: false,
    clipboardWrite: true,
    reconnect: {
      enabled: true,
      maxAttempts: 8,
    },
    keyCapture: {
      ctrlR: true,
      ctrlL: true,
      ctrlK: false,
    },
    clipboardKeys: {
      ctrlV: false,
      ctrlC: false,
    },
  },
  sidebarDensity: "comfortable",
  projectRoots: [],
  launchers: {
    defaultShell: "zsh",
    defaultAgent: "claude",
    hiddenAgents: [],
    skipPermissionsAgents: [],
  },
  notifications: {
    channels: {
      browser: true,
      sound: false,
    },
    soundName: "ping",
    idleThresholdSeconds: 30,
    autoFocusOnAttention: false,
    notificationMatrix: {
      exited: { notify: false, sound: false, autoFocus: false },
      api_error: { notify: true, sound: false, autoFocus: false },
      tool_failure: { notify: true, sound: false, autoFocus: false },
      awaiting_permission: { notify: true, sound: false, autoFocus: false },
      awaiting_plan: { notify: true, sound: false, autoFocus: false },
      awaiting_review_gate: { notify: true, sound: false, autoFocus: false },
      awaiting_promote: { notify: true, sound: false, autoFocus: false },
      awaiting_elicitation: { notify: true, sound: false, autoFocus: false },
      finished: { notify: false, sound: false, autoFocus: false },
      needs_input: { notify: true, sound: false, autoFocus: false },
      compacting: { notify: false, sound: false, autoFocus: false },
      subagent: { notify: false, sound: false, autoFocus: false },
      background: { notify: false, sound: false, autoFocus: false },
      working: { notify: false, sound: false, autoFocus: false },
      idle: { notify: false, sound: false, autoFocus: false },
    } as Record<SessionStatus, { notify: boolean; sound: boolean; autoFocus: boolean }>,
  },
  dock: {
    defaultWorktreeRefresh: false,
    autoDetectDevServer: "ask",
  },
  sessions: {
    namePattern: "{agent} · {project}",
    confirmBeforeKill: true,
    hideEndedSessions: false,
    reconcileIntervalSeconds: 30,
    // Mirrors settings.ts's DEFAULT_SETTINGS — raised from 600 (fix:
    // status-clearing-semantics), see that file's comment for why.
    staleErrorSeconds: 1800,
    // Mirrors settings.ts's DEFAULT_SETTINGS.
    staleBusySeconds: 7200,
    gitAutoFetchIntervalSeconds: 300,
    eventPersistence: false,
    eventRetentionDays: 30,
    injectAgentGuide: true,
    maxChildSessionsPerParent: 5,
    autoOpenChildPanels: false,
  },
  taskMaster: {
    autoClaimPaused: false,
    enabled: "inherit",
    maxConcurrent: -1,
    budgetMinutes: -1,
    progressCommentMinutes: -1,
  },
};

// Carries the HTTP status code alongside the backend's message so a caller
// can branch on the actual response (e.g. Settings -> Hosts' cascade-delete
// prompt checking `statusCode === 409`) instead of substring-matching
// error text, which silently breaks the moment the backend's wording changes.
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // Same-origin only (never sent cross-origin) — required for the
    // optional in-process auth session cookie (issue #19,
    // src/plugins/auth.ts) to ride along; a no-op when MULLION_AUTH_TOKEN is
    // unset, since there's no cookie to send either way.
    credentials: "same-origin",
    // Only set this when there's actually a body — sending it on bodyless
    // requests (GET, DELETE) is invalid and some fetch layers reject it outright.
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message || `${path} failed with ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function normalizeAgentId(id: string): string {
  return id.startsWith("agent:") ? id.slice(6) : id;
}

export const api = {
  listProjects: () => request<Project[]>("/api/projects"),

  createProject: (name: string, cwd: string, hostId?: string) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(hostId ? { name, cwd, hostId } : { name, cwd }),
    }),

  updateProject: (
    id: number,
    patch: Partial<
      Pick<Project, "name" | "cwd" | "devServerUrl" | "defaultAgent" | "defaultReviewAgent">
    > & { autoFetch?: boolean | null },
  ) =>
    request<Project>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteProject: (id: number) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),

  discoverProjects: (hostId?: string) =>
    request<DiscoveredProject[]>(
      `/api/projects/discover${hostId ? `?hostId=${encodeURIComponent(hostId)}` : ""}`,
    ),

  listProjectActions: (projectId: number) =>
    request<Launcher[]>(`/api/projects/${projectId}/actions`),

  listProjectDock: (projectId: number) => request<DockControl[]>(`/api/projects/${projectId}/dock`),

  // Issue #431 — the full target list (all agents, both scopes), content
  // inlined for whatever exists. Never 204s — see routes/agent-rules.ts's
  // own comment on why the target LIST itself is never "not applicable",
  // only individual targets' `exists` flags are.
  listAgentRules: (projectId: number) =>
    request<AgentRuleTarget[]>(`/api/projects/${projectId}/agent-rules`),

  writeProjectAgentRule: (projectId: number, targetId: string, content: string) =>
    request<AgentRuleTarget>(
      `/api/projects/${projectId}/agent-rules/${encodeURIComponent(targetId)}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    ),

  deleteProjectAgentRule: (projectId: number, targetId: string) =>
    request<void>(`/api/projects/${projectId}/agent-rules/${encodeURIComponent(targetId)}`, {
      method: "DELETE",
    }),

  // Issue #432 — global + builtin skills only, no project context (Settings'
  // read-only "resolved skill dirs" listing).
  listGlobalSkills: () => request<SkillInfo[]>("/api/skills"),

  // Project-scope skills for `projectId`, plus every global/builtin one on
  // that project's own host (local or remote — see routes/skills.ts).
  listProjectSkills: (projectId: number) =>
    request<SkillInfo[]>(`/api/projects/${projectId}/skills`),

  // Issue #463 — body-only {agent, name, enabled} (see routes/skills.ts's
  // own header for why no path params). Returns the freshly re-resolved
  // SkillInfo row; SkillsPanel still does a full listProjectSkills refetch
  // afterward anyway (same non-optimistic pattern as
  // writeProjectAgentRule/AgentRulesPanel) rather than patching just this
  // one row into client state.
  writeSkillEnabled: (projectId: number, agent: SkillAgent, name: string, enabled: boolean) =>
    request<SkillInfo>(`/api/projects/${projectId}/skills`, {
      method: "PUT",
      body: JSON.stringify({ agent, name, enabled }),
    }),

  // undefined for the 204 "not applicable" response (see GitHubStatus above)
  // — request() already returns undefined for a 204 body, this just gives
  // that case an honest return type instead of asserting GitHubStatus.
  getProjectGitHub: (projectId: number) =>
    request<GitHubStatus | undefined>(`/api/projects/${projectId}/github`),

  // Per-PR CI status (issue #102) — reads from the server-side poller's
  // warm cache. Returns undefined (204) when the poller hasn't run yet or
  // the repo has no open PRs. Optional `branch` (issue #202) filters down
  // to whichever PR (if any) has that branch as its head — not used by the
  // sidebar's per-session rows (which fetch the unfiltered list once per
  // project and match `headBranch` client-side instead, to avoid one
  // request per session), but exposed here since the backend route
  // supports it and any future single-session/detail view can use it
  // directly.
  getProjectGitHubPRs: (projectId: number, branch?: string) =>
    request<GitHubPRsStatus | undefined>(
      `/api/projects/${projectId}/github/prs${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`,
    ),

  // Phase 2 — jobs and logs for a workflow run (issue #102 follow-up).
  getGitHubRunJobs: (projectId: number, runId: number) =>
    request<GitHubJob[]>(`/api/projects/${projectId}/github/actions/${runId}/jobs`),

  getGitHubLogs: (projectId: number, runId: number, jobId: number, lines?: number) =>
    request<GitHubLogResponse>(
      `/api/projects/${projectId}/github/actions/${runId}/jobs/${jobId}/logs${lines ? `?lines=${lines}` : ""}`,
    ),

  enableGitHubWebhooks: () =>
    request<WebhookRegistrationResult>("/api/integrations/github/webhooks", {
      method: "POST",
    }),

  disableGitHubWebhooks: () =>
    request<void>("/api/integrations/github/webhooks", {
      method: "DELETE",
    }),

  getGitHubWebhookStatus: () =>
    request<{ enabled: boolean; reposSucceeded?: number; reposFailed?: number }>(
      "/api/integrations/github/webhooks/status",
    ),

  // undefined for the 204 "not applicable" response (see GitStatus above).
  // `opts.fresh` (issue #433, Hermes review on PR #506) bypasses the
  // backend's ~5s git-status cache — pass it only for an explicit user
  // "Fetch" action (SourceControlSection, GitPanel), never the 4s
  // live-refresh poll, which should keep benefiting from that cache.
  getProjectGitStatus: (projectId: number, opts: { fresh?: boolean } = {}) =>
    request<GitStatus | undefined>(
      `/api/projects/${projectId}/git-status${opts.fresh ? "?fresh=1" : ""}`,
    ),

  // Batch git-status for the sidebar's live-refresh loop: replaces N
  // parallel per-project requests with a single request. Returns
  // `{ projects, sessions }` (see GitStatusesBatchResult above); entries
  // whose git status was transiently unavailable (503-equivalent on the
  // per-project endpoint) are simply omitted from their map, letting the
  // caller keep last-known-good for those. Null means "durably not a git
  // repo" (the per-project endpoint's 204 case). `sessionIds` (issue #202)
  // additionally requests per-session (worktree-aware) status.
  getProjectGitStatuses: (ids: number[], sessionIds: number[] = []) => {
    // Built manually (not URLSearchParams) so ids stay comma-joined as
    // plain "1,2,3" — URLSearchParams percent-encodes the comma, which the
    // backend's own parseIdListParam splits on either way, but keeping the
    // querystring shape identical to the rest of this file's `ids=` params
    // (getProjectGitStatuses's own sibling batch calls, discoverProjects,
    // etc.) avoids a one-off encoding just for this route.
    const parts: string[] = [];
    if (ids.length > 0) parts.push(`ids=${ids.join(",")}`);
    if (sessionIds.length > 0) parts.push(`sessionIds=${sessionIds.join(",")}`);
    return request<GitStatusesBatchResult>(
      `/api/projects/git-statuses${parts.length > 0 ? `?${parts.join("&")}` : ""}`,
    );
  },

  // undefined for the 204 "not applicable" response (see GitBranchesResult
  // above). `detail` (issue #442) requests the opt-in isMerged enrichment —
  // defaults to off so store.ts's refreshGitRefs call site (the 60s
  // background poll) stays literally unchanged and keeps paying for
  // exactly the one for-each-ref spawn it always has.
  getProjectGitBranches: (projectId: number, detail?: boolean) =>
    request<GitBranchesResult | undefined>(
      `/api/projects/${projectId}/git-branches${detail ? "?detail=1" : ""}`,
    ),

  // Manual git fetch trigger — runs `git fetch origin` for this project now.
  postProjectGitFetch: (projectId: number) =>
    request<{ success: boolean; error?: string }>(`/api/projects/${projectId}/git-fetch`, {
      method: "POST",
    }),

  // Issue #442 — GitPanel manual branch deletion. `deleted: false` with a
  // `reason` is a normal 200 response (a git-level refusal), not a thrown
  // ApiError — only a genuine HTTP error (4xx/5xx) throws.
  deleteProjectGitBranch: (projectId: number, name: string, force?: boolean) =>
    request<DeleteBranchResult>(`/api/projects/${projectId}/git-branch-delete`, {
      method: "POST",
      body: JSON.stringify({ name, force }),
    }),

  // Issue #442 — GitPanel manual worktree removal. Same "refusal is a 200,
  // not a throw" shape as deleteProjectGitBranch above.
  removeProjectGitWorktree: (projectId: number, worktreePath: string, force?: boolean) =>
    request<RemoveWorktreeResult>(`/api/projects/${projectId}/git-worktree-remove`, {
      method: "POST",
      body: JSON.stringify({ worktreePath, force }),
    }),

  // Issue #442 — GitPanel "Prune stale" button (`git worktree prune` only —
  // never removes a worktree that still exists on disk).
  pruneProjectGitWorktrees: (projectId: number) =>
    request<{ pruned: boolean }>(`/api/projects/${projectId}/git-worktree-prune`, {
      method: "POST",
    }),

  // Batch diff stats (issue #202, greenfield) — same batching motivation and
  // shape as getProjectGitStatuses's sessionIds above, but session-only
  // (diff stats are inherently per-cwd, and every session has an effective
  // cwd whether or not it's a distinct worktree). A missing entry means
  // "transiently unavailable"; `null` means "not a repo, or nothing to diff
  // yet" (unborn HEAD).
  getSessionGitDiffStats: (sessionIds: number[]): Promise<Record<string, GitDiffStats | null>> => {
    if (sessionIds.length === 0) return Promise.resolve({});
    return request<Record<string, GitDiffStats | null>>(
      `/api/projects/git-diff-stats?sessionIds=${sessionIds.join(",")}&base=AUTO`,
    );
  },

  // Per-file unified diff (issue #262, follow-up to #177) — fetches the raw
  // patch for a single file in the session's working tree. Called on-demand
  // when the user clicks a file-change chip in the sidebar.
  getSessionGitFileDiff: (sessionId: number, path: string): Promise<GitFileDiffResponse> =>
    request<GitFileDiffResponse>(
      `/api/projects/git-file-diff?sessionId=${sessionId}&path=${encodeURIComponent(path)}&base=AUTO`,
    ),

  // Same endpoint, keyed by project instead of session (issue #433's Source
  // Control sidebar section, which has no session to anchor to).
  getProjectGitFileDiff: (projectId: number, path: string): Promise<GitFileDiffResponse> =>
    request<GitFileDiffResponse>(
      `/api/projects/git-file-diff?projectId=${projectId}&path=${encodeURIComponent(path)}&base=AUTO`,
    ),

  listProjectUrls: (projectId: number) => request<ProjectUrl[]>(`/api/projects/${projectId}/urls`),

  listFavoriteUrls: () => request<ProjectUrl[]>("/api/browser-urls/favorites"),

  createProjectUrl: (projectId: number, label: string, url: string, favorite?: boolean) =>
    request<ProjectUrl>(`/api/projects/${projectId}/urls`, {
      method: "POST",
      body: JSON.stringify({ label, url, favorite }),
    }),

  updateProjectUrl: (
    projectId: number,
    urlId: number,
    patch: Partial<Pick<ProjectUrl, "label" | "url" | "favorite">>,
  ) =>
    request<ProjectUrl>(`/api/projects/${projectId}/urls/${urlId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteProjectUrl: (projectId: number, urlId: number) =>
    request<void>(`/api/projects/${projectId}/urls/${urlId}`, { method: "DELETE" }),

  reorderProjectUrls: (projectId: number, ids: number[]) =>
    request<void>(`/api/projects/${projectId}/urls/reorder`, {
      method: "PATCH",
      body: JSON.stringify({ ids }),
    }),

  listSessions: (opts?: { projectId?: number; kind?: "terminal" | "dock" }) => {
    const params = new URLSearchParams();
    if (opts?.projectId !== undefined) params.set("projectId", String(opts.projectId));
    if (opts?.kind !== undefined) params.set("kind", opts.kind);
    const qs = params.toString();
    return request<Session[]>(`/api/sessions${qs ? `?${qs}` : ""}`);
  },

  createSession: (
    projectId: number,
    command: string,
    opts?: {
      name?: string;
      cwd?: string;
      kind?: "terminal" | "dock";
      // Issue #271, option 1 — the launcher's opt-in "isolate this session"
      // toggle: create the session inside a fresh worktree instead of `cwd`.
      worktree?: { baseRef: string; branchName?: string } | { branch: string };
      // When true, a preview worktree created for this session is
      // periodically synced to the branch's latest commit.
      worktreeRefresh?: boolean;
      skipPermissions?: boolean;
    },
  ) =>
    request<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId, command, ...opts }),
    }),

  renameSession: (id: number, name: string) =>
    request<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  deleteSession: (id: number) => request<void>(`/api/sessions/${id}`, { method: "DELETE" }),

  // Issue #271, option 2 — "promote an existing session": creates a
  // worktree, moves work into a new session there, and kills the source.
  promoteSession: (
    id: number,
    opts: { baseRef: string; branchName?: string; seedPrompt?: string },
  ) =>
    request<Session>(`/api/sessions/${id}/promote`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),

  declinePromote: (id: number, reason?: string) =>
    request<void>(`/api/sessions/${id}/promote/decline`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  // Minimal review gate (issue #178) — delivers a human's Approve/Deny
  // decision (NotificationBell.tsx) for a session's pending `review_gate`.
  resolveReviewGate: (id: number, decision: "approved" | "denied", reason?: string) =>
    request<void>(`/api/sessions/${id}/review-gate`, {
      method: "POST",
      body: JSON.stringify({ decision, ...(reason !== undefined ? { reason } : {}) }),
    }),

  // Issue #404 — accepts a plain session's detected dev-server offer: wires
  // the already-running server into the project's devServerUrl + preview
  // (never spawns a second session). `preview` is null when
  // PREVIEW_BASE_HOST isn't configured (previews disabled server-wide).
  acceptDevServerPort: (id: number, port: string) =>
    request<{ devServerUrl: string; preview: Preview | null }>(
      `/api/sessions/${id}/dev-server/accept`,
      { method: "POST", body: JSON.stringify({ port }) },
    ),

  // Issue #404 — dismisses a plain session's detected dev-server offer so
  // the same (session, port) doesn't re-offer.
  dismissDevServerPort: (id: number, port: string) =>
    request<void>(`/api/sessions/${id}/dev-server/dismiss`, {
      method: "POST",
      body: JSON.stringify({ port }),
    }),

  // Phase 2.5 Task Master, Thin Slice (issue #219), extended by Phase 6's
  // task board (6.5/#218) with the optional filters GET /api/tasks now
  // accepts. Always 200s with [] when the feature is disabled or nothing's
  // been ingested yet (see ServerInfo's taskMasterEnabled) — the local board
  // itself works regardless (see the roadmap's Flag semantics decision).
  listTasks: (params?: { status?: TaskStatus; projectId?: number }) => {
    const q = new URLSearchParams();
    if (params?.status !== undefined) q.set("status", params.status);
    if (params?.projectId !== undefined) q.set("projectId", String(params.projectId));
    const qs = q.toString();
    return request<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
  },

  // Phase 6 (6.9/#233) — local-board creation, works with
  // MULLION_TASK_MASTER_ENABLED off. A task created here has no GitHub
  // issue link (issueNumber/htmlUrl stay null).
  createTask: (projectId: number, title: string, body?: string | null) =>
    request<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId, title, body: body ?? undefined }),
    }),

  // boardOrder is editable for any task; title/body only for a task with no
  // linked GitHub issue; status only while the task is still backlog/ready
  // (see routes/tasks.ts's own doc comment — claimed/in_progress/reviewing/
  // done/failed require claim/approve/reject instead).
  updateTask: (
    id: number,
    patch: {
      title?: string;
      body?: string | null;
      status?: "backlog" | "ready";
      boardOrder?: number;
    },
  ) => request<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteTask: (id: number) => request<void>(`/api/tasks/${id}`, { method: "DELETE" }),

  // Claims a ready task: creates an isolated worktree, spawns the resolved
  // agent there seeded with the issue/task as its prompt, and returns the
  // spawned Session — same response shape createSession returns, plus
  // whether the seed prompt was actually delivered.
  claimTask: (id: number) =>
    request<Session & { seedDelivered: boolean }>(`/api/tasks/${id}/claim`, { method: "POST" }),

  // reviewing -> done: pushes the branch, opens a PR, closes the issue.
  approveTask: (id: number) => request<Task>(`/api/tasks/${id}/approve`, { method: "POST" }),

  // reviewing -> in_progress: posts optional feedback, re-seeds a fresh
  // session in the same worktree if the worker's own session already exited.
  rejectTask: (id: number, feedback?: string) =>
    request<Task>(`/api/tasks/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(feedback ? { feedback } : {}),
    }),

  // #483 — failed -> claimed: resumes on the task's preserved
  // mullion/task-<id> branch (no work lost) rather than starting a fresh
  // one, spawning a new session there. Same response shape as claimTask.
  retryTask: (id: number) =>
    request<Session & { seedDelivered: boolean }>(`/api/tasks/${id}/retry`, { method: "POST" }),

  // #483 — reviewing -> failed: the other resolver of a reviewing task,
  // alongside approve/reject, for when the answer is "give up entirely"
  // rather than "try again."
  giveUpTask: (id: number, reason?: string) =>
    request<Task>(`/api/tasks/${id}/give-up`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),

  // Issue #68: uploads a pasted/attached image (Blob straight off the
  // clipboard or a file input — never re-encoded) so the backend can write
  // it under this session's own cwd and hand back the path to inject into
  // the terminal. request()'s own header logic already sets Content-Type
  // from init.headers when present, overriding its "application/json"
  // default — passing the blob's own type here is enough, no separate
  // raw-body fetch needed.
  uploadSessionImage: (sessionId: number, blob: Blob) =>
    request<{ path: string }>(`/api/sessions/${sessionId}/uploads`, {
      method: "POST",
      body: blob,
      headers: { "Content-Type": blob.type },
    }),

  listWorkspaces: () => request<Workspace[]>("/api/workspaces"),

  createWorkspace: (name: string) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  renameWorkspace: (id: number, name: string) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  saveWorkspaceLayout: (id: number, layout: Record<string, unknown>) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ layout }),
    }),

  setWorkspaceGroup: (id: number, groupId: number | null, position?: number) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ groupId, ...(position !== undefined ? { position } : {}) }),
    }),

  deleteWorkspace: (id: number) => request<void>(`/api/workspaces/${id}`, { method: "DELETE" }),

  listGroups: () => request<Group[]>("/api/groups"),

  createGroup: (name: string, color?: string) =>
    request<Group>("/api/groups", {
      method: "POST",
      body: JSON.stringify(color !== undefined ? { name, color } : { name }),
    }),

  updateGroup: (
    id: number,
    patch: Partial<Pick<Group, "name" | "icon" | "color" | "collapsed" | "position">>,
  ) =>
    request<Group>(`/api/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteGroup: (id: number) => request<void>(`/api/groups/${id}`, { method: "DELETE" }),

  listGlobalActions: () => request<Launcher[]>("/api/actions"),

  listAgents: (refresh?: boolean) => request<Agent[]>(`/api/agents${refresh ? "?refresh=1" : ""}`),
  getSkipPermissionFlags: () =>
    request<Record<string, string>>("/api/agents/skip-permissions-flags"),

  getServerInfo: () => request<ServerInfo>("/api/server-info"),
  checkForUpdate: (force?: boolean) =>
    request<UpdateCheckResult>(`/api/updates/check${force ? "?force=true" : ""}`),
  getUpdateStatus: () => request<UpdateStatus>("/api/updates/status"),
  applyUpdate: (version: string, assetUrl: string, checksumUrl: string) =>
    request<UpdateStatus>("/api/updates/apply", {
      method: "POST",
      body: JSON.stringify({ version, assetUrl, checksumUrl }),
    }),

  getSettings: () => request<AppSettings>("/api/settings"),

  patchSettings: (patch: SettingsPatch) =>
    request<AppSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  listHosts: () => request<Host[]>("/api/hosts"),

  createHost: (name: string, baseUrl: string, token: string) =>
    request<Host>("/api/hosts", {
      method: "POST",
      body: JSON.stringify({ name, baseUrl, token }),
    }),

  updateHost: (id: string, patch: Partial<{ name: string; baseUrl: string; token: string }>) =>
    request<Host>(`/api/hosts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // `?cascade=true` best-effort terminates every live session under this
  // host's projects and deletes them along with it — see
  // src/routes/hosts.ts's DELETE handler. Without it, a host that still
  // owns projects 409s (surfaced to the caller as a thrown Error whose
  // message names the project count, per request()'s body.message handling
  // above).
  deleteHost: (id: string, opts?: { cascade?: boolean }) =>
    request<void>(`/api/hosts/${encodeURIComponent(id)}${opts?.cascade ? "?cascade=true" : ""}`, {
      method: "DELETE",
    }),

  pingHost: (id: string) =>
    request<{ online: boolean }>(`/api/hosts/${encodeURIComponent(id)}/ping`, { method: "POST" }),

  getGitHubIntegration: () => request<GitHubIntegration>("/api/integrations/github"),

  setGitHubToken: (token: string) =>
    request<GitHubIntegration>("/api/integrations/github/token", {
      method: "PUT",
      body: JSON.stringify({ token }),
    }),

  disconnectGitHub: () => request<void>("/api/integrations/github", { method: "DELETE" }),

  startGitHubDeviceFlow: () =>
    request<DeviceFlowStatus>("/api/integrations/github/device/start", { method: "POST" }),

  getGitHubDeviceFlowStatus: () =>
    request<DeviceFlowStatus>("/api/integrations/github/device/status"),

  listBrowserCookieProfiles: (projectId: number) =>
    request<BrowserCookieProfile[]>(`/api/projects/${projectId}/browser-cookies`),

  importBrowserCookieProfile: (
    projectId: number,
    input: { browser: "chrome" | "firefox"; profilePath: string; label: string },
  ) =>
    request<BrowserCookieProfile>(`/api/projects/${projectId}/browser-cookies/import`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  uploadBrowserCookieProfile: (
    projectId: number,
    body: { browser: "chrome" | "firefox"; fileBase64: string; label: string },
  ) =>
    request<BrowserCookieProfile>(`/api/projects/${projectId}/browser-cookies/upload`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteBrowserCookieProfile: (projectId: number, id: number) =>
    request<void>(`/api/projects/${projectId}/browser-cookies/${id}`, { method: "DELETE" }),

  getDevServerStatus: (projectId: number) =>
    request<{ online: boolean }>(`/api/projects/${projectId}/dev-server-status`),

  // Idempotent by projectId — reopening the same project's browser pane
  // reuses its existing preview row/slug rather than minting a new one (see
  // src/services/preview-registry.ts).
  createProjectPreview: (projectId: number) =>
    request<Preview>("/api/previews", {
      method: "POST",
      body: JSON.stringify({ kind: "project", projectId }),
    }),

  createExternalPreview: (url: string) =>
    request<Preview>("/api/previews", {
      method: "POST",
      body: JSON.stringify({ kind: "external", url }),
    }),

  getPreview: (slug: string) => request<Preview>(`/api/previews/${encodeURIComponent(slug)}`),

  deletePreview: (slug: string) =>
    request<void>(`/api/previews/${encodeURIComponent(slug)}`, { method: "DELETE" }),

  // Issue #383 — mints the 60-second bootstrap token BrowserPanel.tsx
  // appends to a preview iframe's URL when previewAuthRequired is true (see
  // ServerInfo above). Only called when that flag is set; a no-op path
  // otherwise.
  mintPreviewToken: (slug: string) =>
    request<{ token: string }>(`/api/previews/${encodeURIComponent(slug)}/token`, {
      method: "POST",
    }),

  // Never gated by src/plugins/auth.ts's own onRequest hook (see its
  // /api/auth/ prefix exemption) — a request has to be able to reach these
  // to authenticate in the first place.
  getAuthStatus: () => request<AuthStatus>("/api/auth/me"),

  login: (token: string) =>
    request<void>("/api/auth/login", { method: "POST", body: JSON.stringify({ token }) }),

  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
};
