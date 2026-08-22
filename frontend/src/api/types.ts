// Local (frontend-only) API response/request shapes — split out of the
// former flat frontend/src/api.ts (PR 22 of the refactoring roadmap). The
// ~90 types that used to be hand-mirrored 1:1 copies of a backend
// declaration already moved to src/shared/types.ts in an earlier PR (Wave
// 2); this file holds only what's left: shapes with no backend twin,
// response envelopes assembled ad hoc in route handlers, and request-only
// input types. Domain modules (./projects.ts, ./sessions.ts, etc.) import
// from here for their function signatures; api/index.ts re-exports every
// name below unchanged so no call site anywhere in the frontend needs to
// change its import.
import type {
  SessionStatus,
  SessionSeverity,
  GitBranchInfo,
  GitWorktreeInfo,
  GitStatus,
  GitPullReason,
  GitPullResult,
  DockControl,
  Theme,
  CursorStyle,
  SidebarDensity,
  SoundName,
  LayoutMode,
  TabletPaneCap,
} from "../../../src/shared/types.js";
import type { TaskStatus } from "../../../src/shared/constants.js";

export type { GitPullReason, GitPullResult };

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
  // optional per-project override of settings.taskMaster.defaultAgent, used
  // to resolve which agent a claimed task spawns. Null means "fall through
  // to the global default." Mirrors src/db/schema.ts's projects.defaultAgent.
  defaultAgent: string | null;
  // Same precedence shape as defaultAgent, for the optional advisory review
  // agent spawned when a task enters "reviewing" (see task-state.ts). Null
  // means "no project-level review agent" — it falls through to the
  // install-wide settings.taskMaster.defaultReviewAgent, which itself
  // defaults to "none" (no review agent).
  defaultReviewAgent: string | null;
  // Per-project only, no install-wide tier — same posture as
  // defaultReviewAgent above. Approving a task also requests a merge for
  // its PR; the reconciler lands it once GitHub's checks are green and the
  // branch is up to date. Mirrors src/db/schema.ts's projects.mergeOnApprove.
  mergeOnApprove: boolean | null;
  // A "reviewing" task approves itself once its review agent's latest
  // verdict is "clean" and CI on the PR head is green — no human click.
  // Needs a review agent configured (defaultReviewAgent above) to ever
  // produce a verdict at all. Mirrors projects.autoApprove.
  autoApprove: boolean | null;
  // #756 — per-project override of the auto-return round cap. Null means
  // "use the install default" (currently 2). Mirrors
  // projects.maxAutoReturnRounds.
  maxAutoReturnRounds: number | null;
  // #761 — off by default: the PR title is the raw task title. On, the
  // worker is asked to write a Conventional Commits title alongside its
  // usual completion signal. Mirrors projects.conventionalCommitTitles.
  conventionalCommitTitles: boolean | null;
  // #744 — off by default: task PR merges don't automatically trigger
  // release-please. Mirrors src/db/schema.ts's projects.autoTagRelease.
  autoTagRelease: boolean | null;
}

// Mirrors src/services/host-registry.ts's HostSummary, plus the live
// heartbeat fields src/routes/hosts.ts merges in at the route layer (issue
// #246) — health/lastSeenAt are never persisted, just the primary's
// in-memory view of "is it actually up right now" as of the last sweep.
// Never carries a token, just whether one is set (hasToken), same
// "no secrets over the API" rule AppSettings/ServerInfo above already follow.
export type HostHealthStatus = "pending" | "online" | "degraded" | "offline";

export interface Host {
  id: string;
  name: string;
  baseUrl: string | null;
  isLocal: boolean;
  hasToken: boolean;
  createdAt: string;
  health: HostHealthStatus;
  // Not currently rendered anywhere — kept for a future "last seen Nm ago"
  // affordance (would make a "degraded" host more actionable than a bare
  // color). Deliberate forward-plumbing, not dead code: it's the one field
  // in this merge the backend computes but the UI doesn't consume yet.
  lastSeenAt: string | null;
  // Distinct from lastSeenAt (last successful contact): advances on every
  // sweep result, success or failure. Settings.tsx uses this to tell "a
  // sweep has run since my Test click completed" apart from "the host was
  // last reachable at this time" (Hermes review, PR #524).
  lastCheckedAt: string | null;
}

