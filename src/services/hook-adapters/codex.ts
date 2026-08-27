import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";
import { shellQuote } from "./shared.js";

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
// `Stop`, `SessionStart`, `SessionEnd`, `PermissionRequest`, `UserPromptSubmit`,
// `PostToolUse` (apply_patch + Bash matchers), `PreCompact`, `PostCompact`,
// `SubagentStart`, and `SubagentStop` are registered.
//
// PermissionRequest is ALSO the blocking permission-approval channel (issue
// #264, same rescope as Claude Code's — see hook-adapters/claude-code.ts's
// file header). Confirmed live against installed codex-cli 0.149.0 (a real
// interactive session, --dangerously-bypass-hook-trust for verification
// only): the hook fires with a real `tool_name`/`tool_input` payload,
// tolerates a timeout well past SessionEnd's separate 1s/3s cap (nothing
// else in Codex's own hook timeout defaults to below 600s), and its
// `hookSpecificOutput.decision.{behavior,message}` reply shape is
// byte-identical to Claude Code's — allow/deny/no-reply-at-all (falls
// through to Codex's own native prompt) all verified. See
// forwarder-core.mjs's mapCodexPermissionRequest/formatGateDecision.
//
// PreCompact/PostCompact/SubagentStart/SubagentStop (issue: extend surfaced
// session statuses) were added once codex-cli 0.149.0's own embedded hook
// I/O schemas confirmed real equivalents to Claude Code's — a previous
// revision of this file left them unregistered, unverified whether Codex's
// hook surface even had them. SubagentStart/SubagentStop payloads carry
// `agent_id`/`agent_type` (required for Start, required for Stop too), and
// PostToolUse's own schema carries the same pair optionally — confirming
// Codex's hook payloads support the same agent-attribution envelope Claude
// Code's do (Phase 5, Track A — see forwarder-core.mjs's applyAgentEnvelope,
// now applied to mapCodexEvent's output too).

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

function hookGroup(
  execPath: string,
  forwarderPath: string,
  kind: string,
  matcher?: string,
  timeoutSeconds = 10,
) {
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
        timeout: timeoutSeconds,
      },
    ],
  };
}

// Issue #264 — a blocking permission decision needs long enough for an
// actual human to notice the amber review indicator and click
// Approve/Deny, not just enough to stop a wedged process (see hookGroup's
// own 10s default for the fire-and-forget hooks). Confirmed live (installed
// codex-cli 0.149.0) that PermissionRequest tolerates a timeout well past
// this — 300s stays comfortably under Mullion's own server-side timeout
// (hooks.ts's GATE_TIMEOUT_MS, 290s) controlling the fall-through, same
// reasoning as Claude Code's PERMISSION_REQUEST_TIMEOUT_SECONDS.
const PERMISSION_REQUEST_TIMEOUT_SECONDS = 300;

/** True if `group` is one Mullion itself previously wrote — identified by
 * its command referencing this install's own forwarder path, never by
 * position/index, so re-running this merge never disturbs a hook group the
 * user configured themselves. Exported for codex-trust.ts, which needs the
 * same "is this Mullion's own group" test to locate the group whose Codex
 * `/hooks` trust status it's checking.
 *
 * Deliberately pinned to the CURRENT forwarder path, not a release-agnostic
 * match — codex-trust.ts's trust lookup depends on this returning the exact
 * group index Codex granted trust against (see that file's doc comment). Do
 * NOT loosen this to fix #460; use `isMullionOwnedByAnyRelease` below for
 * that, which mergeCodexHooks uses for pruning instead. */
