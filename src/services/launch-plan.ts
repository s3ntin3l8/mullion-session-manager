// PR 32 (Wave 6 of the refactoring roadmap) — extracted from
// Session.bootstrapMaster() in pty-manager.ts. This module composes the
// argv/env for a session's dtach master launch; it does NOT spawn anything
// itself. See pty-manager.ts's Session.bootstrapMaster() for the actual
// `systemd-run` spawn, which is untouched by this extraction and stays
// there since it owns the real OS process (and the reject/resolve wiring
// around its `exit`/`error` events).
//
// NOT a pure function despite "composition" in the name above: like the
// code it was extracted from, buildLaunchPlan() performs the same
// spawn-time disk writes bootstrapMaster() always has (writeSessionAgentGuide,
// and — via applyHookAdapters — an adapter's own settingsFiles writes and
// fire-and-forget managedInstall). Those are kept in this exact sequence,
// not split out into a separate "run the side effects" step, because of the
// issue #437c ordering constraint below: the opencode adapter's
// prepareLaunch reads the per-session agent-guide file straight off disk,
// so that write must already be complete by the time applyHookAdapters
// runs. Splitting the I/O out would just move that ordering hazard onto
// every caller instead of keeping it as one documented invariant here.
import path from "node:path";
import type { HookMessageKind } from "./hook-protocol.js";
import { buildSessionEnv } from "./session-env.js";
import { applyShellIntegrationEnv } from "./shell-integration.js";
import { writeSessionAgentGuide } from "./agent-guide.js";
import {
  applyHookAdapters,
  getAdapterInitialPromptArgs,
  getAdapterResumeSessionArgs,
  resolveForwarderPath,
} from "./hook-adapters/index.js";
import { scopeUnitName } from "./session-process.js";

// Per-agent skip-permissions flag lookup. Anchored at the start of the
// trimmed command (optionally path-qualified), same conservative "no
// partial/substring match" posture as agent-detect.ts's KNOWN_AGENTS probing
// and the hook adapters' matches() regexen. Only matches unchained, simple
// invocations (no shell metacharacters) so the flag is never appended to the
// wrong part of a pipeline or chain.
/** Exported for the agents route to expose to the frontend (re-exported via
 * pty-manager.ts, this module's original home before PR 32's extraction). */
export const SKIP_PERMISSION_FLAGS: Record<string, string> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  opencode: "--auto",
  gemini: "--approval-mode yolo",
  agy: "--dangerously-skip-permissions",
  aider: "--yes",
};

/** Exported for tests (and re-exported via pty-manager.ts). */
export function getSkipPermissionFlag(command: string): string | null {
  const trimmed = command.trim();
  for (const [bin, flag] of Object.entries(SKIP_PERMISSION_FLAGS)) {
    if (new RegExp(`^(?:\\S*/)?${bin}(?:\\s|$)`).test(trimmed) && !/[;&|<>]/.test(trimmed)) {
      return flag;
    }
  }
  return null;
}

/**
 * The subset of Session's own fields buildLaunchPlan() needs. Deliberately a
 * plain object literal built by the caller (bootstrapMaster), not the
 * `Session` instance itself — keeps this module decoupled from Session's own
 * class shape/visibility and makes the seam's inputs explicit and greppable,
 * which is the whole point of extracting this in the first place.
 */
export interface LaunchPlanSession {
  readonly id: string;
  readonly cwd: string;
  readonly command: string;
  readonly socketPath: string;
  readonly hookToken: string;
  readonly hookSocketPath: string;
  readonly controlSocketPath: string;
  readonly sessionsDir: string;
  readonly reviewGateEnabled: boolean;
  readonly injectAgentGuide: boolean;
  readonly skipPermissions: boolean;
  readonly initialPrompt: string | undefined;
  /** Issue #678 — see HookAdapterContext.seedPrompt's own doc comment for
   * why this needs a spawn-time channel distinct from initialPrompt above
   * (a submitted turn) and distinct from stashSeed's live SessionStart hook
   * round trip (opencode has none). */
  readonly seedPrompt: string | undefined;
  /** Issue #271 follow-up — see CreateSessionOptions.resumeAgentSessionId's
   * own doc comment (pty-manager.ts). */
  readonly resumeAgentSessionId: string | undefined;
}

