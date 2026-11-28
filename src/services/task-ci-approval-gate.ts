import type { FastifyInstance } from "fastify";
import type { tasks } from "../db/schema.js";
import type { GitHubRepoRef } from "./git-remote.js";
import {
  isPassingCheckConclusion,
  isRedCheckConclusion,
  latestCheckRunsByName,
  type GitHubCiStatus,
} from "./github.js";
import { resolveGitHubToken } from "./github-integration.js";
import { readPrCheckRuns, type PrCheckRuns } from "./pr-check-runs.js";

/**
 * Is CI green enough for auto-approve (`attemptAutoApprove`'s last gate)?
 *
 * The aggregate `status` is computed from the head's WORKFLOW RUNS, but what
 * GitHub itself gates a merge on (and what the red-CI return reads) are CHECK
 * RUNS. They usually agree — but they can disagree in BOTH directions:
 *
 *   - GitHub loses a run (a CodeQL or dependency review run that ends
 *     `failure` with its jobs never created, and that it refuses to retry):
 *     the run stays `failure` forever, no check run is red, the PR's checks
 *     tab is green, the red-CI return correctly sees nothing to send back,
 *     and auto-approve returned silently on `status !== "success"`. Three
 *     approved, green tasks sat like that for hours.
 *   - `computeCiStatus` EXCLUDES a `cancelled` run from its aggregate, so a
 *     cancelled required check (CI/CD cancelled, the other workflows green)
 *     leaves the aggregate `success` while GitHub's own merge gate still
 *     refuses the head. Approving that head approves a merge GitHub rejects
 *     (#3591).
 *
 * So BOTH paths read the head's check runs:
 *
 *   - `success` — the latest run of EVERY check name must satisfy the merge
 *     gate (`isPassingCheckConclusion`: success, skipped or neutral). A
 *     cancelled, still-running, missing or unreadable check list holds the
 *     approval, and says which one it was.
 *   - `failure` — the failure is only overridden when ALL of these hold:
 *       - every failed workflow run is one of `LOST_RUN_WORKFLOWS` (the known
 *         analysis workflows GitHub loses). A run that fails workflow
 *         validation (a broken `uses:` ref) also creates no job and no check
 *         run, and would read as noise here, so any OTHER failed workflow
 *         keeps holding;
 *       - the head has check runs, GitHub answered, and the latest run of each
 *         check name satisfies the merge gate (success, skipped or neutral).
 *
 * Every refusal is logged with its actual reason (throttled to once per task
 * per hour — this runs each sweep tick), so a task waiting here is no longer
 * silent.
 */
const LOST_RUN_WORKFLOWS: readonly string[] = ["CodeQL", "Dependency Review"];

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

/** What the gate reads about the head's CI. */
type CiApprovalContext = {
  status: GitHubCiStatus;
  headSha: string;
  repoRef: GitHubRepoRef;
  runs: { name: string; conclusion: string | null }[];
  /** False when the Actions-runs lookup failed: `status` is then null, which
   * is not the same as "no workflow runs". */
  runsAnswered?: boolean;
  /** The check runs the red-CI return already read this tick, if it did. */
  checkRuns?: PrCheckRuns;
};