// Mirrors src/services/remote-host-client.ts's AgentConfig 1:1 — issue #247 /
// roadmap 7.4. No idle timeout: that's a DB-backed Settings value on the
// primary with no env-var equivalent, so a remote agent has no way to know
// it either.
export interface HostConfig {
  role: "primary" | "agent";
  version: string;
  projectsRoots: string[];
  sessionsDir: string;
  crsConfigDir: string;
  browserEnabled: boolean;
}

// Mirrors GET /api/hosts/:id/update's response (src/routes/hosts.ts) —
// issue #647 / roadmap 7.8. `status` reuses UpdateStatus below (defined
// further down this file, the same shape self-update.sh's own
// .update-status.json already produces on the primary), proxied from the
// agent's own /internal/updates/status.
export interface HostUpdateStatus {
  hostVersion: string;
  primaryVersion: string;
  upToDate: boolean;
  // False whenever upToDate, OR the primary's own release has no
  // downloadable asset yet (see unavailableReason) — never true just
  // because a version differs.
  updatable: boolean;
  unavailableReason: string | null;
  assetUrl: string | null;
  checksumUrl: string | null;
  status: UpdateStatus;
}

// Mirrors src/services/github-integration.ts's GitHubAppStatus 1:1 — never
// carries the private key, only the public appId, a live installation
// count (null when not configured, or when the live GitHub call failed),
// and (#514) a fingerprint/rotation timestamp for the currently-stored
// key so a rotation is verifiable from Settings.
export interface GitHubAppStatus {
  configured: boolean;
  appId: string | null;
  installationCount: number | null;
  keyFingerprint: string | null;
  keyRotatedAt: string | null;
}

// #514 — PUT /api/integrations/github/app's response: it now verifies the
// credential against GitHub (GET /app) before persisting, so a successful
// PUT reports what that check found rather than an empty 204. See
// src/services/github-integration.ts's verifyAppCredentials for the full
// verified/rejected/mismatch/unreachable outcome set — only the two
// persisted outcomes (verified, unreachable) ever reach here, since a
// rejected/mismatch result 400s instead (thrown as an ApiError by
// `request`).
export interface SetGitHubAppResult {
  verified: boolean;
  appSlug?: string;
  keyFingerprint: string;
  warning?: string;
}

// Mirrors src/services/github-integration.ts's GitHubIntegrationSummary 1:1
// (plus the separately-fetched `githubApp` status GET /api/integrations/github
// merges in) — never carries the token itself, same "hasToken-only" rule as
// Host above (there `hasToken`, here `connected`).
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
  githubApp: GitHubAppStatus;
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

// Issue #679 — POST /api/sessions/:id/promote's own response shape, NOT a
// field on Session itself: `warnings` only ever exists on this one 201
// response (a non-fatal note that e.g. resolvePendingPromote failed on a
// remote host, even though the promoted session itself is up and running),
// and Session is consumed everywhere — sidebar rows, kanban cards, the
// store's session maps — where that reach would be unwarranted. Assignable
// to Session (a strict superset), so existing `onPromoted?: (newSession:
// Session) => void` call sites compile unchanged; only PromoteDialog.tsx
// itself needs to know about the extra field.
export type PromoteSessionResponse = Session & { warnings?: string[] };

// Issue #213 (roadmap 4.7) — a row from the persisted `session_events` table
// (src/db/schema.ts / src/services/event-history.ts's StoredEventRow),
// deliberately NOT the same shape as NotificationEvent (src/shared/types.ts):
//   - `sessionId` is nullable (the FK is `onDelete: "set null"` — a row
//     outlives its session, by design, since that's the point of history).
//   - `kind` is a plain string, not the 16-member union — the DB column has
//     no enum constraint (schema.ts's own comment: 16+ kinds and growing),
//     so an old row can carry a kind newer code no longer recognizes.
//   - `payload` is nullable — `null` in the DB, or when the stored JSON
//     failed to parse (src/services/event-history.ts's parsePayload).
// See frontend/src/eventHistory.ts's adapter for how this becomes something
// SessionTimeline.tsx can render.
export interface StoredEventRow {
  id: number;
  sessionId: number | null;
  seq: number;
  kind: string;
  ts: number;
  payload: Record<string, unknown> | null;
}

