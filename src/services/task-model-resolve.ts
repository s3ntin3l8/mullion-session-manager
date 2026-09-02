import type { FastifyInstance } from "fastify";
import { getStoredSettings } from "./settings.js";

export type OpenCodeModelRole = "implementer" | "reviewer";

const MODEL_LINE_RE = /^\s*Model:\s*(\S+)\s*$/im;
const REVIEWER_MODEL_LINE_RE = /^\s*Reviewer-Model:\s*(\S+)\s*$/im;

const MODEL_FORMAT_RE = /^[^\s/]+\/[^\s/]+$/;

export function validateModel(value: string): boolean {
  return MODEL_FORMAT_RE.test(value);
}

function parseModelDirective(body: string | null): string | null {
  if (body === null) return null;
  const match = MODEL_LINE_RE.exec(body);
  return match ? match[1] : null;
}

function parseReviewerModelDirective(body: string | null): string | null {
  if (body === null) return null;
  const match = REVIEWER_MODEL_LINE_RE.exec(body);
  return match ? match[1] : null;
}

/**
 * Resolve the opencode model for a session, given its role (implementer or
 * reviewer). Precedence chain (highest to lowest):
 *
 *   1. `taskModel` — explicit model from the task's DB row
 *   2. Issue-body directive — `Model:` for implementers, `Reviewer-Model:`
 *      for reviewers (falls back to `Model:` when no role-specific directive
 *      is present)
 *   3. Install-wide default — `settings.opencode.implementerModel` or
 *      `settings.opencode.reviewerModel` depending on role
 *   4. `null` — no override; let opencode pick via its own priority chain
 */
export function resolveOpenCodeModel(
  app: FastifyInstance,
  opts: { taskModel?: string | null; issueBody: string | null; role?: OpenCodeModelRole },
): string | null {
  const role = opts.role ?? "implementer";

  if (opts.taskModel) {
    if (validateModel(opts.taskModel)) return opts.taskModel;
    app.log.warn(
      { model: opts.taskModel },
      "[task-model-resolve] task's model is malformed (expected provider/model), falling through",
    );
  }

  // Role-specific directive first, then fall back to the generic `Model:`
  const fromIssue =
    role === "reviewer"
      ? (parseReviewerModelDirective(opts.issueBody) ?? parseModelDirective(opts.issueBody))
      : parseModelDirective(opts.issueBody);
  if (fromIssue !== null) {
    if (validateModel(fromIssue)) return fromIssue;
    app.log.warn(
      { model: fromIssue },
      "[task-model-resolve] issue body's Model: line is malformed (expected provider/model), falling through",
    );
  }

  const settings = getStoredSettings(app.db).opencode;
  const globalDefault = role === "reviewer" ? settings.reviewerModel : settings.implementerModel;
  if (globalDefault !== null) {
    if (validateModel(globalDefault)) return globalDefault;
    app.log.warn(
      { model: globalDefault },
      "[task-model-resolve] install-wide default model is malformed, returning null",
    );
  }
  return null;
}
