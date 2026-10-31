import type { FastifyInstance } from "fastify";
import { issueDirectiveAgents } from "./task-agent-resolve.js";

// Derived fields layered onto a task row by routes/tasks.ts.

// The task detail dropdowns' view of the issue body's `Agent:` /
// `ReviewAgent:` directives, computed with the resolvers' own parsing.
export function withIssueDirectives<T extends { body: string | null }>(
  app: FastifyInstance,
  row: T,
): T & { issueAgent: string | null; issueReviewAgent: string | null } {
  return { ...row, ...issueDirectiveAgents(app, row.body) };
}
