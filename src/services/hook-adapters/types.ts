// Phase 2 (issue #174) — the per-agent hook adapter framework. Different
// agents wire hook config in different ways (an ephemeral CLI flag, an
// ephemeral env var, a managed file write — see the plan's "Per-agent
// integration research" table), but the spawn seam in pty-manager.ts needs
// one uniform shape to call regardless of which agent it's launching. Each
// concrete adapter (claude-code.ts today; codex.ts/agy.ts/opencode.ts in
// follow-up PRs) implements this interface once and is registered in
// index.ts's ADAPTERS list — the spawn seam itself never special-cases an
// agent by name.

import type { HookMessageKind } from "../hook-protocol.js";

export interface HookAdapterContext {
  /** The session this launch belongs to — adapters that write per-session
   * config files (e.g. Claude Code's `<id>.hooks.json`) key filenames on
   * this so concurrent sessions never collide. */
  sessionId: string;
  /** Directory ephemeral per-session hook config should be written under —
   * same directory as the dtach sockets and the shared hooks.sock listener
   * (PtyManager.sessionsDir), never the agent's own real config dir. */
  sessionsDir: string;
  /** This session's shared-socket connection path (MULLION_HOOK_SOCKET). */
  hookSocketPath: string;
  /** This session's handshake secret (MULLION_HOOK_TOKEN). */
  hookToken: string;
  /** This session's control-socket path (MULLION_SOCKET_PATH) — Claude
   * Code's adapter injects this into the auto-registered `mullion` MCP
   * server's config (buildClaudeMcpConfig) so its session/project/preview
   * tools (src/mcp/tools.mjs, #134 part 2) can find the socket. */
  controlSocketPath: string;
  /** Absolute path to the shared forwarder script every shell-command-hook
   * adapter's generated config invokes — see hook-adapters/shared.ts. */
  forwarderPath: string;
  /** Whether the blocking review-gate hook (Claude Code's `PreToolUse` on
   * Bash, issue #178) should be registered — mirrors
   * app.config.MULLION_REVIEW_GATE_ENABLED, default off (see env.ts). When
   * `false`, an adapter must not register any *blocking* gate hook; the
   * observational fire-and-forget hooks (Notification/Stop/PostToolUse) are
   * unaffected by this flag and are always registered regardless. */
  reviewGateEnabled: boolean;
  /** Mirrors the live `sessions.injectAgentGuide` setting (default on, see
   * settings.ts) at the moment THIS session is spawned. Every other
   * consumer of this setting (hooks.ts's session_start branch) re-reads it
   * fresh on every hook fire, live; an adapter has no equivalent live round
   * trip to re-check against, so this is necessarily a spawn-time snapshot
   * — a toggle after this session starts won't retroactively affect it.
   * Issue #437c (opencode) is the first and, by construction, only adapter
   * that can use this: every other agent's guide pointer is gated inside
   * hooks.ts itself, not here, because their SessionStart is a live hook
   * round trip this context has no equivalent of. */
  injectAgentGuide: boolean;
  /** Same spawn-time-snapshot caveat as `injectAgentGuide` immediately
   * above, for the same reason: opencode's adapter has no live hook round
   * trip to re-check `sessions.injectProjectBriefing` against, so this is a
   * snapshot taken at spawn time. Mirrors that setting, not
   * `injectAgentGuide` — a project's own briefing and Mullion's guide are
   * gated independently (see settings.ts's own comment on why they're
   * separate keys). */
  injectProjectBriefing: boolean;
  /** This session's working directory. Optional — only agy's adapter reads
   * it today (to pre-trust a fresh worktree, see agy.ts's
   * mergeAgyTrustedWorkspace), so it's not required on every ctx literal
   * the other three adapters' tests already construct. */
  cwd?: string;
  /** Mirrors this session's own `skipPermissions` spawn option (the same
   * flag pty-manager.ts uses to decide whether to append
   * `--dangerously-skip-permissions`/`--auto`/etc — see
   * getSkipPermissionFlag()). Optional for the same reason as `cwd` above.
   * agy's adapter uses this to decide whether pre-trusting `cwd` is in
   * scope: a caller that already asked to skip every tool-permission
   * prompt has opted into "unattended, don't stop me," which is exactly
   * the posture a pre-trusted folder matches — a manual launch with this
   * off (the default) still sees agy's folder-trust prompt, unchanged. */
  skipPermissions?: boolean;
  /** Issue #678 — the promote flow's seed prompt (POST
   * /api/sessions/:id/promote's `seedPrompt` body field), threaded all the
   * way from session-lifecycle.ts's createSessionRecord through spawn() so
   * an adapter with no live hook round trip (opencode — see that file's own
   * header) has a spawn-time channel to inject it, the same way
   * `injectAgentGuide` above exists for opencode's agent-guide pointer.
   * Every other adapter ignores this field entirely: their SessionStart is
   * a live hook round trip (hooks.ts's "session_start" branch,
   * app.pty.consumeSeed) that delivers the seed independently of this
   * context. Gated INDEPENDENTLY of `injectAgentGuide` wherever it's
   * consumed — a user-supplied promote seed must not vanish just because
   * someone disabled the unrelated guide-injection setting. */
  seedPrompt?: string;
}

