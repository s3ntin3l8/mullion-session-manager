// DOM-free mirror of the install-wide model-role fallback in
// src/services/task-model-resolve.ts — same algorithm, same sentinel
// semantics, kept in its own module (the taskConfig.ts convention) so it's
// independently unit-testable and keeps Settings.tsx react-refresh-clean.
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

export interface ModelRoleResolution {
  /** The model the implementer role resolves to, install-wide. */
  implementer: string | null;
  /** The model the reviewer role resolves to, install-wide. */
  reviewer: string | null;
  /**
   * True when the two roles resolve to the SAME model — i.e. the reviewer
   * offers no second opinion, because it IS the implementer with the same
   * weights. This is the case worth warning about.
   */
  shared: boolean;
}

/**
 * claude-code / codex / agy — mirrors resolveCliModel's install-wide tail.
 * The reviewer falls back to the implementer's model, so the two are shared
 * whenever the reviewer model is unset or names the same value.
 */
export function resolveCliModelRoles(
  defaultModel: string | null | undefined,
  reviewerModel: string | null | undefined,
): ModelRoleResolution {
  const implementer = defaultModel ?? null;
  const reviewer = reviewerModel ?? implementer;
  return { implementer, reviewer, shared: reviewer === implementer };
}

/**
 * opencode — mirrors resolveOpenCodeModel's install-wide tail. The two
 * roles have separate settings and NEITHER falls back to the other: an
 * unset value resolves to null, which at spawn time means "no override", so
 * opencode's own default applies. The roles are therefore shared only when
 * both name the same model — including both being unset, which means both
 * land on opencode's own default.
 */
export function resolveOpencodeModelRoles(
  implementerModel: string | null | undefined,
  reviewerModel: string | null | undefined,
): ModelRoleResolution {
  const implementer = implementerModel ?? null;
  const reviewer = reviewerModel ?? null;
  return { implementer, reviewer, shared: reviewer === implementer };
}
