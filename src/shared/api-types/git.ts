// Shared API types for branches, worktrees, status, pull, doctor and diff stats (#2412).
//
// The single declaration of each API shape here, used by both workspaces.
// Most were hand-copied into frontend/src/api/ before #2412; the backend
// module that produces one re-exports it, so its importers are unchanged, and
// the frontend imports it through src/shared/types.ts, the one entry point.
// Type-only: no runtime code, and no import from outside src/shared/ (an
// import back from types.ts would be a cycle).

// ---------------------------------------------------------------------------
// git-refs.ts — GitBranchInfo / GitWorktreeInfo
// ---------------------------------------------------------------------------

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  // Issue #442 — enrichment fields for Source Control's branch-management UI.
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
   * with `{ detail: true }` (Source Control's explicit `?detail=1` fetch).
   * Left `undefined` (not `false`) when detail wasn't requested, or when the
   * base-ref chain fell through to `HEAD` (no remote configured) — "merged
   * into whatever branch you're standing on" is a misleading thing to label
   * a bare `merged`. */
  isMerged?: boolean;
  /** Tip commit (`%(objectname)`). Lets a caller pin a PR's head SHA to this
   * branch so a reused branch name isn't mistaken for the merged one. */
  sha?: string;
  /** Why this branch counts as done, cheapest signal first. Detail only.
   * `ancestor` / `upstream-gone` come from git alone; `pr-merged` /
   * `pr-closed` are layered on by the route from the shared closed-PR lookup
   * (a squash merge leaves the branch un-merged as far as git can tell).
   * Absent = no signal that it is done. */
  mergeState?: GitBranchMergeState;
  /** The pull request for this branch's head, when one is known. */
  pr?: GitBranchPr;
}

export type GitBranchMergeState = "ancestor" | "upstream-gone" | "pr-merged" | "pr-closed";

