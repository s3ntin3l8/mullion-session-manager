import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, tasks } from "../db/schema.js";
import { isGitHubRateLimited } from "./github-fetch.js";
import { resolveGitHubToken } from "./github-integration.js";
import { getPullRequestByNumber } from "./github-write.js";
import { resolveRepoRef } from "./host-git.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { PR_CLOSED_REASON, flagClosedUnmergedDoneTask } from "./task-pr-closed.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

// A hand-merge never sets `mergeRequestedAt`, so the merge sweep
// (processMergeRequests) never looks at it; the `pull_request` webhook is the
// only other signal, and webhook registration is best-effort. This sweep is
// the poll behind both: it re-reads the PR of an approved task that nobody has
// asked Mullion to merge, and finishes the task (marking it merged, which
// closes its issue) or flags it (closed without merging).
//
// Bounded so it cannot hammer GitHub: a task is only looked at once it has been
// `done` for REPOLL_GRACE_MS (the webhook normally wins that race), at most
// once per REPOLL_INTERVAL_MS (FLAGGED_REPOLL_INTERVAL_MS once flagged), never
// once archived, and at most MAX_REPOLLS_PER_SWEEP per tick.
export const REPOLL_GRACE_MS = 30 * 60_000;
const REPOLL_INTERVAL_MS = 60 * 60_000;
// A task already flagged `pr-closed` is polled far less often: the only thing
// left to find is a human reopening and merging the PR by hand.
const FLAGGED_REPOLL_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_REPOLLS_PER_SWEEP = 10;
const MAX_LEDGER_ENTRIES = 500;

const lastPolledAt = new Map<number, number>();

export function resetRepollLedgerForTests(): void {
  lastPolledAt.clear();
}

function recordPoll(taskId: number, now: number): void {
  lastPolledAt.delete(taskId); // re-insert so the Map's order is least-recently-polled first
  lastPolledAt.set(taskId, now);
  if (lastPolledAt.size > MAX_LEDGER_ENTRIES) {
    const oldest = lastPolledAt.keys().next().value;
    if (oldest !== undefined) lastPolledAt.delete(oldest);
  }
}

/**
 * @param onMerged called for a task whose PR turned out to be merged; the
 *   reconciler passes `finishMergedDoneTask` (marks it merged, closes the
 *   issue, arms autorelease). Injected, not imported, so this module stays
 *   below the reconciler in the import graph.
 */
export async function repollUnmergedDoneTasks(
  app: FastifyInstance,
  onMerged: (
    app: FastifyInstance,
    task: TaskRow,
    project: ProjectRow,
    mergedAt: Date | undefined,
  ) => void,
): Promise<void> {
  if (!resolveTaskMasterConfig(app).enabled) return;
  if (isGitHubRateLimited()) return;

  const now = Date.now();
  const rows = app.db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(tasks.status, "done"),
        isNotNull(tasks.prNumber),
        isNull(tasks.mergedAt),
        isNull(tasks.mergeRequestedAt),
        // Archived (cleared) tasks are finished business; do not poll them forever.
        isNull(tasks.archivedAt),
        lte(tasks.completedAt, new Date(now - REPOLL_GRACE_MS)),
      ),
    )
    .orderBy(asc(tasks.completedAt))
    .all()
    .filter(({ task }) => {
      const interval =
        task.needsHumanReason === PR_CLOSED_REASON
          ? FLAGGED_REPOLL_INTERVAL_MS
          : REPOLL_INTERVAL_MS;
      return now - (lastPolledAt.get(task.id) ?? 0) >= interval;
    })
    .slice(0, MAX_REPOLLS_PER_SWEEP);

  for (const { task, project } of rows) {
    if (isGitHubRateLimited()) return;
    recordPoll(task.id, now);
    try {
      const repoRef = await resolveRepoRef(app, project);
      const token = repoRef ? await resolveGitHubToken(app, repoRef) : null;
      if (!repoRef || !token || task.prNumber === null) continue;
      const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
      if (pr.merged) {
        onMerged(app, task, project, pr.mergedAt ? new Date(pr.mergedAt) : undefined);
      } else if (pr.state === "closed") {
        await flagClosedUnmergedDoneTask(app, task, project);
      }
    } catch (err) {
      // One PR's failure (deleted, 404, a flaky read) must not end the sweep;
      // the task is retried after REPOLL_INTERVAL_MS.
      app.log.debug({ taskId: task.id, err }, "task reconcile: re-poll of an approved task failed");
    }
  }
}
