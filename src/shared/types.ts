// Type-only shapes shared verbatim between the backend and
// `frontend/src/api.ts`. These were previously hand-mirrored on both sides
// (each frontend copy annotated "Mirrors src/services/X.ts's Y 1:1"), kept
// in sync by hand with zero compiler enforcement. Moving the physical
// declaration here and having both sides `export type { X } from ...`
// re-export it means a divergence between frontend and backend is now a
// compile error instead of a silent drift.
//
// Purely a relocation of existing declarations — no new runtime behavior,
// no new API surface. Every backend module that used to declare one of
// these types now re-exports it from here instead (see each module's own
// `export type { ... } from "../shared/types.js"` line), so no existing
// backend import path needed to change. `frontend/src/api.ts` does the same
// via a relative import across the workspace boundary
// (`../../src/shared/types.js`), and re-exports so every existing frontend
// consumer of these types keeps importing them from `./api.js` unchanged.
//
// NOT every hand-mirrored shape here lives in this file — a handful of
// pairs were found to have a real (not cosmetic) divergence between the two
// sides during the audit that produced this file, and were deliberately
// left alone rather than papered over. See the PR description for the full
// list.

// ---------------------------------------------------------------------------
// session-status.ts — SessionStatus / SessionSeverity
// ---------------------------------------------------------------------------
//
// Only these two leaf unions move here — `DerivedSessionStatus` and
// `DeriveSessionStatusInput` (also declared in session-status.ts) have no
// frontend mirror at all and stay put; this file is only for shapes
// verified identical on both sides of the workspace boundary.

export type SessionStatus =
  | "exited" // process gone (DB says killed/exited, or PtyManager has no live handle)
  | "awaiting_permission" // a tool-permission dialog is blocking the agent
  | "awaiting_plan" // an ExitPlanMode plan is ready for human review
  | "awaiting_review_gate" // Mullion's own blocking PreToolUse gate is waiting
  | "awaiting_promote" // a worktree-isolation promote request is waiting
  | "awaiting_question" // the agent's `question` tool is blocking on a user decision
  | "awaiting_elicitation" // an MCP server is asking the human for input
  | "api_error" // turn ended on an API error (StopFailure hook)
  | "tool_failure" // a tool call failed and the agent has since stalled (PostToolUseFailure hook)
  | "finished" // the agent's turn is over; process alive, your move
  | "needs_input" // byte-heuristic attention (bell/notification/title/silence) — a guess
  | "compacting" // context compaction is running
  | "subagent" // one or more subagents are running
  | "background" // outstanding backgroundTasks (bash/MCP/agent) the Stop hook reported (issue #428)
  | "working"
  | "idle";

export type SessionSeverity =
  "gone" | "failed" | "blocked" | "done" | "waiting" | "busy" | "dormant";

// ---------------------------------------------------------------------------
// pty-manager.ts — NotificationEvent
// ---------------------------------------------------------------------------
//
// Phase 1's notification event model (issue #166) — a structured, replayable
// record of the byte-driven "something happened" moments a session
// produces, distinct from SessionInfo's poll-derived snapshot fields. `seq`
// is per-session and monotonic (starts at 1), not globally unique — a
// consumer keys read/unread state off (sessionId, seq) together, never seq
// alone (two different sessions both legitimately have a seq:1).
// `file_change` and `review_gate` (Phase 2, issue #176) are the first two
// kinds sourced from the structured hook channel (src/plugins/hooks.ts)
// rather than PTY parsing — exactly the extension the original closed set
// anticipated, with no shape change needed.
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
    // Rich statuses — elicitation is a "blocked pending a human decision"
    // event, same tier as review_gate/promote_request/permission_request/
    // plan_ready above, so it gets its own dedicated kind the same way they
    // did. turn_start/compact/subagent are lower-signal state transitions —
    // routed through the existing "status_change" kind instead (same
    // reasoning progress/git_branch/cwd_changed already use it for), not
    // given their own kinds.
    | "elicitation"
    | "question"
    | "todo"
    | "session_diff"
    // Issue #404 — a background, PTY-scrollback-derived signal that a plain
    // (non-dock) session's dev server just started listening (see
    // dev-server-detect.ts's parseDevServerPort and
    // PtyManager.sweepDevServerDetection). Its own dedicated kind, same tier
    // as review_gate/promote_request/plan_ready above ("pending a human
    // decision" — accept wires the port into the project's devServerUrl +
    // preview, dismiss suppresses it), not folded into status_change. Unlike
    // review_gate/promote_request, nothing blocks on this: it's purely
    // backend-detected, never holds an agent's hook-socket connection open.
    | "dev_server_detected";
  ts: number;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// skills.ts — SkillInfo / SkillAgent / SkillScope
