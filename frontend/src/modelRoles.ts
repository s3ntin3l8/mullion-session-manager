import { isValidCliModelName, isValidOpenCodeModel } from "./cliModel.js";
import { AGENT_OPTIONS } from "./settings/agentOptions.js";

// DOM-free mirror of the install-wide model-role fallback in
// src/services/task-model-resolve.ts — same algorithm, same sentinel
// semantics, kept in its own module (the taskConfig.ts convention) so it's
// independently unit-testable and keeps Settings.tsx react-refresh-clean.
// settings/agentOptions.ts is DOM-free too (a plain array of option
// values), so importing it here does not break that property.
//
// Why this exists: the backend resolves a task's implementer and reviewer
// models by a precedence chain that ends in the install-wide per-CLI
// settings. The final step of that chain — what happens when the reviewer
// model is UNSET — differs between the two families, and the difference is
// exactly what a user looking at Settings → Models needs to be told:
//
//   - claude-code / codex / agy (resolveCliModel): the candidate order is
//     task model → `Reviewer-Model:` → `Model:` → install-wide reviewer
//     model → install-wide DEFAULT model. The reviewer therefore falls back
//     to the implementer's model, so an unset reviewer model means "the
//     reviewer runs on exactly the implementer's model".
//   - opencode (resolveOpenCodeModel): the install-wide default is
//     role-split — `reviewerModel` for the reviewer role, `implementerModel`
//     for the implementer role — and an unset value resolves to null, i.e.
//     NO override at all. So the reviewer does NOT inherit the implementer's
//     setting; it falls back to opencode's own default.
//
// Both are worth surfacing: in the first family an unset reviewer model is
// a silent "same model as the implementer", and in the second family two
// settings that happen to name the same model are the same thing.
//
// The VALIDATION tier is mirrored too, via cliModel.ts. The backend skips
// any candidate that fails its own check and falls through to the next tier,
// so a stored-but-invalid value resolves to something else entirely — an
// invalid `reviewerModel` collapses onto the implementer's model, and an
// invalid `defaultModel` leaves the role with no model at all. Mirroring
// the check is what lets this module agree with the backend in both
// directions, rather than only in the one the UI can produce.
//
// A copy of a regex can drift; the backend stays authoritative, and that is
// why the mirrors live in one place (cliModel.ts) rather than being
// inlined at each call site.

export interface ModelRoleResolution {
  /** The model the implementer role resolves to, install-wide. */
  implementer: string | null;
  /** The model the reviewer role resolves to, install-wide. */
  reviewer: string | null;
}

/**
 * The models the worker and the reviewer actually run, install-wide.
 *
 * The two roles come from SEPARATE settings — the worker agent from an
 * issue's `Agent:` line, the project's default agent, or
 * `taskMaster.defaultAgent`; the review agent from an issue's
 * `ReviewAgent:` line, the project's default review agent, or
 * `taskMaster.defaultReviewAgent`. They may therefore be DIFFERENT CLIs,
 * and then each side's model comes from that CLI's OWN settings — so
 * comparing one CLI's two roles against each other compares two models
 * that never met. A reviewer on a different CLI is the cheapest way to
 * get a genuinely different model, which is exactly the configuration the
 * warning must not misreport.
 *
 * Install-wide only: a project's `defaultAgent`/`defaultReviewAgent` and a
 * task's own `Agent:`/`ReviewAgent:` line can both override these.
 */
export interface InstalledRoleModels {
  /** The CLI the reviewer role runs under, install-wide. */
  reviewCli: string | null;
  /** The model the reviewer runs, install-wide. */
  reviewer: string | null;
  /** The model the worker runs, install-wide. */
  worker: string | null;
  /** True when both are known and identical — no second opinion. */
  shared: boolean;
}

/**
 * Resolve the models the worker and reviewer actually run, from the
 * install-wide agent defaults and each CLI's own model settings.
 *
 * `pairs` maps a CLI key to that CLI's two roles (see resolveCliModelRoles /
 * resolveOpencodeModelRoles). A CLI absent from it has no model settings of
 * its own — a reviewer or worker on such a CLI runs whatever that CLI
 * defaults to, which the panel cannot know, so the comparison is skipped
 * rather than guessed.
 */
export function resolveInstalledRoleModels(opts: {
  workerCli: string | null | undefined;
  reviewCli: string | null | undefined;
  pairs: Record<string, ModelRoleResolution>;
}): InstalledRoleModels {
  const workerCli = opts.workerCli ?? null;
  const reviewCli = opts.reviewCli ?? null;
  const worker = workerCli ? (opts.pairs[workerCli]?.implementer ?? null) : null;
  const reviewer = reviewCli ? (opts.pairs[reviewCli]?.reviewer ?? null) : null;
  return {
    reviewCli,
    worker,
    reviewer,
    shared: worker !== null && reviewer !== null && worker === reviewer,
  };
}

