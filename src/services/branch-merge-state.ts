import type { GitBranchInfo, GitWorktreeInfo } from "../shared/types.js";
import type { ClosedPrRecord } from "./github-merged-prs.js";

// Layers the GitHub-derived signals onto the git-derived ones git-refs.ts's
// `listBranches` already set (`ancestor`, `upstream-gone`), and decides what a
// local prune may touch. Pure: the route owns every network/DB read.

/** The slice of an open PR this needs (`PROrWithChecks` satisfies it). */
export interface OpenPrRef {
  number: number;
  htmlUrl: string;
  headBranch: string;
}

/**
 * Sets `pr` and, when git found no signal of its own, `mergeState` from the
 * closed/merged PR map. A closed PR only counts when its head SHA is this
 * branch's tip: a branch name reused after a merge, or one with commits added
 * since, must not read as done (the prune would delete unmerged work).
 */
export function applyPrState(
  branches: GitBranchInfo[],
  closedByBranch: Map<string, ClosedPrRecord> | null,
  openPrs: OpenPrRef[] | null,
): void {
  for (const branch of branches) {
    const open = openPrs?.find((pr) => pr.headBranch === branch.name);
    if (open) {
      branch.pr = { number: open.number, state: "open", url: open.htmlUrl };
      continue;
    }
    const closed = closedByBranch?.get(branch.name);
    if (!closed || !branch.sha || closed.headSha !== branch.sha) continue;
    branch.pr = { number: closed.number, state: closed.state, url: closed.url };
    if (branch.mergeState === undefined) {
      branch.mergeState = closed.state === "merged" ? "pr-merged" : "pr-closed";
    }
  }
}

export type PruneSkipReason = "current" | "worktree" | "task-claimed" | "default";

export interface PruneCandidate {
  name: string;
  reason: NonNullable<GitBranchInfo["mergeState"]>;
}

export interface PrunePlan {
  candidates: PruneCandidate[];
  skipped: { name: string; why: PruneSkipReason }[];
}

/** `origin/main` -> `main`. */
function localDefaultName(defaultBranch: string | null | undefined): string | null {
  return defaultBranch ? defaultBranch.replace(/^origin\//, "") : null;
}

/**
 * Splits branches that look done into prunable candidates and guarded skips.
 * Guards are the same ones `git-branch-delete` enforces (current, checked out
 * in a worktree, claimed by a resumable task) plus the default branch.
 * `pr-closed` (closed unmerged) is never a candidate: that work was abandoned,
 * not landed.
 */
export function planPrune(
  branches: GitBranchInfo[],
  worktrees: GitWorktreeInfo[],
  defaultBranch: string | null | undefined,
  isTaskClaimed: (name: string) => boolean,
): PrunePlan {
  const defaultName = localDefaultName(defaultBranch);
  const inWorktree = new Set(worktrees.map((w) => w.branch).filter((b): b is string => !!b));
  const plan: PrunePlan = { candidates: [], skipped: [] };
  for (const branch of branches) {
    const state = branch.mergeState;
    if (!state || state === "pr-closed") continue;
    if (branch.isCurrent) plan.skipped.push({ name: branch.name, why: "current" });
    else if (branch.name === defaultName) plan.skipped.push({ name: branch.name, why: "default" });
    else if (inWorktree.has(branch.name)) plan.skipped.push({ name: branch.name, why: "worktree" });
    else if (isTaskClaimed(branch.name)) {
      plan.skipped.push({ name: branch.name, why: "task-claimed" });
    } else plan.candidates.push({ name: branch.name, reason: state });
  }
  return plan;
}
