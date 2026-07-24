import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { HookAdapterContext, HookAgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { openCodeAdapter } from "./opencode.js";
import { codexAdapter } from "./codex.js";
import { agyAdapter } from "./agy.js";

export type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";
export { resolveForwarderPath, resolveOpenCodePluginPath } from "./shared.js";

// Registered in dependency-sequence order per the plan (Claude Code in PR4;
// OpenCode in PR5; Codex in PR6; agy here in PR7 — all reusing this same
// framework, Claude Code/Codex/agy also sharing the forwarder). Order only
// matters in that the first match wins — each adapter's `matches()` is
// conservative enough that two adapters matching the same command is not
// expected to happen in practice.
const ADAPTERS: HookAgentAdapter[] = [claudeCodeAdapter, openCodeAdapter, codexAdapter, agyAdapter];

export interface AppliedHooks {
  /** The command to actually spawn — unchanged unless an adapter's
   * `commandTransform` ran. */
  command: string;
  /** Env vars to merge into the session's env (in addition to
   * MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN, which the caller sets itself). */
  envAdditions: Record<string, string>;
  /** Whether an adapter actually matched AND its launch plan applied
   * successfully — false for both "no adapter matched this command" and the
   * catch-and-fall-back-to-unhooked-launch path below. Session (pty-manager.ts)
   * uses this to know whether it can trust this agent's own hook-sourced
   * "done"/"needs attention" signals (Stop/session.idle/Notification) rather
   * than falling back to the byte-driven silence heuristic, which can't tell
   * a real "went quiet after work" apart from a hook agent's own startup
   * splash render. */
  matched: boolean;
}

/**
 * Finds the first adapter matching `command`, runs its launch plan's I/O
 * side effects (settings-file writes, managed installs), and returns the
 * possibly-transformed command plus any env additions. Deliberately
 * defensive: any adapter failure (a write error, a throwing managedInstall)
 * is logged and swallowed rather than propagated — a broken hook-config
 * write must never prevent a session from spawning at all, since hooks are
 * a pure enhancement and every agent works exactly as before without them.
 */
export function applyHookAdapters(
  command: string,
  ctx: HookAdapterContext,
  log: { error: (obj: unknown, msg: string) => void } = console,
): AppliedHooks {
  const adapter = ADAPTERS.find((candidate) => candidate.matches(command));
  if (!adapter) {
    return { command, envAdditions: {}, matched: false };
  }

  try {
    const plan = adapter.prepareLaunch(ctx);
    for (const file of plan.settingsFiles ?? []) {
      // recursive: true — OpenCode's adapter (issue #175) writes into a
      // nested <sessionId>.opencode-config/plugins/ scratch directory that
      // doesn't exist yet; Claude Code's flat <sessionId>.hooks.json under
      // an already-existing sessionsDir made this a no-op before now.
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.contents, { mode: 0o600 });
    }
    if (plan.managedInstall) {
      // Fire-and-forget from this synchronous seam's point of view: a
      // managed install (Codex, agy) touches the agent's own REAL config
      // location, not this session's spawn.
      // `Promise.resolve().then(() => plan.managedInstall())`, NOT
      // `Promise.resolve(plan.managedInstall())` — the call itself must
      // happen inside the microtask, so an adapter whose managedInstall
      // throws SYNCHRONOUSLY (rather than returning a rejected promise)
      // still only ever produces a rejection here, not an exception that
      // unwinds into this function's own outer try/catch below and
      // discards an otherwise-successful commandTransform/envAdditions.
      Promise.resolve()
        .then(() => plan.managedInstall?.())
        .catch((err: unknown) => {
          log.error({ err, adapter: adapter.name }, "hook adapter managed install failed");
        });
    }
    return {
      command: plan.commandTransform ? plan.commandTransform(command) : command,
      envAdditions: plan.envAdditions ?? {},
      matched: true,
    };
  } catch (err) {
    log.error({ err, adapter: adapter.name }, "hook adapter failed, launching without hooks");
    return { command, envAdditions: {}, matched: false };
  }
}
