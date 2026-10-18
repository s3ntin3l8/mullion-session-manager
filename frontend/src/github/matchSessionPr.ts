/**
 * The open PR a session (or Task Master task) is working on. A task's recorded
 * PR number wins when that PR is still open — it survives the worker switching
 * branches — otherwise the PR whose head is the session's branch. One
 * definition for the session row, the task detail and the rail badge, so they
 * can't point at different PRs.
 */
export function matchSessionPr<T extends { number: number; headBranch: string }>(
  prs: readonly T[] | undefined,
  match: { branch?: string | null; taskPrNumber?: number | null },
): T | undefined {
  if (!prs) return undefined;
  if (match.taskPrNumber != null) {
    const byNumber = prs.find((pr) => pr.number === match.taskPrNumber);
    if (byNumber) return byNumber;
  }
  return match.branch ? prs.find((pr) => pr.headBranch === match.branch) : undefined;
}
