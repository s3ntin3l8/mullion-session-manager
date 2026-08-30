import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";
import {
  shellQuote,
  escapeTomlBasicString,
  resolveMcpServerPath,
  SHELL_METACHARACTERS_RE,
} from "./shared.js";
import { ensureForwarderShim, forwarderHookCommand } from "./forwarder-shim.js";
import { installBundleSkills, uninstallBundleSkills } from "./mullion-bundle.js";

// Codex adapter (issue #252). Unlike Claude Code/OpenCode, its HOOKS
// wiring is NOT an ephemeral, per-session injection — verified this PR
// against the real installed Codex CLI and its own hook documentation,
// both facts the original plan got wrong:
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
// Given both, hooks follow the SAME "managed, reversible install" pattern
// the plan already approved for agy/OpenCode-fallback (not the plan's
// original "pure env, no argv edit, no managed install" bullet for Codex,
// which was written before either fact above was verified — see issue #880
// below for the ONE thing that bullet still turned out right about: the
// MCP server, added later, genuinely is ephemeral argv): an idempotent,
// Mullion-owned merge into the user's REAL `~/.codex/hooks.json` (never a
// throwaway scratch file), keyed off a fixed forwarder-shim path
// (forwarder-shim.ts) so re-running this on every launch only ever replaces
// Mullion's OWN group — any other hooks the user has configured themselves
// are left completely untouched. Real
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
// Issue #880 — the MCP server (`mcp__mullion__*` tools) is the ONE part of
// this adapter that IS ephemeral, and deliberately so: see
// buildCodexMcpFlags' own doc comment for the two reasons (the
// managedInstall/config-read-at-startup race, and not wanting a per-session
// token in the user's persistent config.toml) it doesn't follow hooks.json's
// managed-write pattern. No `/hooks`-equivalent trust gate exists for it —
// confirmed live against a real interactive session — so there is nothing
// to grant and nothing to remove; `### Removing managed hooks`
// (docs/agent-hooks.md) has no Codex-MCP entry for exactly that reason.
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
// SHELL_METACHARACTERS_RE (shared.js) — unlike claude-code.ts's matcher,
// this one is NOT applied in `matches()` below. It gates only
// `commandTransform`'s MCP `-c` flags (issue #880) — see that function's
// own comment for why a chained/piped/redirected command should still
// match this adapter (and still get hooks.json/bundle-skills) even when
// it's not safe to also append an argv flag.

