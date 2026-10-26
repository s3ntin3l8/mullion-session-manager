// DOM-free mirrors of the backend's two model-name validators — the
// backend is the source of truth (src/services/hook-adapters/shared.ts's
// `validateCliModel`, and src/services/task-model-resolve.ts's
// `validateModel`).
//
// The same mirror already lived in ModelPicker.tsx as a bare regex, for the
// picker's own client-side rejection. It is here now so that the
// install-wide role resolution (modelRoles.ts) can apply the SAME rules
// instead of only documenting that it does not.
//
// A copy of a regex can drift. That risk is real and is why the backend
// stays authoritative: a value that fails validation here is still applied
// by the backend only if the backend's own check passes. The mirror's
// job is to make the SETTINGS UI's picture of what will actually be
// applied match the backend's, so the UI never warns about a model that
// will be silently skipped (or stays silent about one that will be).

/**
 * Mirror of CLI_MODEL_RE (src/services/hook-adapters/shared.ts) — the
 * allowlist for the bare model names claude-code / codex / agy take
 * (`sonnet`, `gpt-5`, `claude-opus-4-5[1m]`). The value ends up in a shell
 * command line, so it is a strict allowlist with no whitespace, quotes,
 * `$`, backticks, or leading `-`.
 */
export const CLI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

/**
 * Mirror of the backend's `validateCliModel`.
 *
 * A type predicate, so a caller can narrow the value it validated
 * (`isValidCliModelName(v) ? v : null`) without a cast — the mirrored
 * validators are used to decide which stored value will actually be
 * applied, so the narrowed type is the point.
 */
export function isValidCliModelName(value: string | null | undefined): value is string {
  return typeof value === "string" && CLI_MODEL_RE.test(value);
}

/**
 * Mirror of the backend's `validateModel` — opencode's own shape, which is
 * `provider/model` (possibly multi-slash, e.g.
 * `openrouter/anthropic/claude-sonnet-4-5`), optionally with a `#variant`.
 * The backend's check is not a regex: it requires a length of at least
 * three, no whitespace anywhere, and a `/` strictly inside the value.
 */
export function isValidOpenCodeModel(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 3 || /\s/.test(value)) return false;
  return value.slice(1, -1).includes("/");
}

/**
 * Mirror of the backend's `isClaudeModelAlias`
 * (src/services/hook-adapters/shared.ts, issue #2032). A Claude Code model
 * ALIAS is a bare word — letters only, plus an optional `[1m]` suffix
 * (`haiku`, `opusplan`, `sonnet[1m]`, and any letter-only alias added later;
 * one that carries a digit would be read as an id — keep in step with the
 * backend rule). Real model
 * ids always carry a digit or a separator (`claude-haiku-5-5`,
 * `anthropic.claude-haiku-5-5-v1:0`).
 *
 * Fine for the main model, but the small model becomes
 * ANTHROPIC_DEFAULT_HAIKU_MODEL — the variable the `haiku` alias itself
 * resolves to — so there an alias is ignored by the backend and the Settings
 * UI warns about a stored one.
 */
export const CLAUDE_MODEL_ALIAS_RE = /^[a-z]+(\[1m\])?$/i;

export function isClaudeModelAlias(value: string): boolean {
  return CLAUDE_MODEL_ALIAS_RE.test(value);
}
