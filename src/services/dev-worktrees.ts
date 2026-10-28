import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runGitFetch } from "./git-fetch.js";
import {
  isAncestorOf,
  listBranches,
  listWorktrees,
  resolveCommitSha,
  resolveDefaultBaseRefNoFetch,
} from "./git-refs.js";
import { getGitStatus } from "./git-status.js";
import { removeListedWorktree } from "./git-worktree.js";
import { dirSize } from "./temp-storage.js";
import { containsMount, UnsupportedMountPlatformError } from "./mount-boundaries.js";
import type { GitBranchInfo, GitWorktreeInfo } from "../shared/types.js";

// Developer worktrees (issue #1605): `.wt/<slug>`, this repo's own convention,
// and `.claude/worktrees/agent-*`, which Claude Code's isolated sub-agents
// leave behind. Each carries its own checkout and usually its own
// `node_modules`, a few hundred MB apiece, and nothing ever cleans them up once
// their PR is merged. Not `.mullion-worktrees/`: Task Master owns those and has
// its own lifecycle (see git-worktree.ts).
//
// A worktree is only ever offered when removing it loses no work: its tree is
// clean, nothing is using it, it has been idle for a day, and its commits are
// provably elsewhere. Removal goes through `removeListedWorktree`, the same
// clean-status-checked path the Git panel uses (that helper runs the removal
// itself with `--force` once its own check has passed, so the guard is that
// check, repeated right before each removal here). The branch is always left
// alone: a ref costs nothing, and any commit that was never pushed is still
// reachable from it. What is NOT preserved is files git ignores, `node_modules`
// being the point of it but also a local `.env` or editor settings.

const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const ROOTS = [
  { dir: ".wt", kind: "wt" },
  // Not ours, but other projects' agents pick it when nothing tells them where
  // to put a worktree; treated like `.wt/`.
  { dir: ".worktrees", kind: "wt" },
  { dir: path.join(".claude", "worktrees"), kind: "claude-agent" },
] as const;

/** Directories (relative to a project) that hold developer worktrees. */
export const DEV_WORKTREE_DIRS: readonly string[] = ROOTS.map((root) => root.dir);

export type DevWorktreeKind = (typeof ROOTS)[number]["kind"];

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

export interface DevWorktreeProject {
  id: number;
  name: string;
  cwd: string;
}

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

export interface DevWorktreePruneResult {
  output: string;
  reclaimedBytes: number;
  error?: string;
}

export interface DevWorktreeOptions {
  /** Local projects only: remote hosts' worktrees live on another machine. */
  projects: DevWorktreeProject[];
  /** A live session or resumable task is using this worktree. */
  inUse?: (project: DevWorktreeProject, worktreePath: string) => boolean;
  /**
   * The number of a PR that merged exactly `tipSha`, from `branch`, into
   * `defaultBranch`, or null (none, no GitHub remote, no token, an API error).
   * Unknown is null.
   */
  mergedPr?: (
    project: DevWorktreeProject,
    branch: string,
    tipSha: string,
    defaultBranch: string,
  ) => Promise<number | null>;
  now?: number;
  /** How long a worktree's HEAD must have been still. Defaults to a day. */
  minAgeMs?: number;
  /** Test seam for `git fetch --prune`; prune only. */
  fetch?: (cwd: string) => Promise<unknown>;
}

interface Located {
  worktree: GitWorktreeInfo;
  kind: DevWorktreeKind;
  slug: string;
}

/**
 * The project's directory as git spells it. `git worktree list` prints real
 * paths, so a project registered through a symlink would otherwise match none of
 * its own worktrees.
 */
async function repoRoot(repoCwd: string): Promise<string> {
  return fs.realpath(repoCwd).catch(() => path.resolve(repoCwd));
}

