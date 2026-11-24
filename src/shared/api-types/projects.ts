// Shared API types for projects: files, discovery, duplicates, placement and setup (#2412).
//
// The single declaration of each API shape here, used by both workspaces.
// Most were hand-copied into frontend/src/api/ before #2412; the backend
// module that produces one re-exports it, so its importers are unchanged, and
// the frontend imports it through src/shared/types.ts, the one entry point.
// Type-only: no runtime code, and no import from outside src/shared/ (an
// import back from types.ts would be a cycle).

import type { DropDisposition, PlacementCapability, PlacementPlatform } from "../constants.js";

export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  truncated: boolean;
}

export interface ScaffoldConflict {
  file: string;
  excerpt: string;
  /** Report mode only ever carries a `ConflictKind`; a restructure report keeps
   * whatever kind the agent used ("stale-reference", "other", ...). */
  kind: string;
  note: string;
  /** Set only for a passage the agent dropped on purpose (#2934). Any other
   * value, including none, still blocks reducing CLAUDE.md. */
  disposition?: DropDisposition;
}

export type SetupStatus = "running" | "ok" | "failed" | "timeout";

export type PreProvision = "none" | "all" | string[];

export interface HostCheckoutSuggestion {
  hostId: string;
  hostName: string;
  /** Origin matches first, then name matches. Never empty. */
  candidates: CheckoutCandidate[];
  /** More than one clone on the host has the project's origin. */
  ambiguous: boolean;
  /** The operator removed a mapping for this host earlier: it is still
   * suggested, but auto-fill skips it. */
  declined: boolean;
}

export interface CheckoutCandidate {
  cwd: string;
  /** `origin`: same normalised `origin` remote. `name`: only the directory
   * name matches — a weaker suggestion that is NEVER auto-filled. */
  match: CheckoutMatch;
}

export type CheckoutMatch = "origin" | "name";

/** What a merge would move, for the confirm dialog and the result. */
export interface MergeCounts {
  tasks: number;
  liveTasks: number;
  sessions: number;
  runningSessions: number;
  previews: number;
}

// Issue #937 — a small, finite set of well-known "how we work" policy
// choices (branch-vs-direct-commit, merge strategy, review process, ...),
// deterministically assembled into prose by buildWorkflowConventionsText
// below. Same "pure function assembling structural output" posture as
// mullion-scaffold.ts's computeScaffold — no agent, no network, fully
// unit-testable — but this is a STARTER, not an ongoing mode: running it
// fills settings.sessions.workflowConventionsText (settings.ts) with the
// generated prose, which is then a normal, freely-editable textarea with no
// distinction between wizard-written and hand-edited parts, and no answer
// state kept around to reconcile against later edits. See routes/
// workflow-conventions.ts for the two read-only endpoints (GET the question
// set, POST answers -> text) the frontend's wizard drives.
//
// This is the issue's own explicit v1 question list — extend over time as
// gaps are found, per the issue's own "not exhaustive" framing, but don't
// silently narrow it: each axis below is named directly in issue #937's
// "Starting question set."
export interface WorkflowConventionOption {
  id: string;
  label: string;
  /** The prose sentence(s) this option contributes when selected — joined
   * with every other selected fragment, in question order, by
   * buildWorkflowConventionsText below. Deliberately plain sentences, not a
   * markdown list item each: the assembled result reads as ordinary prose a
   * human would keep hand-editing afterward, not as a form dump. */
  fragment: string;
}

export interface WorkflowConventionQuestion {
  id: string;
  question: string;
  options: WorkflowConventionOption[];
}

export interface ProjectDirEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  /** Symlinks only: what the link resolves to. "outside" covers both a
   * target beyond the project root and a dangling link — neither is
   * openable. */
  targetKind?: "file" | "dir" | "outside";
}

export interface ProjectFileStat {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ProjectDirListing {
  path: string;
  entries: ProjectDirEntry[];
  truncated: boolean;
}

export interface ProjectFileContent {
  path: string;
  content: string;
  size: number;
  mtimeMs: number;
  /** Project-relative path the requested path resolves to, set only when
   * the requested path is (or passes through) a symlink. */
  symlinkTarget?: string;
}

export interface ProjectFileWriteResult {
  size: number;
  mtimeMs: number;
}

export interface ProjectSearchResult {
  path: string;
}

export interface ProjectSearchListing {
  results: ProjectSearchResult[];
  /** The walk hit MAX_SEARCH_VISITED, so a match may exist that wasn't seen. */
  truncated: boolean;
}

export interface HostCwdsMeta {
  auto: string[];
  declined: string[];
  /** Hosts whose `hostCwds` entry is a Mullion-created clone (written by the
   * materialization step, not by the clone endpoint itself). */
  managed: string[];
}

export interface DuplicateGroup {
  /** The group's shared origin key (the same key the create gate uses). */
  origin: string;
  survivor: DuplicateMember;
  duplicates: DuplicateEntry[];
}

export interface DuplicateEntry extends DuplicateMember {
  counts: MergeCounts;
  /** Why merging this project into the survivor would be refused right now. */
  refusal: MergeRefusal | null;
}

export interface DuplicateMember {
  id: number;
  name: string;
  hostId: string;
  cwd: string;
  createdAt: string;
}

export interface MergeRefusal {
  code: MergeRefusalCode;
  message: string;
}

export type MergeRefusalCode =
  | "NOT_FOUND"
  | "SAME_PROJECT"
  | "SAME_HOST"
  | "HOST_PATH_CONFLICT"
  | "HOST_CWDS_LIMIT"
  | "STACK_IDENTITY_CONFLICT"
  | "LIVE_TASK_CONFLICT";

/**
 * A project's placement steering flags (issue #2241), parsed.
 *
 * `platform` is an allow-list (empty = any platform); `allowBurst` lets
 * "burst" hosts take Auto work (false = they stay out, the default).
 */
export interface PlacementConstraints {
  platform: PlacementPlatform[];
  allowBurst: boolean;
  /** Host capabilities (`PLACEMENT_CAPABILITIES`) the project needs (issue #2306). */
  capabilities: PlacementCapability[];
}

/** Issue #2241 — what the API accepts for `placementConstraints`. */
export interface PlacementConstraintsBody {
  platform?: PlacementPlatform[];
  allowBurst?: boolean;
  capabilities?: PlacementCapability[];
}

export interface DiscoveredCandidate {
  name: string;
  cwd: string;
  isGitRepo: boolean;
  /**
   * Issue #2090 — the checkout's raw `origin` URL (`null`: a git repo with no
   * origin, or not a repo). OPTIONAL on the type because an agent build that
   * predates the field simply omits it: `undefined` means "this host cannot
   * say", which is not the same as `null` ("it has no origin") — the matcher
   * never auto-fills on an unknown origin.
   */
  origin?: string | null;
  /**
   * Issue #2090 — `.git` is a FILE (a linked worktree or a submodule), not a
   * clone of its own. Such a directory is never matched as "the project's
   * checkout" on another host.
   */
  isWorktree?: boolean;
}

export type RepoMatchReason = "path" | "origin";

export interface DiscoveredProject extends DiscoveredCandidate {
  isRegistered: boolean;
  // Issue #2231 — the existing project this candidate is a checkout of, when
  // its path or git origin matches one. The UI offers "Add as checkout of".
  // `hostId` is the project's own host: a candidate on that host is a second
  // clone there, which cannot be attached (only created separately).
  matchedProject?: { id: number; name: string; hostId: string; reason: RepoMatchReason };
}
