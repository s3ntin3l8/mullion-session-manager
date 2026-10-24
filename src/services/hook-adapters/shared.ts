import path from "node:path";
import type { PromptFraming } from "./types.js";
import { fileURLToPath } from "node:url";

// Resolves the shared forwarder's absolute path relative to THIS module's
// own location, rather than hardcoding `src/` or `dist/` — so it resolves
// correctly whether the server is running under `tsx` (dev, this file lives
// at src/services/hook-adapters/shared.ts) or compiled (`dist/services/
// hook-adapters/shared.js`, same relative depth — tsc mirrors src/'s
// directory structure, and `make build` copies src/hooks/ into dist/hooks/
// verbatim since forwarder.mjs is plain JS with no compile step of its own —
// see package.json's build script and src/hooks/forwarder.mjs's own header
// comment for why).
//
// On a versioned-release install (MULLION_HOME set — see env.ts's own
// comment and deploy/install.sh), prefer the stable `current` symlink over
// this module's own realpathed, per-release location. Codex's hook adapter
// (codex.ts) embeds this path verbatim in the merged hook's command string,
// and Codex trusts that command by hash (issue #259) — resolving via
// `import.meta.url` alone means every release bump changes the path, changes
// the hash, and silently re-triggers Codex's one-time interactive `/hooks`
// trust prompt. Resolving through `current` instead keeps the command
// identical across upgrades, so a trust grant persists forever, not just
// until the next update. Read directly off process.env (bypassing
// app.config) the same way codex.ts already reads CODEX_HOME: this module is
// a plain function called from the hook-adapters/pty-manager seam, with no
// Fastify app instance in scope. Dev checkouts (`make dev`) and any
// non-versioned install never set MULLION_HOME, so they keep today's
// import.meta.url resolution unchanged.
export function resolveHooksDir(): string {
  const mullionHome = process.env.MULLION_HOME?.trim();
  if (mullionHome) {
    return path.join(mullionHome, "current", "dist", "hooks");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "hooks");
}

export function resolveForwarderPath(): string {
  return path.join(resolveHooksDir(), "forwarder.mjs");
}

/** Same dev/prod resolution as resolveForwarderPath() above, for the
 * PACKAGED forwarder shim script (issue: host-global agy/Codex hook
 * configs pinning a checkout-specific forwarder path — see
 * hook-adapters/forwarder-shim.ts). Resolves where THIS release's copy of
 * `forwarder-shim.sh` lives, so `ensureForwarderShim()` can read its
 * content and install it at the fixed, host-stable location that function
 * itself resolves independently (`resolveForwarderShimPath()`, homedir-
 * anchored, deliberately NOT this function). */
export function resolveForwarderShimSourcePath(): string {
  return path.join(resolveHooksDir(), "forwarder-shim.sh");
}

/** Same dev/prod resolution as resolveForwarderPath() above, for OpenCode's
 * plugin file (issue #175) — see src/hooks/opencode-plugin.js's own header
 * comment for why it's plain JS too. */
export function resolveOpenCodePluginPath(): string {
  return path.join(resolveHooksDir(), "opencode-plugin.js");
}

/** Same dev/prod resolution as resolveForwarderPath() above, for the MCP
 * stdio server (src/mcp/server.mjs) — see server.mjs's own header comment
 * for why it's plain JS, and shared.ts's resolveHooksDir() comment for the
 * MULLION_HOME reasoning. Extracted here so claude-code.ts and agy.ts share
 * one implementation (issue #271, issue #253). */
export function resolveMcpServerPath(): string {
  const mullionHome = process.env.MULLION_HOME?.trim();
  if (mullionHome) {
    return path.join(mullionHome, "current", "dist", "mcp", "server.mjs");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "mcp", "server.mjs");
}

