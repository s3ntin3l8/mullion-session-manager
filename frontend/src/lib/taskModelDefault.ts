import type { AppSettings } from "../api/index.js";
import type { ModelCli } from "../models/modelCatalogs.js";

const DIRECTIVE = {
  model: /^\s*Model:\s*(\S+)\s*$/im,
  reviewerModel: /^\s*Reviewer-Model:\s*(\S+)\s*$/im,
  smallModel: /^\s*SmallModel:\s*(\S+)\s*$/im,
};

function directive(body: string | null, re: RegExp): string | null {
  return body === null ? null : (re.exec(body)?.[1] ?? null);
}

export type ModelRole = "implementer" | "reviewer" | "small";

// What "Default" resolves to once the task-level choice is cleared: the
// issue-body directive, then the install-wide default (the project tier has no
// model of its own). Mirrors task-model-resolve.ts closely enough for a label;
// the backend stays the authority.
export function resolvedDefaultModel(
  cli: ModelCli,
  role: ModelRole,
  body: string | null,
  settings: AppSettings | null,
): string | null {
  const own =
    role === "small"
      ? directive(body, DIRECTIVE.smallModel)
      : role === "reviewer"
        ? (directive(body, DIRECTIVE.reviewerModel) ?? directive(body, DIRECTIVE.model))
        : directive(body, DIRECTIVE.model);
  if (own) return own;
  if (!settings) return null;
  if (cli === "opencode") {
    const s = settings.opencode;
    return (
      (role === "small"
        ? s.defaultSmallModel
        : role === "reviewer"
          ? s.reviewerModel
          : s.implementerModel) || null
    );
  }
  if (cli === "claude-code" && role === "small") return settings.claudeCode.smallModel || null;
  const s = cli === "claude-code" ? settings.claudeCode : settings[cli];
  if (role === "small") return null;
  return (role === "reviewer" ? s.reviewerModel || s.defaultModel : s.defaultModel) || null;
}
