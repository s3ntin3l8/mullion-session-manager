/**
 * The `## Round N` heading for one review round, as stored in
 * `tasks.review_findings` and posted on the PR.
 *
 * A suggestions round and a re-armed inconclusive review both spend no round,
 * so they would otherwise repeat the previous heading; each gets a suffix.
 * Three notes exist: `retry N` (re-armed inconclusive review), `re-review after
 * suggestions`, and `late verdict — supersedes the inconclusive ingest` (the
 * `supersedeInconclusive` flag). The last two are mutually exclusive — a late
 * verdict wins over the suggestions note — while the retry note stacks with
 * either, in one parenthetical.
 * A never-re-armed round keeps the plain heading, and every heading must stay
 * prefix-compatible with `^## Round (\d+)` and the `\n\n(?=## Round )` split:
 * `parseReviewRounds` (frontend/src/lib/reviewRounds.ts) and
 * `openRefsOfRenderedRound`/`priorRoundFor` parse it back. Keep the suffix on
 * the one heading line.
 */
export function reviewRoundLabel(
  task: {
    autoReturnRounds: number;
    lastAutoReturnReason: string | null;
    inconclusiveReviewRearmCount: number;
  },
  supersedeInconclusive = false,
): string {
  const notes: string[] = [];
  if (task.inconclusiveReviewRearmCount > 0) {
    notes.push(`retry ${task.inconclusiveReviewRearmCount + 1}`);
  }
  if (supersedeInconclusive) {
    notes.push("late verdict — supersedes the inconclusive ingest");
  } else if (task.lastAutoReturnReason === "suggestions") {
    notes.push("re-review after suggestions");
  }
  const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  return `## Round ${task.autoReturnRounds + 1}${suffix}`;
}