/** The per-CLI model settings the panel reads, in the shape it needs them. */
export interface CliModelSettings {
  claudeCode?: { defaultModel?: string | null; reviewerModel?: string | null } | null;
  codex?: { defaultModel?: string | null; reviewerModel?: string | null } | null;
  agy?: { defaultModel?: string | null; reviewerModel?: string | null } | null;
  opencode?: { implementerModel?: string | null; reviewerModel?: string | null } | null;
}

/**
 * How each CLI's two roles are read out of the settings object.
 *
 * This map is the ONE hand-written part, and it has to stay hand-written:
 * each CLI stores its models under a different key (claudeCode, codex, agy,
 * opencode) and opencode splits the two roles while the others do not, so
 * there is no shape the four share.
 *
 * The KEYS of the pairs map are NOT written here — buildCliModelPairs
 * derives them from AGENT_OPTIONS, so a new agent option can never be
 * missing from the comparison. This map only says HOW a CLI's settings are
 * read, and the resolver-coverage test in modelRoles.test.ts fails when an
 * agent option has no entry here. That test is what keeps the derivation
 * honest: deriving the keys means an option with no resolver would
 * otherwise be handed null roles and quietly skipped — the very silent gap
 * the hand-written key list used to make a CI failure.
 */
export const CLI_MODEL_ROLE_RESOLVERS: Record<
  string,
  (settings: CliModelSettings) => ModelRoleResolution
> = {
  claude: (s) => resolveCliModelRoles(s.claudeCode?.defaultModel, s.claudeCode?.reviewerModel),
  codex: (s) => resolveCliModelRoles(s.codex?.defaultModel, s.codex?.reviewerModel),
  agy: (s) => resolveCliModelRoles(s.agy?.defaultModel, s.agy?.reviewerModel),
  opencode: (s) =>
    resolveOpencodeModelRoles(s.opencode?.implementerModel, s.opencode?.reviewerModel),
};

/**
 * Each model-capable CLI's two roles, keyed by the agent-option value the
 * install-wide agent settings use — "claude", "codex", "agy", "opencode"
 * (see frontend/src/settings/agentOptions.ts's AGENT_OPTIONS, and the
 * backend's own KNOWN_AGENTS in agent-detect.ts).
 *
 * The key set comes from AGENT_OPTIONS, so it cannot drift from the list
 * the settings dropdowns offer; an option with no resolver in
 * CLI_MODEL_ROLE_RESOLVERS resolves to null roles (the comparison skips it)
 * and fails the resolver-coverage test in CI.
 */
export function buildCliModelPairs(
  settings: CliModelSettings,
): Record<string, ModelRoleResolution> {
  const pairs: Record<string, ModelRoleResolution> = {};
  for (const { value } of AGENT_OPTIONS) {
    const resolve = CLI_MODEL_ROLE_RESOLVERS[value];
    pairs[value] = resolve ? resolve(settings) : { implementer: null, reviewer: null };
  }
  return pairs;
}

/**
 * claude-code / codex / agy — mirrors resolveCliModel's install-wide tail.
 * The reviewer falls back to the implementer's model, so the two are shared
 * whenever the reviewer model is unset, invalid, or names the same value.
 */
export function resolveCliModelRoles(
  defaultModel: string | null | undefined,
  reviewerModel: string | null | undefined,
): ModelRoleResolution {
  // The backend's candidate loop skips any candidate that is falsy OR fails
  // validation, falling through to the next tier. So an invalid
  // `defaultModel` leaves the implementer with NO model at all (not the bad
  // name), and an invalid `reviewerModel` falls through to the
  // implementer's model — which is a real collapse the backend performs.
  const implementer = isValidCliModelName(defaultModel) ? defaultModel : null;
  const reviewer = isValidCliModelName(reviewerModel) ? reviewerModel : implementer;
  return { implementer, reviewer };
}

/**
 * opencode — mirrors resolveOpenCodeModel's install-wide tail. The two
 * roles have separate settings and NEITHER falls back to the other: an
 * unset or invalid value resolves to null, which at spawn time means "no
 * override", so opencode's own default applies. The roles resolve to the
 * same model only when both NAME one — when both are unset they both
 * resolve to null here, which means "no override" rather than a shared
 * model, and the cross-CLI comparison skips it for that reason (a null
 * model is not a model that will be applied).
 */
export function resolveOpencodeModelRoles(
  implementerModel: string | null | undefined,
  reviewerModel: string | null | undefined,
): ModelRoleResolution {
  const implementer = isValidOpenCodeModel(implementerModel) ? implementerModel : null;
  const reviewer = isValidOpenCodeModel(reviewerModel) ? reviewerModel : null;
  return { implementer, reviewer };
}
