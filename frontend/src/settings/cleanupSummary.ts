import type { CleanupJob, CleanupSource } from "../api/index.js";
import { formatBytes } from "../formatBytes.js";

// How each source is named inside a sentence.
const SENTENCE_LABEL: Record<CleanupSource, string> = {
  docker: "Docker",
  temp: "temp files",
  caches: "caches",
  opencode: "opencode database",
  worktrees: "developer worktrees",
};

/**
 * One line for a finished cleanup: what was freed, per source when more than
 * one took part, and what stopped it. Skipped sources don't appear (their
 * reason is in the step list), and developer worktrees only when they did or
 * reported something, since there is usually nothing there.
 */
export function summarizeCleanup(job: CleanupJob): string {
  const parts = job.steps.filter(
    (step) =>
      (step.state === "done" || step.state === "error") &&
      (step.source !== "worktrees" || step.reclaimedBytes > 0 || step.note),
  );
  const total = parts.reduce((sum, step) => sum + step.reclaimedBytes, 0);
  const errors = parts
    .map((step) => step.note)
    .filter(Boolean)
    .join("; ");
  let message = `Freed ${formatBytes(total)}`;
  if (parts.length > 1) {
    message += ` (${parts
      .map((step) => `${SENTENCE_LABEL[step.source]} ${formatBytes(step.reclaimedBytes)}`)
      .join(", ")})`;
  }
  return !errors ? `${message}.` : total === 0 ? errors : `${message}, then stopped: ${errors}`;
}
