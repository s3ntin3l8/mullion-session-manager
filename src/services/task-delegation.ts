import type { FastifyInstance } from "fastify";
import type { DelegationContext } from "./hook-adapters/delegation.js";
import { commandIsOpencode, commandModelCli } from "./hook-adapters/index.js";
import type { ModelInjectingCli } from "./hook-adapters/index.js";
import { getStoredSettings } from "./settings.js";
import {
  resolveCliModel,
  resolveOpenCodeModel,
  validateCliModel,
  validateModel,
} from "./task-model-resolve.js";

const SETTINGS_KEY = {
  "claude-code": "claudeCode",
  codex: "codex",
  agy: "agy",
  mcode: "mcode",
} as const satisfies Record<ModelInjectingCli, "claudeCode" | "codex" | "agy" | "mcode">;

/**
 * What a Task Master worker's prompt needs to decide whether to tell it to
 * delegate to a cheaper model (hook-adapters/delegation.ts): the model the
 * worker runs under and the install's configured Delegate model for that CLI.
 *
 * The worker model is resolved the SAME way the spawn resolves `--model`
 * (task row > issue-body `Model:` line > install default), not read from
 * `tasks.model`, because the first prompt is built before that column is
 * written. `null` when the CLI runs on its own default, which Mullion cannot
 * see. The delegate model is validated like any model name headed for a
 * prompt or command line — an invalid stored value counts as unset.
 *
 * Returns `null` for a command that is no model-capable agent (a plain
 * shell): there is nothing to delegate to.
 */
export function resolveWorkerDelegation(
  app: FastifyInstance,
  command: string | null | undefined,
  task: { modelOverride?: string | null; body: string | null },
): DelegationContext | null {
  if (!command) return null;
  const settings = getStoredSettings(app.db);
  const resolveOpts = { taskModel: task.modelOverride ?? null, issueBody: task.body };
  if (commandIsOpencode(command)) {
    const delegate = settings.opencode.delegateModel;
    return {
      workerModel: resolveOpenCodeModel(app, { ...resolveOpts, role: "implementer" }),
      delegateModel: delegate && validateModel(delegate) ? delegate : null,
    };
  }
  const cli = commandModelCli(command);
  if (cli === null) return null;
  const delegate = settings[SETTINGS_KEY[cli]].delegateModel;
  return {
    workerModel: resolveCliModel(app, cli, resolveOpts),
    delegateModel: delegate && validateCliModel(delegate) ? delegate : null,
  };
}