export function isMullionOwned(group: CodexHookGroup, forwarderPath: string): boolean {
  return (group.hooks ?? []).some(
    (entry) => typeof entry.command === "string" && entry.command.includes(forwarderPath),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Broader than `isMullionOwned`: true if `group` is a Mullion-written group
 * from ANY past release, not just the currently resolved forwarder path —
 * identified by the command matching the EXACT shape `hookGroup()` (and the
 * hand-built SessionEnd group) produce: a quoted execPath, then a quoted
 * path ending in `forwarder.mjs` with nothing else around it, then a literal
 * ` codex <kind>` tail, anchored start to end. A versioned-release install's
 * forwarder path changed on every upgrade
 * (`.../releases/<ver>/dist/hooks/forwarder.mjs`) before `shared.ts`'s
 * `resolveForwarderPath()` started preferring the stable `current` symlink
 * (issue #259) — so `isMullionOwned`'s exact-path match left a previous
 * release's group in place forever, each stale group still executing (issue
 * #460). Independent review, PR #464: verified via git history that the
 * affected population is BOUNDED, not open-ended — the Codex adapter and the
 * `current`-symlink fix landed roughly 19 hours apart (v0.2.1 → v0.2.4), so
 * only a host that ran Codex hooks in that narrow window can have more than
 * one legacy group per event. Every release since resolves to the same
 * stable path, so `isMullionOwned` alone already keeps working correctly
 * release over release — this predicate exists to clean up that one bounded
 * legacy population, not to guard against ongoing per-release growth.
 *
 * Anchored end-to-end rather than a loose `includes("forwarder.mjs")` +
 * `endsWith(" codex <kind>")` check (Hermes review, PR #464: that pair could
 * match a user's own multi-part command that merely MENTIONS forwarder.mjs
 * somewhere and separately happens to end the same way — this instead
 * requires the SECOND quoted argument specifically to be the forwarder.mjs
 * path, with nothing else in the command).
 *
 * Used ONLY by `mergeCodexHooks`'s prune step, never by codex-trust.ts: this
 * function's whole point is to stop caring which release wrote a group, and
 * codex-trust.ts needs the opposite — the exact index of the CURRENT group,
 * which only `isMullionOwned` (pinned to the live forwarder path) can give
 * it. Mixing the two here would shift a granted trust key's group index out
 * from under it on every prune.
 *
 * Known limitation (independent review, PR #464): a `[^"]*` character class
 * doesn't understand JSON's `\"` escaping, so a `forwarderPath`/`execPath`
 * containing a literal double quote would break the anchored match and this
 * predicate would fail to recognize the group as Mullion's own — the #460
 * bug would persist for that one host rather than being pruned. Fails safe,
 * not open: the effect is "not pruned" (status quo), never a false-positive
 * prune of a real user-authored group. Not handled because it requires an
 * embedded `"` in an installer-controlled path Mullion itself never writes
 * (`execPath = process.execPath`; `forwarderPath` is always a `releases/
 * <ver>/...` or `current` symlink path) — effectively unreachable on the
 * POSIX/systemd deploys this repo targets. */
function isMullionOwnedByAnyRelease(group: CodexHookGroup, kind: string): boolean {
  const pattern = new RegExp(`^"[^"]*"\\s+"[^"]*forwarder\\.mjs"\\s+codex ${escapeRegExp(kind)}$`);
  return (group.hooks ?? []).some(
    (entry) => typeof entry.command === "string" && pattern.test(entry.command),
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
  const fwd = ctx.forwarderPath;

  // Filtering on isMullionOwnedByAnyRelease (not isMullionOwned) here is the
  // #460 fix: it prunes every past release's Mullion-owned group, not just
  // one matching the CURRENT forwarder path, so hooks.json never accumulates
  // a duplicate group — and therefore a duplicate hook firing — per release
  // that has ever installed hooks on this host. See that function's doc
  // comment for why codex-trust.ts must keep using isMullionOwned instead.
  hooks.Stop = [
    ...(hooks.Stop ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "Stop")),
    hookGroup(execPath, fwd, "Stop"),
  ];
  hooks.SessionStart = [
    ...(hooks.SessionStart ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "SessionStart")),
    // No matcher — fires on all SessionStart sources (startup/resume/clear/
    // compact). The forwarder extracts the `source` field from the payload
    // when present.
    hookGroup(execPath, fwd, "SessionStart"),
  ];
  hooks.SessionEnd = [
    ...(hooks.SessionEnd ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "SessionEnd")),
    // Codex's SessionEnd hook timeout defaults to 1s and supports up to 3s.
    // 3s is generous enough for a local socket round trip.
    {
      hooks: [
        {
          type: "command" as const,
          command: `${JSON.stringify(execPath)} ${JSON.stringify(fwd)} codex SessionEnd`,
          timeout: 3,
        },
      ],
    },
  ];
  hooks.PermissionRequest = [
    ...(hooks.PermissionRequest ?? []).filter(
      (g) => !isMullionOwnedByAnyRelease(g, "PermissionRequest"),
    ),
    // No matcher — fires for ALL tools that trigger a permission dialog,
    // giving us a deterministic "agent needs user input" signal regardless
    // of tool type. Also the blocking permission-approval channel (issue
    // #264) — needs the long timeout, not the fire-and-forget default.
    hookGroup(execPath, fwd, "PermissionRequest", undefined, PERMISSION_REQUEST_TIMEOUT_SECONDS),
  ];
  hooks.UserPromptSubmit = [
    ...(hooks.UserPromptSubmit ?? []).filter(
      (g) => !isMullionOwnedByAnyRelease(g, "UserPromptSubmit"),
    ),
    // No matcher support for UserPromptSubmit (per Codex docs).
    hookGroup(execPath, fwd, "UserPromptSubmit"),
  ];
  hooks.PostToolUse = [
    ...(hooks.PostToolUse ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "PostToolUse")),
    hookGroup(execPath, fwd, "PostToolUse", "apply_patch"),
    // Issue: sidebar worktree detection — register a Bash matcher so the
    // forwarder receives Bash PostToolUse events and can detect git worktree
    // add commands and forward cwd changes. Currently a no-op for file_change
    // output (mapCodexPostToolUse only handles apply_patch); the Bash matcher
    // is also registered for future payload-shape verification against a live
    // Codex hook firing (tracked as part of issue #264).
    hookGroup(execPath, fwd, "PostToolUse", "Bash"),
  ];
  // Issue: extend surfaced session statuses (Codex parity) — confirmed live
  // against installed codex-cli 0.149.0's own embedded hook I/O schemas
  // (`pre-compact.command.input`/`post-compact.command.input`/
  // `subagent-start.command.input`/`subagent-stop.command.input`) that Codex
  // has real equivalents of Claude Code's PreCompact/PostCompact/
  // SubagentStart/SubagentStop, contradicting CODEX_EMITS's previous "hasn't
  // been verified to have them" caveat. All four are fire-and-forget,
  // observational only.
  hooks.PreCompact = [
    ...(hooks.PreCompact ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "PreCompact")),
    hookGroup(execPath, fwd, "PreCompact"),
  ];
  hooks.PostCompact = [
    ...(hooks.PostCompact ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "PostCompact")),
    hookGroup(execPath, fwd, "PostCompact"),
  ];
  hooks.SubagentStart = [
    ...(hooks.SubagentStart ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "SubagentStart")),
    hookGroup(execPath, fwd, "SubagentStart"),
  ];
  hooks.SubagentStop = [
    ...(hooks.SubagentStop ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "SubagentStop")),
    hookGroup(execPath, fwd, "SubagentStop"),
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