// ---------------------------------------------------------------------------

export type SkillAgent = "claude-code" | "codex" | "opencode" | "agy";
export type SkillScope = "builtin" | "global" | "project";

// No `content`/body field, deliberately — the backend never reads a skill's
// body past its frontmatter, only name/description.
export interface SkillInfo {
  name: string;
  description: string;
  sourceDir: string;
  scope: SkillScope;
  agents: SkillAgent[];
  // `null` means "not toggleable for this skill/agent pair." Reasons vary by
  // agent: agy never supports a write at all; codex/opencode are null when
  // the name is ambiguous across directories or their config couldn't be
  // read (malformed config.toml/opencode.json); claude-code is additionally
  // null for a builtin-scope (plugin-sourced) skill, a directory-basename
  // collision across scopes, or when read from the cwd-less global route. A
  // config-read failure degrades to "not toggleable" for that one agent — it
  // never fails the whole request.
  enabledByAgent: Partial<Record<SkillAgent, boolean | null>>;
}

// ---------------------------------------------------------------------------
// git-refs.ts — GitBranchInfo / GitWorktreeInfo
// ---------------------------------------------------------------------------

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  // Issue #442 — enrichment fields for the GitPanel's branch-management UI.
  // All optional: the same shape crosses the /internal/git-branches proxy,
  // so a new primary talking to an old agent (or the reverse) must degrade
  // rather than break (see the plan's binding decision #7).
  /** `%(upstream:short)` — e.g. "origin/main". Absent when no upstream is
   * configured for this branch. */
  upstream?: string;
  /** Parsed from `%(upstream:track)`'s "[ahead N]"/"[ahead N, behind M]"
   * form. Absent when there's no upstream or nothing to report. */
  ahead?: number;
  behind?: number;
  /** True when `%(upstream:track)` reports "[gone]" — the upstream branch
   * was deleted on the remote. */
  upstreamGone?: boolean;
  /** `%(committerdate:relative)` — e.g. "3 days ago". */
  lastCommitRelative?: string;
  /** Whether this branch is an ancestor of the resolved default base ref
   * (`git branch --merged`). Only computed when `listBranches` is called
   * with `{ detail: true }` (the GitPanel's explicit `?detail=1` fetch).
   * Left `undefined` (not `false`) when detail wasn't requested, or when the
   * base-ref chain fell through to `HEAD` (no remote configured) — "merged
   * into whatever branch you're standing on" is a misleading thing to label
   * a bare `merged`. */
  isMerged?: boolean;
}

export interface GitWorktreeInfo {
  path: string;
  /** `null` for a worktree checked out at a detached HEAD (or a bare repo
   * entry) — not every worktree has a branch. */
  branch: string | null;
  /** The repo's original working directory — always first in `git worktree
   * list`'s own output, never removable via `git worktree remove`. */
  isMain: boolean;
}

// ---------------------------------------------------------------------------
// git-status.ts — GitStatus / GitFileStatus / GitFileStatusCode
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// git-pull.ts — GitPullReason / GitPullResult
// ---------------------------------------------------------------------------

export type GitPullReason =
  | "not-a-repo"
  | "unborn-head"
  | "detached-head"
  | "no-upstream"
  | "dirty-tree"
  | "not-fast-forward"
  | "already-up-to-date"
  | "pull-failed";

export interface GitPullResult {
  pulled: boolean;
  reason?: GitPullReason;
  detail?: string;
}

// ---------------------------------------------------------------------------
// routes/projects.ts — release-please detection/run/merge (#744)
// ---------------------------------------------------------------------------
//
// Same "a domain refusal is a normal 200, only a genuine HTTP error throws"
// contract as GitPullResult above (see frontend/src/api/git.ts's doc comment
// on that convention) — ReleaseRunResult/ReleaseMergeResult follow it too.

export interface ReleaseWorkflowInfo {
  id: number;
  name: string;
  path: string;
}

// A repo not configured for release-please, and a token that can't even
// list workflows, both surface as "no Release section" — but they are NOT
// the same failure, and collapsing them repeats a regret this repo's own
// docs already record (docs/github-integration.md's Current-limitations
// note on the CI dot: "no UI signal distinguishing 'no workflows' from 'no
// permission'"). `"found"` carries the workflow to dispatch against;
// `"not-configured"` means the token could list workflows and none matched;
// `"no-actions-scope"` means the list call itself was rejected — a PAT
// without `Actions: read` is an explicitly supported configuration
// (docs/github-integration.md), not an error.
export type ReleaseDetectionResult =
  | { kind: "found"; workflow: ReleaseWorkflowInfo }
  | { kind: "not-configured" }
  | { kind: "no-actions-scope" };

