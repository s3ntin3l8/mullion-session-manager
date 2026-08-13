// #667 — dependency-aware task claiming. Shared by task-watcher.ts's
// autoClaimReadyTasks (the poll path) and routes/webhooks.ts (the push
// path, both `issue_dependencies` deliveries and a blocker's own "closed"
// event) so the two paths can't drift — the same reason upsertIssueTask /
// syncClosedIssueToLocal are shared rather than duplicated per path.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import { listBlockedByIssues } from "./github-write.js";
import { broadcastTaskEvent } from "./task-events.js";

export interface StoredBlocker {
  owner: string;
  repo: string;
  number: number;
  title: string;
  // Null for the synthetic "N blocker(s) not visible to this token" entry
  // refreshTaskBlockers adds below — nothing to link to.
  htmlUrl: string | null;
}

export type DependencyGate = "clear" | "blocked" | "unresolved";

/** Tolerant of a malformed/foreign blob — returns null (⇒ unresolved ⇒ fail
 * closed in dependencyGate) rather than throwing, since a task row's
 * blockedBy column is written only by refreshTaskBlockers below but read by
 * every auto-claim sweep. */
export function parseBlockedBy(json: string | null): StoredBlocker[] | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as StoredBlocker[]) : null;
  } catch {
    return null;
  }
}

export interface DependencyGateRow {
  issueNumber: number | null;
  dependencyCount: number | null;
  blockedBy: string | null;
}

/**
 * The single truth table dependency-aware claiming is built on — see
 * docs/tasks.md's "Dependency-aware claiming" section for the full
 * rationale. `issueNumber` is part of the input, not an afterthought: it's
 * what separates "local task, never gated" (always `clear`, zero cost, zero
 * network dependency — preserves the pre-#667 "auto-claim works with no
 * GitHub connection at all" behavior for local tasks exactly) from
 * "GitHub-linked and not yet observed" (`unresolved`, fail-closed).
 *
 * | dependencyCount | issueNumber | blockedBy | gate       |
 * | --------------- | ----------- | --------- | ---------- |
 * | null            | null        | null      | clear      |
 * | null            | set         | any       | unresolved |
 * | 0                | set         | null      | clear      |
 * | >0               | set         | null      | unresolved |
 * | >0               | set         | "[]"      | clear      |
 * | >0               | set         | [{...}]   | blocked    |
 */
export function dependencyGate(row: DependencyGateRow): DependencyGate {
  if (row.issueNumber === null) return "clear";
  if (row.dependencyCount === null) return "unresolved";
  if (row.dependencyCount === 0) return "clear";
  const blockers = parseBlockedBy(row.blockedBy);
  if (blockers === null) return "unresolved";
  return blockers.length > 0 ? "blocked" : "clear";
}

/**
 * Resolves and stores a task's current open blockers. Called lazily by
 * task-watcher.ts's autoClaimReadyTasks (only for a candidate it's actually
 * about to try) and eagerly by routes/webhooks.ts's `issue_dependencies`/
 * blocker-close pushes. On any failure: logs and returns WITHOUT touching
 * `blockedBy`/`blockedByCheckedAt` — a prior "[]" stays valid, a
 * never-resolved null stays fail-closed. Never throws.
 */
export async function refreshTaskBlockers(
  app: FastifyInstance,
  params: {
    taskId: number;
    projectId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    dependencyCount: number | null;
    token: string;
  },
): Promise<void> {
  try {
    const results = await listBlockedByIssues(
      params.token,
      params.owner,
      params.repo,
      params.issueNumber,
    );

    // Defensive count check (see github-write.ts's listBlockedByIssues doc
    // comment) — `blocked_by` vs `total_blocked_by`'s exact difference is
    // undocumented by GitHub; the safest reading treats a shorter-than-
    // expected result as "some blockers aren't visible to this token"
    // rather than "GitHub simply reports fewer than the summary said," and
    // fails toward blocked rather than risk claiming a genuinely blocked
    // task. Costs nothing when the counts agree, which was the only case
    // observed in the wild during planning.
    const expected = params.dependencyCount ?? 0;
    const openBlockers: StoredBlocker[] = results
      .filter((r) => r.state === "open")
      .map((r) => ({
        owner: r.owner,
        repo: r.repo,
        number: r.number,
        title: r.title,
        htmlUrl: r.htmlUrl,
      }));

    let blockers = openBlockers;
    if (results.length < expected) {
      const hidden = expected - results.length;
      app.log.warn(
        { taskId: params.taskId, expected, visible: results.length },
        "[task-dependencies] fewer blockers visible to this token than GitHub reports — treating as blocked",
      );
      blockers = [
        {
          owner: params.owner,
          repo: params.repo,
          number: 0,
          title: `${hidden} blocker(s) not visible to this token`,
          htmlUrl: null,
        },
        ...openBlockers,
      ];
    }

    app.db
      .update(tasks)
      .set({ blockedBy: JSON.stringify(blockers), blockedByCheckedAt: new Date() })
      .where(eq(tasks.id, params.taskId))
      .run();

    broadcastTaskEvent({
      taskId: params.taskId,
      projectId: params.projectId,
      kind: "blockers",
      ts: Date.now(),
    });
  } catch (err) {
    app.log.warn(
      { err, taskId: params.taskId, owner: params.owner, repo: params.repo },
      "[task-dependencies] failed to resolve blockers — leaving prior state (fail closed)",
    );
  }
}
