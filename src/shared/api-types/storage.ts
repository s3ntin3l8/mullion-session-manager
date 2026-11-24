// Shared API types for Settings > Storage: disk usage, caches, temp files and cleanup jobs (#2412).
//
// The single declaration of each API shape here, used by both workspaces.
// Most were hand-copied into frontend/src/api/ before #2412; the backend
// module that produces one re-exports it, so its importers are unchanged, and
// the frontend imports it through src/shared/types.ts, the one entry point.
// Type-only: no runtime code, and no import from outside src/shared/ (an
// import back from types.ts would be a cycle).

export type CleanupSource =
  "docker" | "temp" | "caches" | "opencode" | "worktrees" | "android-images";

export interface CleanupStepState {
  source: CleanupSource;
  label: string;
  state: "pending" | "running" | "done" | "skipped" | "error";
  reclaimedBytes: number;
  /** Why it was skipped, or what went wrong. */
  note?: string;
}

export interface CleanupJob {
  id: string;
  mode: CleanupMode;
  state: "running" | "done";
  startedAt: string;
  finishedAt?: string;
  steps: CleanupStepState[];
}

export type CleanupStatus = CleanupJob | { state: "idle" };

// Both prune services take the same two tiers; the intersection fails to
// compile if either of them ever diverges from what a job hands to it.
export type CleanupMode = DockerPruneMode & TempPruneMode;

export type ResourceSeverity = "normal" | "warning" | "critical";

export interface ProbeMeta {
  state: "measuring" | "ready" | "error";
  /** ISO time the held value was measured; null until a first run lands. */
  measuredAt: string | null;
  /** ISO time the run in flight started; only while `measuring`. */
  startedAt?: string;
  /** How long the run that produced the held value took. */
  durationMs?: number;
  error?: string;
}

export type Measured<T> = (T & ProbeMeta) | ProbeMeta;

export interface SpaceEntry {
  path: string;
  /** Allocated bytes, matching what deleting would free (hard links count per name). */
  bytes: number;
  isDirectory: boolean;
  /** What cleanup source owns this path, when one does (e.g. "uv"). */
  coveredBy?: string;
  /** Why nothing in Mullion cleans this; set only when `coveredBy` is not. */
  notCovered?: string;
  /** The biggest entries inside it; absent at the deepest level and for files. */
  children?: SpaceEntry[];
}

export interface DockerStorageStatus {
  available: boolean;
  rows: DockerUsageRow[];
  totalSizeBytes: number;
  reclaimableBytes: number;
  /** What each cleanup tier is expected to free; `safeBytes` is null if it couldn't be computed. */
  estimates: { safeBytes: number | null; aggressiveBytes: number };
  /** Omitted (not zeroed) when `docker system df -v` failed: "unknown", not "none". */
  volumes?: DockerVolumesSummary;
  error?: string;
}

export type DockerPruneMode = "safe" | "aggressive";

export interface DockerUsageRow {
  type: string;
  totalCount: number;
  activeCount: number;
  sizeBytes: number;
  reclaimableBytes: number;
}

/**
 * Docker volumes split by what cleanup may ever consider. Anonymous means the
 * name is exactly 64 lowercase hex characters (what `docker run -v /path`
 * creates); named volumes are never candidates, in use or not.
 */
export interface DockerVolumesSummary {
  anonymousUnused: DockerVolumeTotal;
  named: DockerVolumeTotal;
  /** Anonymous volumes still linked to a container. */
  inUse: DockerVolumeTotal;
}

export interface DockerVolumeTotal {
  count: number;
  bytes: number;
}

export interface TempStorageStatus {
  available: boolean;
  root: string;
  estimates: {
    safeBytes: number;
    aggressiveBytes: number;
    /** Part of `aggressiveBytes`: the npm cache, which aggressive cleanup also clears. */
    npmCacheBytes: number;
  };
  candidates: { safe: number; aggressive: number };
  claudeScratch: ClaudeScratchStatus;
  error?: string;
}

export type TempPruneMode = "safe" | "aggressive";

export interface ClaudeScratchStatus {
  /** Why `claude-<uid>` is being left alone entirely, when liveness is unknown. */
  skipped?: string;
  /** Registry files that were skipped but didn't stop the rest. */
  warnings: string[];
}

export interface OpencodeStorageStatus {
  /** False when there is no database, or it couldn't be read. */
  available: boolean;
  path: string;
  /** The database plus its write-ahead log, as on disk. */
  fileBytes: number;
  /** Free pages a VACUUM would return (`freelist_count * page_size`). Exact. */
  reclaimableBytes: number;
  /** What the compacted database would take. */
  liveBytes: number;
  /** Some other process has it open; a VACUUM would lock it out, so it is skipped. */
  inUse: boolean;
  /** Who has it open, when `inUse`; what to stop to let the compaction run. */
  holders?: Holder[];
  /**
   * Who has it open couldn't be established (no readable /proc, or one of this
   * user's own processes can't be looked into). Unknown is not "nobody": it is
   * skipped just like `inUse`.
   */
  holdersUnknown: boolean;
  /** What couldn't be looked into, e.g. `cannot list /proc/1234/fd (EACCES)`. */
  holdersUnknownReason?: string;
  /**
   * A compaction is running right now. Its child process has the database open,
   * so the holder scan is skipped meanwhile rather than reporting opencode.
   */
  compacting: boolean;
  /** How the last compaction since this server started ended; absent before any. */
  lastPrune?: OpencodeLastPrune;
  error?: string;
}

