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
 *    not been observed granted on any host checked so far). We only check
 *    for the presence of that exact bracketed header as a raw substring —
 *    never parse TOML, never recompute or compare the `trusted_hash` value.
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

  let hooksFile: CodexHooksFile;
  try {
    hooksFile = JSON.parse(readFileSync(hooksPath, "utf8")) as CodexHooksFile;
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

  let configText = "";
  try {
    configText = readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    // No config.toml means nothing has ever been trusted.
  }

  const anyTrusted = stateKeys.some((key) => configText.includes(`[hooks.state."${key}"]`));
  return anyTrusted ? "trusted" : "pending";
}