export async function ciAllowsAutoApproval(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  current: CiApprovalContext,
): Promise<boolean> {
  // The aggregate says every workflow run succeeded — but it EXCLUDES a
  // cancelled run, so a cancelled required check leaves it green while
  // GitHub's own merge gate still refuses the head (#3591). Read the check
  // runs before approving: the merge gate is what decides whether this head
  // can merge, and check runs are what it reads.
  if (current.status === "success") {
    const verdict = await evaluateLatestChecks(app, task, current);
    if (!verdict.ok) {
      logWaiting(app, task, current, verdict.reason);
      return false;
    }
    return true;
  }

  let reason: string;
  if (current.status !== "failure") {
    reason =
      current.status === "in_progress"
        ? "workflow-runs-in-progress"
        : current.runsAnswered === false
          ? "workflow-runs-lookup-failed"
          : "no-workflow-runs";
  } else {
    const failedRuns = current.runs
      .filter((r) => r.conclusion !== null && isRedCheckConclusion(r.conclusion))
      .map((r) => r.name);
    const otherFailures = failedRuns.filter((n) => !LOST_RUN_WORKFLOWS.includes(n));
    if (failedRuns.length === 0) {
      // `computeCiStatus` counts a `neutral` run as a failure, but the red
      // predicate does not: with no run named there is nothing to say is lost.
      reason = "failure-without-a-red-workflow-run";
    } else if (otherFailures.length > 0) {
      reason = "failed-workflow-not-known-lost";
    } else {
      const verdict = await evaluateLatestChecks(app, task, current);
      if (!verdict.ok) {
        reason = verdict.reason;
      } else {
        logOncePerHour(
          app,
          task.id,
          "warn",
          { headSha: current.headSha, failedRuns },
          "task reconcile: auto-approve is ignoring workflow run(s) that failed without any failing check run (a run GitHub lost) — the latest run of every check name on the head is green",
        );
        return true;
      }
    }
  }

  logWaiting(app, task, current, reason);
  return false;
}

/**
 * The head's latest check runs, and whether they satisfy GitHub's merge gate.
 *
 * The check runs the red-CI return already read this tick are reused when it
 * read them (`current.checkRuns`) — one lookup per tick, not two.
 *
 * "The latest run of each check name" is what GitHub's merge gate looks at:
 * a re-run that passes unblocks the merge even though the superseded attempt
 * (a cancelled one) is still listed on the head.
 */
async function evaluateLatestChecks(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  current: CiApprovalContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = current.checkRuns ? null : await resolveGitHubToken(app, current.repoRef, "read");
  const checks =
    current.checkRuns ??
    (token
      ? await readPrCheckRuns(app, task, token, current.repoRef, current.headSha, "approval-gate")
      : null);
  const latestChecks = checks?.ok ? latestCheckRunsByName(checks.runs) : [];
  if (checks === null) {
    return { ok: false, reason: "no-token-to-read-check-runs" };
  }
  if (!checks.ok) {
    return { ok: false, reason: "check-runs-unreadable" };
  }
  if (latestChecks.length === 0) {
    return { ok: false, reason: "no-check-runs" };
  }
  if (latestChecks.some((c) => !isPassingCheckConclusion(c.conclusion))) {
    // At least one latest check does not satisfy GitHub's merge gate. Name the
    // reason as precisely as the conclusion allows:
    //   - a running check needs time;
    //   - a CANCELLED check is NOT red (`isRedCheckConclusion` excludes it:
    //     the red-CI return must not send the worker back for it), but it is
    //     not passing either — GitHub's merge gate refuses the head until the
    //     job is re-run. It gets its own reason because it needs a CI/CD
    //     re-run, not a fix, and an operator reading the log must be able to
    //     tell the two;
    //   - everything else that does not pass is red: `isRedCheckConclusion`
    //     covers every remaining conclusion (and any GitHub adds later), so
    //     this is also the safety net for a conclusion the merge gate
    //     rejects but the red path does not.
    if (latestChecks.some((c) => c.conclusion === null)) {
      return { ok: false, reason: "check-run-still-running" };
    }
    if (latestChecks.some((c) => c.conclusion === "cancelled")) {
      return { ok: false, reason: "check-run-cancelled" };
    }
    return { ok: false, reason: "check-run-red" };
  }
  return { ok: true };
}

/** Says why the gate is holding, with the actual reason. */
function logWaiting(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  current: CiApprovalContext,
  reason: string,
): void {
  logOncePerHour(
    app,
    task.id,
    "info",
    { headSha: current.headSha, ciStatus: current.status, reason },
    `task reconcile: auto-approve is waiting on CI (${reason})`,
  );
}
