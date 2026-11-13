// The audit rows behind a dismissed code-scanning alert (#2999): who dismissed
// which alert from which task, why, and whether the thread was closed after.

import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { codeScanningDismissals } from "../db/schema.js";
import type { PriorDismissal } from "./code-scanning.js";

export interface TaskDismissal {
  alertNumber: number;
  ruleId: string;
  path: string | null;
  reason: string;
  comment: string;
  dismissedBy: string | null;
  threadResolved: boolean;
  createdAt: string;
}

type Row = typeof codeScanningDismissals.$inferSelect;

export function toTaskDismissal(r: Row): TaskDismissal {
  return {
    alertNumber: r.alertNumber,
    ruleId: r.ruleId,
    path: r.path,
    reason: r.reason,
    comment: r.comment,
    dismissedBy: r.dismissedBy,
    threadResolved: r.threadResolved,
    createdAt: r.createdAt.toISOString(),
  };
}

export function insertDismissal(
  app: FastifyInstance,
  values: typeof codeScanningDismissals.$inferInsert,
): Row {
  return app.db.insert(codeScanningDismissals).values(values).returning().get();
}

/** Every dismissal recorded for a task, oldest first. */
export function listTaskDismissals(app: FastifyInstance, taskId: number): TaskDismissal[] {
  return app.db
    .select()
    .from(codeScanningDismissals)
    .where(eq(codeScanningDismissals.taskId, taskId))
    .orderBy(asc(codeScanningDismissals.id))
    .all()
    .map(toTaskDismissal);
}

/** Recorded dismissals of a rule in a repo, newest first, in `PriorDismissal` shape. */
export function recordedPriorDismissals(
  app: FastifyInstance,
  repo: string,
  ruleId: string,
): PriorDismissal[] {
  return app.db
    .select()
    .from(codeScanningDismissals)
    .where(and(eq(codeScanningDismissals.repo, repo), eq(codeScanningDismissals.ruleId, ruleId)))
    .orderBy(desc(codeScanningDismissals.id))
    .all()
    .map((r) => ({
      number: r.alertNumber,
      path: r.path,
      reason: r.reason,
      comment: r.comment,
      dismissedBy: r.dismissedBy,
      url: `https://github.com/${r.repo}/security/code-scanning/${r.alertNumber}`,
    }));
}