export interface GitBranchPr {
  number: number;
  state: "open" | "merged" | "closed";
  url: string;
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
  | "pull-failed"
  // Issue #1896 — a git operation (a clone repair) already holds the clone.
  // Not a failure: the pull was refused, and trying again in a moment works.
  | "busy"
  // A lock file git names is old enough to be orphaned by a killed process.
  // `detail` is "<path> (<age> old)"; Pull never deletes it.
  | "stale-lock";

export interface GitPullResult {
  pulled: boolean;
  reason?: GitPullReason;
  detail?: string;
}

// ---------------------------------------------------------------------------
// git-branch-ops.ts — GitBranchOpReason / GitBranchOpResult (issue #1672)
//
// The guarded checkout / create / rebase of the project's own checkout. A
// refusal is a 200 with a reason, the same contract as GitPullResult.
// ---------------------------------------------------------------------------

export type GitBranchOpReason =
  | "not-a-repo"
  | "invalid-name"
  | "no-such-branch"
  | "no-such-ref"
  | "already-exists"
  | "already-current"
  | "checked-out"
  | "unborn-head"
  | "detached-head"
  | "dirty-tree"
  | "operation-in-progress"
  | "no-base"
  | "already-up-to-date"
  | "conflicts"
  | "failed"
  // Issue #3068 — the per-branch fast-forward Pull (`pullBranch`): the branch
  // tracks nothing (or its upstream is gone), or it has commits its upstream
  // lacks, so a fast-forward is impossible. Pull never merges or rebases.
  | "no-upstream"
  | "not-fast-forward"
  // Added one layer up, by the routes: they need the sessions table and the
  // clone registry, which the DB-less git service has no access to.
  | "sessions-active"
  | "busy";

export interface GitBranchOpResult {
  ok: boolean;
  reason?: GitBranchOpReason;
  /** Human-readable context: the worktree holding a branch, the ids of the
   * active sessions, a truncated git stderr, or the ref a rebase used. */
  detail?: string;
  /** `conflicts` only: the files the aborted rebase stopped on. */
  conflicts?: string[];
}

// ---------------------------------------------------------------------------
// services/git-doctor.ts — CloneHealth, RepairPlan, RepairOutcome
// (issues #1851 and #1896)
//
// CloneHealth is what the READ-ONLY half of the doctor found. It never
// mutates anything.
//
// RepairPlan is what the repair WOULD do, computed from reads only — the app
// shows it before asking for the confirmation, because the repair moves
// files inside `.git/objects` and rewrites worktree indexes.
//
// RepairOutcome is what the repair DID.

export interface CloneHealth {
  /** The shared git dir, or null when this is not a git checkout. */
  gitDir: string | null;
  /** Zero-byte files that are loose objects — the #1836 damage. */
  zeroByteObjects: string[];
  /** Zero-byte files under objects/ that are NOT loose objects — a different,
   * riskier kind of damage. */
  otherZeroByteFiles: string[];
  /** git fsck's error lines, without the `dangling …` noise that is normal. */
  fsckErrors: string[];
  /** True when nothing is wrong. */
  healthy: boolean;
  /** True when `git fsck` did not finish — the check's verdict is UNKNOWN,
   * which is NOT the same as "damaged". */
  timedOut: boolean;
}

/** What the repair would do — computed from reads only, so showing it
 * changes nothing. */
export interface RepairPlan {
  /** The shared git dir, or null when this is not a git checkout. */
  gitDir: string | null;
  /** The zero-byte loose objects that would be quarantined, by sha. */
  quarantine: string[];
  /** Whether `git fetch origin --prune` would run (there is an origin). */
  willFetch: boolean;
  /** The worktrees whose index would be rebuilt. */
  indexesToRebuild: string[];
  /** The worktrees whose index would be SKIPPED, and the paths responsible —
   * staged content that is not in the working tree, which re-staging would
   * discard. */
  indexesToSkip: { path: string; paths: string[] }[];
  /** True when the repair has damaged objects to move aside.
   *
   * NOT the same as "the clone is healthy": a clone whose object was deleted
   * outright (rather than left zero-byte) has nothing to quarantine, and the
   * fetch is what helps it. */
  actionable: boolean;
}

/** What a repair did. */
export interface RepairOutcome extends CloneHealth {
  /** Where the moved-aside files went. */
  quarantine: string | null;
  /** The shas that were quarantined. */
  quarantined: string[];
  /** The shas that read fine again (they were only shadowed). */
  recovered: string[];
  /** The shas that are genuinely gone — never committed, not on the remote. */
  unrecovered: string[];
  /** Whether the remote refs were restored. */
  refsRestored: boolean;
  /** The worktrees whose index was rebuilt. */
  indexesRebuilt: string[];
  /** The worktrees whose index was left alone, and why. */
  indexesSkipped: string[];
  /** True when the clone is consistent again. */
  whole: boolean;
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
  // Changed paths under `.github/workflows/` (a rename reports both sides'
  // text as git prints it). Absent from a host agent that predates the
  // workflow-change approval gate — a caller must read that as "unknown",
  // never as "none".
  workflowFiles?: string[];
}

export interface GitBranchCommit {
  sha: string;
  subject: string;
  author: string;
  /** Unix seconds. */
  time: number;
}

export type PruneSkipReason = "current" | "worktree" | "task-claimed" | "default";

export type DeleteBranchReason =
  | "not-a-repo"
  | "invalid-name"
  | "no-such-branch"
  | "current-branch"
  | "checked-out"
  | "unmerged"
  | "delete-failed";

export interface DeleteBranchResult {
  deleted: boolean;
  reason?: DeleteBranchReason;
  /** For "checked-out": the worktree path holding it. */
  detail?: string;
}

export interface GitBranchDetail {
  name: string;
  sha: string;
  upstream?: string;
  upstreamGone?: boolean;
  /** Commits ahead of / behind the upstream (absent without one). */
  upstreamAhead?: number;
  upstreamBehind?: number;
  /** The base ref the numbers below compare against (e.g. "origin/main"). */
  base: string | null;
  baseAhead?: number;
  baseBehind?: number;
  /** `base..branch`, newest first, capped at 50 (`uniqueTruncated` says so). */
  uniqueCommits: GitBranchCommit[];
  uniqueTruncated: boolean;
  lastCommit: GitBranchCommit | null;
}

/** GET /api/projects/:id/git-branch's response: the service's GitBranchDetail
 * plus what the route merges in from the branch list, the worktree list and
 * the tasks table. */
export interface GitBranchDrilldown extends GitBranchDetail {
  isCurrent: boolean;
  mergeState: GitBranchMergeState | null;
  pr: GitBranchPr | null;
  worktreePath: string | null;
  /** The resumable task that claims this branch, if any. */
  taskId: number | null;
}

/** DELETE branch's response: the service's DeleteBranchResult, or the
 * route's own task-branch guard (a branch a resumable task still claims),
 * which needs the tasks table the service has no access to. */
export type DeleteBranchResponse =
  DeleteBranchResult | { deleted: false; reason: "task-branch"; detail: string };