/**
 * A process with the database, its WAL or its shared-memory file open.
 * `command` is its command line (truncated), so the user can tell what to stop.
 */
export interface Holder {
  pid: number;
  command: string;
}

export interface OpencodeLastPrune {
  output: string;
  reclaimedBytes: number;
  error?: string;
  /** ISO time the compaction finished. */
  finishedAt: string;
}

export type RemoveOrphanResult =
  | { removed: true; reclaimedBytes: number }
  | {
      removed: false;
      reason:
        | "invalid-path"
        | "not-orphan"
        | "in-use"
        | "unsupported-platform"
        | "cross-device"
        | "contains-mount"
        | "unavailable"
        | "changed"
        | "remove-failed";
      recoveryPath?: string;
    };

export type OrphanRemovalStatus =
  | { state: "idle" }
  | { id: string; projectId: number; path: string; state: "running"; startedAt: string }
  | {
      id: string;
      projectId: number;
      path: string;
      state: "done";
      startedAt: string;
      finishedAt: string;
      result: RemoveOrphanResult;
    };

// Spelled out here rather than derived from the backend's CACHE_DIRS table
// (a runtime value this type-only file cannot import); that table's
// `satisfies` clause is typed against this union, so an entry whose id is
// missing here is a compile error on the backend.
export type CacheDirId =
  | "ms-playwright"
  | "huggingface"
  | "pre-commit"
  | "pip"
  | "go-build"
  | "uv"
  | "go-mod"
  | "gradle"
  | "cargo-registry"
  | "gh"
  | "claude-cli-nodejs"
  | "npm-npx"
  | "trash"
  | "claude-versions"
  | "claude-remote-cli"
  | "minimax-releases";

export interface CacheDirStatus {
  id: CacheDirId;
  label: string;
  bytes: number;
  exists: boolean;
  /** Emptying is irreversible: the contents are not rebuilt or re-downloaded. */
  permanent: boolean;
}

export interface CacheStorageStatus {
  available: boolean;
  root: string;
  caches: CacheDirStatus[];
}

// Spelled out rather than derived from dev-worktrees.ts's ROOTS table (a
// runtime value); ROOTS is typed against this union, so a new kind there
// must be added here too.
export type DevWorktreeKind = "wt" | "claude-agent";

/**
 * Why it is safe to remove:
 * - `gone`: its branch's upstream was deleted on the remote (a merged and
 *   auto-deleted PR, or an abandoned one), per the last fetch.
 * - `merged`: GitHub reports a merged PR whose head is exactly this commit, for
 *   repos that don't delete branches on merge. Commits added since don't count.
 * - `detached-merged`: a detached HEAD whose commit is already in the default
 *   branch.
 * - `in-default`: a hook-created `worktree-*` branch whose tip is already in the
 *   default branch, i.e. nothing was committed on it.
 *
 * And one that is removed only by explicit confirmation (issue #2045):
 * - `orphaned`: a directory under a worktree root that `git worktree list` does
 *   not know (its registration was pruned, or it was never a worktree). Nothing
 *   can tell whether it holds work, so it is never removed by cleanup; it is
 *   not counted in `totalBytes`.
 */
export type DevWorktreeReason = "gone" | "merged" | "detached-merged" | "in-default" | "orphaned";

export interface DevWorktreeCandidate {
  projectId: number;
  projectName: string;
  /** The project's main checkout, which `git worktree` commands run against. */
  repoCwd: string;
  path: string;
  /** Path under the worktree root, e.g. `fix-thing` or `feat/nested`. */
  slug: string;
  branch: string | null;
  kind: DevWorktreeKind;
  reason: DevWorktreeReason;
  /** e.g. `#1234` for `merged`. */
  detail?: string;
  headSha: string;
  bytes: number;
}

export interface DevWorktreeStatus {
  available: boolean;
  /** Includes `orphaned` directories, which cleanup never removes. */
  candidates: DevWorktreeCandidate[];
  /** What cleanup can free: every candidate but the `orphaned` ones. */
  totalBytes: number;
  error?: string;
}

export interface OrphanRecovery {
  projectId: number;
  originalPath: string;
  recoveryPath: string;
  mayBePartial: boolean;
  unverified?: boolean;
}

// GET /api/storage/worktrees/remove-orphan (routes/system-resources.ts).
export interface OrphanRemovalSnapshot {
  job: OrphanRemovalStatus;
  recoveries: OrphanRecovery[];
  warnings?: string[];
}