// Issue: extend surfaced session statuses — the hook-protocol `kind`s the
// ten events mergeCodexHooks registers above can ever produce (see
// forwarder-core.mjs's mapCodexEvent for the mapping). PreCompact/
// PostCompact/SubagentStart/SubagentStop were added once codex-cli 0.149.0's
// own embedded hook I/O schemas confirmed real equivalents exist — see the
// registration comment above. No elicitation equivalent is registered —
// Codex's hook surface still hasn't been verified to have one.
//
// `review_gate`, not `permission_request` (issue #264 rescope): Codex's
// PermissionRequest now always maps to review_gate — unlike Claude Code,
// Codex has no ExitPlanMode-equivalent tool/dedup concern to exempt, so
// every PermissionRequest for this agent becomes a gate, with no
// observational fallback shape surviving at all.
const CODEX_EMITS = [
  "progress",
  "session_start",
  "session_end",
  "review_gate",
  "turn_start",
  "file_change",
  "git_branch",
  "cwd_changed",
  "compact",
  "subagent",
] as const;

export const codexAdapter: HookAgentAdapter = {
  name: "codex",
  // No commandTransform (unlike Claude Code) — see the file header for why
  // an argv edit isn't the right tool here even though one exists
  // (`--dangerously-bypass-hook-trust`).
  matches: (command) => CODEX_COMMAND_RE.test(command.trim()),
  prepareLaunch,
  emits: CODEX_EMITS,
  // `codex [OPTIONS] [PROMPT]` — "Optional user prompt to start the
  // session," a plain trailing positional in interactive mode (the default;
  // `exec`/`review` subcommands are the non-interactive path and aren't
  // used here). Verified against `codex --help` on a live host.
  //
  // Hermes review, PR #538 — a task title/prompt starting with `-` (e.g.
  // "- fix X") would otherwise be parsed as an unknown clap OPTION, not a
  // positional (`error: unexpected argument '-x' found`, verified live —
  // clap's own error even suggests `-- -x`). The `--` end-of-options marker
  // closes that, verified live to make an otherwise-rejected leading-hyphen
  // prompt reach codex's positional PROMPT argument instead.
  initialPromptArgs: (prompt) => `-- ${shellQuote(prompt)}`,
};