export interface CodexHookGroup {
  matcher?: string;
  hooks?: Array<{ command?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface CodexHooksFile {
  hooks?: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
}

// Hermes review, PR #908 — `timeoutSeconds`/`statusMessage` take an options
// object, not two more trailing positionals: a 4-positional signature would
// force the PermissionRequest call site below to pass an explicit
// `undefined` for `matcher` just to reach them, which is an easy
// `timeoutSeconds`/`statusMessage` transposition waiting to happen.
function hookGroup(
  kind: string,
  matcher?: string,
  options?: { timeoutSeconds?: number; statusMessage?: string },
) {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command" as const,
        command: forwarderHookCommand("codex", kind),
        // Shown to the user when they review this hook via Codex's own
        // `/hooks` trust UI — makes clear what it is and that it's safe to
        // remove, without requiring them to go read this file's source.
        // `PermissionRequest` overrides this with an actionable message
        // (see its own registration below) since Codex renders it live,
        // in the terminal, for the full duration the hook blocks — the
        // ONLY in-terminal signal a gate parked behind an already-pending
        // one has (issue tracked alongside the "concurrent gates" fix).
        statusMessage:
          options?.statusMessage ??
          "Mullion agent-hook forwarder — safe to remove, see docs/agent-hooks.md",
        timeout: options?.timeoutSeconds ?? 10,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `group`'s command matches the CURRENT shape `hookGroup()`
 * produces: a single-quoted path to the fixed forwarder shim
 * (`forwarder-shim.ts`), a literal ` codex <kind>` tail, and an optional
 * `|| printf ...` fail-open guard — anchored start to end, not a loose
 * `includes()` (Hermes review, PR #464, preserved here: a user's own
 * multi-part command that merely MENTIONS the shim filename and separately
 * happens to end the same way must not false-positive as Mullion's own).
 *
 * Unlike the pre-shim `isMullionOwned(group, forwarderPath)` this replaces,
 * this no longer needs to be pinned to a live, checkout-specific path: the
 * shim path is now a true host-wide constant (`resolveForwarderShimPath()`),
 * so "the group Codex granted trust against" and "the group this release
 * would write" are the same thing for every post-fix group, keyed only by
 * `kind`. Exported for codex-trust.ts, which needs the same "is this
 * Mullion's CURRENT group" test to locate the group whose Codex `/hooks`
 * trust status it's checking.
 *
 * Known limitation, same posture as the pre-shim version's `[^"]*` caveat
 * (independent review, PR #464): the `[^']*` character class doesn't
 * understand an embedded escaped single quote, so a shim path containing a
 * literal `'` would break this match. Fails safe, not open — the effect is
 * "not recognized as current" (falls through to legacy/unrecognized, never
 * pruned as if user-authored), never a false-positive match of a real
 * user-authored group. Effectively unreachable: `resolveForwarderShimPath()`
 * is `os.homedir()`-derived, a location this codebase never writes a `'`
 * into. */
export function isCurrentMullionGroup(group: CodexHookGroup, kind: string): boolean {
  const pattern = new RegExp(
    `^'[^']*mullion-forwarder-shim\\.sh'\\s+codex ${escapeRegExp(kind)}(?:\\s+\\|\\|\\s+printf\\b.*)?$`,
  );
  return (group.hooks ?? []).some(
    (entry) => typeof entry.command === "string" && pattern.test(entry.command),
  );
}

/** True if `group`'s command matches the shape a PRE-shim Mullion release
 * wrote — a quoted execPath, a quoted path ending in `forwarder.mjs` with
 * nothing else around it, then a literal ` codex <kind>` tail, anchored
 * start to end. Kept verbatim (including its own `[^"]*`-doesn't-understand-
 * `\"`-escaping caveat, see the #460/#464 history this predicate
 * originally addressed) purely so THIS release still recognizes and prunes
 * a group an older release wrote, during the one-time migration to the
 * shim shape. Used only by `isMullionOwnedByAnyRelease`'s pruning — never
 * by codex-trust.ts, which only ever needs to find the CURRENT group. */
function isLegacyMullionGroup(group: CodexHookGroup, kind: string): boolean {
  const pattern = new RegExp(`^"[^"]*"\\s+"[^"]*forwarder\\.mjs"\\s+codex ${escapeRegExp(kind)}$`);
  return (group.hooks ?? []).some(
    (entry) => typeof entry.command === "string" && pattern.test(entry.command),
  );
}

/** True if `group` is a Mullion-written group in EITHER the current
 * shim-based shape or a pre-shim release's `forwarder.mjs`-based shape.
 * `mergeCodexHooks`'s prune step uses this (not `isCurrentMullionGroup`
 * alone) so re-running the merge cleans up every past release's group —
 * including ones from before this shim migration — rather than leaving a
 * stale legacy group in place alongside the new one (the original #460
 * bug, which this same broadening once fixed for the pre-shim path
 * migration and must keep fixing across this one too). */
function isMullionOwnedByAnyRelease(group: CodexHookGroup, kind: string): boolean {
  return isCurrentMullionGroup(group, kind) || isLegacyMullionGroup(group, kind);
}

/** Where Codex keeps its real, non-ephemeral home — see the file header for
 * why this can never be a per-session scratch dir. Exported so codex-trust.ts
 * resolves the exact same `hooks.json`/`config.toml` this adapter writes to. */
export function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function mergeCodexHooks(): void {
  const codexHome = resolveCodexHome();
  const hooksPath = path.join(codexHome, "hooks.json");

  // Issue: host-global hook config collision — installs the fixed,
  // host-stable forwarder shim BEFORE writing any command that references
  // it, same independently-guarded, log-and-continue posture as agy.ts's
  // mergeAgyHooks (a failure here must not skip the hooks.json write below
  // — the emitted commands' `|| printf` guard makes a missing shim degrade
  // to a safe no-op, never a reason to leave the OLD, checkout-specific
  // command in place). See forwarder-shim.ts's header.
  try {
    ensureForwarderShim();
  } catch (err) {
    console.error({ err }, "mergeCodexHooks: failed to install forwarder shim, continuing anyway");
  }

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

  // Filtering on isMullionOwnedByAnyRelease (not isCurrentMullionGroup) here
  // is the #460 fix: it prunes every past release's Mullion-owned group —
  // both the current shim shape and any pre-shim `forwarder.mjs` shape — not
  // just the current one, so hooks.json never accumulates a duplicate group
  // (and therefore a duplicate hook firing) per release that has ever
  // installed hooks on this host. See that function's doc comment for why
  // codex-trust.ts must keep using isCurrentMullionGroup instead.
  hooks.Stop = [
    ...(hooks.Stop ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "Stop")),
    hookGroup("Stop"),
  ];
  hooks.SessionStart = [
    ...(hooks.SessionStart ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "SessionStart")),
    // No matcher — fires on all SessionStart sources (startup/resume/clear/
    // compact). The forwarder extracts the `source` field from the payload
    // when present.
    hookGroup("SessionStart"),
  ];
  hooks.SessionEnd = [
    ...(hooks.SessionEnd ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "SessionEnd")),
    // Codex's SessionEnd hook timeout defaults to 1s and supports up to 3s.
    // 3s is generous enough for a local socket round trip.
    {
      hooks: [
        {
          type: "command" as const,
          command: forwarderHookCommand("codex", "SessionEnd"),
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
    //
    // Own statusMessage, not hookGroup's shared default: Codex renders this
    // string live, in the terminal, for as long as this hook blocks (up to
    // PERMISSION_REQUEST_TIMEOUT_SECONDS). It is the ONLY affordance a gate
    // has in the terminal when Mullion's own single-gate-per-session model
    // has already parked it behind a concurrent one that fell through to
    // Codex's native prompt instead — investigated live against a stuck
    // branchDAM session where the user approved the *other* concurrent
    // request in the TUI and had no indication a second one was still
    // waiting on a decision only reachable from the Mullion UI.
    hookGroup("PermissionRequest", undefined, {
      timeoutSeconds: PERMISSION_REQUEST_TIMEOUT_SECONDS,
      statusMessage:
        "Mullion is holding this approval — open Mullion and Approve/Deny it there (see docs/agent-hooks.md)",
    }),
  ];
  hooks.UserPromptSubmit = [
    ...(hooks.UserPromptSubmit ?? []).filter(
      (g) => !isMullionOwnedByAnyRelease(g, "UserPromptSubmit"),
    ),
    // No matcher support for UserPromptSubmit (per Codex docs).
    hookGroup("UserPromptSubmit"),
  ];
  hooks.PostToolUse = [
    ...(hooks.PostToolUse ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "PostToolUse")),
    hookGroup("PostToolUse", "apply_patch"),
    // Issue: sidebar worktree detection — register a Bash matcher so the
    // forwarder receives Bash PostToolUse events and can detect git worktree
    // add commands and forward cwd changes. Currently a no-op for file_change
    // output (mapCodexPostToolUse only handles apply_patch); the Bash matcher
    // is also registered for future payload-shape verification against a live
    // Codex hook firing (tracked as part of issue #264).
    hookGroup("PostToolUse", "Bash"),
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
    hookGroup("PreCompact"),
  ];
  hooks.PostCompact = [
    ...(hooks.PostCompact ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "PostCompact")),
    hookGroup("PostCompact"),
  ];
  hooks.SubagentStart = [
    ...(hooks.SubagentStart ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "SubagentStart")),
    hookGroup("SubagentStart"),
  ];
  hooks.SubagentStop = [
    ...(hooks.SubagentStop ?? []).filter((g) => !isMullionOwnedByAnyRelease(g, "SubagentStop")),
    hookGroup("SubagentStop"),
  ];

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`);
}

// Codex's own global skill-scope directory, per skills.ts's globalSkillDirs
// table (`agentsSkills = expandHome("~/.agents/skills")`, entry for
// agent: "codex") — verified this session (S6 spike, plan doc) that the
// installed codex CLI genuinely reads a skill placed there. Distinct from
// agy's own global root below (agy does NOT read this path at all — see
// mullion-bundle.ts's installBundleSkills doc comment).
export function resolveCodexAgentsSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

// Issue #880 — exposes Mullion's own MCP server (src/mcp/server.mjs) to
// Codex, via `-c mcp_servers.mullion.*` overrides on the command line —
// NOT a managed write into the user's real `~/.codex/hooks.json`/
// `config.toml`, unlike this file's own `mergeCodexHooks`. That asymmetry
// is deliberate, not an oversight:
//
// - `applyHookAdapters` runs `managedInstall` fire-and-forget
//   (hook-adapters/index.ts, `Promise.resolve().then(...)`), and Codex
//   reads `config.toml` at process STARTUP. `hooks.json` tolerates the
//   fire-and-forget race because Codex re-reads it when a hook fires,
//   well after startup; an `mcp_servers` table written after Codex has
//   already booted would silently no-op for that launch. `-c` has no such
//   race — it's parsed before Codex starts at all.
// - It also avoids writing a per-SESSION hook token into the user's
//   PERSISTENT, hand-edited `config.toml` on every launch (the pattern
//   `mergeAgyMcpConfig`, agy.ts, already accepts for agy — not one to
//   extend here when a cleaner channel exists for Codex).
//
// Verified empirically this PR, at the bar this repo requires for a new
// per-CLI mechanism — not just "the flag is accepted," but a REAL
// interactive `codex` (the actual TUI Mullion launches, not `codex mcp
// list`/`codex debug prompt-input`, which are separate code paths per
// `feedback_verify_actual_cli_subcommand_not_sibling`'s own lesson):
//
// 1. Launched a real `codex` (bare, no subcommand) in a PTY, in a scratch
//    CODEX_HOME seeded with a COPY of a real `auth.json`/`config.toml`
//    (never the user's real `~/.codex` — redirecting CODEX_HOME itself is
//    the file-header-documented "breaks Codex outright" mistake; a copy
//    sidesteps that while still exercising real auth), with
//    `-c mcp_servers.probe.command/args/env` pointing at a stdio probe
//    server. The probe's own spawn log confirmed the FULL MCP handshake —
//    `initialize` -> `notifications/initialized` -> `tools/list` — fired
//    during ordinary TUI startup, before any prompt was submitted.
// 2. The captured terminal output reached Codex's normal ready-for-input
//    screen with NO additional trust/consent dialog for the MCP server —
//    unlike hooks.json's `/hooks` gate, there is no equivalent one-time
//    review step for `-c`-configured MCP servers.
// 3. A parent-env var (`MULLION_HOOK_TOKEN` set in the invoking shell) was
//    NOT inherited by the spawned server (`env vars: []` in `codex mcp
//    list --json`'s own transport field, i.e. no forwarding by name
//    happens implicitly) — confirming secrets must be passed via an
//    explicit `mcp_servers.mullion.env` table, the same "session-scoped
//    hook token only, never MULLION_AUTH_TOKEN" posture
//    `buildClaudeMcpConfig` (claude-code.ts) and `mergeAgyMcpConfig`
//    (agy.ts) already use — confirmed this DOES work when set explicitly.
//
// Never calls `smol-toml`'s stringifier — these are new, synthesized `-c`
// arguments, not an edit to a user's existing file, so there is nothing to
// round-trip or preserve; each override is built as a small, independently
// valid TOML literal and escaped via `escapeTomlBasicString` (shared.js,
// hoisted from codex-skills.ts's own identical need) before being
// shell-quoted as one argument.
export function buildCodexMcpFlags(
  mcpServerPath: string,
  hookSocketPath: string,
  hookToken: string,
  controlSocketPath: string,
  execPath: string = process.execPath,
): string {
  const tomlString = (value: string) => `"${escapeTomlBasicString(value)}"`;
  const envTable = [
    `MULLION_HOOK_SOCKET=${tomlString(hookSocketPath)}`,
    `MULLION_HOOK_TOKEN=${tomlString(hookToken)}`,
    `MULLION_SOCKET_PATH=${tomlString(controlSocketPath)}`,
  ].join(", ");
  const overrides = [
    `mcp_servers.mullion.command=${tomlString(execPath)}`,
    `mcp_servers.mullion.args=[${tomlString(mcpServerPath)}]`,
    `mcp_servers.mullion.env={${envTable}}`,
  ];
  return overrides.map((override) => `-c ${shellQuote(override)}`).join(" ");
}

function prepareLaunch(ctx: HookAdapterContext): HookLaunchPlan {
  return {
    // Issue #906 — Codex's workspace-write sandbox marks .git read-only,
    // causing every git worktree add/remove and git stash push to require an
    // escalated permission (PermissionRequest gate). --add-dir .git grants
    // .git write access inside the sandbox, reducing escalations at the
    // source. Verified against installed codex-cli 0.151.0's own --help
    // output. Guard against double-append if the user already supplies
    // --add-dir .git. Note: in a git worktree, .git is a plain file
    // (gitdir: pointer), not a directory — this still helps normal checkouts
    // but may not fully resolve escalations for worktree sessions (see
    // docs/agent-hooks.md).
    //
    // Issue #880 — combined with the Mullion MCP server below in the same
    // commandTransform (only one may exist per adapter): always registered
    // (mirroring claude-code.ts's unconditional --mcp-config and agy.ts's
    // unconditional mergeAgyMcpConfig, and now opencode.ts's unconditional
    // mcp.mullion entry — none of the four is gated on any setting, since
    // the tools it exposes are core Mullion functionality, not an optional
    // nudge). See buildCodexMcpFlags' own doc comment for why this rides
    // `commandTransform`, an ephemeral argv edit, rather than a fourth
    // managedInstall step alongside mergeCodexHooks below.
    //
    // The metacharacter check applies ONLY to the MCP flags, not to
    // --add-dir .git above — a chained/piped/redirected codex command
    // (`codex && npm test`) still matches this adapter and still gets
    // hooks.json/bundle-skills via managedInstall below, which doesn't care
    // about the command string at all. It just doesn't ALSO get the MCP
    // flags appended, the same "degrade this one flag, not the whole
    // adapter" posture getSkipPermissionFlag() already has (launch-plan.ts)
    // — appending `-c ...` to one piece of a chain could attach it to the
    // wrong command entirely, but that's a reason to skip the flag, not to
    // drop hooks too.
    commandTransform: (command) => {
      const withGitDir = command.includes("--add-dir .git")
        ? command
        : `${command} --add-dir .git`;
      if (SHELL_METACHARACTERS_RE.test(command.trim())) return withGitDir;
      return `${withGitDir} ${buildCodexMcpFlags(
        resolveMcpServerPath(),
        ctx.hookSocketPath,
        ctx.hookToken,
        ctx.controlSocketPath,
      )}`;
    },
    // async, not a plain arrow wrapping a sync call: a synchronous throw
    // from any step below must become a REJECTED PROMISE here, not an
    // exception thrown out of this function call itself —
    // applyHookAdapters' caller does
    // `Promise.resolve(plan.managedInstall()).catch(...)`, which only
    // catches a rejection, not a synchronous throw from evaluating the call
    // expression itself.
    //
    // Two independently-guarded steps, same per-step try/catch shape as
    // agy.ts's managedInstall (and for the same reason: a bundle-skill
    // install failure — e.g. EACCES on ~/.agents — must never skip
    // mergeCodexHooks, which is the step that actually matters for a
    // session's hook wiring).
    managedInstall: async () => {
      const steps: Array<[string, () => void]> = [
        ["mergeCodexHooks", () => mergeCodexHooks()],
        [
          "installBundleSkills",
          () => {
            const skillsDir = resolveCodexAgentsSkillsDir();
            if (ctx.injectMullionBundle) installBundleSkills(skillsDir);
            else uninstallBundleSkills(skillsDir);
          },
        ],
      ];
      let firstError: unknown;
      for (const [name, step] of steps) {
        try {
          step();
        } catch (err) {
          console.error(`[codex] managedInstall step "${name}" failed:`, err);
          firstError ??= err;
        }
      }
      if (firstError !== undefined) throw firstError;
    },
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
  // Deliberately NOT gated on SHELL_METACHARACTERS_RE the way Claude
  // Code's matches() is (issue #880 follow-up correction): this adapter's
  // primary mechanism is `managedInstall` (mergeCodexHooks), which writes
  // a REAL, host-level config file and doesn't care what the launch
  // command looks like — unlike Claude Code, whose entire integration IS
  // the argv/settings-file edit. Gating the whole adapter on that check
  // would silently drop hooks, the review gate, and bundle-skill install
  // for any chained/piped/redirected codex launch, not just the new MCP
  // `-c` flags below — a materially bigger regression than the metacharacter
  // guard is meant to prevent. The guard belongs on the flag it protects,
  // not the adapter; see commandTransform's own check.
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
