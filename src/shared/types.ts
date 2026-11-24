// Type-only shapes shared verbatim between the backend and
// `frontend/src/api/`. These were previously hand-mirrored on both sides
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
// The first wave left a handful of pairs alone because the two sides had
// really diverged. The second wave (issue #2412) settled those and every
// other same-named twin: the single declaration matches what the route
// actually sends, and scripts/check-shared-type-twins.mjs (run by
// `npm run lint`) fails if the frontend declares a type with a backend
// type's name again. The second wave's types live in api-types/, one file per
// area, re-exported at the bottom of this file, which stays the one entry
// point both workspaces import.

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
  | "suspended" // the host did not answer — the session may still be running (issue #1727)
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
    | "dev_server_detected"
    // PR transitions from the GitHub poller (github-pr-poller.ts), emitted
    // onto the session whose branch (or Task Master task) owns the PR — see
    // pr-session-events.ts. Machine-sourced like dev_server_detected, so an
    // agent can wait on its own PR via events.subscribe.
    | "pr_ci_failed"
    | "pr_ci_passed"
    | "pr_review_submitted"
    | "pr_new_comments"
    | "pr_merged"
    | "pr_conflicts"
    // Issue #2270 — audit of a message one session sent another (sessions.message):
    // `message_sent` on the sender, `message_received` on the target.
    | "message_sent"
    | "message_received";
  ts: number;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// skills.ts — SkillInfo / SkillAgent / SkillScope
// ---------------------------------------------------------------------------

export type SkillAgent = "claude-code" | "codex" | "opencode" | "agy" | "mcode";
export type SkillScope = "builtin" | "global" | "project";
// Issue #885 — a "skill" is a `SKILL.md`-carrying directory (as before); an
// "agent" is a Claude Code/opencode subagent definition file; a "command" is
// a Claude Code slash-command file. Both of the latter two are discovery-only
// — never toggleable, and never write-eligible through toggleSkillEnabled
// (skills.ts's attachEnabledByAgent forces `enabledByAgent[agent] = null` for
// every non-"skill" row unconditionally).
export type SkillKind = "skill" | "agent" | "command";

// No `content`/body field, deliberately — the backend never reads a skill's
// body past its frontmatter, only name/description.
export interface SkillInfo {
  name: string;
  description: string;
  // A skill's directory (`<dir>/<name>/SKILL.md`'s parent) for kind
  // "skill", but the single `.md` FILE itself (`<dir>/<name>.md`) for kind
  // "agent"/"command" — those have no per-item subdirectory. Still the
  // unique dedup/selector key either way (skills.ts's scanSkillDirs/
  // scanFileDirs each merge on this exact string, never cross the two kinds).
  sourceDir: string;
  scope: SkillScope;
  kind: SkillKind;
  agents: SkillAgent[];
  // `null` means "not toggleable for this skill/agent pair." Reasons vary by
  // agent: agy never supports a write at all; codex/opencode are null when
  // the name is ambiguous across directories or their config couldn't be
  // read (malformed config.toml/opencode.json); claude-code is additionally
  // null for a builtin-scope (plugin-sourced) skill, a directory-basename
  // collision across scopes, or when read from the cwd-less global route. A
  // config-read failure degrades to "not toggleable" for that one agent — it
  // never fails the whole request. Always `null` for every agent when `kind`
  // is "agent"/"command" — issue #885 is discovery-only, no writer exists.
  enabledByAgent: Partial<Record<SkillAgent, boolean | null>>;
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
  // Whether the workflow file declares `workflow_dispatch:` (GitHub 422s a
  // manual run without it). null = the file couldn't be read.
  dispatchable: boolean | null;
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
  // Workflow runs GitHub is holding for approval on the PR's head commit
  // (`conclusion` or `status` of `action_required`; `waiting` runs are
  // concurrency/environment gates that /approve refuses, so they are not counted). 0 also when the token could not read runs.
  heldRuns: number;
  // True when GitHub has no workflow run at all for the head commit — the
  // shape of a PR opened with the default GITHUB_TOKEN, which triggers none.
  // Approving cannot help; only a push by another identity (or a manual
  // dispatch) starts CI.
  noRuns: boolean;
}