function locate(repoRootPath: string, worktree: GitWorktreeInfo): Located | null {
  if (worktree.isMain) return null;
  const resolved = path.resolve(worktree.path);
  for (const root of ROOTS) {
    const prefix = path.join(repoRootPath, root.dir) + path.sep;
    if (resolved.startsWith(prefix)) {
      return { worktree, kind: root.kind, slug: resolved.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * When the worktree's HEAD last moved (a checkout, commit, pull or reset), from
 * its reflog. Not the index, which `git status` itself touches. `null` when it
 * can't be told: callers then treat the worktree as too recent to touch.
 */
async function lastActivityMs(worktreePath: string): Promise<number | null> {
  try {
    const dotGit = await fs.readFile(path.join(worktreePath, ".git"), "utf8");
    const gitdir = /^gitdir:\s*(.+)$/m.exec(dotGit)?.[1]?.trim();
    if (!gitdir) return null;
    const dir = path.resolve(worktreePath, gitdir);
    let newest = 0;
    for (const file of [path.join("logs", "HEAD"), "HEAD"]) {
      try {
        newest = Math.max(newest, (await fs.stat(path.join(dir, file))).mtimeMs);
      } catch {
        // not every worktree has a reflog
      }
    }
    return newest > 0 ? newest : null;
  } catch {
    return null;
  }
}

interface RepoContext {
  project: DevWorktreeProject;
  branches: Map<string, GitBranchInfo>;
  /** The default branch, or "HEAD" when none is known (then nothing is "merged"). */
  base: string;
}

async function repoContext(project: DevWorktreeProject): Promise<RepoContext | null> {
  const branches = await listBranches(project.cwd);
  if (!branches) return null;
  return {
    project,
    branches: new Map(branches.map((branch) => [branch.name, branch])),
    base: await resolveDefaultBaseRefNoFetch(project.cwd),
  };
}

type Evaluated = Omit<DevWorktreeCandidate, "bytes">;

/** Whether one worktree can go, and why; `null` unless it provably can. */
async function evaluate(
  ctx: RepoContext,
  located: Located,
  options: DevWorktreeOptions,
): Promise<Evaluated | null> {
  const { project } = ctx;
  const { worktree } = located;
  if (options.inUse?.(project, worktree.path)) return null;
  const status = await getGitStatus(worktree.path, { forceFresh: true });
  if (!status || status.hasConflicts || !status.isClean) return null;
  const activity = await lastActivityMs(worktree.path);
  const now = options.now ?? Date.now();
  if (activity === null || now - activity < (options.minAgeMs ?? DEFAULT_MIN_AGE_MS)) return null;
  const headSha = await resolveCommitSha(worktree.path, "HEAD");
  if (!headSha) return null;

  const base: Evaluated = {
    projectId: project.id,
    projectName: project.name,
    repoCwd: project.cwd,
    path: worktree.path,
    slug: located.slug,
    branch: worktree.branch,
    kind: located.kind,
    reason: "gone",
    headSha,
  };
  if (worktree.branch === null) {
    // Detached: nothing names these commits, so only a commit already in the
    // default branch is safe to forget.
    return ctx.base !== "HEAD" && (await isAncestorOf(worktree.path, headSha, ctx.base))
      ? { ...base, reason: "detached-merged" }
      : null;
  }
  const info = ctx.branches.get(worktree.branch);
  if (!info) return null;
  if (info.upstreamGone) return base;
  // A branch pushed without tracking set up is as merged as any other: the
  // branch name and commit are all the lookup needs. Only a merge into the
  // default branch counts as "elsewhere"; one into a feature branch does not.
  const defaultBranch = ctx.base.startsWith("origin/") ? ctx.base.slice("origin/".length) : null;
  if (defaultBranch && options.mergedPr) {
    const pr = await options
      .mergedPr(project, worktree.branch, headSha, defaultBranch)
      .catch(() => null);
    if (pr !== null) return { ...base, reason: "merged", detail: `#${String(pr)}` };
  }
  // Only for the branches worktree-hook.mjs names itself: an ordinary local
  // branch with no commits yet may be work someone is about to start.
  if (
    worktree.branch.startsWith("worktree-") &&
    ctx.base !== "HEAD" &&
    (await isAncestorOf(worktree.path, headSha, ctx.base))
  ) {
    return { ...base, reason: "in-default" };
  }
  return null;
}

/** This project's developer worktrees, with the repo facts every check needs. */
async function gather(
  project: DevWorktreeProject,
  listed?: GitWorktreeInfo[] | null,
): Promise<{ ctx: RepoContext; located: Located[] } | null> {
  const worktrees = listed === undefined ? await listWorktrees(project.cwd) : listed;
  if (!worktrees) return null;
  const root = await repoRoot(project.cwd);
  const located = worktrees.flatMap((worktree) => locate(root, worktree) ?? []);
  if (located.length === 0) return null;
  const ctx = await repoContext(project);
  return ctx ? { ctx, located } : null;
}

/**
 * Directories under `dir` that are neither a registered worktree nor a parent
 * of one (`.wt/feat/` holding a registered `.wt/feat/x` is walked into, not
 * reported). Symlinks are skipped: what they point at isn't this root's.
 */
async function unregisteredDirs(dir: string, known: string[]): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (known.includes(full)) continue;
    if (known.some((k) => k.startsWith(full + path.sep))) {
      found.push(...(await unregisteredDirs(full, known)));
    } else {
      found.push(full);
    }
  }
  return found;
}

/** Issue #1979 — the project's `orphaned` directories under each root. */
async function findOrphans(
  project: DevWorktreeProject,
  worktrees: GitWorktreeInfo[],
): Promise<Evaluated[]> {
  const root = await repoRoot(project.cwd);
  const known = worktrees.map((worktree) => path.resolve(worktree.path));
  const orphans: Evaluated[] = [];
  const seenRoots = new Set<string>();
  for (const { dir, kind } of ROOTS) {
    // Real path: `git worktree list` prints one, so a symlinked `.wt` (or
    // `.claude`) would otherwise make every registered worktree under it look
    // unknown.
    const rootDir = await fs.realpath(path.join(root, dir)).catch(() => null);
    // Two roots can be one directory (`.worktrees` symlinked to `.wt`); walk
    // it once, or every orphan in it is reported twice.
    if (!rootDir || seenRoots.has(rootDir)) continue;
    seenRoots.add(rootDir);
    for (const orphan of await unregisteredDirs(rootDir, known)) {
      orphans.push({
        projectId: project.id,
        projectName: project.name,
        repoCwd: project.cwd,
        path: orphan,
        slug: path.relative(rootDir, orphan),
        branch: null,
        kind,
        reason: "orphaned",
        headSha: "",
      });
    }
  }
  return orphans;
}

export interface OrphanRecovery {
  projectId: number;
  originalPath: string;
  recoveryPath: string;
  mayBePartial: boolean;
  unverified?: boolean;
}

/** Recovery records live outside project rows, so project moves/deletions and
 * server restarts do not hide quarantined work. */
export async function inspectOrphanRecoveries(
  registryDir: string,
): Promise<{ recoveries: OrphanRecovery[]; warnings: string[] }> {
  let entries: string[];
  try {
    entries = await fs.readdir(registryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { recoveries: [], warnings: [] };
    throw error;
  }
  const found: OrphanRecovery[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    if (!/^[0-9a-f-]+\.json$/i.test(entry)) continue;
    try {
      const record: unknown = JSON.parse(await fs.readFile(path.join(registryDir, entry), "utf8"));
      if (!record || typeof record !== "object") throw new Error("Invalid record");
      const data = record as {
        projectId?: unknown;
        originalPath?: unknown;
        recoveryPath?: unknown;
        phase?: unknown;
        dev?: unknown;
        ino?: unknown;
      };
      if (
        typeof data.projectId !== "number" ||
        !Number.isInteger(data.projectId) ||
        typeof data.originalPath !== "string" ||
        path.resolve(data.originalPath) !== data.originalPath ||
        typeof data.recoveryPath !== "string" ||
        path.resolve(data.recoveryPath) !== data.recoveryPath ||
        (data.phase !== "staged" && data.phase !== "deleting") ||
        typeof data.dev !== "number" ||
        typeof data.ino !== "number"
      )
        throw new Error("Invalid record");
      const originalPath = data.originalPath;
      const quarantine = path.dirname(data.recoveryPath);
      const root = path.dirname(quarantine);
      if (
        path.basename(data.recoveryPath) !== "directory" ||
        !path.basename(quarantine).startsWith(".mullion-orphan-")
      )
        throw new Error("Invalid record");
      const allowed = ROOTS.map(({ dir }) => path.join(root, dir));
      if (!allowed.some((base) => originalPath.startsWith(base + path.sep)))
        throw new Error("Invalid record");
      let recoveryPath = data.recoveryPath;
      const readStat = async (candidate: string) => {
        try {
          return { stat: await fs.lstat(candidate), unavailable: false };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { stat: null, unavailable: false };
          return { stat: null, unavailable: true };
        }
      };
      let checked = await readStat(recoveryPath);
      if (!checked.stat && !checked.unavailable && data.phase === "deleting") {
        recoveryPath = originalPath;
        checked = await readStat(originalPath);
      }
      if (checked.unavailable) {
        found.push({
          projectId: data.projectId,
          originalPath,
          recoveryPath,
          mayBePartial: data.phase === "deleting",
          unverified: true,
        });
        continue;
      }
      const stat = checked.stat;
      if (
        !stat ||
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (recoveryPath === originalPath && (stat.dev !== data.dev || stat.ino !== data.ino))
      )
        continue;
      found.push({
        projectId: data.projectId,
        originalPath,
        recoveryPath,
        mayBePartial: data.phase === "deleting",
      });
    } catch (error) {
      // An entry removed concurrently is harmless; unreadable or malformed
      // records must surface an error rather than hide potential recovery.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(
          `Recovery record ${path.join(registryDir, entry)} could not be read or verified. Inspect it and any .mullion-orphan-* directories before clearing it.`,
        );
    }
  }
  return { recoveries: found, warnings };
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

/** Remove one freshly verified orphan, never as part of the cleanup sweep. */
export async function removeOrphanedDevWorktree(
  project: DevWorktreeProject,
  requestedPath: string,
  inUse: (worktreePath: string) => Promise<boolean>,
  registryDir: string,
): Promise<RemoveOrphanResult> {
  if (!path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes("..")) {
    return { removed: false, reason: "invalid-path" };
  }
  try {
    const projectRoot = await fs.realpath(project.cwd);
    const initial = await fs.lstat(requestedPath);
    if (!initial.isDirectory() || initial.isSymbolicLink()) {
      return { removed: false, reason: "invalid-path" };
    }
    const target = await fs.realpath(requestedPath);
    const allowedRoots = await Promise.all(
      ROOTS.map(({ dir }) => fs.realpath(path.join(projectRoot, dir)).catch(() => null)),
    );
    // A root may alias another approved worktree root, but cannot turn an
    // unrelated project directory into a deletion root (e.g. .wt -> src).
    const inside = (child: string, parent: string) => child.startsWith(parent + path.sep);
    const approved = ROOTS.map(({ dir }) => path.join(projectRoot, dir));
    if (
      !allowedRoots.some(
        (root) =>
          root &&
          approved.some((base) => root === base || inside(root, base)) &&
          inside(target, root),
      )
    ) {
      return { removed: false, reason: "invalid-path" };
    }
    const overlapsRegistered = (worktrees: GitWorktreeInfo[]) =>
      worktrees.some((worktree) => {
        const registered = path.resolve(worktree.path);
        // The project's own checkout necessarily contains its worktree roots.
        if (projectRoot === registered || inside(projectRoot, registered)) return false;
        return target === registered || inside(target, registered) || inside(registered, target);
      });
    const verify = async (): Promise<RemoveOrphanResult | null> => {
      const worktrees = await listWorktrees(project.cwd);
      if (!worktrees) return { removed: false, reason: "unavailable" };
      if (overlapsRegistered(worktrees)) return { removed: false, reason: "not-orphan" };
      if (!(await findOrphans(project, worktrees)).some((candidate) => candidate.path === target)) {
        return { removed: false, reason: "not-orphan" };
      }
      if (await inUse(target)) return { removed: false, reason: "in-use" };
      if (await containsMount(target)) return { removed: false, reason: "contains-mount" };
      const stat = await fs.lstat(requestedPath);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== initial.dev ||
        stat.ino !== initial.ino ||
        (await fs.realpath(requestedPath)) !== target
      )
        return { removed: false, reason: "changed" };
      return null;
    };
    const first = await verify();
    if (first) return first;
    const bytes = await dirSize(target);
    const again = await verify();
    if (again) return again;
    // Atomically move the directory into a private, non-scanned location.
    // A path swapped after the last check is never deleted: the moved inode
    // must still be the one the user confirmed. Cross-device renames fail
    // without changing the original.
    await fs.mkdir(registryDir, { recursive: true, mode: 0o700 });
    const quarantine = await fs.mkdtemp(path.join(projectRoot, ".mullion-orphan-"));
    const staged = path.join(quarantine, "directory");
    const manifest = path.join(registryDir, `${randomUUID()}.json`);
    const nextManifest = `${manifest}.next`;
    const record = (phase: "staged" | "deleting") =>
      JSON.stringify({
        projectId: project.id,
        originalPath: target,
        recoveryPath: staged,
        phase,
        dev: initial.dev,
        ino: initial.ino,
      });
    const cleanQuarantine = async () => {
      await fs.unlink(manifest).catch(() => undefined);
      await fs.unlink(nextManifest).catch(() => undefined);
      await fs.rmdir(quarantine).catch(() => undefined);
    };
    let moved = false;
    const restore = async (
      reason:
        | "changed"
        | "not-orphan"
        | "in-use"
        | "contains-mount"
        | "unavailable"
        | "remove-failed"
        | "cross-device",
    ): Promise<RemoveOrphanResult> => {
      if (!moved) {
        await cleanQuarantine();
        return { removed: false, reason };
      }
      try {
        // Claim the old name exclusively; never overwrite another directory.
        await fs.mkdir(target);
        await fs.rename(staged, target);
        moved = false;
        if (reason === "remove-failed") {
          // Keep the manifest so a later page load still warns about the
          // partially removed tree even after another job has started.
          return { removed: false, reason, recoveryPath: target };
        }
        await cleanQuarantine();
        return { removed: false, reason };
      } catch {
        // Preserve the remaining data when the old name is occupied or
        // restoration fails. The caller displays this path for recovery.
        return { removed: false, reason, recoveryPath: staged };
      }
    };
    try {
      // This record exists before the move, so even a process crash leaves
      // the original and recovery locations discoverable on the next boot.
      await fs.writeFile(nextManifest, record("staged"), { flag: "wx", mode: 0o600 });
      await fs.rename(nextManifest, manifest);
      try {
        await fs.rename(target, staged);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EXDEV") return await restore("cross-device");
        throw error;
      }
      moved = true;
      const stagedStat = await fs.lstat(staged);
      if (
        !stagedStat.isDirectory() ||
        stagedStat.isSymbolicLink() ||
        stagedStat.dev !== initial.dev ||
        stagedStat.ino !== initial.ino
      ) {
        return await restore("changed");
      }
      const worktrees = await listWorktrees(project.cwd);
      if (!worktrees) return await restore("unavailable");
      if (overlapsRegistered(worktrees)) return await restore("not-orphan");
      if ((await inUse(target)) || (await inUse(staged))) return await restore("in-use");
      if ((await containsMount(target)) || (await containsMount(staged)))
        return await restore("contains-mount");
      const finalStat = await fs.lstat(staged);
      if (
        !finalStat.isDirectory() ||
        finalStat.isSymbolicLink() ||
        finalStat.dev !== initial.dev ||
        finalStat.ino !== initial.ino
      ) {
        return await restore("changed");
      }
      // Persist the partial-deletion warning atomically before the first rm.
      await fs.writeFile(nextManifest, record("deleting"), { flag: "wx", mode: 0o600 });
      await fs.rename(nextManifest, manifest);
      if ((await inUse(target)) || (await inUse(staged))) return await restore("in-use");
      if ((await containsMount(target)) || (await containsMount(staged)))
        return await restore("contains-mount");
      const deletionStat = await fs.lstat(staged);
      if (
        !deletionStat.isDirectory() ||
        deletionStat.isSymbolicLink() ||
        deletionStat.dev !== initial.dev ||
        deletionStat.ino !== initial.ino
      ) {
        return await restore("changed");
      }
      try {
        await fs.rm(staged, { recursive: true });
      } catch {
        return await restore("remove-failed");
      }
      moved = false;
      await cleanQuarantine();
      return { removed: true, reclaimedBytes: bytes };
    } catch {
      return await restore("unavailable");
    }
  } catch (error) {
    return {
      removed: false,
      reason:
        error instanceof UnsupportedMountPlatformError ? "unsupported-platform" : "unavailable",
    };
  }
}

/**
 * Stale developer worktrees across the given projects. Reads refs as of the
 * last fetch (a fetch per project is too heavy for a polled preview), which can
 * only undercount: a branch deleted since then isn't seen as gone yet.
 */
export async function inspectDevWorktrees(options: DevWorktreeOptions): Promise<DevWorktreeStatus> {
  try {
    const candidates: DevWorktreeCandidate[] = [];
    for (const project of options.projects) {
      try {
        const worktrees = await listWorktrees(project.cwd);
        const gathered = await gather(project, worktrees);
        for (const located of gathered?.located ?? []) {
          const found = await evaluate(gathered!.ctx, located, options);
          if (found) candidates.push({ ...found, bytes: await dirSize(found.path) });
        }
        for (const orphan of worktrees ? await findOrphans(project, worktrees) : []) {
          candidates.push({ ...orphan, bytes: await dirSize(orphan.path) });
        }
      } catch {
        // one unreadable repo must not hide the rest
      }
    }
    return {
      available: true,
      candidates,
      totalBytes: candidates
        .filter((c) => c.reason !== "orphaned")
        .reduce((sum, c) => sum + c.bytes, 0),
    };
  } catch (error) {
    return {
      available: false,
      candidates: [],
      totalBytes: 0,
      error: error instanceof Error ? error.message : "Could not list worktrees",
    };
  }
}

let pruneRunning = false;

/**
 * Removes the stale worktrees: fetches each project first so a branch deleted
 * on the remote since the preview is seen, then re-checks each one right before
 * removing it (clean, unused, same commit, same reason) and removes it through
 * `removeListedWorktree`'s clean-checked path (see the header for what that does
 * and doesn't guard). Branches are left alone. One failure doesn't stop the rest.
 */
export async function pruneDevWorktrees(
  options: DevWorktreeOptions,
): Promise<DevWorktreePruneResult> {
  // Check-and-set with no await between them, as in cache-storage.ts.
  if (pruneRunning) throw new Error("DEV_WORKTREE_PRUNE_IN_PROGRESS");
  pruneRunning = true;
  try {
    let removed = 0;
    let reclaimedBytes = 0;
    const errors: string[] = [];
    for (const project of options.projects) {
      try {
        // Nothing to fetch for a project with no developer worktrees.
        const listed = await listWorktrees(project.cwd);
        const root = await repoRoot(project.cwd);
        if (!listed?.some((worktree) => locate(root, worktree))) continue;
        // Best effort: offline just means refs stay as of the last fetch, which
        // can only hide a stale worktree, never invent one. Gathered after, so
        // the branches it reads include what the fetch just learned.
        await (options.fetch ?? runGitFetch)(project.cwd).catch(() => undefined);
        const gathered = await gather(project);
        if (!gathered) continue;
        for (const located of gathered.located) {
          const candidate = await evaluate(gathered.ctx, located, options);
          if (!candidate) continue;
          // The size walk of a big node_modules takes a while: look again after
          // it, right before removing (still clean, unused, same commit, same
          // reason).
          const bytes = await dirSize(candidate.path);
          const again = await evaluate(gathered.ctx, located, options);
          if (again?.headSha !== candidate.headSha || again.reason !== candidate.reason) continue;
          const result = await removeListedWorktree(project.cwd, candidate.path);
          if (result.removed) {
            removed += 1;
            reclaimedBytes += bytes;
          } else if (result.reason === "remove-failed") {
            errors.push(`${project.name}/${candidate.slug}: could not be removed`);
          }
          // Anything else (dirty, conflicts, gone, not listed) changed under us.
        }
      } catch (error) {
        errors.push(`${project.name}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    return {
      output: `Removed ${String(removed)} stale developer worktree${removed === 1 ? "" : "s"}.`,
      reclaimedBytes,
      ...(errors.length > 0 ? { error: errors.slice(0, 3).join("; ") } : {}),
    };
  } finally {
    pruneRunning = false;
  }
}
