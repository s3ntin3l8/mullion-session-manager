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
 * When `storedFindings` already holds the same heading (a human re-review of a
 * concluded round), a `re-review N` note is added so no two headings repeat.
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
  storedFindings: string | null = null,
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
  const build = (extra: string[]): string => {
    const all = [...notes, ...extra];
    return `## Round ${task.autoReturnRounds + 1}${all.length > 0 ? ` (${all.join(", ")})` : ""}`;
  };
  // A human re-review of a concluded round spends no counter, so it would
  // re-ingest under the same heading; number it against what is already stored.
  const taken = new Set(
    (storedFindings ?? "")
      .split("\n")
      .filter((l) => l.startsWith("## Round "))
      .map((l) => l.trimEnd()),
  );
  let label = build([]);
  for (let n = 2; taken.has(label); n++) label = build([`re-review ${n}`]);
  return label;
}
