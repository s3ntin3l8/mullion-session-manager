import fs from "node:fs/promises";
import path from "node:path";
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
  { dir: path.join(".claude", "worktrees"), kind: "claude-agent" },
] as const;

export type DevWorktreeKind = (typeof ROOTS)[number]["kind"];

/**
 * Why it is safe to remove:
 * - `gone`: its branch's upstream was deleted on the remote (a merged and
 *   auto-deleted PR, or an abandoned one), per the last fetch.
 * - `merged`: GitHub reports a merged PR whose head is exactly this commit, for
 *   repos that don't delete branches on merge. Commits added since don't count.
 * - `detached-merged`: a detached HEAD whose commit is already in the default
 *   branch.
 */
export type DevWorktreeReason = "gone" | "merged" | "detached-merged";

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
  candidates: DevWorktreeCandidate[];
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

function locate(repoCwd: string, worktree: GitWorktreeInfo): Located | null {
  if (worktree.isMain) return null;
  const resolved = path.resolve(worktree.path);
  for (const root of ROOTS) {
    const prefix = path.join(path.resolve(repoCwd), root.dir) + path.sep;
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
  return null;
}

/** This project's developer worktrees, with the repo facts every check needs. */
async function gather(
  project: DevWorktreeProject,
): Promise<{ ctx: RepoContext; located: Located[] } | null> {
  const worktrees = await listWorktrees(project.cwd);
  if (!worktrees) return null;
  const located = worktrees.flatMap((worktree) => locate(project.cwd, worktree) ?? []);
  if (located.length === 0) return null;
  const ctx = await repoContext(project);
  return ctx ? { ctx, located } : null;
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
        const gathered = await gather(project);
        for (const located of gathered?.located ?? []) {
          const found = await evaluate(gathered!.ctx, located, options);
          if (found) candidates.push({ ...found, bytes: await dirSize(found.path) });
        }
      } catch {
        // one unreadable repo must not hide the rest
      }
    }
    return {
      available: true,
      candidates,
      totalBytes: candidates.reduce((sum, c) => sum + c.bytes, 0),
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
 * removing it (clean, unused, same commit, same reason) and removes it without
 * `--force`. Branches are left alone. One failure doesn't stop the rest.
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
        if (!listed?.some((worktree) => locate(project.cwd, worktree))) continue;
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
