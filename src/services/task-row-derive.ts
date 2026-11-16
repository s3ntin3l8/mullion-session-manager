import type { FastifyInstance } from "fastify";
import { issueDirectiveAgents } from "./task-agent-resolve.js";
import { MAX_WORKER_NUDGES, nudgesThisSpell } from "./task-nudge.js";
import { withPrTitleFallback } from "./task-pr-title-fallback.js";

// Derived fields layered onto a task row by routes/tasks.ts.

// The task detail dropdowns' view of the issue body's `Agent:` /
// `ReviewAgent:` directives, computed with the resolvers' own parsing.
export function withIssueDirectives<T extends { body: string | null }>(
  app: FastifyInstance,
  row: T,
): T & { issueAgent: string | null; issueReviewAgent: string | null } {
  return { ...row, ...issueDirectiveAgents(app, row.body) };
}

// #3179 — the continuation nudges of the CURRENT in_progress spell, for the
// board card. `nudgeCount` is this spell's only (a re-claimed task reads 0, so
// the card never shows a stale note); `nudgeLimit` spares the frontend a copy
// of the cap.
export function withNudge<
  T extends { claimedAt: Date | null; nudgeCount: number; lastNudgedAt: Date | null },
>(row: T): Omit<T, "lastNudgedAt"> & { nudgeLimit: number; lastNudgedAt: string | null } {
  const { lastNudgedAt, ...rest } = row;
  return {
    ...rest,
    nudgeCount: nudgesThisSpell(row),
    nudgeLimit: MAX_WORKER_NUDGES,
    lastNudgedAt: lastNudgedAt ? lastNudgedAt.toISOString() : null,
  };
}

// Every derived field routes/tasks.ts layers onto a task row, in one call.
export function withTaskDerived<
  T extends {
    title: string;
    body: string | null;
    prTitle: string | null;
    prUrl: string | null;
    projectConventionalCommitTitles: boolean | null;
    claimedAt: Date | null;
    nudgeCount: number;
    lastNudgedAt: Date | null;
  },
>(app: FastifyInstance, row: T) {
  return withNudge(withIssueDirectives(app, withPrTitleFallback(row)));
}
