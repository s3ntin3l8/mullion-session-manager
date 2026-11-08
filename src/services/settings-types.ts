// The shape of the server-persisted Settings blob (`AppSettings`) and the
// log-level vocabulary. Split out of settings.ts so runtime-config.ts can read
// the shape without importing settings.ts (which imports runtime-config.ts's
// resolvers) — see issue #2715. settings.ts re-exports everything here, so
// every existing importer keeps its path. Types only: no defaults, no logic.
import type { CacheDirId } from "./cache-storage.js";
import type {
  Theme,
  CursorStyle,
  SidebarDensity,
  SoundName,
  LayoutMode,
  TabletPaneCap,
} from "../shared/types.js";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppSettings {
  theme: Theme;
  terminal: {
    fontFamily: string;
    fontSize: number;
    // Inner inset (px) between the dockview panel edge and the rendered
    // terminal content, applied on all four sides — see frontend/src/api.ts's
    // matching field for the full rationale (issue #91).
    padding: number;
    colorScheme: string;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    scrollback: number;
    copyOnSelect: boolean;
    pasteOnRightClick: boolean;
    // Honors OSC 52 clipboard-write requests from the foreground program
    // (Claude Code / opencode both copy this way — xterm.js core has no
    // built-in OSC 52 handler, so without this the escape sequence is
    // silently dropped and the CLI's own "copied" toast is a lie). Default
    // on to match expected copy behavior; off lets a security-conscious user
    // deny any PTY-run program the ability to silently overwrite their
    // system clipboard (a paste-swap vector). OSC 52 *read* queries are
    // never answered regardless of this setting — see TerminalPane.tsx.
    clipboardWrite: boolean;
    reconnect: {
      enabled: boolean;
      maxAttempts: number;
    };
    keyCapture: {
      ctrlR: boolean;
      ctrlL: boolean;
      ctrlK: boolean;
    };
    // Opt-in clipboard chords (issue #67 follow-up). Unlike keyCapture above
    // — which takes a key AWAY from the browser and gives it to the terminal
    // — these take a key away from the TERMINAL program: Ctrl+V collides with
    // vim's Visual Block mode and readline's quoted-insert (both raw 0x16),
    // and Ctrl+C is SIGINT. Both default off; the always-on baseline
    // (Ctrl+Insert/Shift+Insert/Cmd+C/Cmd+V) already covers copy/paste
    // without this tradeoff — see TerminalPane.tsx's attachKeyConflictHandler.
    clipboardKeys: {
      ctrlV: boolean;
      ctrlC: boolean;
    };
    // Voice dictation (push-to-talk) — see frontend/src/voice/ and
    // TerminalPane.tsx's VoiceMicButton. Browser-only feature (Web Speech
    // API); nothing here reaches this backend beyond persisting the toggle.
    voice: {
      // Shows the mic button and, when hotkeyEnabled is also true, arms the
      // desktop chord below. Off hides the button entirely, same as an
      // unsupported browser (frontend/src/voice/support.ts).
      enabled: boolean;
      // Independent of `enabled` above so a user can keep the button but
      // opt out of the desktop chord specifically — see terminalKeys.ts's
      // getVoiceChord getter.
      hotkeyEnabled: boolean;
      // BCP-47 tag (e.g. "en-US"), or "" to fall back to navigator.language
      // at dictation start. A free string like fontFamily above — no
      // enum/leaf-union in shared/types.ts, and sanitizeSettings below
      // doesn't validate it for the same reason fontFamily isn't validated
      // there: an unrecognized tag is the Web Speech engine's own problem
      // to reject or fall back on, not this backend's to police.
      lang: string;
      // The push-to-talk chord, a frontend/src/lib/keyChord.ts-parseable
      // string (e.g. "Ctrl+Shift+Space", the default — kept as the default
      // despite colliding with 1Password's Quick Access default on
      // Windows/Linux, #1119: it's still the most natural push-to-talk
      // chord, free in every browser/shell/TUI and on macOS, and now
      // user-rebindable). A free string for the same reason `lang` above is
      // one: an unparseable value is keyChord.ts's own fallback-to-default
      // problem, not this backend's to police.
      hotkey: string;
    };
  };
  sidebarDensity: SidebarDensity;
  // Tablet tier plan, PR 4 — "auto" resolves from live window width
  // (frontend); see shared/types.ts's own doc comment on LayoutMode for the
  // full rationale. tabletPaneCap only takes effect once the resolved tier
  // is "tablet" — a lower cap keeps each column comfortably clear of PR 2's
  // TerminalPane font-shrink threshold, a higher one trades that off for
  // more visible panes; see AppearanceSection.tsx's Settings copy.
  layoutMode: LayoutMode;
  tabletPaneCap: TabletPaneCap;
  // Dragging a panel onto a pane's edge makes dockview halve only the target
  // (50/25/25 for a third pane); when on, the frontend evens out that row or
  // column afterwards, as the split buttons already do.
  balancePanesOnDrop: boolean;
  // Editable project-scan roots (Settings -> Projects & discovery). Empty
  // array = "use the PROJECTS_ROOTS env var" (see routes/projects.ts) —
  // this lets a fresh deploy keep working from its env config until someone
  // actually edits roots from the UI, at which point the DB value wins.
  projectRoots: string[];
  // Issue #2090 — OPT-IN (default off): when a host comes online, map each
  // project onto it automatically if the host has exactly ONE clone whose
  // `origin` matches the project's (never overwriting an entry, never a host
  // the operator declined). Off by default because `hostCwds` is also where
  // session-scoped children may be sent. Settings -> Projects & discovery.
  autoDetectHostCheckouts: boolean;
  // Folders OUTSIDE any project the file viewer may open read-only (an agent
  // CLI's plan/artifact dirs, e.g. ~/.claude/plans). Absolute or `~/`-prefixed
  // directory prefixes; keep them narrow — never a whole CLI dot-dir, which
  // holds credentials next to the plans. See readExternalFile.
  externalReadRoots: string[];
  // Settings -> Server -> Disk cleanup (issue #1606): which allowlisted
  // ~/.cache subtrees the aggressive cleanup may empty. Empty = none; opt-in
  // because they're slow to re-download (Playwright browsers, HF models).
  diskCleanup: {
    cacheDirs: CacheDirId[];
  };
  launchers: {
    defaultShell: string;
    defaultAgent: string;
    hiddenAgents: string[];
    skipPermissionsAgents: string[];
  };
  notifications: {
    channels: {
      browser: boolean;
      sound: boolean;
      // #95 — web push delivery (push-delivery.ts), gated the same way
      // browser/sound already are: per-status via notificationMatrix.notify
      // below, this toggle is the channel-level on/off on top of that.
      push: boolean;
    };
    soundName: SoundName;
    idleThresholdSeconds: number;
    // #98/#168 (frontend PR) — auto-bring-into-focus on an attention
    // transition, read by frontend/src/App.tsx only; this backend never
    // acts on it. Added here (rather than left frontend-only) because
    // deepMerge below only ever merges keys this interface already knows
    // about — a field missing from here would silently fail to persist
    // across a PATCH /api/settings + reload round-trip, defeating the
    // point of a Settings toggle. Mechanical mirror of frontend/src/api.ts's
    // matching field; see that file for the default-off rationale. Combined
    // with `notificationMatrix`'s own `autoFocus` column (both must be true
    // for a given status to auto-focus) — see App.tsx.
    autoFocusOnAttention: boolean;
    /** Per-status notification matrix. Rows = status keys, columns =
     * notify/sound/autoFocus. Seeded from DEFAULT_SETTINGS on first read;
     * deepMerge preserves user overrides. Replaces the old flat
     * attentionAlerts/exitedAlerts/finishedAlerts toggles (issue #318) — see
     * frontend/src/sessionStatus.ts's STATUS_PRESENTATION.defaultNotify for
     * the per-status rationale these defaults mirror (e.g. `finished`
     * defaults to notify:false since a turn completing is by far the
     * highest-frequency notifiable event in the system). */
    notificationMatrix: Record<string, { notify: boolean; sound: boolean; autoFocus: boolean }>;
  };
  dock: {
    /** Default for per-control worktreeRefresh when the control itself
     * doesn't specify one. When true, a worktree created for a dock monitor
     * is periodically synced to the branch's latest commit. */
    defaultWorktreeRefresh: boolean;
    /** Issue #404 — whether a plain (non-dock) session's detected dev
     * server (src/services/dev-server-detect.ts's parseDevServerPort, run
     * periodically by src/plugins/pty.ts's dedicated timer — see
     * PtyManager.sweepDevServerDetection) surfaces as a "dev_server_detected"
     * notification the user can accept or dismiss. "ask" (default) shows
     * the notification; "off" disables the background scan entirely for
     * every plain session. Deliberately NOT a three-way "ask"/"off"/"always"
     * enum: an "always" value that silently rewrites a project's
     * devServerUrl from PTY output with no human confirmation would be
     * genuinely surprising, unlike surfacing it as a notification — the
     * exact same inline detection already exists today as a one-time
     * prefill suggestion in frontend/src/CreateProjectModal.tsx ("Detected
     * dev server on port N — use it?"), so this is not novel behavior. */
    autoDetectDevServer: "ask" | "off";
    /** Issue #73 — whether GET /api/projects/:id/dock merges in
     * auto-discovered Docker Compose services (docker-service-detect.ts)
     * alongside dock.json's configured controls. Default true: this is a
     * visibility kill-switch, not the safety gate — a discovered control
     * still never auto-starts (same as any other dock control), so leaving
     * it on by default doesn't change the dock's "never starts a monitor
     * without a click" invariant. */
    dockerServices: boolean;
    /** Issue #73 follow-up (PR #857's plan) — whether a discovered Docker
     * monitor with no matching session (control.docker.state === "running")
     * has its log stream started automatically, instead of requiring a
     * manual header click. Default false: unlike dockerServices above, this
     * DOES change the "never starts a monitor without a click" invariant
     * (deliberately, opt-in only) — and each auto-attached stream is one
     * more PTY session per running container per visible column, a real
     * resource cost the default shouldn't impose silently. */
    autoAttachDockerLogs: boolean;
  };
  sessions: {
    // Tokens: {agent} {project} {n} — expanded client-side at launch time
    // (see frontend/src/CommandPalette.tsx).
    namePattern: string;
    confirmBeforeKill: boolean;
    hideEndedSessions: boolean;
    // #9 — a task-owned session (worker/review/rebase) is hidden from the
    // sidebar by default, same as any other decluttering toggle here; a
    // "killed" one is already filtered out unconditionally regardless of
    // this setting (see Sidebar.tsx's own filter — that's a status check
    // that runs first, not this preference). Off by default so the sidebar
    // stays focused on sessions a human is more likely to want to glance at
    // or attach to directly.
    showTaskSessions: boolean;
    reconcileIntervalSeconds: number;
    // Rich statuses — a session's `errorState` (api_error/tool_failure) is
    // otherwise cleared only by the next progress/turn_start hook, a genuine
    // keystroke (see write()'s doc comment in pty-manager.ts), a respawn, or
    // the session dying (see session-status.ts's precedence comment). This
    // is the narrow TTL backstop from that plan: swept alongside the
    // existing exited-session reconciliation, on the same interval, so an
    // error whose resolving hook never fires doesn't stick forever. Issue
    // #320 extends this same TTL to the blocked latches (permissionState,
    // planState, gateState, promoteState, elicitationState) — swept by the
    // same timer via sweepStaleStates(). The busy latches (compactState,
    // subagentCount) use staleBusySeconds below instead: a long compaction
    // or a long-running subagent is legitimate, ongoing work, not evidence
    // something silently failed, so it needs a longer backstop than an
    // unresolved error/permission prompt does.
    staleErrorSeconds: number;
    // Same backstop as staleErrorSeconds, but for compactState/subagentCount
    // (issue #320 follow-up) — kept separate and longer-default so a
    // genuinely long compaction or subagent run isn't degraded out from
    // under a still-busy session just because it ran past the much shorter
    // error/permission TTL.
    staleBusySeconds: number;
    // How often the background git-fetcher runs for autoFetch-enabled projects
    // (src/plugins/git-fetcher.ts). 0 disables auto-fetch entirely.
    gitAutoFetchIntervalSeconds: number;
    // Issue #213 (roadmap 4.7) — opt-in persistence of notification events
    // (src/plugins/event-store.ts) to the new `session_events` table. Default
    // off, matching Phase 1's in-memory-only event model (docs/roadmap.md).
    // Covers every enrolled host, not just this process's own — toggling
    // this also opens/closes remote-event-subscriber.ts's per-host
    // subscriptions (see event-store.ts's own doc comment).
    eventPersistence: boolean;
    // Age (in days) past which persisted session_events rows are swept by
    // src/plugins/event-store.ts's retention sweep. 0 = unlimited/no sweep,
    // same "0 disables" convention as gitAutoFetchIntervalSeconds above.
    eventRetentionDays: number;
    // Issue #213's own body asked for "max events per session, max age, or
    // unlimited" — only max-age (above) shipped in the original PR (#421).
    // This is the missing count-based bound: per session, the sweep keeps
    // only the newest N session_events rows and deletes the rest. 0 =
    // unlimited/no sweep, same convention as eventRetentionDays. Orphaned
    // rows (sessionId: null, onDelete: "set null") have no session to count
    // against and are excluded from this sweep — eventRetentionDays is the
    // only thing that bounds them.
    eventRetentionPerSession: number;
    // Issue #405 — gates ONLY the SessionStart auto-inject pointer to the
    // per-session agent guide copy (src/plugins/hooks.ts); it never gates
    // whether that per-session file itself gets written
    // (Session.bootstrapMaster() -> writeSessionAgentGuide(), always
    // unconditional — see agent-guide.ts). Default true: a few lines of
    // pointer text is cheap, and the whole point of the feature is
    // discovery. Affects all four agents, just via two different
    // mechanisms: forwarder-core.mjs's formatSessionStartOutput produces a
    // real hookSpecificOutput/injectSteps reply for claude-code, codex, and
    // agy (opencode's forwarder invocation hits its `default:` case and
    // drops the reply); opencode instead reads this same setting via
    // ctx.injectAgentGuide in hook-adapters/opencode.ts's prepareLaunch,
    // which points its `instructions` config at the per-session copy
    // (issue #437c) — the guide's full text, not a pointer sentence.
    injectAgentGuide: boolean;
    // agent-briefing follow-up to #405, redesigned by #942 — gates the
    // SessionStart injection of a PROJECT's own pinned note (a short,
    // DB-authored, always-additive note — never a competing alternate to
    // AGENTS.md, which every CLI already reads natively — written
    // per-session by writeSessionBriefing, see project-briefing.ts),
    // independently of injectAgentGuide above. Kept
    // as its own key rather than folded into injectAgentGuide: that key's
    // meaning is already shipped and test-asserted narrow ("gates the
    // pointer to Mullion's own per-session GUIDE copy" — see this field's
    // own test coverage), so reusing it would silently let muting Mullion's
    // doc also mute a project's operating instructions. Same
    // unconditional-write / gate-only-the-injection contract as
    // injectAgentGuide: the per-session copy is always written at spawn
    // time regardless of this setting.
    injectProjectBriefing: boolean;
    // Issue: Mullion's own agent-facing tooling only reached an agent when
    // the session's cwd happened to be Mullion's own checkout. Gates
    // whether Claude Code's launch command gets `--plugin-dir` pointed at
    // the shipped bundle (src/bundle/ — see hook-adapters/mullion-bundle.ts
    // and claude-code.ts's commandTransform), independently of
    // injectAgentGuide/injectProjectBriefing above: this gates the WHOLE
    // delivery mechanism for a fundamentally different kind of content
    // (Mullion-owned skills/subagents/commands via a CLI flag), not a
    // SessionStart text injection. Default true, same "cheap and the point
    // is discovery" reasoning as injectAgentGuide. A plugin-sourced Claude
    // Code skill has no per-skill toggle of its own (see types.ts's
    // `injectMullionBundle` doc comment) — this setting IS the toggle.
    //
    // Issue #941 — also gates plugins/bundle-sync.ts's boot-time, host-level
    // sync of the shipped bundle into all four CLIs' global config roots
    // (on = syncBundleContent(), off = removeBundleContent()), independently
    // of any individual session. Per-session delivery (this setting's
    // original scope) and host-level sync are two mechanisms this one flag
    // now controls together — see types.ts's `injectMullionBundle` doc
    // comment for how claude-code.ts/opencode.ts reconcile the two once the
    // host-level sync has covered a given CLI.
    injectMullionBundle: boolean;
    // Issue #937 — a single, install-wide, free-text "how we work" policy
    // (branching, merge strategy, review process, ... — see
    // workflow-conventions.ts's WORKFLOW_CONVENTION_QUESTIONS for the
    // starter axes), injected into `additionalContext` for every session
    // whose project hasn't opted out (projects.injectWorkflowConventions,
    // schema.ts). Deliberately NOT written into the user's own global CLI
    // config files (~/.claude/CLAUDE.md etc.) — those are the user's own,
    // used identically with or without Mullion; this is Mullion's own
    // opinionated default for Mullion-orchestrated work specifically, kept
    // in its own lane. Default "": an empty value is its own independent
    // "nothing to inject" gate (see session-lifecycle.ts's
    // createSessionRecord and writeSessionWorkflowConventions's own doc
    // comment) — distinct from injectAgentGuide/injectProjectBriefing
    // above, which default to `true` because THEY gate a boolean, not a
    // value. Populated by the structured wizard
    // (buildWorkflowConventionsText) rather than hand-typed from a blank
    // starter template, but ordinary free text from that point on.
    workflowConventionsText: string;
    // Issue #1203 (Phase 2 of the follow-up plan) — before this field
    // existed, the wizard was a one-shot:
    // WorkflowConventionsWizardModal.tsx's own header comment used to say
    // "re-opening this modal always starts from a blank slate," so changing
    // a single answer meant re-answering every question and silently
    // discarding any hand-edits already made to `workflowConventionsText`
    // above. Stored alongside the text (same `PATCH /api/settings` call,
    // same `sessions` group) so the modal can pre-fill and open on a review
    // step when every question is already answered.
    //
    // Default: every CURRENT `WORKFLOW_CONVENTION_QUESTIONS` id mapped to
    // `""`, never a bare `{}` — see DEFAULT_SETTINGS's own construction of
    // this field (deepMerge below only ever touches a patch key that
    // already exists on `base`, so a `{}` default would make the wizard's
    // own real-answer PATCH merge to nothing). `""` per key is the "not yet
    // answered" state — indistinguishable, deliberately, from "this
    // install's wizard has never been run," since both cases must show the
    // fresh question flow rather than a false "already answered" review
    // step, and neither should ever trigger the hand-edit warning below.
    //
    // Storing this does NOT turn the wizard into an ongoing synced mode:
    // `workflowConventionsText` stays a freely-editable textarea with no
    // distinction between wizard-written and hand-edited text — the modal
    // only computes, on open, whether
    // `buildWorkflowConventionsText(workflowConventionAnswers) !==
    // workflowConventionsText` (both sides "" when every answer is still ""
    // — no false positive) to warn before an explicit re-apply would
    // silently overwrite a hand-edit.
    workflowConventionAnswers: Record<string, string>;
    // The exact text the wizard last generated and saved, written by the
    // server in applySettingsPatch (never sent by a client): `""` when the
    // text was hand-typed or has never come from the wizard. It is what lets
    // getStoredSettings tell "still the wizard's output, so regenerate it
    // when the rules change" from "someone edited it, leave it alone". Before
    // this, a rule change (#1759's `.wt/<branch>`) never reached an install
    // whose text was generated earlier, and agents picked their own worktree
    // directory.
    workflowConventionsAppliedText: string;
    // Phase 5 (Track B, issue #193 5.3b) — hard cap on how many LIVE
    // (status "active") children a single session may have spawned via the
    // sessions.spawn_child control-socket op. Enforced in
    // createSessionRecord (services/session-lifecycle.ts), not just at the socket
    // layer, so a direct full-scope sessions.create call carrying a
    // parentSessionId is bound by the same limit. The control socket is
    // deliberately exempt from the app-wide rate limiter (see
    // plugins/security.ts's CONTROL_SOCKET_ADDR allowList) so a `mullion
    // ps` poll loop never 429s — which means there is no ambient backstop
    // on how many sessions a compromised or looping agent's inherited
    // token could spawn. This is that backstop.
    maxChildSessionsPerParent: number;
    // Phase 5 (Track B, issue #194 5.4) — whether a spawned child session's
    // dockview panel opens automatically, positioned next to its parent's
    // (frontend/src/App.tsx, frontend/src/panelUtils.ts's
    // childPanelPosition). Default false: opening a panel with no user
    // gesture behind it is the first backend-state-driven panel add in this
    // codebase (every existing such effect only setActive()s or closes an
    // already-open panel) — opt-in until proven unsurprising. The child
    // still appears in the sidebar unconditionally regardless of this flag;
    // this only gates whether its PANEL auto-opens.
    autoOpenChildPanels: boolean;
    // The git identity stamped on commits made by Mullion sessions (as
    // command-scope user.name/user.email, see session-env.ts) and by
    // Mullion's own salvage commit (git-worktree.ts). A project's own
    // `gitIdentity` beats it. Either field blank = unset: nothing is injected
    // and the host's own git config applies. A plain object (not nullable) so
    // deepMerge can patch it field by field.
    gitIdentity: { name: string; email: string };
  };
  // Phase 6 Task Master (6.2/#215) — the runtime kill-switch the roadmap's
  // Security & trust row asks for, distinct from MULLION_TASK_MASTER_ENABLED
  // (an env var that needs a process restart to flip). Checked fresh by the
  // auto-claim pass every sweep, so pausing takes effect immediately.
  //
  // Follow-up (Settings UI for the safety envelope): enabled/maxConcurrent/
  // budgetMinutes/progressCommentMinutes let the dashboard override the
  // matching MULLION_TASK_* env vars at runtime, without a restart. Each of
  // the four uses a same-typed sentinel to mean "no override, use the env
  // default" — see resolveTaskMasterConfig (src/services/task-config.ts) for
  // the one place that understands them. Sentinels exist because deepMerge
  // (below) drops any patch leaf whose type differs from its DEFAULT_SETTINGS
  // counterpart, so a `number | null` field would be permanently unsettable
  // once set to null; and because PATCH /api/settings always persists the
  // *full* merged blob, so "is this key present in the stored JSON" can never
  // distinguish "user set it" from "still defaulted." `-1` for the numbers,
  // `"inherit"` for enabled (a boolean can't carry three states). Never
  // exposed to the user — the Settings UI always shows/writes an effective
  // value and offers a single "reset to environment defaults" action that
  // writes the sentinels back.
  //
  // MULLION_TASK_LABEL and MULLION_TASK_POLL_INTERVAL are deliberately NOT
  // included here — see the plan's "Cut from scope" section. The label is
  // effectively deploy identity (changing it mid-flight orphans already-
  // labeled GitHub issues with no migration path); the poll interval is a
  // rate-limit tradeoff nobody tunes from a browser, and making it live
  // would require timer-lifecycle churn (a reconfigure decorator) that isn't
  // worth it for the value.
  // Issue #957 — install-wide default opencode model per role, each a
  // `provider/model` string (e.g. "openrouter/minimax-m3",
  // "anthropic/claude-sonnet-4-5"). Applied at spawn time to
  // OPENCODE_CONFIG_CONTENT.model by the opencode adapter's prepareLaunch.
  // The lowest tier of resolveOpenCodeModel's precedence chain
  // (src/services/task-model-resolve.ts). `null` means "no override; let
  // opencode pick via its own priority chain (last-used / first model)" —
  // today's behavior, unchanged.
  // Runtime overrides for env-configured behaviour knobs. Same sentinel
  // shape as taskMaster below: -1 / "inherit" means "use the env default"
  // (resolved in services/runtime-config.ts), anything else wins over it.
  github: {
    // GITHUB_POLL_INTERVAL_ACTIVE / _QUIET / GITHUB_POLL_STALE_THRESHOLD.
    pollActiveSeconds: number;
    pollQuietSeconds: number;
    pollStaleThresholdSeconds: number;
  };
  hosts: {
    // HOST_HEARTBEAT_INTERVAL_SECONDS. 0 disables the heartbeat.
    heartbeatSeconds: number;
  };
  // Non-secret half of the Hermes review relay (services/hermes-review.ts):
  // an agent's `request_review` asks the Mullion server to POST a review
  // request to this API instead of going through a GitHub workflow. The
  // API key is deliberately NOT here — this blob is returned verbatim by
  // GET /api/settings — it lives encrypted in the `integrations` table
  // (services/hermes-integration.ts). Empty `apiUrl` means the feature is off.
  reviewRelay: {
    // Which reviewer `request_review` / `mullion review` dispatches to.
    // "none" = no reviewer configured; "hermes" = the Hermes API relay.
    provider: "none" | "hermes";
    // Base URL of the Hermes API server, e.g. http://host:8643 (no trailing path).
    apiUrl: string;
    // Model for relay runs. "hermes-agent" (the API server's virtual alias,
    // API_SERVER_MODEL_NAME) = the Hermes profile's own model priority; any
    // other value overrides it for relay runs only.
    model: string;
    // Hermes provider slug the model belongs to (from /api/model/options).
    // Empty = send the bare model. Ignored while `model` is the alias.
    modelProvider: string;
    // Optional "owner/repo" holding a custom review prompt, fetched
    // unauthenticated. Empty = Mullion's built-in prompt.
    promptRepo: string;
    // Path of the review prompt inside promptRepo.
    promptPath: string;
    // The same pair for the issue-triage relay (issue #1629): a triage run
    // gets its own prompt, because "review this PR" and "triage this issue"
    // are different jobs. Empty = Mullion's built-in triage prompt.
    triagePromptRepo: string;
    // Path of the triage prompt inside triagePromptRepo.
    triagePromptPath: string;
    // Minimum minutes between two requests for the same PR.
    cooldownMinutes: number;
    /**
     * The GitHub login of the bot that posts the review (e.g.
     * "s3ntin3l8-hermes[bot]").
     *
     * Only THIS bot's landed reviews set the delta base of the next round.
     * Another bot's review on the head (claude[bot], Copilot, a Task Master
     * reviewer) must neither make a request a no-op nor become the base of
     * Hermes' next round — that round would then skip everything Hermes
     * itself has not looked at.
     *
     * The shared workflow computes the same value (its `mention-trigger`
     * input plus "[bot]"), and both put it in the idempotency key: a
     * difference here means the two entry points stop deduplicating against
     * each other. The same login decides whether a review "landed" in the
     * relay's status (the pill and `review status`), so another bot's review
     * of the head does not show as the relay's. It decides the same for the
     * triage reply (`triage status`): only this bot's issue comment counts.
     * Empty = any bot's review or comment counts in the STATUS the relay
     * shows (the old rule). It does NOT count for the delta base: the shared
     * workflow only ever accepts `<mention-trigger>[bot]`, so with no login
     * the relay cannot derive the same base and reviews the whole diff
     * instead (s3ntin3l8/.github#133).
     */
    reviewerBotLogin: string;
    /**
     * The name of the check run that records which commit a review round
     * covered (the "ledger"). The relay writes it, and reads it to find the
     * commit the last round covered (the delta base) and the session it ran in.
     *
     * Mirrors the shared workflow's inputs: this is `hermes-review-ledger-name`
     * (default "Hermes review"), and EMPTY means the ledger is off, like
     * `hermes-review-ledger: off`. The two must be set together: a relay that
     * keeps a ledger the workflow does not (or under another name) derives a
     * different base, and the two SILENTLY stop deduplicating against each other
     * (nothing detects it; the same range can be reviewed twice). With
     * the ledger off the delta base falls back to the review's `commit_id`,
     * which GitHub re-points when the branch is rewritten, and is trusted only
     * while it provably predates the review.
     */
    ledgerName: string;
    /**
     * What `request_review` does when the review bot has already APPROVED the
     * pull request: "refuse" answers 409 (apply the bot's suggestions and push
     * without another round — a re-review of small fixes only breeds more
     * nits, so the cycle never ends); "allow" re-reviews every new head, as
     * before. A request with `force` goes through either way. Only the
     * reviewer bot's own newest decisive review counts, so a later
     * CHANGES_REQUESTED, a dismissed approval or a human's approval does not;
     * with no `reviewerBotLogin` set there is no verdict to go by, so nothing
     * is refused.
     */
    reReviewAfterApproval: "refuse" | "allow";
    /**
     * Whether Task Master may use this Hermes connection as a review agent
     * (`hermes` as a task's, project's or install-wide default review agent,
     * #2369). Independent of `provider`, which turns on the GitHub-side relay
     * (`mullion review`) — a Task Master review is dispatched by Mullion and
     * ingested by it, with nothing posted to GitHub by Hermes. Off by default;
     * it also needs `apiUrl` and the stored key to count as usable
     * (`hermesTaskReviewerUsable`).
     */
    taskMasterReviewer: boolean;
  };
  /**
   * The Runway quota integration (issue #29).
   *
   * Runway is a SEPARATE service — an "AI usage tracker" — that already
   * knows each provider's remaining quota. Mullion polls it and uses the
   * answer to decide whether an agent may be claimed at all.
   *
   * As with reviewRelay above, the NON-SECRET half lives here (this blob is
   * returned verbatim by GET /api/settings) and the admin key lives
   * encrypted in the `integrations` table (services/runway-integration.ts).
   * An empty `apiUrl` means the feature is off.
   */
  runway: {
    /** Base URL of the Runway server, e.g. https://runway.example.com (no trailing path). */
    apiUrl: string;
    /**
     * Which Mullion agent each Runway provider_id describes.
     *
     * A mapping, not a derivation: Runway's provider ids describe
     * *providers* (anthropic, opencode, chatgpt, minimax, …) and Mullion's
     * agents are *CLIs* (claude, codex, opencode, agy). Neither set
     * contains the other and several Runway providers have no Mullion agent
     * at all (gemini, github, ollama, …). So the correspondence is a
     * per-install decision, with a conservative default.
     *
     * A value is a target or a list of targets. A target is a bare agent
     * (`opencode` = every opencode task) or, for a multi-provider CLI,
     * `opencode/<opencode-provider-id>` (`xai` -> `opencode/xai`): it holds
     * only the tasks whose resolved model is `<provider>/…`.
     *
     * An agent that is NOT in this map is never quarantined: absence of
     * data must not block work.
     */
    providerMap: Record<string, string | string[]>;
    /** How often to poll Runway for the quota. 0 = never poll (the feature is configured but idle). */
    pollSeconds: number;
  };
  browser: {
    // BROWSER_ENABLED. Read once at boot: a change needs a restart.
    enabled: "inherit" | "on" | "off";
    // BROWSER_FRAMERATE. Applied to the next browser stream that opens.
    framerate: number;
    // BROWSER_MAX_INSTANCES. Read once at boot: a change needs a restart.
    maxInstances: number;
  };
  devices: {
    // DEVICE_DISCOVERY_ENABLED (mDNS phone discovery). Read once at boot: a
    // change needs a restart.
    discoveryEnabled: "inherit" | "on" | "off";
    // DEVICE_EMULATOR_HEADLESS. "on" passes `-no-window` (today's default).
    // Read on every emulator start, not at boot — a change applies to the
    // next launch without a restart. Host-wide, not per device: the host
    // either has a display for an emulator window or it does not.
    emulatorHeadless: "inherit" | "on" | "off";
    // DEVICE_EMULATOR_GPU. `null` inherits the env default. A string is a
    // single token (`swiftshader_indirect`, `host`, …). Also read on every
    // emulator start. Not an enum: newer emulators add modes.
    emulatorGpu: string | null;
  };
  server: {
    // LOG_LEVEL. Applied live to the root logger.
    logLevel: "inherit" | LogLevel;
  };
  opencode: {
    implementerModel: string | null;
    reviewerModel: string | null;
    // Issue #958 — opencode's `small_model` config key, used for
    // lightweight tasks (title generation, summarization) that don't
    // need the full model. Single setting, not per-role — it's a
    // property of the model itself, not the task.
    defaultSmallModel: string | null;
  };
  // Install-wide default `--model` per non-opencode CLI (the lowest tier of
  // resolveCliModel's precedence chain). Free-form because each CLI names
  // models differently (`sonnet`, `gpt-5`, ...); `null` means "no flag, let
  // the CLI pick".
  claudeCode: {
    defaultModel: string | null;
    reviewerModel: string | null;
    smallModel: string | null;
  };
  codex: { defaultModel: string | null; reviewerModel: string | null };
  agy: { defaultModel: string | null; reviewerModel: string | null };
  // Issue: mcode support — mcode takes `-m <provider/model>`, the same shape
  // the other CLI-model agents take.
  mcode: { defaultModel: string | null; reviewerModel: string | null };
  taskMaster: {
    autoClaimPaused: boolean;
    // GitHub logins trusted in addition to OWNER/MEMBER/COLLABORATOR
    // authors (task-trust.ts). Unioned with MULLION_TASK_TRUSTED_LOGINS,
    // not sentinel-overridden.
    trustedLogins: string[];
    enabled: "inherit" | "on" | "off";
    maxConcurrent: number;
    budgetMinutes: number;
    progressCommentMinutes: number;
    rateLimitGraceMinutes: number;
    // #741 — Task Master's own install-wide worker-agent default, split out
    // of settings.launchers.defaultAgent (which only drives the terminal
    // launcher) so terminal and Task Master agent defaults are independent.
    // The lowest tier of resolveAgentCommand's precedence (src/services/
    // task-agent-resolve.ts). Independent, NOT a coupled fallback.
    defaultAgent: string;
    // #741 — Task Master's install-wide review-agent default. Previously the
    // review agent had no global fallback tier at all (opt-in per
    // project/task only); this is the new lowest tier of
    // resolveReviewAgentCommand. "none"/empty means "no review agent, human
    // reviews directly" — today's behavior, unchanged.
    defaultReviewAgent: string;
    // Whether an unattended task spawn (claim/auto-claim/retry/review agent)
    // should pass skipPermissions through to the agent's own flag (e.g.
    // `--dangerously-skip-permissions`) — see getSkipPermissionFlag in
    // pty-manager.ts for the per-agent mapping. Distinct from
    // `launchers.skipPermissionsAgents` above, which only drives the
    // frontend's CommandPalette manual-launch UI and never reaches the
    // claim/retry/review spawns. Same "inherit"-sentinel shape as `enabled`
    // above — a boolean can't carry three states, and this needs the same
    // "no override, use the env default" reading MULLION_TASK_SKIP_PERMISSIONS
    // provides.
    skipPermissions: "inherit" | "on" | "off";
    // #738 follow-up — how long the review-agent spawn (task-reconciler.ts's
    // processPendingReviewSpawns) waits for CI to reach a terminal state on
    // the task's PR head before spawning anyway. Also waits on `null` (no
    // runs registered yet) and on the lookup itself throwing (a transient
    // blip, or GitHub not yet consistent on the brand-new PR) — Hermes
    // review, PR #742 — not just `"in_progress"`: the very first lookup
    // happens within moments of the push that created the head commit,
    // before GitHub has necessarily registered the Actions run or even
    // become fully consistent on the PR, so any of those is indistinguishable
    // from "this repo has no CI at all" without waiting. Plain number, NOT one of
    // the "inherit"-sentinel fields above: those exist only for fields with
    // an env-var counterpart (MULLION_TASK_*), and this one has none — a
    // repo with Actions disabled or no workflows needs `0` (spawn
    // immediately, never wait) to be reachable without env-var surgery.
    reviewCiWaitMinutes: number;
    // Install-wide cap on the automatic fix-up rounds a task may spend
    // (a changes-requested review, a red CI check, an unresolved PR
    // review comment — an approved review's suggestions round spends none).
    // 0 = unlimited. A project's own `maxAutoReturnRounds` overrides it; an
    // unset project inherits this. Plain number, no "inherit" sentinel and no
    // env counterpart, for the same reason as reviewCiWaitMinutes above.
    maxAutoReturnRounds: number;
  };
}