export interface EventHistoryPage {
  // false when sessions.eventPersistence is off — a deliberate success
  // response, not an error, so a caller can tell "off" from "nothing
  // happened yet" (src/routes/events.ts's own comment). `events` is always
  // `[]` and `nextCursor` always `null` in that case.
  persistenceEnabled: boolean;
  events: StoredEventRow[];
  nextCursor: number | null;
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

// GET /api/projects/:id/git-branches' response (issue #442's base-ref
// picker). Branch/worktree lists are fetched on demand when the GitPanel
// opens, not on the sidebar's 4s live-refresh tick (they change far less
// often than working-tree status).
export interface GitBranchesResult {
  branches: GitBranchInfo[];
  worktrees: GitWorktreeInfo[];
  // Remote-tracking branch names (issue #271), e.g. "origin/main" — for the
  // base-ref picker's "not one hardcoded rule" requirement (a human present
  // may want to branch off a remote branch, not just a local one). Kept
  // separate from `branches` rather than merged in — see
  // src/services/git-refs.ts's listRemoteBranches doc comment.
  remoteBranches: string[];
  // Issue #271 follow-up — the repo's resolved default branch (e.g.
  // "origin/main"), for the promote/launcher base-ref pickers to prefer
  // over the current branch. `undefined` when this response came from a
  // pre-upgrade remote agent that doesn't send it yet; `null` when the
  // fetching host resolved it and found no usable default (no remote
  // configured, or the fallback chain bottomed out). Both cases mean
  // "fall back to the current branch" — see git-refs.ts's
  // resolveDefaultBaseRefForPicker.
  defaultBranch?: string | null;
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

// U4 — mirrors src/services/dock-config.ts's DockConfigReadResult 1:1. The
// raw, per-project `.crs/dock.json` (never the merged global+Docker view
// GET /api/projects/:id/dock returns — see that module's own doc comment
// on why an editor needs a separate, unmerged read/write pair).
export interface DockConfigResult {
  controls: DockControl[];
  /** True when `.crs/dock.json` exists but doesn't parse/validate — see
   * dock-config.ts's own doc comment for why this is surfaced rather than
   * silently shown as an empty (and therefore overwrite-on-save-able)
   * config. */
  invalid: boolean;
  reason: string | null;
  /** True when `.crs/dock.json` is itself a symlink — mirrors
   * AgentRuleTarget's own `isSymlink` field 1:1 (agent-rules.ts's read
   * follows it to show real content, but its write refuses to save
   * through one). `controls` above is still populated from following the
   * symlink where possible; the editor should treat this target as
   * read-only (Save disabled) rather than offer an edit whose Save is
   * guaranteed to 400. */
  isSymlink: boolean;
}

// The subset of DockControl fields this editor can actually set — `source`/
// `docker` are docker-service-detect.ts-only fields a project's own
// dock.json can never carry (see project-config.ts's normalizeRawControl
// and dock-config.ts's ALLOWED_CONTROL_KEYS); typing the editor's own state
// around this narrower shape means it's simply not possible to construct a
// payload containing them.
export type DockControlInput = Omit<DockControl, "source" | "docker">;

export type DockerUpdateCheckResult =
  | {
      updateAvailable: boolean;
      currentImageId: string;
      latestImageId: string;
      imageRef: string;
      checkedAt: string;
    }
  | { updateAvailable: false; reason: "build-only" | "pull-failed" };

export interface DockerUpdateResult {
  sessionId: number;
  /** Ephemeral — never returned by GET .../dock. Dock.tsx prepends this to
   * its own control list so the new session renders through the ordinary
   * monitor body; it drops out again once the session is no longer active. */
  control: DockControl;
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
    skipPermissions: boolean;
    issueLabel: string;
    pollIntervalSeconds: number;
  };
}

// #667 — mirrors task-dependencies.ts's StoredBlocker. htmlUrl is null only
// for the synthetic "N blocker(s) not visible to this token" entry
// refreshTaskBlockers adds when GitHub's summary count and the actually
// visible blocker list disagree.
export interface TaskBlocker {
  owner: string;
  repo: string;
  number: number;
  title: string;
  htmlUrl: string | null;
}

// #746 — POST /api/tasks/clear-done's response shape. No route in this
// codebase returned a per-row ok/failed shape before this one; modeled on
// git-worktree.ts's own cleanupOrphanWorktrees (`{ removed, skipped }`).
export interface ClearDoneBranchResult {
  id: number;
  branch: string;
  deleted: boolean;
  reason?: string;
}

export interface ClearDoneResult {
  deleted: number[];
  failed: { id: number; error: string }[];
  branches: ClearDoneBranchResult[];
  // Non-zero only when the batch cap (20 per call) truncated the sweep —
  // the caller can call again to pick up the rest.
  remaining: number;
}

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
  // Whether the worker's most recent spawn (claim/auto-claim/retry)
  // actually delivered an initial prompt as argv (see task-claim.ts's own
  // doc comment). Null before the task is ever claimed; true/false is set
  // alongside sessionId on every claim/retry, so a promptless worker
  // session is visible on the row, not only in the claim/retry HTTP
  // response at the moment of the call. See TaskDetail.tsx.
  seedDelivered: boolean | null;
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
  // Task-claim queueing (rate-limit-storm fix) — the reviewSessionId whose
  // findings have already been read and acted on. `reviewSessionId !==
  // reviewFindingsIngestedSessionId` means a review agent is still running;
  // equal (or reviewSessionId null) means either awaiting your manual
  // approve/reject, or there was never a review agent at all. See
  // TaskCard.tsx's "review in flight" label.
  reviewFindingsIngestedSessionId: number | null;
  // The review agent's own findings, captured once its session finishes —
  // appended across rounds under a "## Round N" header, never replaced.
  // Null until the first round is ingested (no review agent configured,
  // still running, or genuinely found nothing).
  reviewFindings: string | null;
  // How many times this task has already driven an automatic
  // "reviewing -> in_progress" round back to the worker — not just from a
  // changes-requested review verdict anymore (a red required CI check and
  // an unresolved PR review comment are later triggers on the same model).
  // Bounded by a resolved per-project cap (default 2) and never reset —
  // see TaskDetail.tsx's review card. Renamed from `reviewRounds`.
  autoReturnRounds: number;
  // Which trigger most recently spent a round — "review" | "ci" |
  // "pr-comment". Null until the first auto-return.
  lastAutoReturnReason: "review" | "ci" | "pr-comment" | null;
  worktreePath: string | null;
  branchName: string | null;
  // #491 — the commit SHA the worktree was actually branched from, pinned
  // at claim time (local-hosted projects only; null on remote hosts and on
  // tasks claimed before this column existed). Drives the diff-stat shown
  // on the reviewing issue comment; not otherwise rendered in the UI.
  baseSha: string | null;
  agent: string | null;
  reviewAgent: string | null;
  // The resolved launch command actually used for the worker session (task.agent ->
  // issue `Agent:` line -> projects.defaultAgent -> settings.taskMaster.defaultAgent),
  // recorded once at claim time.
  agentCommand: string | null;
  prUrl: string | null;
  // Set alongside prUrl — a draft PR opened at "-> reviewing", or the PR
  // approve creates directly as a fallback for a task that reached
  // "reviewing" before that shipped. Not otherwise rendered in the UI yet.
  prNumber: number | null;
  // Merge-on-approve — set at approve time when the project's
  // mergeOnApprove is on, or by a manual "Merge now"/"Retry merge" click.
  // The reconciler's merge sweep clears this once the PR merges (or is
  // found already merged/closed). Non-null means a merge is outstanding.
  mergeRequestedAt: string | null;
  // The merge sweep's last failure reason (conflicts with main, checks
  // blocked, ...), independent of mergeRequestedAt itself — a task can have
  // an outstanding merge request AND a recorded error at the same time
  // (the sweep keeps retrying). Null means no known problem.
  mergeError: string | null;
  // The review agent's most recently ingested verdict — "clean" |
  // "changes-requested" | "inconclusive" — or null if no round has been
  // ingested yet. Durable input to auto-approve's gate; not itself the
  // rendered findings text (see reviewFindings above).
  lastReviewVerdict: string | null;
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
  // #667 — dependency-aware claiming. dependencyCount is GitHub's own
  // total_blocked_by snapshot (null = never observed). blockedState is the
  // server-computed dependencyGate() result (task-dependencies.ts) — NOT
  // re-derived here, since frontend/ has no access to backend source; see
  // routes/tasks.ts's withBlockedState. blockers is the parsed list of
  // currently-open blockers (empty for "clear", irrelevant for
  // "unresolved" — the UI shows "checking…" instead of the list then).
  dependencyCount: number | null;
  blockedState: "clear" | "blocked" | "unresolved";
  blockers: TaskBlocker[];
  // #701 — GitHub sub-issue hierarchy, display-only (never gates claiming,
  // unlike dependencyCount above). parentIssueNumber/parentIssueRepo ride
  // the same ingest response dependencyCount does; parentIssueTitle is
  // filled lazily (task-watcher.ts's fillParentIssueTitles) and may briefly
  // lag the number/repo — a card falls back to `#N` until it arrives.
  // subIssueTotal/subIssueCompleted are only meaningful when this task is
  // itself someone's parent.
  parentIssueNumber: number | null;
  parentIssueRepo: string | null;
  parentIssueTitle: string | null;
  subIssueTotal: number | null;
  subIssueCompleted: number | null;
  createdAt: string;
  updatedAt: string;
  // Task-claim queueing (rate-limit-storm fix) — when the task joined the
  // queue (status -> "claimed"), distinct from claimedAt below. See
  // TaskCard.tsx's age-chip logic.
  queuedAt: string | null;
  // When the CURRENT worker spell started (dispatch, not enqueue) — null
  // while a task sits queued with no session yet.
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

// AppSettings itself stays hand-mirrored rather than shared — its
// notifications.notificationMatrix field is a real, deliberate type
// divergence from the backend's settings.ts (see src/shared/types.ts's own
// doc comment on Theme/CursorStyle/SidebarDensity/SoundName, which DO move,
// for the full rationale). AppSettings is otherwise still a duplicate of
// the backend's row shape, same pattern as Project/Session/etc. above.
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
  // Tablet tier plan (.claude/plans/another-thing-to-investigate-lively-
  // kitten.md, PR 4) — see shared/types.ts's own doc comment on LayoutMode.
  layoutMode: LayoutMode;
  tabletPaneCap: TabletPaneCap;
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
      // #95 — web push delivery (pushClient.ts + public/push-sw.js), gated
      // the same way browser/sound already are: per-status via
      // notificationMatrix.notify below, this is the channel-level on/off on
      // top of that. Mirrors src/services/settings.ts's own channels.push.
      push: boolean;
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
    // Issue #73 — mirrors src/services/settings.ts's AppSettings.dock.
    // dockerServices 1:1. Whether GET /api/projects/:id/dock merges in
    // auto-discovered Docker Compose services; default true. A visibility
    // kill-switch, not the safety gate — a discovered control still never
    // auto-starts either way.
    dockerServices: boolean;
  };
  sessions: {
    namePattern: string;
    confirmBeforeKill: boolean;
    hideEndedSessions: boolean;
    showTaskSessions: boolean;
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
    // The "max events per session" bound issue #213's own body asked for,
    // alongside eventRetentionDays above — independent settings, both swept
    // on the same hourly tick. 0 = unlimited. Server clamps to [0, 100_000].
    eventRetentionPerSession: number;
    // Issue #405 — mirrors src/services/settings.ts 1:1. Gates only the
    // SessionStart auto-inject pointer to the per-session agent guide copy
    // (src/plugins/hooks.ts), never the per-session file write itself.
    // Surfaced in Settings.tsx's Sessions section.
    injectAgentGuide: boolean;
    // agent-briefing follow-up to #405 — mirrors src/services/settings.ts
    // 1:1. Gates the SessionStart injection of a PROJECT's own briefing,
    // independently of injectAgentGuide above. Surfaced in Settings.tsx's
    // Sessions section.
    injectProjectBriefing: boolean;
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
    skipPermissions: "inherit" | "on" | "off";
    // #741 — Task Master's install-wide worker/review agent defaults,
    // mirroring settings.ts's AppSettings.taskMaster 1:1. Independent of
    // launchers.defaultAgent (which only drives the terminal launcher).
    defaultAgent: string;
    defaultReviewAgent: string;
    // No sentinel, no env counterpart — settings.ts's own doc comment on
    // this field explains why.
    reviewCiWaitMinutes: number;
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

// #95 — matches the standard PushSubscription.toJSON() shape and
// src/routes/push.ts's subscribeSchema exactly (additionalProperties:
// false, expirationTime accepted-but-unused). pushClient.ts constructs this
// via JSON.parse(JSON.stringify(subscription)) rather than by hand.
export interface PushSubscriptionPayload {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface CreateProjectDirOptions {
  // Confirm-first directory creation — see CreateProjectModal.tsx. Leaf-only
  // on the backend (project-dir.ts): the parent must already exist.
  createDir?: boolean;
  // Only takes effect when this request actually creates the directory.
  gitInit?: boolean;
}

// Extra fields the backend only includes when `createDir` was requested —
// see projects.ts's POST/PATCH handlers. Kept off `Project` itself so every
// other GET /api/projects consumer doesn't inherit two fields that are
// never present there.
export type CreateProjectResult = Project & { dirCreated?: boolean; gitInitialized?: boolean };