export interface HookLaunchPlan {
  /** Extra environment variables to merge into the session's env (e.g.
   * Codex's `CODEX_HOME` pointing at a scratch dir). Merged in addition to,
   * never in place of, MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN. */
  envAdditions?: Record<string, string>;
  /** Ephemeral per-session config files to write before spawn — `path` is
   * absolute, `contents` is written verbatim. Always written under
   * `ctx.sessionsDir`, never the agent's own real config location (that's
   * what `managedInstall` below is for, when there's no ephemeral option). */
  settingsFiles?: Array<{ path: string; contents: string }>;
  /** Rewrites the command line actually spawned, given the original command.
   * The ONE deliberate, narrow exception to "the backend never parses a
   * shell command line" (see CLAUDE.md and the plan's Context section) —
   * only Claude Code's adapter uses this, to append `--settings <path>`.
   * Absent for every other agent. */
  commandTransform?: (command: string) => string;
  /** An idempotent, Mullion-owned write into the agent's OWN real config
   * location, for agents with no ephemeral injection path at all (agy,
   * OpenCode — see follow-up PRs). Must be safe to call on every launch:
   * no-op if the content Mullion would write already matches. Absent for
   * agents that don't need it (Claude Code, Codex). */
  managedInstall?: () => Promise<void> | void;
}

export interface HookAgentAdapter {
  /** Short, stable identifier — also the `<agent>` argv the shared forwarder
   * receives (see src/hooks/forwarder.mjs), e.g. "claude-code". */
  name: string;
  /** Conservative program-token match against the (untouched) command about
   * to be spawned — same posture as agent-detect.ts's KNOWN_AGENTS list:
   * anchored, no partial/substring matches, and (for adapters that go on to
   * rewrite the command) no shell metacharacters anywhere in it, so a
   * transform never misattaches to the wrong part of a chained command. */
  matches(command: string): boolean;
  /** Builds this launch's plan. Pure aside from what it returns — actually
   * writing settingsFiles/running managedInstall is the caller's job (see
   * applyHookAdapters in index.ts), so this stays easy to unit test. */
  prepareLaunch(ctx: HookAdapterContext): HookLaunchPlan;
  /** Issue: extend surfaced session statuses — the hook-protocol `kind`s
   * this agent's registered hooks/plugin events can ever produce, for
   * whichever launch configuration is always active regardless of runtime
   * flags (a conditionally-registered hook like Claude Code's blocking
   * review gate is deliberately excluded — see CLAUDE_CODE_EMITS's own doc
   * comment). Exposed via GET /api/agents so the frontend can hide status
   * legend entries/filters a given agent can never reach. A parity test
   * (forwarder-core.test.ts for the three shell-hook adapters;
   * opencode-plugin.test.ts for OpenCode's own event-bus mapper) asserts
   * every event this adapter actually registers maps to a kind inside this
   * list. */
  emits: readonly HookMessageKind[];
  /** Builds the argv suffix that starts this agent with `prompt` as its
   * initial turn (e.g. Claude Code/Codex: the prompt as a shell-quoted
   * positional; agy: `-i <prompt>`; opencode: `--prompt <prompt>`, verified
   * to actually submit a turn rather than just pre-fill the input — see
   * opencode.ts's own comment), for Task Master's unattended worker/
   * review-agent spawns (see task-claim.ts, task-reconciler.ts) and for
   * routes/sessions.ts's promote handler. Pure, no I/O — same posture as
   * `matches()`/`prepareLaunch()`. Absent for agents with no initial-prompt
   * argv at all (currently `aider`/`gemini`/`pi`, none of which have an
   * adapter) or none wired yet; the caller (hook-adapters/index.ts's
   * getAdapterInitialPromptArgs) treats a missing function the same as
   * "this agent can't receive an initial prompt this way." NOT gated on
   * `session_start` being among `emits` — opencode has this field but never
   * emits `session_start` (no live hook round trip at all, see opencode.ts's
   * header), so that emit is not a reliable proxy for this capability.
   * Deliberately NOT part of
   * `HookLaunchPlan`: `prepareLaunch`'s `ctx` has no task/prompt context, and
   * this needs to be called per-spawn with a prompt that varies per task,
   * not once per adapter registration. The returned string is appended to
   * the already-built command line (pty-manager.ts), after hook-adapter
   * `commandTransform` and after the skip-permissions flag — never fed back
   * through `matches()` or any other command-line parser, so prompt text
   * containing shell metacharacters can never confuse those. */
  initialPromptArgs?(prompt: string): string;
  /** Issue #271 follow-up — builds the argv suffix that resumes an EXISTING
   * agent-native session by id, for routes/sessions.ts's promote handler
   * once opencode-session-transfer.ts has imported the source session's
   * conversation history into the new worktree. Currently opencode-only
   * (`--session <id>`, verified empirically to run subsequent tool calls
   * with cwd = the directory opencode was invoked in, not the transferred
   * session's original directory — see opencode-session-transfer.ts's own
   * doc comment for the full empirical spike this rests on). Claude Code's
   * `~/.claude/projects/` keys sessions by literal cwd, so it has no
   * equivalent resume-by-id concept to implement this for. Same "pure, no
   * I/O, appended last" posture as `initialPromptArgs` above — when both are
   * present for a launch, `--session <id>` is appended first so a following
   * `--prompt <text>` is unambiguously the resumed session's next turn, not
   * a fresh one. */
  resumeSessionArgs?(agentSessionId: string): string;
}
