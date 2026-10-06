// Extracted from pty-manager.ts (issue #1522) — pure type declarations, no runtime code.
import type { HookMessageKind, BackgroundTask } from "./hook-protocol.js";
import type { AttentionSignalKind } from "./attention-detect.js";

export interface CreateSessionOptions {
  id: string;
  cwd: string;
  /** Shell command line to run inside the session, e.g. "claude", "bash". */
  command: string;
  cols: number;
  rows: number;
  /** When true, append the agent's skip-permissions flag (e.g.
   * `--dangerously-skip-permissions`, `--auto`) so the CLI skips every
   * permission prompt — see getSkipPermissionFlag() for the per-agent
   * mapping. Default false. */
  skipPermissions?: boolean;
  /** Task Master (task-claim.ts/task-reconciler.ts) and, as of the
   * promote-flow first-turn fix, routes/sessions.ts's promote handler too —
   * a prompt to start the agent's first turn with, delivered as argv via
   * the matched hook adapter's `initialPromptArgs` (hook-adapters/index.ts's
   * getAdapterInitialPromptArgs). A no-op for an agent with no such argv
   * form at all (currently only `aider`/`gemini`/`pi`, none of which have
   * an adapter — every registered adapter, including OpenCode's `--prompt`,
   * has one now) — the session still spawns, just with no prompt submitted,
   * same as before this option existed. See Session.spawn()'s own doc
   * comment for why this can't be delivered via stashSeed's SessionStart
   * `additionalContext` for an unattended worker. */
  initialPrompt?: string;
  /** Issue #678 — the promote flow's seed prompt (POST
   * /api/sessions/:id/promote's `seedPrompt` body field, or the launcher's
   * own equivalent), stashed against this session's id (see
   * PtyManager.stashSeed) and also threaded through to
   * HookAdapterContext.seedPrompt for an adapter with no live hook round
   * trip to deliver it through (opencode — see that adapter's own header).
   * Distinct from `initialPrompt` above: this never submits a turn, it only
   * injects context, matching what a hook-based agent's SessionStart
   * `additionalContext` already does for it. Since the promote-flow
   * first-turn fix, the promote route only ever sets this for an adapter
   * with no `initialPromptArgs` at all — opencode itself now prefers
   * `initialPrompt` instead (see routes/sessions.ts's promote handler), so
   * this field's `HookAdapterContext.seedPrompt` delivery is a fallback,
   * not opencode's primary channel anymore. */
  seedPrompt?: string;
  /** Issue #271 follow-up — routes/sessions.ts's promote handler, when
   * opencode-session-transfer.ts successfully imported the source session's
   * full conversation history into this session's own worktree directory
   * under a fresh id. Delivered as argv via the matched adapter's
   * `resumeSessionArgs` (hook-adapters/index.ts's getAdapterResumeSessionArgs)
   * — currently opencode-only. When both this and `initialPrompt` are set,
   * the resume flag is appended first (see launch-plan.ts) so the prompt
   * reads as "the resumed session's next turn," not a fresh one. A no-op
   * for any agent whose adapter has no `resumeSessionArgs` — the session
   * still spawns as an ordinary fresh one, same as if this were never set. */
  resumeAgentSessionId?: string;
  projectId?: number;
  /** Issue #822 — extra env vars for this session's launch, on top of the
   * usual scrub + Mullion injections (see launch-plan.ts's buildLaunchPlan,
   * which applies this BEFORE every Mullion-owned write so none of those
   * can be overridden by it). Sourced from sessions.env (schema.ts) on both
   * the initial spawn and every later reattach (routes/terminal.ts) — see
   * that column's own doc comment for why it's persisted rather than
   * spawn-time-only. */
  env?: Record<string, string>;
  /** Issue: per-project briefing storage / #942 (pinned note) — resolved on
   * the PRIMARY (where the DB lives) and threaded straight through to
   * writeSessionBriefing's `note` param (project-briefing.ts), the same
   * spawn-body channel `seedPrompt` above already uses. Exists because a
   * multi-host **agent**-role process has no DB of its own (see
   * src/plugins/hooks.ts's `app.db ? ... : DEFAULT_SETTINGS` comment for
   * the same constraint on `injectAgentGuide`) — resolving a per-project
   * note there directly would silently resolve to nothing on every remote
   * host. The producer is session-lifecycle.ts's createSessionRecord; a
   * caller that omits this leaves writeSessionBriefing with no note to
   * write for this session — issue #942 redesigned this from a
   * precedence-based override of a committed file region into a short,
   * always-additive pinned note with no fallback of its own. */
  briefingOverride?: string;
  /** PR-5 — see HookAdapterContext.projectSkill's own doc comment
   * (hook-adapters/types.ts). Same producer/multi-host reasoning as
   * `briefingOverride` immediately above. */
  projectSkill?: string;
  /** PR-5 — see HookAdapterContext.projectReviewerAgent's own doc comment
   * (hook-adapters/types.ts). Same producer/multi-host reasoning as
   * `briefingOverride` above. */
  projectReviewerAgent?: string;
  /** Issue #957 — see HookAdapterContext.model's own doc comment
   * (hook-adapters/types.ts). Same producer/multi-host reasoning as
   * `projectReviewerAgent` above. Resolved on the primary by
   * createSessionRecord and forwarded into `applyHookAdapters` →
   * `HookAdapterContext.model` for the opencode adapter. */
  model?: string;
  /** Issue #958 — same threading posture as `model` above, for
   * opencode's `small_model` config key. Forwarded into
   * `HookAdapterContext.smallModel`. */
  smallModel?: string;
  /** Issue #884 — the per-project-resolved value of
   * sessions.injectAgentGuide (settings.ts), already merged with this
   * project's own nullable override column (projects.injectAgentGuide,
   * schema.ts) by session-lifecycle.ts's createSessionRecord, on the
   * PRIMARY, for the same multi-host reason `briefingOverride` above
   * exists. When set, wins over the live `getInjectAgentGuide()` closure
   * below (see getOrCreate()) — a caller that omits this (any getOrCreate()
   * call outside session-lifecycle.ts's producer, e.g. a dock/reconciler
   * respawn) keeps today's global-settings-only behavior exactly as
   * before. */
  injectAgentGuide?: boolean;
  /** Same producer/multi-host reasoning and "wins over the live closure
   * when set" posture as `injectAgentGuide` immediately above, for the
   * independent sessions.injectProjectBriefing setting. */
  injectProjectBriefing?: boolean;
  /** Issue #1089 — same producer/multi-host reasoning as `injectAgentGuide`
   * immediately above, for the independent sessions.injectMullionBundle
   * setting (settings.ts). Unlike injectAgentGuide/injectProjectBriefing,
   * there is no per-project override to merge (schema.ts's own comment on
   * `projects.injectAgentGuide` explains why injectMullionBundle
   * deliberately doesn't get one) — session-lifecycle.ts's
   * createSessionRecord resolves this straight from the global setting and
   * threads it through the spawn body exactly like briefingOverride
   * already is. When set, wins over the live `getInjectMullionBundle()`
   * closure below (see getOrCreate()) — a caller that omits this (any
   * getOrCreate() call outside session-lifecycle.ts's producer, e.g. a
   * dock/reconciler respawn) keeps today's global-settings-only behavior
   * exactly as before. */
  injectMullionBundle?: boolean;
  /** Issue #937 — the install-wide workflow-conventions text, already fully
   * resolved (gated on both the global text being non-empty AND this
   * project's own injectWorkflowConventions column) by
   * session-lifecycle.ts's createSessionRecord, on the PRIMARY, for the
   * same multi-host reason `briefingOverride` above exists. Unlike
   * injectAgentGuide/injectProjectBriefing immediately above, this is a
   * SINGLE resolved `string | undefined`, not a separate boolean + raw
   * text: nothing downstream needs the boolean independently of the text
   * (the frontend's per-project toggle reads projects.injectWorkflowConventions
   * directly, never anything echoed off a Session), so there is no live
   * closure to fall back to and no caller-supplied override concept —
   * every session for a project gets the same resolved value, same as
   * injectAgentGuide/injectProjectBriefing's "no per-caller override"
   * posture, just carrying a value instead of a boolean. `undefined` means
   * "inject nothing" — see writeSessionWorkflowConventions's own doc
   * comment (workflow-conventions.ts) for why that's also true of an empty
   * string, unlike briefingOverride. */
  workflowConventionsText?: string;
  /** Set ONLY for sessions spawned by Mullion's Task Master (worker, review
   * agent, retry, reject/auto-return re-seed — see task-claim.ts and
   * task-reconciler.ts's spawn sites). Threaded through to the opencode
   * and codex adapters' `HookAdapterContext.taskId` (opencode.ts's and
   * codex.ts's prepareLaunch), which use a positive value to deny
   * superpowers skills that gate on a human in the loop (brainstorming /
   * writing-plans / finishing-a-development-branch). Spawn-time only: not
   * persisted on `sessions` (no row column, no migration); a later
   * reattach of a already-live session reads `undefined` here, which is
   * correct since the denial config was set when the session was first
   * spawned.
   * Producer: session-lifecycle.ts's createSessionRecord (called from the
   * Task Master spawn sites). A caller that omits this leaves the adapter
   * with no taskId, which is the desired "not a Task Master session"
   * default. */
  taskId?: number;
}