/** Wraps `value` in POSIX single quotes, escaping any embedded single quote
 * as `'\''` (close the quote, an escaped literal quote, reopen). Used by
 * `initialPromptArgs` implementations (claude-code.ts, codex.ts, agy.ts) to
 * put a Task Master prompt — arbitrary issue-body text, which routinely
 * contains `;`/`&`/`|`/backticks/etc — safely onto a command line that's
 * ultimately run via `$SHELL -lc "<finalCommand>"` (pty-manager.ts). Single
 * quotes are the only POSIX quoting form with no escape sequences of their
 * own to worry about inside the quotes, which is why this doesn't attempt
 * double-quote or backslash-based escaping. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Any of these anywhere in a command means it's not a simple invocation (a
 * pipeline, a chain, redirection, or a second command) — appending a flag to
 * the raw string in that case could attach it to the wrong part of the
 * chain instead of to the agent binary itself. Originally private to
 * claude-code.ts; hoisted here (issue #880) once codex.ts's own
 * `commandTransform` needed the identical guard — a second independent copy
 * of a security-relevant regex is a drift risk this module exists to avoid
 * (see resolveMcpServerPath's own comment on the same rationale). */
export const SHELL_METACHARACTERS_RE = /[;&|<>]/;

/** Escapes `value` for use inside a TOML basic string (`"..."`) — backslash
 * first, then double-quote, so an embedded backslash doesn't get
 * re-escaped by the quote replacement that follows it. Originally private
 * to codex-skills.ts (which writes `~/.codex/config.toml`'s
 * `[[skills.config]]` blocks by hand rather than through a TOML
 * stringifier, to avoid dropping the user's own comments/formatting — see
 * that file's own header); hoisted here once codex.ts's MCP `-c` flags
 * (issue #880) needed the identical escaping for a different `config.toml`
 * key, so both call sites can't drift out of sync.
 *
 * Hermes review, PR #930 — TOML basic strings forbid literal control
 * characters (U+0000–U+0008, U+000A–U+001F, U+007F) outright; the original
 * version only handled backslash/quote. Not a live bug at either current
 * call site (skill names and internally-generated socket paths/install
 * paths never contain one), but defense-in-depth now that this is a shared
 * helper any future caller might feed less-trusted input through. The five
 * TOML-defined short escapes (`\b \t \n \f \r`) go first — after them, any
 * OTHER remaining control character (or U+007F) falls through to a generic
 * `\uXXXX` escape, which TOML also accepts. Order matters: the short-escape
 * replacements must run before the catch-all, or e.g. a literal newline
 * would already be gone by the time the catch-all's own regex runs — never
 * the reverse. */
// Intentionally matching a literal backspace — TOML's own short escape for
// it (`\b`). A named constant, not inline in the .replace() chain below, so
// the eslint-disable comment stays pinned to it regardless of how Prettier
// wraps the surrounding call.
// eslint-disable-next-line no-control-regex
const TOML_BACKSPACE_RE = /\x08/g;
// Catch-all for any OTHER control character TOML forbids, once the five
// named short escapes have already removed the ones that have one.
// eslint-disable-next-line no-control-regex
const TOML_OTHER_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/g;

