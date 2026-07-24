import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";

// Codex adapter (issue #252). Unlike Claude Code/OpenCode, this is NOT an
// ephemeral, per-session injection — verified this PR against the real
// installed Codex CLI and its own hook documentation, both facts the
// original plan got wrong:
//
// 1. `CODEX_HOME` is not a surgical "relocate just the hooks" knob like
//    OpenCode's `OPENCODE_CONFIG_DIR` — it relocates EVERYTHING (auth,
//    model config, MCP servers, trusted-project state, history). Pointing
//    it at a fresh per-session scratch directory breaks Codex outright
//    (`codex doctor` reports "no Codex credentials were found" against an
//    empty CODEX_HOME) — not a graceful degradation, a broken agent.
// 2. Even with a real, populated config, Codex requires an explicit,
//    interactive one-time trust decision (`/hooks`) before ANY non-managed
//    command hook — including one Mullion generates — is allowed to run.
//    "Managed" hooks that skip this review require an enterprise
//    `requirements.toml` deployed via MDM/system tooling, not writable by
//    an ordinary user process. The only non-interactive bypass is
//    `--dangerously-bypass-hook-trust` — a flag that disables the trust
//    review GLOBALLY for that invocation, including for any hooks a cloned
//    repo's own `.codex/hooks.json` ships (a real unreviewed-code-exec
//    vector for a tool whose job is running agents against arbitrary
//    repos). Not used here, on purpose — see issue #252 for the fuller
//    writeup.
//
// Given both, this follows the SAME "managed, reversible install" pattern
// the plan already approved for agy/OpenCode-fallback (not the plan's
// original "pure env, no argv edit, no managed install" bullet for Codex,
// which was written before either fact above was verified): an idempotent,
// Mullion-owned merge into the user's REAL `~/.codex/hooks.json` (never a
// throwaway scratch file), keyed off `forwarderPath` so re-running this on
// every launch only ever replaces Mullion's OWN group — any other hooks the
// user has configured themselves are left completely untouched. Real
// CODEX_HOME (auth/config/MCP) stays intact, and because trust is recorded
// against the REAL, stable home rather than a fresh-per-session one, a
// one-time `/hooks` trust grant persists across every future
// Mullion-launched Codex session — it just isn't automatic. Until a user
// grants that trust, these hooks are silently skipped and Codex behaves
// exactly as it does today. UPDATE (follow-up to #275, gap #1 — issue #259):
// the PTY-parsed attention channel is NOT unconditionally "unaffected either
// way" as originally written here — pty-manager.ts's Session.tick() disables
// its own fast byte-driven silence guess for any `hooksActive` session on
// the assumption the matched adapter's hook actually fires, which is exactly
// false for an untrusted Codex session. That gap is closed by the
// `hooksProven` latch (see pty-manager.ts): a session that's merely
// `hooksActive` but has never actually delivered a hook message (this
// untrusted-Codex case) retains the fast byte-driven detection instead of
// silently downgrading to the much slower 60s fallback watchdog — so the net
// effect described here (Codex behaves as it does without Mullion hooks)
// now genuinely holds for attention detection too, not just for the hooks
// themselves.
//
// Only `Stop` and `PostToolUse` are registered — Codex has no `Notification`
// event at all (confirmed against its hook docs), and gating hooks
// (`PreToolUse`/`PermissionRequest`) are deliberately deferred to issue
// #178, same reasoning as Claude Code's deferred `PreToolUse`: no endpoint
// exists yet to answer a real gate decision.

const CODEX_COMMAND_RE = /^(?:\S*\/)?codex(?:\s|$)/;

export interface CodexHookGroup {
  matcher?: string;
  hooks?: Array<{ command?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface CodexHooksFile {
  hooks?: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
}

function hookGroup(execPath: string, forwarderPath: string, kind: string, matcher?: string) {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command" as const,
        command: `${JSON.stringify(execPath)} ${JSON.stringify(forwarderPath)} codex ${kind}`,
        // Shown to the user when they review this hook via Codex's own
        // `/hooks` trust UI — makes clear what it is and that it's safe to
        // remove, without requiring them to go read this file's source.
        statusMessage: "Mullion agent-hook forwarder — safe to remove, see docs/agent-hooks.md",
        timeout: 10,
      },
    ],
  };
}

/** True if `group` is one Mullion itself previously wrote — identified by
 * its command referencing this install's own forwarder path, never by
 * position/index, so re-running this merge never disturbs a hook group the
 * user configured themselves. Exported for codex-trust.ts, which needs the
 * same "is this Mullion's own group" test to locate the group whose Codex
 * `/hooks` trust status it's checking. */
export function isMullionOwned(group: CodexHookGroup, forwarderPath: string): boolean {
  return (group.hooks ?? []).some(
    (entry) => typeof entry.command === "string" && entry.command.includes(forwarderPath),
  );
}

/** Where Codex keeps its real, non-ephemeral home — see the file header for
 * why this can never be a per-session scratch dir. Exported so codex-trust.ts
 * resolves the exact same `hooks.json`/`config.toml` this adapter writes to. */
export function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function mergeCodexHooks(ctx: HookAdapterContext): void {
  const codexHome = resolveCodexHome();
  const hooksPath = path.join(codexHome, "hooks.json");

  let existing: CodexHooksFile = {};
  try {
    existing = JSON.parse(readFileSync(hooksPath, "utf8")) as CodexHooksFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // A file present but unparseable is a file we must not blindly
      // overwrite — bail without writing anything rather than risk
      // corrupting the user's real Codex config. Logged by
      // applyHookAdapters' managedInstall error handling.
      throw new Error(`cannot parse existing ${hooksPath}, leaving it untouched`, { cause: err });
    }
  }

  const hooks: Record<string, CodexHookGroup[]> = { ...(existing.hooks ?? {}) };
  const execPath = process.execPath;

  hooks.Stop = [
    ...(hooks.Stop ?? []).filter((g) => !isMullionOwned(g, ctx.forwarderPath)),
    hookGroup(execPath, ctx.forwarderPath, "Stop"),
  ];
  hooks.PostToolUse = [
    ...(hooks.PostToolUse ?? []).filter((g) => !isMullionOwned(g, ctx.forwarderPath)),
    hookGroup(execPath, ctx.forwarderPath, "PostToolUse", "apply_patch"),
  ];

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`);
}

function prepareLaunch(ctx: HookAdapterContext): HookLaunchPlan {
  return {
    // async, not a plain arrow wrapping a sync call: a synchronous throw
    // from mergeCodexHooks (e.g. the malformed-JSON bail above) must become
    // a REJECTED PROMISE here, not an exception thrown out of this function
    // call itself — applyHookAdapters' caller does
    // `Promise.resolve(plan.managedInstall()).catch(...)`, which only
    // catches a rejection, not a synchronous throw from evaluating the call
    // expression itself.
    managedInstall: async () => mergeCodexHooks(ctx),
  };
}

export const codexAdapter: HookAgentAdapter = {
  name: "codex",
  // No commandTransform (unlike Claude Code) — see the file header for why
  // an argv edit isn't the right tool here even though one exists
  // (`--dangerously-bypass-hook-trust`).
  matches: (command) => CODEX_COMMAND_RE.test(command.trim()),
  prepareLaunch,
};
