// #744 — the merge-readiness classification `attemptMerge`
// (task-reconciler.ts) already encoded inline, extracted as a pure function
// so the release-please "Merge" route (routes/projects.ts) can reuse the same
// GitHub-semantics knowledge instead of re-deriving it. Deliberately returns
// a STATE, not an action: the two callers choose different remedies for the
// same state. `attemptMerge` updates a task PR's branch on "behind" and
// spawns an auto-rebase worker on "dirty" — neither is correct for a
// release-please PR, whose branch release-please itself owns and
// force-pushes on every run (see the release-merge route's own doc comment
// for why "behind" there means "re-run release-please," not "update the
// branch").
//
// Two subtleties this must preserve exactly as `attemptMerge` already got
// them right, both easy to regress:
//   - `mergeable: null` / `mergeableState: "unknown"` means "GitHub is still
//     computing this asynchronously after a push, ask again" — never treat
//     it as "not mergeable." Falls out of the `default` arm below.
//   - `"unstable"` (a non-required check red or still running) must NOT be
//     treated as mergeable. Merging on "unstable" would silently skip
//     whatever that check was verifying.
export type MergeReadiness =
  "clean" | "behind" | "blocked" | "unstable" | "dirty" | "computing" | "already-done";

export interface MergeReadinessInput {
  merged: boolean;
  state: "open" | "closed";
  mergeableState: string;
}

export function classifyMergeReadiness(pr: MergeReadinessInput): MergeReadiness {
  // Merged or closed out of band (a human merged it directly on GitHub, or
  // closed it) takes precedence over whatever `mergeableState` GitHub still
  // reports for a closed PR — checked first, matching `attemptMerge`'s
  // original ordering.
  if (pr.merged || pr.state === "closed") return "already-done";
  switch (pr.mergeableState) {
    case "clean":
      return "clean";
    case "behind":
      return "behind";
    case "unstable":
      return "unstable";
    case "dirty":
      return "dirty";
    case "blocked":
      return "blocked";
    default:
      // "unknown" (pr.mergeable === null — GitHub is still computing
      // mergeability after a push) or any future state GitHub adds.
      return "computing";
  }
}