export function escapeTomlBasicString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(TOML_BACKSPACE_RE, "\\b")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\f/g, "\\f")
    .replace(/\r/g, "\\r")
    .replace(
      TOML_OTHER_CONTROL_CHAR_RE,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

// Hermes review, PR #1300 — hoisted out of codex.ts, where an identical
// local `const tomlString = ...` had been independently redefined in
// buildCodexMcpFlags, buildCodexTrustFlag, and buildCodexSkillDenyFlag
// (the third `-c`-builder Hermes flagged as the threshold for hoisting).
// A quoted TOML basic string — `escapeTomlBasicString` plus the
// surrounding `"..."` every one of those functions needs before
// shell-quoting the whole `-c` argument.
export function tomlString(value: string): string {
  return `"${escapeTomlBasicString(value)}"`;
}

// Unlike opencode's `provider/model`, these CLIs take bare names (`sonnet`,
// `gpt-5`, `claude-opus-4-5[1m]`). The value ends up in a shell command
// line, so this is a strict allowlist with no whitespace, quotes, `$`,
// backticks, or leading `-` (which would read as another flag).
const CLI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

export function validateCliModel(value: string): boolean {
  return CLI_MODEL_RE.test(value);
}

/**
 * opencode's model shape: `provider/model`, optionally `#variant`.
 *
 * The sibling of validateCliModel above, and it lives here for the same
 * reason: this module is a leaf (no imports beyond node builtins and a
 * type-only one), so anything that must validate an opencode model without
 * dragging in the adapter graph can import it here.
 *
 * The check is deliberately LINEAR, not a regex. An earlier implementation
 * split the string between two `\S+` groups at every "/" before backtracking
 * to try the next one, which is polynomial in the number of "/" — and the
 * code path is reachable with attacker-controlled text (issue #1423), where
 * a project reviewer agent's frontmatter is operator-authored but still
 * arrives over HTTP. The rewrite as a plain substring search keeps the same
 * semantics (a "/" strictly between the first and last character; a "/"
 * immediately at either boundary, e.g. "/foo" or "foo/", does not count on
 * its own) while being linear and non-backtracking.
 */
export function validateOpenCodeModel(value: string): boolean {
  if (value.length < 3 || /\s/.test(value)) return false;
  return value.slice(1, -1).includes("/");
}

/** ` --model '<value>'` to append to a launch command, or "" when there is no
 * model or the command already carries its own model flag (a hand-typed
 * `--model` always wins over a Mullion default). `shortFlag` covers CLIs
 * (codex) whose `-m` is an alias. The value is single-quoted via shellQuote
 * on top of resolveCliModel's own character allowlist. */
export function buildModelFlag(
  command: string,
  model: string | undefined,
  shortFlag?: string,
): string {
  if (!model) return "";
  const existing = shortFlag
    ? new RegExp(`(?:^|\\s)(?:--model|${shortFlag})(?:[\\s=]|$)`)
    : /(?:^|\s)--model(?:[\s=]|$)/;
  if (existing.test(command)) return "";
  return ` --model ${shellQuote(model)}`;
}

/** Max prompt text sessions.prompt will type into an agent (bytes). */
export const MAX_PROMPT_BYTES = 32 * 1024;
/** Gap between the pasted body and the Enter that submits it. */
const PROMPT_SUBMIT_DELAY_MS = 150;

/**
 * Prompt text made safe to type into a TUI: line endings normalized to LF
 * (CRLF/CR, and the Unicode separators U+0085 / U+2028 / U+2029, all become
 * "\n"), then EVERY other control character dropped — C0 (except tab and
 * "\n"), DEL, and the C1 range U+0080–U+009F (U+009B is an 8-bit CSI) —
 * plus bidi override/isolate marks. Most importantly ESC: without that a
 * prompt containing `ESC[201~` would end a bracketed paste early and the rest
 * be interpreted as raw keystrokes (e.g. answering a permission dialog).
 */
export function sanitizePromptText(text: string): string {
  return text.replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n").replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}

/**
 * The standard "paste, then Enter" framing for a running agent TUI.
 *
 * With bracketed paste on, newlines (and tabs) survive inside the paste
 * markers. With it off, a bare newline would submit mid-prompt and a raw tab
 * is a completion keypress, so lines collapse to single spaces and tabs
 * become spaces.
 */
export function standardPromptFraming(
  text: string,
  ctx: { bracketedPaste: boolean },
): PromptFraming {
  const clean = sanitizePromptText(text);
  const body = ctx.bracketedPaste
    ? `\u001b[200~${clean}\u001b[201~`
    : clean
        .replace(/\t/g, " ")
        .replace(/\s*\n\s*/g, " ")
        .trim();
  return { body, submit: "\r", submitDelayMs: PROMPT_SUBMIT_DELAY_MS };
}
