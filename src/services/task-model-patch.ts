import type { FastifyInstance } from "fastify";
import { tasks } from "../db/schema.js";
import { commandIsOpencode, commandModelCli } from "./hook-adapters/index.js";
import { resolveAgentCommand, resolveReviewAgentCommand } from "./task-agent-resolve.js";
import { explicitModelError } from "./task-model-resolve.js";

export interface TaskModelPatchBody {
  agent?: string | null;
  reviewAgent?: string | null;
  model?: string | null;
  smallModel?: string | null;
  reviewerModel?: string | null;
}

// Issue #2491 — GET/PATCH /api/tasks wire shape for the task-level choices.
// `model` / `smallModel` in a PATCH are stored as `modelOverride` /
// `smallModelOverride`; the GET row carries the stored column names, because
// `model` / `smallModel` there are the values RESOLVED at claim time.
export const TASK_MODEL_COLUMNS = {
  modelOverride: tasks.modelOverride,
  smallModelOverride: tasks.smallModelOverride,
  reviewerModel: tasks.reviewerModel,
};
export const TASK_MODEL_SCHEMA_PROPS = {
  model: { type: ["string", "null"], maxLength: 200 },
  smallModel: { type: ["string", "null"], maxLength: 200 },
  reviewerModel: { type: ["string", "null"], maxLength: 200 },
};
export function hasModelFields(body: TaskModelPatchBody): boolean {
  return (
    body.model !== undefined || body.smallModel !== undefined || body.reviewerModel !== undefined
  );
}

// Issue #2491 — the model "family" a task-level model choice is bound to: the
// CLI adapter (claude-code / codex / agy / mcode) or opencode; null for a
// command with no model concept (a shell, gemini, pi).
function modelFamily(command: string): string | null {
  return commandModelCli(command) ?? (commandIsOpencode(command) ? "opencode" : null);
}
const smallModelFamilies = new Set(["opencode", "claude-code"]);

// Issue #2491 — validate the task-level model fields of a PATCH against the
// EFFECTIVE agents (the PATCHed value, else the stored one, then the usual
// resolution), and drop a stored choice the new agent can no longer take.
// A choice is bound to an agent FAMILY (claude-code / codex / agy / mcode /
// opencode): `validateCliModel` is only a charset check, so it cannot tell
// an opencode `provider/model` from a codex model name — a family change
// clears the choice instead of revalidating it.
export function resolveTaskModelPatch(
  app: FastifyInstance,
  existing: typeof tasks.$inferSelect,
  project: { defaultAgent: string | null; defaultReviewAgent: string | null } | null,
  body: TaskModelPatchBody,
): { patch: Partial<typeof tasks.$inferInsert> } | { error: string } {
  const workerFor = (taskAgent: string | null) =>
    resolveAgentCommand(app, {
      taskAgent,
      issueBody: existing.body,
      projectDefaultAgent: project?.defaultAgent ?? null,
    });
  const reviewerFor = (taskReviewAgent: string | null) =>
    resolveReviewAgentCommand(app, {
      taskReviewAgent,
      issueBody: existing.body,
      projectDefaultReviewAgent: project?.defaultReviewAgent ?? null,
    });
  const oldWorker = workerFor(existing.agent);
  const newWorker = workerFor(body.agent !== undefined ? body.agent : existing.agent);
  const oldReviewer = reviewerFor(existing.reviewAgent);
  const newReviewer = reviewerFor(
    body.reviewAgent !== undefined ? body.reviewAgent : existing.reviewAgent,
  );

  const patch: Partial<typeof tasks.$inferInsert> = {};
  const settle = (
    field: "model" | "smallModel",
    column: "modelOverride" | "smallModelOverride" | "reviewerModel",
    given: string | null | undefined,
    stored: string | null,
    oldCommand: string | null,
    newCommand: string | null,
    label: string,
  ): string | null => {
    if (given !== undefined) {
      if (given === null || given === "") {
        patch[column] = null;
        return null;
      }
      if (newCommand === null || modelFamily(newCommand) === null) {
        return `${label} cannot be set: the ${column === "reviewerModel" ? "review agent" : "agent"} has no model selection`;
      }
      if (field === "smallModel" && !smallModelFamilies.has(modelFamily(newCommand) ?? "")) {
        return `${label} cannot be set: only opencode and claude workers take a small model`;
      }
      const error = explicitModelError(newCommand, field, given);
      if (error) return error;
      patch[column] = given;
      return null;
    }
    if (stored === null) return null;
    const family = newCommand === null ? null : modelFamily(newCommand);
    const sameFamily =
      oldCommand !== null &&
      newCommand !== null &&
      modelFamily(oldCommand) === family &&
      family !== null &&
      (field === "model" || smallModelFamilies.has(family));
    if (!sameFamily) patch[column] = null;
    return null;
  };
  const error =
    settle(
      "model",
      "modelOverride",
      body.model,
      existing.modelOverride,
      oldWorker,
      newWorker,
      "model",
    ) ??
    settle(
      "smallModel",
      "smallModelOverride",
      body.smallModel,
      existing.smallModelOverride,
      oldWorker,
      newWorker,
      "smallModel",
    ) ??
    settle(
      "model",
      "reviewerModel",
      body.reviewerModel,
      existing.reviewerModel,
      oldReviewer,
      newReviewer,
      "reviewerModel",
    );
  return error ? { error } : { patch };
}
