import type { FastifyInstance } from "fastify";
import { tasks, TASK_STATUSES } from "../db/schema.js";

export { TASK_STATUSES };

/**
 * Insert demo task rows in one transaction (all or nothing: a throw on fixture
 * N, e.g. the unique (project_id, issue_number) index, leaves none behind).
 * `valuesFor` builds each row's insert values.
 */
export function insertDemoTasks(
  app: FastifyInstance,
  valuesFor: Array<Record<string, unknown>>,
): Array<typeof tasks.$inferSelect> {
  return app.db.transaction((tx) =>
    valuesFor.map((values) =>
      tx
        .insert(tasks)
        .values(values as typeof tasks.$inferInsert)
        .returning()
        .get(),
    ),
  );
}
