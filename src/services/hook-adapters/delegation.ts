// Whether a Task Master worker should be told to delegate to a cheaper model.
//
// The delegation paragraph (each adapter's `delegationHint`) costs the worker
// attention and, when followed, a subagent's tokens, so it is only worth
// emitting when it can save something: the install configured a "Delegate
// model" for the worker's CLI (Settings → Models) AND that model is cheaper
// than the one the worker actually runs. A Sonnet worker told to delegate to
// Sonnet would pay for a second context and gain nothing.
//
// Pure functions, no I/O — the adapters own the model-name knowledge
// (`modelTier`), this module only applies the comparison.

export interface DelegationContext {
  /** The model the worker runs under, or `null` when no `--model` was passed
   * and the CLI picks its own default (which Mullion cannot see). */
  workerModel: string | null;
  /** The install's configured Delegate model for the worker's CLI. */
  delegateModel: string | null;
}

const norm = (model: string): string => model.trim().toLowerCase();

/**
 * Claude Code model aliases and full ids → cost tier. `[1m]` (the 1M-context
 * variant) does not change the tier.
 *
 * `opusplan` is Opus while planning and Sonnet while executing. Task Master
 * workers are never in plan mode, so an `opusplan` worker EFFECTIVELY runs
 * Sonnet; ranking it as Opus would tell it to delegate to a model it already
 * is. (Observed: workers launched with `opusplan` ran `claude-sonnet-5-5`.)
 */
export function claudeModelTier(model: string): number | null {
  const m = norm(model).replace(/\[1m\]$/, "");
  if (m.startsWith("opusplan")) return 1;
  if (m.includes("haiku")) return 0;
  if (m.includes("sonnet")) return 1;
  if (m.includes("opus")) return 2;
  if (m.includes("fable") || m.includes("mythos")) return 3;
  return null;
}

/**
 * The alias Claude Code's Task tool accepts as its per-call `model`. The tool's
 * parameter is an enum of exactly `sonnet | opus | haiku | fable` — a full id
 * or a `[1m]` variant is rejected — so the stored Delegate model is mapped to
 * its family alias. `opusplan` maps to `sonnet` (see claudeModelTier). `null`
 * for a name outside those four families.
 */
export function claudeTaskModelAlias(model: string): "haiku" | "sonnet" | "opus" | "fable" | null {
  const tier = claudeModelTier(model);
  return tier === null ? null : (["haiku", "sonnet", "opus", "fable"] as const)[tier];
}

/**
 * Codex model names → cost tier, from the descriptions in `codex debug
 * models`: `luna` is "fast and affordable", `terra` "balanced", `sol` the
 * "workhorse" and `astra` the "frontier" model. The generation (`gpt-6.1-sol`
 * vs `gpt-5.6-sol`) is not ranked; a name this does not know is `null` and
 * falls back to "the operator chose the delegate on purpose".
 */
export function codexModelTier(model: string): number | null {
  const m = norm(model);
  if (m.includes("luna")) return 0;
  if (m.includes("terra")) return 1;
  if (m.includes("sol")) return 2;
  if (m.includes("astra")) return 3;
  return null;
}

/**
 * Whether the delegation paragraph should be shown.
 *
 * - No delegate model configured ⇒ never.
 * - Delegate and worker are the same model ⇒ never (nothing to save).
 * - Both ranked ⇒ only when the delegate is strictly cheaper.
 * - Either unranked (the CLI's own default, or a name the adapter cannot
 *   rank) ⇒ show it: the operator named a delegate deliberately, and
 *   guessing wrong in the other direction would silently disable the feature.
 */
export function delegationApplies(
  ctx: DelegationContext,
  modelTier: ((model: string) => number | null) | undefined,
): boolean {
  const delegate = ctx.delegateModel?.trim();
  if (!delegate) return false;
  const worker = ctx.workerModel?.trim();
  if (!worker) return true;
  if (norm(worker) === norm(delegate)) return false;
  const workerTier = modelTier?.(worker) ?? null;
  const delegateTier = modelTier?.(delegate) ?? null;
  if (workerTier === null || delegateTier === null) return true;
  return delegateTier < workerTier;
}
