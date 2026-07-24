import { readFileSync } from "node:fs";
import path from "node:path";
import { isMullionOwned, resolveCodexHome, type CodexHooksFile } from "./codex.js";
import { resolveForwarderPath } from "./shared.js";

// Issue #259: Codex silently skips Mullion's merged Stop/PostToolUse hooks
// until the user grants a one-time interactive `/hooks` trust decision. This
// module detects that pending state so the UI can surface it, instead of the
// user discovering it by accident (as happened before this was written).

export type CodexHookTrust = "trusted" | "pending" | "not-installed";

const EVENT_SNAKE: Record<string, string> = {
  Stop: "stop",
  PostToolUse: "post_tool_use",
};

/** Escapes a string for literal use inside a RegExp source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reads a file, treating a missing file (ENOENT) as the expected "nothing
 * here yet" case (returns `fallback`) but warning — rather than silently
 * swallowing — on any other error (e.g. EACCES), since that's a real
 * misconfiguration this read-only probe can't recover from, not a normal
 * "not installed yet" state. Mirrors codex.ts's own ENOENT-vs-other
 * distinction in mergeCodexHooks. */
function readFileOrFallback(filePath: string, fallback: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[codex-trust] could not read ${filePath}, treating as unreadable:`, err);
    }
    return fallback;
  }
}

/**
 * Reports whether Codex has granted `/hooks` trust for the Mullion-owned
 * hook group(s) currently merged into the user's real `~/.codex/hooks.json`.
 *
 * Detection is read-only and dependency-free by design:
 *  - `hooks.json` tells us which group (event + index) is Mullion's own for
 *    the CURRENTLY resolved forwarder path (`isMullionOwned`, from codex.ts).
 *  - Codex records grants in `~/.codex/config.toml` under
 *    `[hooks.state."<hooksPath>:<event_snake>:<groupIdx>:<hookIdx>"]`
 *    (verified against a live install — this format is undocumented and
 *    Codex-internal; `post_tool_use` matches an observed real trust grant,
 *    `stop` is inferred from Codex's own `hooks/src/events/stop.rs` module
 *    naming — same convention as the verified `post_tool_use.rs` — but has
 *    not been observed granted on any host checked so far). We check for
 *    that exact bracketed header as its own line (anchored, not a bare
 *    substring, so a coincidental match inside a TOML comment or another
 *    value can't false-positive) — never parse TOML, never recompute or
 *    compare the `trusted_hash` value.
 *
 *  - Reports "trusted" if ANY currently-registered Mullion group has a trust
 *    entry, not only once EVERY one does. Two reasons: first, an observed
 *    real install had a trust entry for PostToolUse but none at all for
 *    Stop despite active use, suggesting Codex's `/hooks` review may grant
 *    trust in a way that doesn't map 1:1 onto "every event separately, every
 *    time" — an `every()` check risks staying stuck on "pending" forever for
 *    a user who already completed that review. Second, this makes the
 *    (inferred, unverified) "stop" token a soft dependency: if it's ever
 *    wrong, the worst outcome is under-reporting ("trusted" while Stop
 *    hooks are still actually gated) rather than a banner that can never
 *    clear — a much better failure mode for a feature whose whole point is
 *    not nagging the user forever.
 *  - A stale hook group from a previous Mullion release (see shared.ts's
 *    stable-path fix) is simply not "the current" group and is ignored here
 *    — trust is reported only for what would actually fire today.
 */
export function getCodexHookTrust(): CodexHookTrust {
  const codexHome = resolveCodexHome();
  const hooksPath = path.join(codexHome, "hooks.json");
  const forwarderPath = resolveForwarderPath();

  const hooksJsonText = readFileOrFallback(hooksPath, "");
  if (!hooksJsonText) {
    return "not-installed";
  }
  let hooksFile: CodexHooksFile;
  try {
    hooksFile = JSON.parse(hooksJsonText) as CodexHooksFile;
  } catch {
    return "not-installed";
  }

  const stateKeys: string[] = [];
  for (const [event, snake] of Object.entries(EVENT_SNAKE)) {
    const groups = hooksFile.hooks?.[event] ?? [];
    const groupIdx = groups.findIndex((group) => isMullionOwned(group, forwarderPath));
    if (groupIdx !== -1) {
      stateKeys.push(`${hooksPath}:${snake}:${groupIdx}:0`);
    }
  }

  if (stateKeys.length === 0) {
    return "not-installed";
  }

  const configText = readFileOrFallback(path.join(codexHome, "config.toml"), "");
  const anyTrusted = stateKeys.some((key) => {
    const header = new RegExp(`^\\[hooks\\.state\\."${escapeRegExp(key)}"\\]`, "m");
    return header.test(configText);
  });
  return anyTrusted ? "trusted" : "pending";
}
