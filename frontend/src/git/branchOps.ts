import type { GitBranchOpResult } from "../api/types.js";
import { describeError } from "../lib/describeError.js";
import { branchOpReasonMessage } from "./gitReasons.js";
import { refreshGitEverywhere } from "./useSourceControl.js";

/** What a checkout / create / rebase came to, worded for the Git view. */
export type BranchOpOutcome = { ok: true; notice: string } | { ok: false; message: string };

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
