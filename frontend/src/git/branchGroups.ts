import type { GitBranchInfo, GitBranchMergeState, GitWorktreeInfo } from "../api/types.js";
import type { Tone } from "../lib/statusTone.js";
import { isTaskBranch, type MullionLinks } from "../hooks/useMullionLinks.js";
import { isDefaultBranchName } from "./gitReasons.js";

export type BranchGroupId = "current" | "pr" | "task" | "prunable" | "other";

export interface BranchGroup {
  id: BranchGroupId;
  title: string;
  branches: GitBranchInfo[];
}

const TITLES: Record<BranchGroupId, string> = {
  current: "Current",
  pr: "With open PR",
  task: "Task branches",
  prunable: "Prunable",
  other: "Other",
};

const DONE_STATES: ReadonlySet<GitBranchMergeState> = new Set([
  "ancestor",
  "upstream-gone",
  "pr-merged",
]);

const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
  month: 2592000,
  year: 31536000,
};

/** `%(committerdate:relative)` ("3 days ago") -> age in seconds; unknown sorts last. */
export function relativeAgeSeconds(relative: string | undefined): number {
  const m = relative?.match(/^(\d+) (second|minute|hour|day|week|month|year)s? ago$/);
  return m ? Number(m[1]) * (UNIT_SECONDS[m[2] as string] ?? 1) : Number.MAX_SAFE_INTEGER;
}

/** Whether the prune would offer this branch (mirrors the server's planPrune guards). */
export function isPrunable(
  branch: GitBranchInfo,
  worktrees: readonly GitWorktreeInfo[],
  defaultBranch: string | null | undefined,
  links: MullionLinks,
): boolean {
  const state = branch.mergeState;
  if (!state || !DONE_STATES.has(state)) return false;
  if (branch.isCurrent || isDefaultBranchName(branch.name, defaultBranch)) return false;
  if (worktrees.some((w) => w.branch === branch.name && !w.isMain)) return false;
  if (isTaskBranch(branch.name) || links.byBranch.get(branch.name)?.taskOwned) return false;
  return true;
}

/**
 * Current · With open PR · Task branches · Prunable · Other, each sorted by
 * recency. A branch lands in the first group that claims it, in that order, so
 * a task branch with an open PR reads as a task branch (the lock is the news).
 */
export function groupBranches(
  branches: readonly GitBranchInfo[],
  opts: {
    worktrees: readonly GitWorktreeInfo[];
    defaultBranch: string | null | undefined;
    links: MullionLinks;
    /** Branch names that have an open PR in the store (fresher than `branch.pr`). */
    openPrBranches: ReadonlySet<string>;
    filter?: string;
  },
): BranchGroup[] {
  const needle = opts.filter?.trim().toLowerCase() ?? "";
  const buckets: Record<BranchGroupId, GitBranchInfo[]> = {
    current: [],
    pr: [],
    task: [],
    prunable: [],
    other: [],
  };
  for (const b of branches) {
    if (needle && !b.name.toLowerCase().includes(needle)) continue;
    const taskOwned = isTaskBranch(b.name) || opts.links.byBranch.get(b.name)?.taskOwned === true;
    let id: BranchGroupId = "other";
    if (b.isCurrent) id = "current";
    else if (taskOwned) id = "task";
    else if (opts.openPrBranches.has(b.name) || b.pr?.state === "open") id = "pr";
    else if (isPrunable(b, opts.worktrees, opts.defaultBranch, opts.links)) id = "prunable";
    buckets[id].push(b);
  }
  const order: BranchGroupId[] = ["current", "pr", "task", "prunable", "other"];
  return order
    .filter((id) => buckets[id].length > 0)
    .map((id) => ({
      id,
      title: TITLES[id],
      branches: [...buckets[id]].sort(
        (a, b) =>
          relativeAgeSeconds(a.lastCommitRelative) - relativeAgeSeconds(b.lastCommitRelative),
      ),
    }));
}

export interface MergeChip {
  tone: Tone;
  label: string;
  short: string;
  title: string;
}

/** The merge-state chip, with the reason in its tooltip. */
export function mergeChip(state: GitBranchMergeState, pr?: { number: number } | null): MergeChip {
  switch (state) {
    case "ancestor":
      return {
        tone: "merged",
        label: "merged",
        short: "merged",
        title: "Merged into the base branch",
      };
    case "pr-merged":
      return {
        tone: "merged",
        label: "squash-merged",
        short: "squash",
        title: pr ? `PR #${pr.number} was merged` : "Its PR was merged",
      };
    case "upstream-gone":
      return {
        tone: "merged",
        label: "upstream gone",
        short: "gone",
        title: "The remote branch was deleted",
      };
    case "pr-closed":
      return {
        tone: "neutral",
        label: "PR closed",
        short: "closed",
        title: pr ? `PR #${pr.number} was closed without merging` : "Its PR was closed unmerged",
      };
  }
}

export const PRUNE_SKIP_LABEL: Record<string, string> = {
  current: "current branch",
  default: "default branch",
  worktree: "checked out in a worktree",
  "task-claimed": "owned by a Task Master task",
};
