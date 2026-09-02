import type { FastifyInstance } from "fastify";
import { getStoredSettings } from "./settings.js";

const MODEL_LINE_RE = /^\s*Model:\s*(\S+)\s*$/im;

const MODEL_FORMAT_RE = /^[^\s/]+\/[^\s/]+$/;

export function validateModel(value: string): boolean {
  return MODEL_FORMAT_RE.test(value);
}

function parseModelDirective(body: string | null): string | null {
  if (body === null) return null;
  const match = MODEL_LINE_RE.exec(body);
  return match ? match[1] : null;
}

export function resolveOpenCodeModel(
  app: FastifyInstance,
  opts: { taskModel?: string | null; issueBody: string | null },
): string | null {
  if (opts.taskModel) {
    if (validateModel(opts.taskModel)) return opts.taskModel;
    app.log.warn(
      { model: opts.taskModel },
      "[task-model-resolve] task's model is malformed (expected provider/model), falling through",
    );
  }

  const fromIssue = parseModelDirective(opts.issueBody);
  if (fromIssue !== null) {
    if (validateModel(fromIssue)) return fromIssue;
    app.log.warn(
      { model: fromIssue },
      "[task-model-resolve] issue body's Model: line is malformed (expected provider/model), falling through",
    );
  }

  const globalDefault = getStoredSettings(app.db).opencode.defaultModel;
  if (globalDefault !== null) {
    if (validateModel(globalDefault)) return globalDefault;
    app.log.warn(
      { model: globalDefault },
      "[task-model-resolve] install-wide defaultModel is malformed, returning null",
    );
  }
  return null;
}