export interface LaunchPlan {
  /** `$SHELL` (or the "/bin/bash" fallback), resolved at plan-build time —
   * also the shell bootstrapMaster's dtach master runs `finalCommand`
   * under. */
  shell: string;
  /** The deterministic systemd --user scope unit name for this session —
   * needed by bootstrapMaster() both for the `-u` argv entry below (already
   * baked into `argv`) and for its own bootstrap-failure error message. */
  unitName: string;
  /** The fully scrubbed + augmented env the dtach master (and therefore the
   * launched agent process) should receive. */
  env: NodeJS.ProcessEnv;
  /** The exact argv to pass as `spawnChild("systemd-run", argv, ...)` —
   * everything after the `systemd-run` binary itself, including the trailing
   * `dtach -n <socketPath> <shell> -lc <finalCommand>` invocation. */
  argv: string[];
  /** Whether a hook adapter actually matched AND applied successfully — see
   * hook-adapters/index.ts's AppliedHooks.matched for the exact semantics.
   * Mirrors what bootstrapMaster used to assign directly to
   * `this.hooksActive`. */
  hooksActive: boolean;
  /** The matched adapter's static `emits` capability list (empty if none
   * matched). Mirrors what bootstrapMaster used to assign directly to
   * `this.hookEmits`. */
  hookEmits: readonly HookMessageKind[];
}

/**
 * Composes the argv/env for a session's dtach master launch — everything
 * `Session.bootstrapMaster()` (pty-manager.ts) used to compute inline before
 * PR 32's extraction: env scrub, shell-integration setup, the five
 * MULLION_* injections, agent-guide injection, hook-adapter wiring,
 * skip-permissions handling, and initial-prompt composition, in that exact
 * order. See this module's own top-of-file doc comment for why this isn't
 * a *pure* function despite doing pure composition work. Behavior-preserving
 * only: every step below reproduces bootstrapMaster's prior inline logic
 * unchanged, just relocated.
 */