export interface ProjectReleaseStatus {
  detection: ReleaseDetectionResult;
  pr: ReleasePullRequestStatus | null;
  // True when this repo has release-please's own config committed
  // (release-please-config.json / .release-please-manifest.json) but
  // `projects.conventionalCommitTitles` is off — the branchdam-mobile
  // incident's shape: `detection` above is commonly `"not-configured"` here
  // too (see RELEASE_WORKFLOW_FILENAMES's own doc comment, github-release.ts,
  // for why a real release-please repo routinely fails THAT detection), so
  // this is deliberately a second, independent signal rather than a variant
  // of `detection` — widening `ReleaseDetectionResult` itself would make the
  // Run button appear with no real workflow id to dispatch. A project that
  // already has the flag on never probes for this (see
  // GET /api/projects/:id/release) — always `false` in that case, not
  // because nothing was found but because nothing needed checking.
  conventionalTitlesWarning: boolean;
}

export type ReleaseRunReason = "no-workflow" | "no-dispatch-trigger" | "dispatch-failed";

export type ReleaseApproveRunsReason =
  "no-release-pr" | "no-held-runs" | "forbidden" | "approve-failed";

export interface ReleaseApproveRunsResult {
  approved: number;
  reason?: ReleaseApproveRunsReason;
  detail?: string;
}

export interface ReleaseRunResult {
  dispatched: boolean;
  reason?: ReleaseRunReason;
  detail?: string;
}

// One reason per `MergeReadiness` non-mergeable state (merge-readiness.ts),
// plus `"no-release-pr"` (nothing to merge) and `"draft"` (mergeableState
// can read "clean" on a draft PR — GitHub only refuses the merge itself, at
// which point it'd otherwise surface as an opaque "merge-failed"). No
// client-supplied PR number/id exists on this route — the PR to merge is
// always re-resolved via findReleasePullRequest, which itself only ever
// returns a PR whose head branch carries release-please's own prefix — so
// there's no "resolved something that wasn't a release PR" case to
// represent here.
export type ReleaseMergeReason =
  | "no-release-pr"
  | "draft"
  | "computing"
  | "behind"
  | "blocked"
  | "unstable"
  | "dirty"
  | "merge-failed";

export interface ReleaseMergeResult {
  merged: boolean;
  reason?: ReleaseMergeReason;
  detail?: string;
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
  // Issue #1243 — split from a single `buildOnly` boolean: `buildable`
  // (has a `build:` key) and `pullable` (has a registry image worth
  // pulling) are independent, since a service can be both. See
  // src/services/docker-service-detect.ts's ComposeService doc comments
  // for the full derivation.
  buildable: boolean;
  pullable: boolean;
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
  /** Issue #2069 — the TCP port this control's server binds (integer
   * 1–65535). When set, POST /api/sessions probes it before spawning a
   * `kind: "dock"` session for the control and refuses with a 409
   * `port_in_use` instead of letting the bind fail inside the PTY. */
  port?: number;
  /** Issues #2016/#2018 — the control a branch preview runs, in the branch's
   * worktree with `PORT` set to the port the preview proxies to. Without one
   * flagged, a project's only control serves; with several and none
   * flagged, branch previews are refused (services/branch-preview.ts). */
  preview?: boolean;
  /** "docker" for a control synthesized from a discovered Compose service
   * (docker-service-detect.ts); absent/"config" for one read from
   * dock.json. Deliberately NOT handled by project-config.ts's
   * normalizeRawControl() — so a project's own dock.json can never forge
   * these fields. */
  source?: "config" | "docker";
  docker?: DockerServiceInfo;
  /** Issue #1112 — set on a stack-wide action's own ephemeral control
   * (startStackSession, routes/project-docker.ts) so a caller can group it with
   * its stack without parsing `id` against a hand-synced actionId prefix
   * list (dockHelpers.ts's EPHEMERAL_STACK_ACTION_PREFIXES / the old
   * composeProjectForControl). Also what makes reconstructing an ephemeral
   * control from a live `docker-stack:<composeProject>` session possible
   * after a workspace switch drops the frontend's own optimistic record of
   * it — the reconstruction has no actionId to parse an id from in the
   * first place, but always knows the compose project directly from the
   * session name. A `docker`-bearing (discovered service) control never
   * sets this — its compose project lives at `docker.composeProject`
   * instead; see composeProjectForControl's own doc comment. */
  composeProject?: string;
}

// ---------------------------------------------------------------------------
// api-types/ — the second wave (issue #2412)
// ---------------------------------------------------------------------------
//
// The same relocation, continued: every remaining frontend type that had a
// same-named backend twin now lives in one of these per-area files, split out
// only to keep each file under the repo's line ceiling. This file stays the
// single entry point both workspaces import from.
export type * from "./api-types/agents.js";
export type * from "./api-types/devices.js";
export type * from "./api-types/git.js";
export type * from "./api-types/github.js";
export type * from "./api-types/hosts.js";
export type * from "./api-types/projects.js";
export type * from "./api-types/sessions.js";
export type * from "./api-types/settings.js";
export type * from "./api-types/storage.js";
