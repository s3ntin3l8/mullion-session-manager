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
  /** The resolved value of `sessions.injectAgentGuide` (default on, see
   * settings.ts), possibly overridden per-project (issue #884), AT THE
   * MOMENT THIS SESSION IS SPAWNED — an adapter has no live hook round trip
   * to re-check against, so this is necessarily a spawn-time snapshot, a
   * toggle after this session starts won't retroactively affect it. Issue
   * #437c (opencode) is the first and, by construction, only ADAPTER that
   * can use this — every other agent's guide pointer is gated inside
   * hooks.ts itself, not here, because their SessionStart is a live hook
   * round trip this context has no equivalent of. Issue #884 WEAKENED, not
   * worsened, that distinction: hooks.ts's session_start branch used to
   * re-derive the (global-only) setting fresh on every hook fire; it now
   * reads this SAME spawn-time-resolved value straight off the Session
   * object (`app.pty.get(sessionId)?.injectAgentGuide`) instead, since only
   * a value resolved on the primary and threaded through the spawn body
   * can ever reflect a per-project override on a multi-host agent role
   * (which has no settings DB of its own to read at all). Every consumer of
   * this setting is now spawn-time-snapshotted, not just opencode's. */
  injectAgentGuide: boolean;
  /** Same spawn-time-snapshot posture and issue #884 history as
   * `injectAgentGuide` immediately above, for the independent
   * `sessions.injectProjectBriefing` setting. Mirrors that setting, not
   * `injectAgentGuide` — a project's own briefing and Mullion's guide are
   * gated independently (see settings.ts's own comment on why they're
   * separate keys). */
  injectProjectBriefing: boolean;
  /** Mirrors the live `sessions.injectMullionBundle` setting (default on,
   * see settings.ts) at the moment THIS session is spawned — same
   * spawn-time-snapshot posture as `injectAgentGuide`/`injectProjectBriefing`
   * above, and governed as its own independent key for the same reason: it
   * gates a fundamentally different mechanism (Claude Code's `--plugin-dir`,
   * not a SessionStart injection any adapter has a live round trip for).
   * Unlike those two settings, this one gates the WHOLE delivery mechanism,
   * not just a pointer — a plugin-sourced Claude Code skill is invisible to
   * Mullion's own Skills Manager (`skills.ts`'s `listInstalledClaudePluginDirs`
   * never sees a session-only `--plugin-dir` bundle, and plugin-sourced
   * skills are a hard no-op for `skillOverrides` — see that file's header),
   * so there is no separate per-skill toggle to reconcile this with.
   *
   * Issue #941 — this same flag NOW ALSO gates a second, HOST-LEVEL
   * mechanism that has nothing to do with any individual session:
   * bundle-sync.ts's boot-time sync, which installs (or, when this setting
   * is off, removes) the shipped bundle globally for all four CLIs. Read
   * directly off the settings row by plugins/bundle-sync.ts, not threaded
   * through this per-session context at all (there is no "session" at boot
   * time) — documented here anyway so a reader of this field doesn't
   * assume its scope is still purely per-session. See claude-code.ts's and
   * opencode.ts's own `isBundleSyncedFor` checks for how the two
   * mechanisms now compose: this field still gates whether a per-session
   * pointer to the shipped bundle is emitted at all, but when the
   * host-level sync already covers a given CLI, the per-session pointer
   * for the plain shipped-bundle case is skipped as redundant. */
  injectMullionBundle: boolean;
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
  /** Issue #949 — mirrors `isAuthEnabled(app.config)`, a boot-time constant
   * (same category as pty-manager.ts's own `sshAuthSock` field — read once
   * at process start, never re-derived per session) needed by opencode's
   * adapter to build its own tier-0 push (buildAgentGuideBlock,
   * agent-guide.ts) the same way hooks.ts's SessionStart reply already
   * does for Claude Code/Codex/agy. Optional for the same reason as `cwd`/
   * `skipPermissions` above: opencode's adapter is the only consumer, so
   * this isn't required on every ctx literal the other three adapters' own
   * tests already construct. */
  authEnabled?: boolean;
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
  /** PR-5 (per-project skills/reviewer) — the project's own DB-authored
   * skill content (project_tooling.skill, schema.ts), resolved on the
   * primary and threaded through the spawn body exactly the way
   * `briefingOverride` already is (session-lifecycle.ts's createSessionRecord
   * is the producer for both, and PtyManager.getOrCreate/buildLaunchPlan the
   * same pass-through) — see briefingOverride's own multi-host reasoning,
   * which applies identically here. Raw SKILL.md content (YAML frontmatter +
   * body); consumed by claude-code.ts's prepareLaunch (composed into a
   * per-session --plugin-dir bundle, hook-adapters/mullion-bundle.ts's
   * composeClaudeSessionBundle) and opencode.ts's prepareLaunch (written
   * under the ephemeral OPENCODE_CONFIG_DIR and added to `skills.paths`).
   * Undefined/absent for codex and agy — neither has an ephemeral overlay
   * for project-scoped skills (see the plan's per-CLI coverage table; PR-6
   * is the repo-write fallback for those two). For agy specifically this is
   * confirmed, not assumed — see the live spike on issue #943 (2026-09-05):
   * agy discovers neither shape of a project-scope agent file, with or
   * without `--add-dir`; there is also no host-global fallback that fits
   * this DB-stored, live-editable content, since a host-global write would
   * leak one project's content into every other repo on the host and get
   * deleted by the next unrelated agy launch (`installBundleSkills`'s prune
   * pass) — see #1083. */
  projectSkill?: string;
  /** PR-5 — the project's own DB-authored reviewer subagent content
   * (project_tooling.reviewerAgent, schema.ts), same spawn-time-resolved,
   * multi-host-correct channel as `projectSkill` immediately above. Stored
   * and threaded in Claude Code's OWN subagent frontmatter shape (`name`/
   * `description`/`tools`/`model`); claude-code.ts writes it through
   * unchanged into the composed bundle's `agents/` dir, while opencode.ts
   * MUST translate it first (mullion-bundle.ts's
   * deriveOpenCodeReviewerAgentFile — see that function's own doc comment
   * for why writing this shape verbatim into opencode's config hard-fails
   * the whole session, not just that one skill). Undefined/absent for codex
   * and agy — for agy this is an empirically confirmed dead end (issue
   * #943's 2026-09-05 spike), not an assumption pending confirmation; see
   * `projectSkill`'s doc comment above for the full reasoning, which
   * applies identically here. */
  projectReviewerAgent?: string;
  /** Issue #957 — the resolved opencode model the session is configured
   * to use, threaded from createSessionRecord (where resolveOpenCodeModel
   * has already run) all the way to the opencode adapter's prepareLaunch,
   * which lands it in OPENCODE_CONFIG_CONTENT.model. `undefined` for
   * any non-opencode adapter and for an opencode session with no model
   * resolution anywhere (opencode's own fallback then runs). The opencode
   * adapter is the only consumer; every other adapter ignores this
   * field, same posture as `seedPrompt`/`projectSkill`/etc. */
  model?: string;
  /** Issue #958 — same threading posture as `model` above, but for
   * opencode's `small_model` config key (used for lightweight tasks).
   * Lands in OPENCODE_CONFIG_CONTENT.small_model. */
  smallModel?: string;
  /** Set ONLY for sessions spawned by Mullion's Task Master (worker, review
   * agent, retry, reject/auto-return re-seed — see task-claim.ts and
   * task-reconciler.ts's spawn sites). A positive value signals "this
   * session is an unattended Task Master agent," which the opencode adapter
   * uses to deny the superpowers skills that gate on a human in the loop
   * (brainstorming / writing-plans / finishing-a-development-branch —
   * verified failing in #66/#67, branchdam-mobile). Spawn-time-only: not
   * persisted on the sessions row, so a `getOrCreate()` reattach of a
   * already-live session sees `undefined` here, which is correct (the
   * opencode config was set when the session was first spawned; a reattach
   * never re-applies it). Absent for every other session kind — manual
   * launches, dock controls, the promote flow's resumed target. */
  taskId?: number;
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
