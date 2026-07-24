// Phase 2 (issue #174) — the per-agent hook adapter framework. Different
// agents wire hook config in different ways (an ephemeral CLI flag, an
// ephemeral env var, a managed file write — see the plan's "Per-agent
// integration research" table), but the spawn seam in pty-manager.ts needs
// one uniform shape to call regardless of which agent it's launching. Each
// concrete adapter (claude-code.ts today; codex.ts/agy.ts/opencode.ts in
// follow-up PRs) implements this interface once and is registered in
// index.ts's ADAPTERS list — the spawn seam itself never special-cases an
// agent by name.

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
}