/** Phase 5 (Track A) — one subagent's identity and activity, built from the
 * agentId-bearing hook messages (see hook-protocol.ts's agent-attribution
 * envelope). Purely additive to `subagentCount`/`subagentCountAt` above,
 * never a replacement: not every adapter can supply an `agentId` (OpenCode's
 * `session.subagent` carries none), and a `.state.json` written before this
 * registry existed restores a bare count with no entries at all — either
 * case means `subagents` may legitimately be shorter than `subagentCount`,
 * which is "count known, detail unavailable," not an inconsistency. */
export interface SubagentInfo {
  agentId: string;
  agentType: string | null;
  startedAt: number;
  /** Set when a matching SubagentStop arrives, OR when the staleness sweep
   * (clearStaleBlockedIfOlderThan) force-finalizes this still-open entry
   * against its own `startedAt` — independent of subagentCount's own
   * staleness, which only zeroes the aggregate count and never touches
   * this field. That second (registry-side) case leaves `summary` null (no
   * final message was ever recorded), distinguishing a genuine finish from
   * a stale one. */
  endedAt: number | null;
  summary: string | null;
  fileChanges: number;
  toolFailures: number;
  /** Count of `fileChanges` + `toolFailures` attributed to this subagent —
   * NOT every hook message involving it (e.g. its own SubagentStart/Stop
   * aren't counted here). */
  eventCount: number;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  /** The shell's current working directory as last announced via an OSC 7
   * escape sequence (see attention-detect.ts's detectCwdChange), or null if
   * none has arrived yet — e.g. the shell doesn't have the injected
   * shell-integration hook, or hasn't drawn a prompt since this session was
   * created. Distinct from `cwd` above (the static spawn directory): a
   * session whose shell `cd`s into a git worktree after launch keeps `cwd`
   * pointing at the original directory forever, while `liveCwd` tracks where
   * the shell actually is now — see routes/projects.ts's
   * resolveSessionCwdTargets for why this matters (git status/branch must
   * reflect the worktree, not the spawn directory). */
  liveCwd: string | null;
  browserUrl: string | null;
  command: string;
  cols: number;
  rows: number;
  createdAt: number;
  alive: boolean;
  subscriberCount: number;
  /** Ms-epoch of the last PTY output, or null if none has arrived yet. */
  lastActivityAt: number | null;
  /** "working" if the terminal title says so, else if output has arrived
   * recently AND persisted for at least SUSTAIN_MS (so a single spawn-time
   * prompt-draw burst doesn't count) AND isn't closely following a user
   * keystroke (see USER_INPUT_ECHO_MS — keystroke echo shouldn't read as
   * work), else "idle" — a coarse heuristic, not a real "is the program
   * busy" signal. */
  activity: "working" | "idle";
  /** True once one of the attention signals in attention-detect.ts's state
   * machine (BEL, OSC 9/777 notification, a working->idle title transition,
   * an alt-screen exit, or sustained silence after a work streak) has been
   * CONFIRMED — i.e. survived its own per-kind debounce window uncontradicted
   * by further output — without being cleared since. See Session.attentionState
   * and advanceAttention() in attention-detect.ts for the full state machine
   * (issue #171/#98) this replaces the old ad-hoc ATTENTION_CLEAR_WINDOW_MS
   * check with. */
  attention: boolean;
  /** Ms-epoch this session was last confirmed as needing attention, or null
   * if never (or since cleared) — Session.attentionState.confirmedAt. */
  attentionAt: number | null;
  /** Payload of the most recent OSC 0/2 title-change sequence — consulted by
   * classifyActivityFromTitle() for a fast-path "working"/"idle" read on
   * agent CLIs that self-report their status in the title. */
  lastTitle: string | null;
  /** Minimal review gate (Phase 2, issue #178; rescoped to remote permission
   * approval in issue #264). "waiting" while at least one hook `review_gate`
   * message is blocked on a real decision (see Session.emitHookEvent/
   * registerPendingGate/resolveGate below); "approved"/"denied" once a
   * human answered the LAST one (via POST /api/sessions/:id/review-gate);
   * "lapsed" once nobody ever did — the server-side timeout, a dropped
   * forwarder connection, or a graceful shutdown while one was pending all
   * fall through to the agent's own native prompt rather than being denied
   * (issue #264), and "lapsed" is what records that on this end; "idle" if
   * no gate has ever fired. Despite the comment this replaced saying
   * otherwise, this field is NOT in-memory only — it's in
   * `StoredStateFields` below and persisted to the per-session state file
   * (issue #323), restored on both `readStateFile()` and `spawn()`'s
   * reattach path. A `"waiting"` value restored from disk is known-stale
   * (no live gate connection can have survived a restart) and is resolved
   * to `"lapsed"` at reattach — see `spawn()`'s savedState handling —
   * rather than left as a live-looking gate with dead Approve/Deny
   * buttons.
   *
   * Issue: correlate concurrent permission gates — this field (and
   * `gatePrompt`/`gateAt` below) is now a DERIVED SUMMARY over the live,
   * in-memory `gates` list below, not the source of truth: `"waiting"`
   * means "at least one gate in `gates` is waiting", not "exactly one is".
   * Kept as a scalar (rather than removed) because session-status.ts,
   * session-live-info.ts, push-delivery.ts, and the persisted state file
   * all only ever needed a single representative summary, and still do —
   * see Session.registerPendingGate/resolveGate's own doc comments for
   * exactly how the summary tracks the underlying list. */
  gateState: "idle" | "waiting" | "approved" | "denied" | "lapsed";
  /** The prompt of the OLDEST still-waiting gate while gateState is
   * "waiting" (see gateState's own doc comment on why this is now a
   * summary, not the whole picture), else null (cleared once the LAST gate
   * resolves — see Session.resolveGate). */
  gatePrompt: string | null;
  /** Issue #320 — ms-epoch the OLDEST still-waiting gate was registered, or
   * null while idle. */
  gateAt: number | null;
  /** Issue: correlate concurrent permission gates — the full list of
   * currently-waiting gates, oldest first, each independently resolvable
   * via `POST /api/sessions/:id/review-gate`'s optional `gateId` body
   * field. In-memory only (see Session.pendingGates's own doc comment for
   * why this deliberately does NOT survive a restart) — always `[]` right
   * after a reattach, even if `gateState` briefly shows the stale
   * `"waiting"` a beat before the reattach path resolves it to `"lapsed"`.
   * `NotificationBell.tsx`'s `GateActions` renders one Approve/Deny row per
   * entry here rather than assuming there's ever just one. */
  gates: Array<{ gateId: string; prompt: string; at: number }>;
  /** Issue #271, option 2 — "pending" while a model-invoked
   * `promote_request` is blocked waiting for a human decision (see
   * Session.emitHookEvent/resolvePromote below); "accepted"/"declined" once
   * resolved; "idle" if no promote request has ever fired. Same in-memory,
   * resets-on-restart posture as gateState above. */
  promoteState: "idle" | "pending" | "accepted" | "declined";
  /** The model-authored seed/summary from the most recent `promote_request`
   * while promoteState is "pending", else null. */
  promoteSummary: string | null;
  /** The base ref the model suggested alongside `promoteSummary`, if any. */
  promoteSuggestedBaseRef: string | null;
  /** Issue #320 — ms-epoch this session's promoteState was last set to
   * "pending", or null while idle. */
  promoteAt: number | null;
  /** Set to "pending" when a PermissionRequest hook fires — the agent is
   * blocked waiting for user permission to use a tool. Cleared when the
   * session's attention state confirms or clears. In-memory only. */
  permissionState: "idle" | "pending";
  /** Issue #320 — ms-epoch this session's permissionState was last set to
   * "pending", or null while idle. Used by the staleness sweep. */
  permissionAt: number | null;
  /** Set to "pending" when an ExitPlanMode PreToolUse hook fires — the
   * agent has a plan ready for human review. Cleared when the session's
   * attention state confirms or clears. In-memory only. */
  planState: "idle" | "pending";
  /** Issue #320 — ms-epoch this session's planState was last set to
   * "pending", or null while idle. */
  planAt: number | null;
  /** Non-null when a StopFailure hook fires (API error) or a
   * PostToolUseFailure hook fires (tool execution error). In-memory only. */
  errorState: "idle" | "api_error" | "tool_failure";
  /** Rich statuses — ms-epoch this session's `errorState` was last set to a
   * non-idle value, null while idle. Lets a staleness sweep (or a future
   * general one — see issue #320) expire an error nothing has cleared
   * because the resolving hook never fired. In-memory only, reset alongside
   * `errorState` everywhere that field is. */
  errorAt: number | null;
  /** Set when a SessionEnd hook fires — why the session terminated.
   * In-memory only. */
  endedReason: string | null;
  /** The process's real exit code, when the SessionEnd hook can report one
   * (see SessionEndHookMessage.exitCode in hook-protocol.ts) — null when
   * unavailable (the agent's adapter can't report one, or no SessionEnd has
   * fired yet). In-memory only. */
  exitCode: number | null;
  /** The latest branch reported by this session's git worktree add,
   * CwdChanged hook, or live branch tracking — null when unknown.
   * In-memory only. */
  liveBranch: string | null;
  /** Issue #271 follow-up — opencode's own internal session id, kept live by
   * the "agent_session" hook (hook-protocol.ts). Lets a later promote carry
   * this session's real conversation history (opencode export/import) into
   * the new worktree session instead of only a seed summary. `null` for
   * every other agent, and for an opencode session before its first
   * session.idle has fired. In-memory only, NOT part of `StoredStateFields`
   * below — losing it across a restart just means the next promote falls
   * back to the ordinary seed-only path, same as if opencode had never
   * reported one; not worth the extra restore-path plumbing a state
   * machine's own fields need. */
  agentSessionId: string | null;
  /** Rich statuses (issue: extend surfaced session statuses) — which
   * attention-detect.ts signal kind is currently confirmed, or null when
   * `attention` is false. Mirrors `attentionState.confirmedKind` directly
   * (see toInfo()) rather than being tracked as its own field — same
   * "attentionAt IS attentionState.confirmedAt" posture that field's own doc
   * comment describes. Used to label WHY a session is `needs_input` (bell vs
   * silence vs title) — see session-status.ts's deriveSessionStatus. NOT used
   * to distinguish `finished` from `needs_input` — see `lastTurnEndedAt`
   * below for why that would be wrong. */
  attentionKind: AttentionSignalKind | null;
  /** Rich statuses — a short, stable label for the current `errorState`,
   * when the failing hook could supply one: a StopFailureHookMessage's
   * `errorType` (falling back to its free-text `errorDetails`) for
   * `api_error`, or the failing tool's name for `tool_failure`. Null when
   * `errorState` is "idle", or when the hook fired with none of these
   * fields. In-memory only. */
  errorDetail: string | null;
  /** The most recent Stop/progress hook's `lastAssistantMessage`, if the
   * adapter forwarded one — kept across turns (not cleared on the next
   * "thinking"/"generating" progress message) so a poll landing between
   * turns still has something to show. In-memory only. */
  lastAssistantMessage: string | null;
  /** Issue: sidebar now-line — the model's current in-progress (or, absent
   * one, pending) todo item, kept across turns the same way
   * lastAssistantMessage above is (not cleared until the next `todo` message
   * says otherwise) so a poll landing mid-task still has something to show.
   * Cleared unconditionally once the latest `todo` message reports a
   * terminal status (completed/cancelled) — content-agnostic, same "no todo
   * beats stale todo" rule as eventDescriptions.ts's sessionContextMap,
   * since todos have no stable per-item id to match against. Both Claude
   * Code (hooks/forwarder-core.mjs's mapClaudeCodePostToolUse, which
   * pre-resolves ONE "current" item per TodoWrite call: in_progress, else
   * pending, else the call's last entry) and OpenCode (hooks/
   * opencode-plugin.js's `todo.updated` handler, which instead fires once
   * PER todo item as its own state changes) map into this same `todo` hook
   * kind — so for OpenCode specifically, a burst of per-item updates ending
   * on a different, now-terminal item can clear this even while another
   * item is still genuinely in progress. Same tradeoff sessionContextMap's
   * own doc comment already accepts for that adapter. In-memory only. */
  currentTodo: { content: string; status: string } | null;
  /** Rich statuses — "compacting" while a PreCompact/PostCompact hook pair
   * is in flight (Claude Code only, so far — see hook-adapters/claude-code.ts).
   * In-memory only. */
  compactState: "idle" | "compacting";
  /** Issue #320 — ms-epoch this session's compactState was last set to
   * "compacting", or null while idle. */
  compactAt: number | null;
  /** Rich statuses — count of SubagentStart hooks not yet matched by a
   * SubagentStop (Claude Code only, so far). Zero when none are running.
   * In-memory only. */
  subagentCount: number;
  /** Issue #320 — ms-epoch this session's subagentCount was last updated
   * by a subagent start event while count > 0 (re-stamps on every
   * subsequent start, not just the initial 0 -> 1 transition), or null
   * while at zero. Used by the staleness sweep. */
  subagentCountAt: number | null;
  /** Phase 5 (Track A) — named subagents built from agentId-bearing hook
   * messages, chronological (oldest first). May be shorter than
   * `subagentCount` when an adapter can't supply identity — see
   * SubagentInfo's own doc comment. In-memory, persisted (trimmed) via
   * StoredStateFields like subagentCount. */
  subagents: SubagentInfo[];
  /** Rich statuses — "pending" while an MCP server's Elicitation hook is
   * blocked waiting on a human response (Claude Code only, so far).
   * In-memory only. */
  elicitationState: "idle" | "pending";
  /** The MCP server name from the most recent Elicitation hook while
   * elicitationState is "pending", else null. In-memory only. */
  elicitationServer: string | null;
  /** Issue #320 — ms-epoch this session's elicitationState was last set to
   * "pending", or null while idle. */
  elicitationAt: number | null;
  /** OpenCode v2 question events — set to "pending" when a `question.asked`
   * event arrives; cleared by `question.replied`/`question.rejected` or on
   * a new turn. Mirrors elicitationState's shape. In-memory only. */
  questionState: "idle" | "pending";
  /** The header from the first question (short label, max 30 chars), or null
   * while questionState is idle. In-memory only. */
  questionHeader: string | null;
  /** Issue #320 — ms-epoch this session's questionState was last set to
   * "pending", or null while idle. */
  questionAt: number | null;
  /** Rich statuses — ms-epoch this session's turn last ended (a hook
   * `progress` message with `phase: "done"`), latched until the NEXT turn
   * genuinely starts (a real human keystroke — see write()'s
   * isGenuineUserInput — or a `turn_start` hook once wired) or the session
   * exits. This is what distinguishes `finished` (turn over, process alive)
   * from `needs_input` (a byte-heuristic guess) — see session-status.ts's
   * deriveSessionStatus and its own doc comment for why this must be a
   * latch rather than read off attentionState.confirmedKind === "agentIdle"
   * (that field is output-clearable and would flicker: `agentIdle` is
   * deliberately NOT in attention-detect.ts's OUTPUT_IMMUNE_KINDS, since
   * it's the ONLY attention trigger opencode/codex/agy have). In-memory
   * only, reset on respawn. */
  lastTurnEndedAt: number | null;
  /** Issue #428 — the raw `backgroundTasks` list off the most recent
   * `progress`/`subagent` hook message that carried one (present-only
   * update: a message with no `backgroundTasks` field, e.g. Claude Code's
   * `idle_prompt` notification path, leaves this untouched rather than
   * wiping it — see emitHookEvent's "progress" case). Kept raw (not
   * pre-filtered) so it round-trips through StoredStateFields unchanged;
   * `outstandingBackgroundTasks` below is the filtered view callers
   * actually want. Cleared on `turn_start`, a genuine keystroke, and
   * respawn, same release paths as `lastTurnEndedAt`. In-memory only. */
  backgroundTasks: BackgroundTask[];
  /** Issue #428 — ms-epoch `backgroundTasks` was last updated while it
   * contained at least one outstanding (non-terminal-status) entry, or null
   * once none remain. Backend-internal TTL bookkeeping for the staleness
   * sweep (clearStaleBlockedIfOlderThan) — excluded from LiveInfoKey the
   * same way errorAt is. */
  backgroundTasksAt: number | null;
  /** Issue #428 — `backgroundTasks` filtered to only outstanding entries,
   * computed once here in toInfo() rather than re-derived by every caller
   * (deriveSessionStatus, the frontend's Row 6 chips) — keeps
   * "presentation only, never re-derivation" true for the frontend, which
   * has no import path to background-tasks.ts's own predicate (separate
   * npm workspace). */
  outstandingBackgroundTasks: BackgroundTask[];
  /** Issue #323: whether this session's state was restored from a
   * persisted state file (`<sessionsDir>/<id>.state.json`) on construction,
   * rather than starting from fresh idle defaults. False for a brand-new
   * session, or when the state file was missing or corrupt. Distinguishes
   * "we genuinely don't know the state" (restart recovered, waiting for
   * hooks) from "nothing pending" in the UI — see session-status.ts's
   * deriveSessionStatus. */
  stateRestored: boolean;
  /** Issue #323: whether the session was launched with a different version
   * of Mullion than is currently running. When true, the session's hook set
   * may be out of date (frozen at launch time), and the UI should show a
   * clock icon indicating it needs a restart to pick up new capabilities.
   * Derived by comparing the stored `launchedAtVersion` from the state file
   * against the current server version at construction time. */
  staleHooks: boolean;
  /** Issue #323: the value of `launchedAtVersion` stored in the state file
   * at construction time, or null when no state file was present. Lets the
   * frontend display the version the session was launched under. */
  restoredVersion: string | null;
  /** Rich statuses — the matched hook adapter's static `emits` capability list
   * for this session's launch command (empty for shells/unmatched). Computed
   * once at launch/reattach from the same adapter.matches() call that decides
   * whether to wire hooks. In-memory only — recomputed on every construction
   * from this.session.command, same posture as hooksActive. */
  hookEmits: readonly HookMessageKind[];
  /** Issue #404 — the port most recently detected in this (non-dock)
   * session's scrollback and not yet accepted or dismissed, or null when
   * nothing is currently pending. Set by PtyManager.sweepDevServerDetection
   * -> Session.detectDevServerPort; cleared by Session.acceptDevServerPort/
   * dismissDevServerPort. In-memory only, resets on restart — unlike
   * gateState/promoteState above, which ARE in `StoredStateFields` and do
   * survive a restart (see gateState's own doc comment for why that turned
   * out to be a bug for gateState specifically, fixed in issue #844; a
   * re-printed dev-server banner on the next detection sweep re-raising
   * harmlessly is a genuinely different case, not the same accepted gap).
   * Keying UI action-button visibility off this live field (not the
   * immutable historical `dev_server_detected` event payload) mirrors
   * gateState's own role for review_gate's GateActions in
   * NotificationBell.tsx. */
  pendingDevServerPort: string | null;
}