export interface ReleasePullRequestStatus {
  number: number;
  htmlUrl: string;
  title: string;
  headRef: string;
  headSha: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  // Warm-cache-only, same posture as /github/prs (github-pr-poller.ts) —
  // null means "no signal yet," not "failing."
  ciStatus: "success" | "failure" | "in_progress" | null;
}

export interface ProjectReleaseStatus {
  detection: ReleaseDetectionResult;
  pr: ReleasePullRequestStatus | null;
}

export type ReleaseRunReason = "no-workflow" | "no-dispatch-trigger" | "dispatch-failed";

export interface ReleaseRunResult {
  dispatched: boolean;
  reason?: ReleaseRunReason;
  detail?: string;
}

// One reason per `MergeReadiness` non-mergeable state (merge-readiness.ts),
// plus `"no-release-pr"` (nothing to merge). No client-supplied PR
// number/id exists on this route — the PR to merge is always re-resolved
// via findReleasePullRequest, which itself only ever returns a PR whose
// head branch carries release-please's own prefix — so there's no
// "resolved something that wasn't a release PR" case to represent here.
export type ReleaseMergeReason =
  "no-release-pr" | "computing" | "behind" | "blocked" | "unstable" | "dirty" | "merge-failed";

export interface ReleaseMergeResult {
  merged: boolean;
  reason?: ReleaseMergeReason;
  detail?: string;
}

// ---------------------------------------------------------------------------
// git-diff.ts — GitDiffStats
// ---------------------------------------------------------------------------

// Files-changed + insertions/deletions against HEAD for a session's own
// effective cwd (its own cwd override, or its project's).
export interface GitDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// project-config.ts — Launcher / LauncherKind / DockControl / DockerServiceInfo
// ---------------------------------------------------------------------------

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

// The frontend hoists the `docker` field's shape into its own named
// interface rather than an inline object literal — purely organizational
// (structurally identical), so this shared version keeps that naming.
export interface DockerServiceInfo {
  composeProject: string;
  service: string;
  containerName: string;
  state: string;
  status: string;
  imageRef: string;
  imageId: string;
  buildOnly: boolean;
}

export interface DockControl {
  id: string;
  title: string;
  command: string;
  cwd?: string;
  height?: number;
  env?: Record<string, string>;
  /** When true, a worktree created for this monitor is periodically synced
   * to the branch's latest commit via `git reset --hard`. Useful for HMR
   * dev servers where the agent works in the main checkout. Default: the
   * global settings.dock.defaultWorktreeRefresh preference. */
  worktreeRefresh?: boolean;
  /** "docker" for a control synthesized from a discovered Compose service
   * (docker-service-detect.ts); absent/"config" for one read from
   * dock.json. Deliberately NOT handled by project-config.ts's
   * normalizeRawControl() — so a project's own dock.json can never forge
   * these fields. */
  source?: "config" | "docker";
  docker?: DockerServiceInfo;
}

// ---------------------------------------------------------------------------
// settings.ts — AppSettings's leaf unions
// ---------------------------------------------------------------------------
//
// AppSettings itself is NOT shared here: its `notifications.notificationMatrix`
// field is typed `Record<string, ...>` on the backend (settings.ts persists
// an arbitrary, possibly-stale JSON blob and deep-merges over defaults — see
// that field's own doc comment) but `Record<SessionStatus, ...>` on the
// frontend (a deliberate exhaustiveness check — the same
// assign-object-literal-to-a-Record-typed-const technique session-status.ts
// itself uses — so a SessionStatus added without a matching notification-
// matrix entry is a frontend type error). That's a real type mismatch, not
// cosmetic drift, so AppSettings stays hand-mirrored; only its
// byte-identical leaf unions move here.

export type Theme = "dark" | "light" | "system";
export type CursorStyle = "block" | "bar" | "underline";
export type SidebarDensity = "comfortable" | "compact";
export type SoundName = "ping" | "chime" | "blip";
// Tablet tier plan (.claude/plans/another-thing-to-investigate-lively-kitten.md,
// PR 4) — "auto" resolves from live window width (frontend/src/lib/
// layoutTier.ts's resolveLayoutTier); the three explicit values are an
// escape hatch for a device whose reported metrics are ambiguous (the
// motivating case: a foldable), and let a tier be reproduced in a desktop
// browser for testing.
export type LayoutMode = "auto" | "phone" | "tablet" | "desktop";
// Simultaneous tiled panes on the tablet tier before a newly-opened panel
// docks as a tab into the active group instead of its own column. User-
// configurable because the tradeoff against terminal readability (a
// narrower column trips the font-shrink from PR 2's TerminalPane fix sooner)
// depends on the device's actual unfolded/tablet width, which this backend
// has no way to know.
export type TabletPaneCap = 2 | 3;
