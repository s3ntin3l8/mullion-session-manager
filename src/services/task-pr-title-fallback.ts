import { parseCommitTitle, resolvePrTitle } from "./task-prompt.js";

// The task drawer's surface for the second silent-fallback layer #761 left:
// even with conventionalCommitTitles on, a worker that skipped or malformed
// its title file left task-reconciler.ts's ingest with nothing but one
// `app.log.warn` — never anything a human looking at the task would see.
// `prTitle === null` alone is NOT that signal (see prTitle's own doc comment
// above) — this recomputes exactly what resolvePrTitle/task-promote.ts
// actually used for the live PR title, and flags it only when THAT title
// isn't Conventional-Commits-shaped despite the project wanting one. A task
// with no PR yet never flags (nothing to fall back on yet).
export function withPrTitleFallback<
  T extends {
    title: string;
    prTitle: string | null;
    prUrl: string | null;
    projectConventionalCommitTitles: boolean | null;
  },
>(row: T): Omit<T, "projectConventionalCommitTitles"> & { prTitleFallback: boolean } {
  const { projectConventionalCommitTitles, ...rest } = row;
  const prTitleFallback =
    projectConventionalCommitTitles === true &&
    row.prUrl !== null &&
    parseCommitTitle(resolvePrTitle(row)) === null;
  return { ...rest, prTitleFallback };
}