export function buildLaunchPlan(session: LaunchPlanSession): LaunchPlan {
  const shell = process.env.SHELL || "/bin/bash";
  const unitName = scopeUnitName(session.id);
  // Strip this server's own Mullion config (PORT, DATABASE_URL,
  // SESSIONS_DIR, secrets, ...) before it reaches the session's shell — a
  // session must not inherit the identity of the process that spawned it,
  // e.g. a `make dev` run from inside this session must not see this
  // process's PORT/DATABASE_URL (issue #70). See session-env.ts.
  const sessionEnv = buildSessionEnv();
  // Issue: sidebar worktree display — injects the OSC 7 shell-integration
  // hook (ZDOTDIR shim for zsh, PROMPT_COMMAND for bash) so this session's
  // shell announces its cwd on every prompt draw, feeding Session.liveCwd.
  // A no-op for any other $SHELL — see shell-integration.ts.
  applyShellIntegrationEnv(shell, sessionEnv, session.sessionsDir);
  // Phase 2 (issue #172): injected AFTER the scrub above (not before), so
  // this session's own hook socket/token survive it — SERVER_ENV_KEYS lists
  // both purely so a *nested* Mullion re-scrubs them from ITS OWN sessions,
  // not so buildSessionEnv() strips them from this one. An agent that
  // ignores these two vars is completely unaffected: the socket exists but
  // nothing ever connects.
  sessionEnv.MULLION_HOOK_SOCKET = session.hookSocketPath;
  sessionEnv.MULLION_HOOK_TOKEN = session.hookToken;
  // Phase 4 (#134): lets the `mullion` CLI (src/cli/), run from inside this
  // session, find the control socket and default its own session targeting
  // to this session with no flags — same "injected after the scrub,
  // SERVER_ENV_KEYS lists it only so a nested Mullion re-scrubs it"
  // reasoning as the hook socket/token above. MULLION_SESSION_ID has no
  // other existing purpose to collide with (session-env.ts).
  sessionEnv.MULLION_SOCKET_PATH = session.controlSocketPath;
  sessionEnv.MULLION_SESSION_ID = session.id;
  // Phase 2 (issue #264): pass the review-gate toggle through the session
  // env so the forwarder (spawned as an agent hook subprocess) can read it
  // and conditionally skip the blocking review_gate for agents whose hook
  // is always registered (agy) rather than gated at registration time.
  sessionEnv.MULLION_REVIEW_GATE_ENABLED = String(session.reviewGateEnabled);

  // Issue #405 — writes this session's own copy of the shipped agent guide
  // doc (docs/agent-guide.md) to `<sessionsDir>/<id>.agent-guide.md`,
  // unconditionally (never gated on hook-adapter match below): every agent
  // benefits from having this on disk, even one with no hook adapter at
  // all. Not gated on `sessions.injectAgentGuide` either — that setting
  // only controls the pointer/injection to this file (both hooks.ts's
  // SessionStart reply and, per issue #437c below, opencode's
  // `instructions` config entry), not the file's own (cheap, harmless)
  // existence. See agent-guide.ts's own doc comment.
  //
  // Issue #437c — runs BEFORE applyHookAdapters: the opencode adapter's
  // prepareLaunch needs this file to already exist so it can point
  // `instructions` only at a copy it has confirmed is actually there, not
  // merely at the shipped SOURCE doc's existence (agentGuideSourceExists())
  // — those can diverge if this write itself fails (logged-and-swallowed,
  // e.g. a full disk or EACCES on sessionsDir), which for opencode would
  // otherwise leave a dangling `instructions` entry pointing at a file that
  // was never created, unlike every other agent where a stale pointer is
  // just harmless prose. No other adapter reads this file, so this
  // ordering changes nothing for Claude Code/Codex/agy.
  writeSessionAgentGuide(path.dirname(session.hookSocketPath), session.id);

  // Phase 2 (issue #174): if `session.command` matches a known agent with a
  // hook adapter (currently just Claude Code), rewrite the command/env for
  // this launch only — see hook-adapters/index.ts's applyHookAdapters for
  // the defensive-fallback behavior (any adapter failure launches the
  // original, unmodified command instead of failing the session outright).
  // `sessionsDir` is derived from hookSocketPath (`<sessionsDir>/hooks.sock`,
  // see PtyManager's constructor) rather than threaded through as its own
  // field, since this is the only place that needs it.
  const {
    command: launchCommand,
    envAdditions,
    matched,
    emits,
  } = applyHookAdapters(session.command, {
    sessionId: session.id,
    sessionsDir: path.dirname(session.hookSocketPath),
    hookSocketPath: session.hookSocketPath,
    hookToken: session.hookToken,
    controlSocketPath: session.controlSocketPath,
    forwarderPath: resolveForwarderPath(),
    reviewGateEnabled: session.reviewGateEnabled,
    injectAgentGuide: session.injectAgentGuide,
    cwd: session.cwd,
    skipPermissions: session.skipPermissions,
    seedPrompt: session.seedPrompt,
  });
  Object.assign(sessionEnv, envAdditions);

  // Issue: skip-permissions flag — if the caller requested it, append the
  // agent-specific flag (e.g. `--dangerously-skip-permissions`, `--auto`)
  // to the launch command. Done after the hook adapters so it never
  // interferes with hook config injection; the shell metacharacter guard
  // in getSkipPermissionFlag() ensures the flag lands only on a simple,
  // unchained invocation regardless.
  const withSkipPermissions = session.skipPermissions
    ? `${launchCommand} ${getSkipPermissionFlag(launchCommand) ?? ""}`.trimEnd()
    : launchCommand;

  // Issue #271 follow-up — resumes an existing agent-native session by id
  // (currently opencode's `--session <id>` only). Same "matched against the
  // ORIGINAL session.command, appended after commandTransform/skip-
  // permissions" reasoning as initialPromptArgs below. A no-op for an agent
  // with no `resumeSessionArgs`, or when no transfer was attempted/
  // succeeded (routes/sessions.ts's promote handler only ever sets this
  // once opencode-session-transfer.ts has actually imported the history —
  // never speculatively).
  //
  // NOT a "resume, then submit this as its next turn" pipeline, despite
  // the two being appended in sequence below — verified empirically
  // (hook-adapters/opencode.ts's own `resumeSessionArgs` comment) that
  // opencode's `--prompt` is silently ignored on ANY resumed session
  // (`--session` or `--continue`), so a trailing `initialPromptArgs` after
  // `resumeSessionArgs` would just be dropped, not delivered as a next
  // turn. `session.initialPrompt` is therefore always unset whenever
  // `resumeAgentSessionId` is set (routes/sessions.ts's promote handler
  // keeps the two mutually exclusive) — this composition only still runs
  // both blocks in the same function because a future agent adapter's
  // `resumeSessionArgs` might not share opencode's `--prompt` limitation.
  const resumeSessionArgs = session.resumeAgentSessionId
    ? getAdapterResumeSessionArgs(session.command, session.resumeAgentSessionId)
    : null;
  const withResume = resumeSessionArgs
    ? `${withSkipPermissions} ${resumeSessionArgs}`.trimEnd()
    : withSkipPermissions;

  // Task Master's initial-turn prompt (see CreateSessionOptions.
  // initialPrompt's own doc comment) — appended LAST, after both
  // applyHookAdapters' own commandTransform and the skip-permissions flag
  // above, so prompt text (arbitrary issue-body content, which routinely
  // contains `;`/`&`/`|`/etc) is never fed back through either of those
  // guards. Matched against `session.command` (the ORIGINAL, unmodified
  // command), same as applyHookAdapters/getAdapterEmits above — not
  // `launchCommand`, which may already have a commandTransform's flags
  // appended and would defeat the adapter's own conservative matches()
  // anchor. A no-op (returns null) for an agent with no initial-prompt
  // argv form, or when no prompt was requested.
  const initialPromptArgs = session.initialPrompt
    ? getAdapterInitialPromptArgs(session.command, session.initialPrompt)
    : null;
  const finalCommand = initialPromptArgs
    ? `${withResume} ${initialPromptArgs}`.trimEnd()
    : withResume;

  return {
    shell,
    unitName,
    env: sessionEnv,
    argv: [
      "--user",
      "--scope",
      "--collect",
      "-u",
      unitName,
      "--",
      "dtach",
      "-n",
      session.socketPath,
      shell,
      "-lc",
      finalCommand,
    ],
    hooksActive: matched,
    hookEmits: emits,
  };
}
