import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, tasks, TASK_STATUSES } from "../db/schema.js";

// Demo-only fixture routes. The demo instance (scripts/demo/) needs tasks in
// states the REST API refuses to create — POST /api/tasks only makes
// backlog/ready (LOCAL_CREATABLE_STATUSES, routes/tasks.ts), everything else
// comes from the claim → review → approve lifecycle, which needs real agents.
// This inserts rows directly, the way the route tests do, so the board, the
// right-sidebar Tasks tab and the PR/issue origin markers can be seen with
// data.
//
// Registered ONLY when MULLION_DEMO is true (set by scripts/demo/instance.mjs,
// never in a real deployment): without the flag the route does not exist and
// answers 404. The writable columns are an explicit allow-list — a fixture
// can describe a task's state but cannot touch anything else.

const TIMESTAMP_COLUMNS = [
  "claimedAt",
  "startedAt",
  "reviewingAt",
  "completedAt",
  "mergedAt",
  "archivedAt",
  "lastReviewVerdictAt",
] as const;

const TEXT_COLUMNS = [
  "body",
  "htmlUrl",
  "branchName",
  "agent",
  "reviewAgent",
  "prUrl",
  "prTitle",
  "assignee",
  "failureReason",
  "mergeError",
  "releaseError",
  "reviewFindings",
  "lastReviewVerdict",
  "needsHumanReason",
  // A run id and the id its findings were ingested from: equal means "the
  // current review has landed", which is what makes an approving verdict
  // read as awaiting approval (task-approval-state.ts) without a session.
  "reviewRunId",
  "reviewRunIngestedId",
] as const;

const INTEGER_COLUMNS = ["issueNumber", "prNumber", "autoReturnRounds", "boardOrder"] as const;

const taskFixtureProps = {
  title: { type: "string", minLength: 1 },
  status: { type: "string", enum: [...TASK_STATUSES] },
  ...Object.fromEntries(TEXT_COLUMNS.map((c) => [c, { type: ["string", "null"] }])),
  // An enum column (db/schema.ts), so a typo is a 400, not a silently bad row.
  needsHumanReason: { enum: ["cap", "no-progress", "finding-persisted", null] },
  ...Object.fromEntries(INTEGER_COLUMNS.map((c) => [c, { type: ["integer", "null"] }])),
  // ISO-8601 strings; the route turns them into Dates.
  ...Object.fromEntries(
    TIMESTAMP_COLUMNS.map((c) => [c, { type: ["string", "null"], format: "date-time" }]),
  ),
} as const;

const createTasksSchema = {
  body: {
    type: "object",
    required: ["projectId", "tasks"],
    additionalProperties: false,
    properties: {
      projectId: { type: "integer" },
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          required: ["title", "status"],
          additionalProperties: false,
          properties: taskFixtureProps,
        },
      },
    },
  },
} as const;

type FixtureTask = Record<string, string | number | null> & { title: string; status: string };

export async function demoFixturesRoute(app: FastifyInstance): Promise<void> {
  if (!app.config.MULLION_DEMO) return;

  app.post<{ Body: { projectId: number; tasks: FixtureTask[] } }>(
    "/api/demo/fixtures/tasks",
    { schema: createTasksSchema },
    async (request, reply) => {
      const { projectId, tasks: fixtures } = request.body;
      const project = app.db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) return reply.notFound(`project ${projectId} not found`);

      // All or nothing: a throw on fixture N (e.g. the unique
      // (project_id, issue_number) index) must not leave 1..N-1 behind.
      const created = app.db.transaction((tx) =>
        fixtures.map((fixture) => {
          const values: Record<string, unknown> = {
            projectId,
            title: fixture.title,
            status: fixture.status,
          };
          // Only the listed columns are ever copied, whatever else got through.
          for (const column of [...TEXT_COLUMNS, ...INTEGER_COLUMNS]) {
            if (fixture[column] !== undefined) values[column] = fixture[column];
          }
          for (const column of TIMESTAMP_COLUMNS) {
            const raw = fixture[column];
            if (raw !== undefined) values[column] = raw === null ? null : new Date(raw as string);
          }
          return tx
            .insert(tasks)
            .values(values as typeof tasks.$inferInsert)
            .returning()
            .get();
        }),
      );
      return reply.code(201).send({ tasks: created });
    },
  );
}
