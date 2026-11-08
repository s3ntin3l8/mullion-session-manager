/**
 * The `## Round N` heading for one review round, as stored in
 * `tasks.review_findings` and posted on the PR.
 *
 * A suggestions round and a re-armed inconclusive review both spend no round,
 * so they would otherwise repeat the previous heading; each gets a suffix.
 * A never-re-armed round keeps the plain heading.
 */
export function reviewRoundLabel(
  task: {
    autoReturnRounds: number;
    lastAutoReturnReason: string | null;
    inconclusiveReviewRearmCount: number;
  },
  supersedeInconclusive = false,
): string {
  const suggestions =
    task.lastAutoReturnReason === "suggestions" ? " (re-review after suggestions)" : "";
  const retry =
    task.inconclusiveReviewRearmCount > 0
      ? ` (retry ${task.inconclusiveReviewRearmCount + 1})`
      : "";
  if (supersedeInconclusive) {
    return `## Round ${task.autoReturnRounds + 1} (late verdict — supersedes the inconclusive ingest)${retry}`;
  }
  return `## Round ${task.autoReturnRounds + 1}${suggestions}${retry}`;
}
