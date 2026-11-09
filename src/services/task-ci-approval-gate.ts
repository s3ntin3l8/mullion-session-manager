import type { FastifyInstance } from "fastify";
import type { tasks } from "../db/schema.js";
import type { GitHubRepoRef } from "./git-remote.js";
import { isRedCheckConclusion, type GitHubCiStatus } from "./github.js";
import { resolveGitHubToken } from "./github-integration.js";
import { readPrCheckRuns } from "./pr-check-runs.js";

/**
 * Is CI green enough for auto-approve (`attemptAutoApprove`'s last gate)?
 *
 * The aggregate `status` is computed from the head's WORKFLOW RUNS, but what
 * GitHub itself gates a merge on (and what the red-CI return reads) are CHECK
 * RUNS. They usually agree. When GitHub loses a run — a CodeQL or dependency
 * review run that ends `failure` with its jobs never created — they do not: the
 * run stays `failure` forever (GitHub refuses to retry some of them), no check
 * run is red, the PR's checks tab is green, the red-CI return correctly sees
 * nothing to send back, and auto-approve returned silently on `status !==
 * "success"`. Three approved, green tasks sat like that for hours.
 *
 * So a `failure` is only believed when a check run backs it. If every check run
 * on the head is complete and none is red, the failed workflow run is
 * infrastructure noise and does not hold the approval. A lookup that cannot be
 * answered, a check still running, or a red check all keep holding it.
 *
 * Every refusal is logged (throttled to once per task per hour — this runs each
 * sweep tick), so a task waiting here is no longer silent.
 */
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
  },
): Promise<boolean> {
  if (current.status === "success") return true;

  if (current.status === "failure") {
    const token = await resolveGitHubToken(app, current.repoRef, "read");
    const checks = token
      ? await readPrCheckRuns(app, task, token, current.repoRef, current.headSha, "approval-gate")
      : null;
    if (checks?.ok && checks.runs.length > 0) {
      const pending = checks.runs.some((c) => c.conclusion === null);
      const red = checks.runs.filter((c) => isRedCheckConclusion(c.conclusion));
      if (!pending && red.length === 0) {
        logOncePerHour(
          app,
          task.id,
          "warn",
          {
            headSha: current.headSha,
            failedRuns: current.runs
              .filter((r) => r.conclusion !== null && isRedCheckConclusion(r.conclusion))
              .map((r) => r.name),
          },
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
    { headSha: current.headSha, ciStatus: current.status },
    "task reconcile: auto-approve is waiting on CI — the head's workflow runs are not all green",
  );
  return false;
}
