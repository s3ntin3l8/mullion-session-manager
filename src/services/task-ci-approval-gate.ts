import type { FastifyInstance } from "fastify";
import type { tasks } from "../db/schema.js";
import type { GitHubRepoRef } from "./git-remote.js";
import { isRedCheckConclusion, type GitHubCiStatus } from "./github.js";
import { resolveGitHubToken } from "./github-integration.js";
import { readPrCheckRuns, type PrCheckRuns } from "./pr-check-runs.js";

/**
 * Is CI green enough for auto-approve (`attemptAutoApprove`'s last gate)?
 *
 * The aggregate `status` is computed from the head's WORKFLOW RUNS, but what
 * GitHub itself gates a merge on (and what the red-CI return reads) are CHECK
 * RUNS. They usually agree. When GitHub loses a run (a CodeQL or dependency
 * review run that ends `failure` with its jobs never created, and that it
 * refuses to retry) they do not: the run stays `failure` forever, no check run
 * is red, the PR's checks tab is green, the red-CI return correctly sees
 * nothing to send back, and auto-approve returned silently on `status !==
 * "success"`. Three approved, green tasks sat like that for hours.
 *
 * So a `failure` is only overridden when ALL of these hold:
 *   - every failed workflow run is one of `LOST_RUN_WORKFLOWS` (the known
 *     analysis workflows GitHub loses). A run that fails workflow validation
 *     (a broken `uses:` ref) also creates no job and no check run, and would
 *     read as noise here, so any OTHER failed workflow keeps holding;
 *   - the head has check runs, GitHub answered, none is still running and none
 *     is red.
 *
 * Every refusal is logged with its actual reason (throttled to once per task
 * per hour — this runs each sweep tick), so a task waiting here is no longer
 * silent.
 */
export const LOST_RUN_WORKFLOWS: readonly string[] = ["CodeQL", "Dependency Review"];

const WAITING_LOG_INTERVAL_MS = 60 * 60_000;
const lastLoggedAt = new Map<number, number>();
const MAX_LOG_ENTRIES = 500;

/** Exported for tests only — the throttle is module-scope state. */
export function resetCiApprovalGateLogsForTests(): void {
  lastLoggedAt.clear();
}

function logOncePerHour(
  app: FastifyInstance,
  taskId: number,
  level: "info" | "warn",
  fields: Record<string, unknown>,
  msg: string,
): void {
  const now = Date.now();
  const last = lastLoggedAt.get(taskId);
  if (last !== undefined && now - last < WAITING_LOG_INTERVAL_MS) return;
  if (last === undefined && lastLoggedAt.size >= MAX_LOG_ENTRIES) {
    const oldest = lastLoggedAt.keys().next().value;
    if (oldest !== undefined) lastLoggedAt.delete(oldest);
  }
  lastLoggedAt.set(taskId, now);
  app.log[level]({ taskId, ...fields }, msg);
}

export async function ciAllowsAutoApproval(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  current: {
    status: GitHubCiStatus;
    headSha: string;
    repoRef: GitHubRepoRef;
    runs: { name: string; conclusion: string | null }[];
    /** The check runs the red-CI return already read this tick, if it did. */
    checkRuns?: PrCheckRuns;
  },
): Promise<boolean> {
  if (current.status === "success") return true;

  let reason: string;
  if (current.status !== "failure") {
    reason = current.status === "in_progress" ? "workflow-runs-in-progress" : "no-workflow-runs";
  } else {
    const failedRuns = current.runs
      .filter((r) => r.conclusion !== null && isRedCheckConclusion(r.conclusion))
      .map((r) => r.name);
    const otherFailures = failedRuns.filter((n) => !LOST_RUN_WORKFLOWS.includes(n));
    if (otherFailures.length > 0) {
      reason = "failed-workflow-not-known-lost";
    } else {
      const token = current.checkRuns
        ? null
        : await resolveGitHubToken(app, current.repoRef, "read");
      const checks =
        current.checkRuns ??
        (token
          ? await readPrCheckRuns(
              app,
              task,
              token,
              current.repoRef,
              current.headSha,
              "approval-gate",
            )
          : null);
      if (checks === null) {
        reason = "no-token-to-read-check-runs";
      } else if (!checks.ok) {
        reason = "check-runs-unreadable";
      } else if (checks.runs.length === 0) {
        reason = "no-check-runs";
      } else if (checks.runs.some((c) => c.conclusion === null)) {
        reason = "check-run-still-running";
      } else if (checks.runs.some((c) => isRedCheckConclusion(c.conclusion))) {
        reason = "check-run-red";
      } else {
        logOncePerHour(
          app,
          task.id,
          "warn",
          { headSha: current.headSha, failedRuns },
          "task reconcile: auto-approve is ignoring workflow run(s) that failed without any failing check run (a run GitHub lost) — every check run on the head is green",
        );
        return true;
      }
    }
  }

  logOncePerHour(
    app,
    task.id,
    "info",
    { headSha: current.headSha, ciStatus: current.status, reason },
    `task reconcile: auto-approve is waiting on CI (${reason})`,
  );
  return false;
}
