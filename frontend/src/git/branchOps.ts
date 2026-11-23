import { api } from "../api/index.js";
import type { GitBranchOpReason, GitBranchOpResult } from "../api/types.js";
import { describeError } from "../lib/describeError.js";
import { branchOpReasonMessage, pullReasonMessage } from "./gitReasons.js";
import { refreshGitEverywhere } from "./useSourceControl.js";

/** What a checkout / create / rebase came to, worded for the Git view. */
export type BranchOpOutcome =
  { ok: true; notice: string } | { ok: false; message: string; reason?: GitBranchOpReason };

/**
 * Runs one guarded branch operation (issue #1672) and words its outcome. A
 * refusal (dirty tree, active session, an aborted conflicting rebase) is the
 * server's 200 `{ ok: false, reason }`; only a transport/HTTP failure
 * throws, and both come back as `{ ok: false, message }` — never a throw, so
 * each caller only decides where the words go. Anything that may have moved
 * HEAD refreshes every git surface for the project.
 */
export async function runBranchOp(
  projectId: number,
  op: () => Promise<GitBranchOpResult>,
  success: (result: GitBranchOpResult) => string,
): Promise<BranchOpOutcome> {
  let result: GitBranchOpResult;
  try {
    result = await op();
  } catch (err) {
    return { ok: false, message: describeError(err, "Request failed — try again.") };
  }
  if (!result.ok) {
    return {
      ok: false,
      message: branchOpReasonMessage(result.reason, result.detail, result.conflicts),
      reason: result.reason,
    };
  }
  refreshGitEverywhere(projectId);
  return {
    ok: true,
    notice:
      result.reason === "already-up-to-date"
        ? branchOpReasonMessage(result.reason, result.detail)
        : success(result),
  };
}

export const rebaseNotice = (result: GitBranchOpResult) =>
  `Rebased${result.detail ? ` onto ${result.detail}` : ""}.`;

/** The ahead/behind a row or the branch detail knows for one branch. */
export interface BranchTracking {
  ahead?: number;
  behind?: number;
}

/** A fast-forward would bring this branch up to date: behind, nothing local. */
export function fastForwardWouldDo(tracking: BranchTracking): boolean {
  return (tracking.behind ?? 0) > 0 && (tracking.ahead ?? 0) === 0;
}

export const SESSIONS_USE_PULL = "Sessions are working in this checkout. Use Pull to fast-forward.";

/**
 * Issue #3068 — the current branch's Rebase, refused because sessions work
 * in the checkout. When a plain fast-forward would do the same job, say so:
 * Pull is not blocked by a session in the checkout (a dirty tree still is).
 */
export function rebaseRefusalMessage(
  outcome: Extract<BranchOpOutcome, { ok: false }>,
  tracking: BranchTracking,
): string {
  return outcome.reason === "sessions-active" && fastForwardWouldDo(tracking)
    ? SESSIONS_USE_PULL
    : outcome.message;
}

/**
 * Issue #3068 — a row's Pull. The project checkout's current branch is the
 * header's own Pull (`git-pull`, which every agent version answers); any
 * other branch goes to `git-branch-pull`, which fast-forwards it in the
 * worktree that holds it, or only its ref when none does.
 */
export async function runBranchPull(
  projectId: number,
  branch: { name: string; isCurrent: boolean; upstream?: string },
): Promise<BranchOpOutcome> {
  const from = branch.upstream ? ` from ${branch.upstream}` : "";
  if (!branch.isCurrent) {
    return runBranchOp(
      projectId,
      () => api.pullProjectGitBranch(projectId, branch.name),
      () => `Pulled ${branch.name}${from}.`,
    );
  }
  try {
    const result = await api.postProjectGitPull(projectId);
    if (!result.pulled) {
      return { ok: false, message: pullReasonMessage(result.reason, result.detail) };
    }
    refreshGitEverywhere(projectId);
    return {
      ok: true,
      notice:
        result.reason === "already-up-to-date"
          ? pullReasonMessage(result.reason)
          : `Pulled ${branch.name}${from}.`,
    };
  } catch (err) {
    return { ok: false, message: describeError(err, "Request failed — try again.") };
  }
}
