import type { FastifyInstance } from "fastify";
import { getStoredSettings } from "./settings.js";

export type OpenCodeModelRole = "implementer" | "reviewer";

const MODEL_LINE_RE = /^\s*Model:\s*(\S+)\s*$/im;
const REVIEWER_MODEL_LINE_RE = /^\s*Reviewer-Model:\s*(\S+)\s*$/im;
const SMALL_MODEL_LINE_RE = /^\s*SmallModel:\s*(\S+)\s*$/im;

// Requires at least one "/" with non-whitespace content on both sides of
// the FIRST and LAST segment — not exactly one slash. `GET /api/opencode/models`
// (issue #957's catalog endpoint) returns real ids like
// "openrouter/anthropic/claude-sonnet-4-5" (a routing prefix in front of the
// underlying provider/model pair) — roughly 60% of the live catalog on this
// install has two slashes, not one. Before the settings-tier deepMerge fix
// (same PR), no install-wide default could ever persist, so this regex was
// dead code for that call site; fixing persistence is what made the
// too-strict pattern actually reachable, so it's fixed here too rather than
// shipping a Models dropdown whose majority of entries silently fail
// validation at spawn time and fall back to "no override".
const MODEL_FORMAT_RE = /^\S+\/\S+$/;

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

function parseSmallModelDirective(body: string | null): string | null {
  if (body === null) return null;
  const match = SMALL_MODEL_LINE_RE.exec(body);
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

/**
 * Resolve opencode's `small_model` config key (used for lightweight tasks
 * like title generation). Same precedence chain as resolveOpenCodeModel
 * but with `SmallModel:` as the issue-body directive and
 * `settings.opencode.defaultSmallModel` as the install-wide default.
 * Not role-split — small_model is a property of the model itself.
 */
export function resolveOpenCodeSmallModel(
  app: FastifyInstance,
  opts: { taskSmallModel?: string | null; issueBody: string | null },
): string | null {
  if (opts.taskSmallModel) {
    if (validateModel(opts.taskSmallModel)) return opts.taskSmallModel;
    app.log.warn(
      { model: opts.taskSmallModel },
      "[task-model-resolve] task's small_model is malformed (expected provider/model), falling through",
    );
  }

  const fromIssue = parseSmallModelDirective(opts.issueBody);
  if (fromIssue !== null) {
    if (validateModel(fromIssue)) return fromIssue;
    app.log.warn(
      { model: fromIssue },
      "[task-model-resolve] issue body's SmallModel: line is malformed (expected provider/model), falling through",
    );
  }

  const globalDefault = getStoredSettings(app.db).opencode.defaultSmallModel;
  if (globalDefault !== null) {
    if (validateModel(globalDefault)) return globalDefault;
    app.log.warn(
      { model: globalDefault },
      "[task-model-resolve] install-wide defaultSmallModel is malformed, returning null",
    );
  }
  return null;
}

export type CliModelAgent = "claude-code" | "codex" | "agy";

// Unlike opencode's `provider/model`, these CLIs take bare names (`sonnet`,
// `gpt-5`, `claude-opus-4-5[1m]`). The value ends up in a shell command
// line, so this is a strict allowlist with no whitespace, quotes, `$`,
// backticks, or leading `-` (which would read as another flag).
const CLI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

export function validateCliModel(value: string): boolean {
  return CLI_MODEL_RE.test(value);
}

const SETTINGS_KEY = { "claude-code": "claudeCode", codex: "codex", agy: "agy" } as const;

/**
 * Resolve the `--model` value for a Claude Code, Codex, or agy session. Same
 * precedence chain as resolveOpenCodeModel: task DB row > issue-body `Model:`
 * directive > install-wide default (`settings.<cli>.defaultModel`) > `null`
 * (no flag; the CLI picks). An invalid value at any tier is logged and falls
 * through rather than reaching the command line.
 */
export function resolveCliModel(
  app: FastifyInstance,
  agent: CliModelAgent,
  opts: { taskModel?: string | null; issueBody: string | null },
): string | null {
  const candidates: Array<[string, string | null | undefined]> = [
    ["task's model", opts.taskModel],
    ["issue body's Model: line", parseModelDirective(opts.issueBody)],
    ["install-wide default model", getStoredSettings(app.db)[SETTINGS_KEY[agent]].defaultModel],
  ];
  for (const [source, value] of candidates) {
    if (!value) continue;
    if (validateCliModel(value)) return value;
    app.log.warn(
      { model: value, agent },
      `[task-model-resolve] ${source} is not a valid ${agent} model name, falling through`,
    );
  }
  return null;
}
