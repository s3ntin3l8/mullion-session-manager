import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import type { IssueTriageState } from "../shared/types.js";
import type { PROrWithChecks } from "./github.js";
import { getRunForTarget } from "./hermes-review.js";

// Mullion's own state on GitHub data (epic #1965, A6): rows in the Git/GitHub
// sidebar link back to the triage run / Task Master task that concern them.
// Both lookups are cache/DB reads — never a GitHub or Hermes call — so the
// list routes stay as cheap as they were.

/**
 * The triage run this Mullion dispatched for an issue, from the in-memory run
 * index, or null (never requested, or the server restarted). It needs no
 * reviewer config: with the relay unset the index is simply empty.
 */
export function issueTriageFor(
  owner: string,
  repo: string,
  issueNumber: number,
): IssueTriageState | null {
  const record = getRunForTarget("issue", owner, repo, issueNumber);
  return record ? { state: "requested", runId: record.runId } : null;
}

/**
 * Joins each PR to the Task Master task that opened it — on `prNumber` (set
 * once the task is promoted to a PR), else on the task's own `branchName`
 * (a draft PR from the task's branch before `prNumber` is recorded). One
 * query per project; PRs with no task are returned untouched.
 */
export function annotatePrTasks(
  app: FastifyInstance,
  projectId: number,
  prs: PROrWithChecks[],
): PROrWithChecks[] {
  if (prs.length === 0) return prs;
  const rows = app.db
    .select({
      id: tasks.id,
      status: tasks.status,
      prNumber: tasks.prNumber,
      branchName: tasks.branchName,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .all();
  if (rows.length === 0) return prs;
  return prs.map((pr) => {
    const task =
      rows.find((t) => t.prNumber === pr.number) ??
      rows.find((t) => t.branchName !== null && t.branchName === pr.headBranch);
    return task ? { ...pr, taskId: task.id, taskStatus: task.status } : pr;
  });
}
