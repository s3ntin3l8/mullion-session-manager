// PR 33a (Wave 6 of the refactoring roadmap) — extracts the 24-case switch
// out of Session.emitHookEvent (pty-manager.ts) into a lookup table keyed by
// hook kind. Each handler below is a byte-for-byte relocation of its former
// switch case's body (including every cast-and-comment pair, moved
// verbatim — those comments encode real latch semantics, e.g.
// `turnEndPingSent`/"absent ≠ cleared", not decoration), rewritten to read
// and write through the narrow `SessionHookContext` facade instead of a full
// `Session` instance.
//
// `SessionHookContext` is deliberately NOT `Session` itself: Session's own
// state fields stay `private`, and pty-manager.ts's `buildHookContext()`
// constructs one of these per emitHookEvent() call as a thin accessor
// facade (get/set pairs proxying the real private fields, methods
// forwarding to the real private methods) — see that method's own doc
// comment for why a plain `this` can't satisfy this interface (TypeScript
// rejects assigning a class with private members to a structurally-matching
// external interface). The set of members below is exactly the union of
// what the 24 handlers collectively touch — still a small fraction of
// Session's full surface (PTY spawn/attach/resize/kill, systemd unit
// management, the byte-driven attention machine, scrollback, state-file
// persistence, etc. are all absent here).
//
// The attention STATE MACHINE itself (advanceAttention/applyAttentionTransition
// and friends) is a separate, coupled follow-up per the roadmap item's own
// note — not touched by this PR.

import type {
  HookMessage,
  HookMessageKind,
  NotificationHookMessage,
  ProgressHookMessage,
  FileChangeHookMessage,
  ReviewGateHookMessage,
  PromoteRequestHookMessage,
  PermissionRequestHookMessage,
  StopFailureHookMessage,
  ToolFailureHookMessage,
  SessionEndHookMessage,
  PlanReadyHookMessage,
  GitBranchHookMessage,
  CwdChangedHookMessage,
  CompactHookMessage,
  SubagentHookMessage,
  ElicitationHookMessage,
  QuestionHookMessage,
  TodoHookMessage,
  SessionDiffHookMessage,
  ToolDoneHookMessage,
  BackgroundTask,
} from "./hook-protocol.js";
import type { AttentionSignalKind } from "./attention-detect.js";
import type { NotificationEvent } from "../shared/types.js";
import { isPathGitIgnoredCached } from "./git-ignore.js";

/**
 * Narrow view of `Session` that the hook handlers below operate over — see
 * this file's header comment for why this exists instead of `Session`
 * itself. Every member here is read and/or written by at least one handler;
 * nothing is included "just in case."
 */
export interface SessionHookContext {
  readonly id: string;
  readonly cwd: string;
  liveCwd: string | null;
  liveBranch: string | null;
  fileChangeQueue: Promise<void>;
  readonly gitIgnoreDirCache: Map<string, boolean>;

  gateState: "idle" | "waiting" | "approved" | "denied";
  gatePrompt: string | null;
  gateAt: number | null;

  promoteState: "idle" | "pending" | "accepted" | "declined";
  promoteSummary: string | null;
  promoteSuggestedBaseRef: string | null;
  promoteAt: number | null;

  permissionState: "idle" | "pending";
  permissionAt: number | null;
  pendingPermissionTool: string | null;

  planState: "idle" | "pending";
  planAt: number | null;

  questionState: "idle" | "pending";
  questionHeader: string | null;
  questionAt: number | null;

  elicitationState: "idle" | "pending";
  elicitationServer: string | null;
  elicitationAt: number | null;

  errorState: "idle" | "api_error" | "tool_failure";
  errorAt: number | null;
  errorDetail: string | null;

  lastAssistantMessage: string | null;
  lastTurnEndedAt: number | null;
  turnEndPingSent: boolean;

  backgroundTasks: BackgroundTask[];
  backgroundTasksAt: number | null;

  compactState: "idle" | "compacting";
  compactAt: number | null;

  subagentCount: number;
  subagentCountAt: number | null;

  endedReason: string | null;
  exitCode: number | null;

  emitEvent(kind: NotificationEvent["kind"], payload: Record<string, unknown>): void;
  emitAttentionSignalWithExtras(
    kind: Extract<
      AttentionSignalKind,
      | "hookNotification"
      | "reviewGate"
      | "promoteRequest"
      | "permissionRequest"
      | "planReady"
      | "elicitation"
      | "question"
    >,
    extras: Record<string, unknown>,
  ): void;
  clearIfConfirmedKind(kind: AttentionSignalKind): void;
  resolveDeferredTurnEnd(): void;
  setBackgroundTasks(tasks: BackgroundTask[]): void;
  bumpSubagentActivity(agentId: string, kind: "file_change" | "tool_failure"): void;
  recordSubagentStart(agentId: string, agentType: string | null, now: number): void;
  recordSubagentStop(agentId: string, summary: string | null, now: number): void;
}

export type HookHandler = (ctx: SessionHookContext, message: HookMessage) => void;

/**
 * Keyed by `HookMessageKind`. A plain `Map` rather than an object literal —
 * `message.kind` is attacker/adapter-controlled text (that's the whole point
 * of `UnknownHookMessage`'s fallback shape), so an object-literal lookup
 * (`HOOK_HANDLERS[message.kind]`) would walk the prototype chain for a kind
 * like `"constructor"`/`"toString"`/`"__proto__"` and could invoke an
 * unrelated `Object.prototype` member. `Map.get` has no such hazard. A kind
 * with no entry (`"browser_action"`, which no case ever handled, or any
 * future/unrecognized kind) yields `undefined` — Session.emitHookEvent
 * (pty-manager.ts) treats that as a silent no-op, same as the original
 * switch's `default: return`.
 */
export const HOOK_HANDLERS: ReadonlyMap<string, HookHandler> = new Map<string, HookHandler>([
  [
    "notification",
    (ctx, message) => {
      // Unlike the original switch case (narrowed to `NotificationHookMessage
      // | UnknownHookMessage` by the switch's own discriminant check on
      // `message.kind`), a standalone handler function gets no such
      // narrowing — `message` here is the full `HookMessage` union, most of
      // whose members lack `title`/`body`. Cast is new to this extraction
      // (the original case had none), safe for the same reason every other
      // per-kind cast in this file is: HOOK_HANDLERS is only ever indexed by
      // a kind matching this literal, so the runtime value is always really
      // a NotificationHookMessage.
      const notification = message as NotificationHookMessage;
      ctx.emitAttentionSignalWithExtras("hookNotification", {
        title: notification.title,
        body: notification.body,
      });
    },
  ],
  [
    "progress",
    (ctx, message) => {
      // Same TS-narrowing gap the review_gate/promote_request cases below
      // document: `UnknownHookMessage`'s `kind: string` (not a literal)
      // means the switch can't exclude it here, so a plain `message.<field>`
      // read stays widened rather than narrowing to ProgressHookMessage.
      // Safe to assert narrow — hook-protocol.ts's validateProgress only
      // ever produces a real ProgressHookMessage for this kind.
      const progress = message as ProgressHookMessage;
      const extras: Record<string, unknown> = { phase: progress.phase };
      if (progress.lastAssistantMessage !== undefined) {
        extras.lastAssistantMessage = progress.lastAssistantMessage;
        // Rich statuses — kept across turns, not just this event's extras;
        // see SessionInfo.lastAssistantMessage's doc comment.
        ctx.lastAssistantMessage = progress.lastAssistantMessage;
      }
      // Issue #428 — present-only update: a message with no
      // `backgroundTasks` field (e.g. Claude Code's `idle_prompt`
      // notification path, mapped to `phase: "done"` with nothing else)
      // must NOT wipe a previously-latched outstanding set. `absent ≠
      // cleared` — only overwrite when the hook actually reported a list.
      if (progress.backgroundTasks !== undefined) {
        extras.backgroundTasks = progress.backgroundTasks;
        ctx.setBackgroundTasks(progress.backgroundTasks);
      }
      if (progress.detail !== undefined) {
        extras.detail = progress.detail;
      }
      ctx.emitEvent("status_change", extras);
      // "done" is the agent's own authoritative "my turn is over" signal
      // (Claude Code's Stop hook, opencode's session.idle, codex/agy's
      // Stop — see forwarder-core.mjs/opencode-plugin.js) — the latch
      // below always fires on it. The ATTENTION signal is gated: firing
      // `agentIdle` (and hence a desktop notification/"needs_input") the
      // moment Stop arrives is wrong when `backgroundTasks` (issue #428)
      // still reports outstanding work — a background `Agent`/`Task` call
      // this same turn hasn't returned yet. See resolveDeferredTurnEnd()
      // for where the deferred ping actually fires once that work drains.
      if (progress.phase === "done") {
        // The agent's turn ending is the authoritative signal that any
        // pending permission request, plan review, or error condition has
        // been resolved (by the agent itself or by a human's intervening
        // action that ended the turn). Clear these sticky states so the
        // sidebar doesn't permanently show "Needs permission" / "Plan
        // ready" / "API error" after the agent has moved on. Unconditional
        // — none of these are affected by outstanding background work.
        ctx.permissionState = "idle";
        ctx.permissionAt = null;
        ctx.pendingPermissionTool = null;
        ctx.planState = "idle";
        ctx.planAt = null;
        ctx.questionState = "idle";
        ctx.questionHeader = null;
        ctx.questionAt = null;
        // Rich statuses — latches the `finished` status (see
        // SessionInfo.lastTurnEndedAt's doc comment for why this must be a
        // latch rather than read off attentionState.confirmedKind). Stays
        // an honest "the Stop hook fired" signal even while background
        // work is outstanding — session-status.ts's deriveSessionStatus is
        // where the two axes combine, not here.
        ctx.lastTurnEndedAt = Date.now();
        // A fresh latch is a NEW turn-end occurrence that deserves its
        // own single ping, even if a PRIOR latch's ping already fired and
        // the user hasn't typed anything since (Hermes review, PR #453 —
        // see turnEndPingSent's own doc comment).
        ctx.turnEndPingSent = false;
        ctx.resolveDeferredTurnEnd();
      } else if (progress.backgroundTasks !== undefined) {
        // Issue #428 — a non-"done" progress message isn't expected to
        // carry `backgroundTasks` per Claude Code's documented shape (only
        // Stop/SubagentStop do), but if a future/other adapter ever
        // reports a drain this way, resolve a still-latched prior Stop
        // rather than requiring the next "done" to catch it. Deliberately
        // NOT called on every plain thinking/generating message with no
        // `backgroundTasks` field — lastTurnEndedAt only clears via
        // turn_start/write()'s genuine-input check, and re-checking it on
        // every unrelated progress tick would risk re-firing `agentIdle`
        // for an agent whose forwarder never sends turn_start.
        ctx.resolveDeferredTurnEnd();
      }
      // Any progress signal (thinking/generating/done) proves the agent
      // loop is alive and advancing — a previous tool failure was either
      // handled or superseded by the agent's own recovery, so the error
      // state is no longer current.
      ctx.errorState = "idle";
      ctx.errorAt = null;
      ctx.errorDetail = null;
    },
  ],
  [
    "file_change",
    (ctx, message) => {
      // Issue: sidebar worktree display's Part B — a git-ignored path (most
      // commonly something under this repo's own `.claude/`, per that
      // issue's motivating case) shouldn't surface as a Row 4 chip.
      // `message.path` isn't normalized by the forwarder (Claude Code sends
      // an absolute path, Codex's apply_patch-derived one is relative —
      // see forwarder-core.mjs) — isPathGitIgnoredCached resolves it
      // against `root` itself. `root` prefers the live cwd (a worktree the
      // shell has since `cd`'d into) over the static spawn cwd, same
      // precedence as everywhere else liveCwd overrides cwd.
      // `UnknownHookMessage`'s fallback shape (`kind: string`) means TS
      // can't discriminate this down to `FileChangeHookMessage` from
      // `message.kind` alone — same explicit-cast gap the `review_gate`
      // case below documents; safe for the same reason (hook-protocol.ts's
      // validateFileChange only ever produces a real FileChangeHookMessage
      // for this kind).
      const fileChange = message as FileChangeHookMessage;
      const root = ctx.liveCwd ?? ctx.cwd;
      const { path: filePath, action, agentId } = fileChange;
      ctx.fileChangeQueue = ctx.fileChangeQueue
        .then(async () => {
          // B8(3) — memoized (gitIgnoreDirCache, this session's whole
          // lifetime) instead of a fresh `git check-ignore` subprocess
          // spawn every single call — see isPathGitIgnoredCached's own
          // doc comment for exactly what is and isn't safe to cache.
          const ignored = await isPathGitIgnoredCached(root, filePath, ctx.gitIgnoreDirCache);
          if (ignored) return;
          // Phase 5 (Track A) — attribute to the subagent that made this
          // change, if the hook carried one. Skipped for an ignored path
          // so the registry's fileChanges count matches what actually
          // surfaces in the sidebar/timeline.
          if (agentId !== undefined) ctx.bumpSubagentActivity(agentId, "file_change");
          ctx.emitEvent("file_change", { path: filePath, action, agentId: agentId ?? null });
        })
        // isPathGitIgnoredCached itself never rejects, but a listener this
        // event fans out to (emitEvent's eventListeners) might throw
        // synchronously — without this, that would leave
        // `fileChangeQueue` permanently rejected, silently dropping every
        // later file_change for this session (each new `.then()` on an
        // already-rejected promise stays rejected too).
        .catch((err) => {
          console.error(`[pty-manager] session ${ctx.id} file_change filter failed:`, err);
        });
    },
  ],
  [
    "review_gate",
    (ctx, message) => {
      // HookMessage's `UnknownHookMessage` fallback has a `kind: string`
      // (not a literal) plus a `[key: string]: unknown` index signature,
      // so TS can't discriminate `message` down to just
      // ReviewGateHookMessage from `message.kind === "review_gate"`
      // alone — reading `.state`/`.prompt` off the still-widened union
      // resolves to `unknown`. Safe to assert narrow here: the protocol
      // layer's validateReviewGate (hook-protocol.ts) only ever produces
      // a real ReviewGateHookMessage for this kind, never
      // UnknownHookMessage.
      const gate = message as ReviewGateHookMessage;
      ctx.gateState = gate.state;
      ctx.gatePrompt = gate.state === "waiting" ? gate.prompt : null;
      ctx.emitEvent("review_gate", { state: gate.state, prompt: gate.prompt });
      if (gate.state === "waiting") {
        ctx.gateAt = Date.now();
        ctx.emitAttentionSignalWithExtras("reviewGate", { prompt: gate.prompt });
      } else {
        // Follow-up to #275 (gap #3): a resolved state arriving over the
        // hook channel itself is as authoritative as resolveGate() below —
        // see this method's doc comment for why a superseding resolution is
        // now required at all (an OUTPUT_IMMUNE_KINDS-confirmed reviewGate
        // no longer clears on the tool call's own PTY output). Gated on
        // confirmedKind so a newer, unrelated confirmed flag isn't
        // dismissed by a stale gate resolution.
        ctx.gateAt = null;
        ctx.clearIfConfirmedKind("reviewGate");
      }
    },
  ],
  [
    "promote_request",
    (ctx, message) => {
      // Same TS-narrowing reasoning as the review_gate case above: safe to
      // assert narrow since hook-protocol.ts's validatePromoteRequest only
      // ever produces a real PromoteRequestHookMessage for this kind.
      const promote = message as PromoteRequestHookMessage;
      ctx.promoteState = "pending";
      ctx.promoteAt = Date.now();
      ctx.promoteSummary = promote.summary;
      ctx.promoteSuggestedBaseRef = promote.suggestedBaseRef ?? null;
      ctx.emitEvent("promote_request", {
        summary: promote.summary,
        suggestedBaseRef: promote.suggestedBaseRef ?? null,
      });
      ctx.emitAttentionSignalWithExtras("promoteRequest", { summary: promote.summary });
    },
  ],
  [
    "session_start",
    () => {
      // Answered directly by hooks.ts (it needs app.pty.consumeSeed, which
      // this Session-scoped method has no access to) — never reaches here.
      // See markHooksProven() below for how THIS kind still latches
      // `hooksProven`, despite bypassing this method entirely.
    },
  ],
  [
    "notification_resolved",
    (ctx) => {
      // Follow-up to #275 (gap #2) — opencode's permission.replied,
      // resolving a hookNotification-confirmed flag with no keystroke of
      // its own (an auto-approved permission) — see
      // NotificationResolvedHookMessage's doc comment in hook-protocol.ts.
      ctx.clearIfConfirmedKind("hookNotification");
    },
  ],
  [
    "permission_request",
    (ctx, message) => {
      const pr = message as PermissionRequestHookMessage;
      ctx.permissionState = "pending";
      ctx.permissionAt = Date.now();
      ctx.pendingPermissionTool = pr.tool;
      ctx.emitEvent("permission_request", { tool: pr.tool, summary: pr.summary });
      ctx.emitAttentionSignalWithExtras("permissionRequest", {
        tool: pr.tool,
        summary: pr.summary,
      });
    },
  ],
  [
    "stop_failure",
    (ctx, message) => {
      const sf = message as StopFailureHookMessage;
      ctx.errorState = "api_error";
      ctx.errorAt = Date.now();
      // Rich statuses — the short, stable label (see errorType's doc
      // comment in hook-protocol.ts), falling back to the free-text detail
      // when the adapter couldn't classify the failure.
      ctx.errorDetail = sf.errorType ?? sf.errorDetails ?? null;
      ctx.emitEvent("stop_failure", { error: sf.error, errorDetails: sf.errorDetails ?? null });
      ctx.emitAttentionSignalWithExtras("hookNotification", {
        title: "API Error",
        body: sf.error,
      });
    },
  ],
  [
    "tool_failure",
    (ctx, message) => {
      const tf = message as ToolFailureHookMessage;
      ctx.errorState = "tool_failure";
      ctx.errorAt = Date.now();
      // Rich statuses — prefer the adapter's own summary; fall back to
      // just naming the failing tool.
      ctx.errorDetail = tf.summary ?? tf.tool;
      // Phase 5 (Track A) — attribute to the subagent that hit this
      // failure, if the hook carried one.
      if (tf.agentId !== undefined) ctx.bumpSubagentActivity(tf.agentId, "tool_failure");
      ctx.emitEvent("tool_failure", {
        tool: tf.tool,
        error: tf.error,
        summary: tf.summary ?? null,
        agentId: tf.agentId ?? null,
      });
      ctx.emitAttentionSignalWithExtras("hookNotification", {
        title: `Tool failed: ${tf.tool}`,
        body: tf.error,
      });
    },
  ],
  [
    "session_end",
    (ctx, message) => {
      const se = message as SessionEndHookMessage;
      ctx.endedReason = se.reason;
      ctx.exitCode = se.exitCode ?? null;
      ctx.emitEvent("session_end", { reason: se.reason, exitCode: se.exitCode ?? null });
    },
  ],
  [
    "plan_ready",
    (ctx, message) => {
      const plan = message as PlanReadyHookMessage;
      ctx.planState = "pending";
      ctx.planAt = Date.now();
      ctx.emitEvent("plan_ready", {
        plan: plan.plan,
        filePath: plan.filePath ?? null,
        summary: plan.summary ?? null,
      });
      ctx.emitAttentionSignalWithExtras("planReady", {
        summary: plan.summary ?? plan.plan.slice(0, 100),
      });
    },
  ],
  [
    "git_branch",
    (ctx, message) => {
      // Issue: sidebar worktree detection — an agent reports its current
      // branch (opencode's vcs.branch.updated, or a Bash tool intercept
      // detecting git worktree add from any agent). Same TS-narrowing
      // reasoning as the review_gate case above.
      const gitBranch = message as GitBranchHookMessage;
      ctx.liveBranch = gitBranch.branch;
      // When the hook also carries a worktree path, update _liveCwd so
      // the cwd-resolution pipeline (resolveSessionCwdTargets,
      // getGitStatus) can resolve the branch from the worktree's actual
      // git state on the next poll cycle.
      if (gitBranch.worktree && gitBranch.worktree !== ctx.liveCwd) {
        ctx.liveCwd = gitBranch.worktree;
      }
      ctx.emitEvent("status_change", { phase: "done" });
    },
  ],
  [
    "cwd_changed",
    (ctx, message) => {
      // Issue: sidebar worktree detection — an agent reports a working
      // directory change via structured hooks instead of OSC 7 (Claude
      // Code's CwdChanged, agy's PreToolUse Cwd, Codex's common cwd).
      // Update _liveCwd so the cwd-resolution pipeline (resolveSessionCwdTargets,
      // readGitBranch, getGitStatus) picks up the new location. Emit a
      // status_change event so consumers don't need to wait for the next
      // polling cycle to see the updated directory.
      const cwdMsg = message as CwdChangedHookMessage;
      if (cwdMsg.cwd !== ctx.liveCwd) {
        ctx.liveCwd = cwdMsg.cwd;
        ctx.emitEvent("status_change", { phase: "done" });
      }
    },
  ],
  [
    "turn_start",
    (ctx) => {
      // Issue: extend surfaced session statuses — a deterministic "a new
      // turn genuinely started" signal (Claude Code's UserPromptSubmit,
      // remapped — see forwarder-core.mjs). Releases every observational
      // "awaiting_*" latch and the `finished` latch, same set
      // progress:done already releases (permissionState/planState) plus
      // the ones only this event can authoritatively clear
      // (elicitationState, lastTurnEndedAt). Mirrors progress:done's own
      // choice NOT to force-clear the attention machine's confirmedKind
      // directly — see that case's own comment for why (moreAuthoritativeKind
      // already keeps an immune kind from being silently downgraded;
      // session-status.ts's precedence order is what actually protects
      // against a stale confirmedKind here, not an explicit clear).
      ctx.permissionState = "idle";
      ctx.permissionAt = null;
      ctx.pendingPermissionTool = null;
      ctx.planState = "idle";
      ctx.planAt = null;
      ctx.elicitationState = "idle";
      ctx.elicitationServer = null;
      ctx.elicitationAt = null;
      ctx.questionState = "idle";
      ctx.questionHeader = null;
      ctx.questionAt = null;
      ctx.errorState = "idle";
      ctx.errorAt = null;
      ctx.errorDetail = null;
      ctx.lastTurnEndedAt = null;
      ctx.turnEndPingSent = false;
      // Issue #428 — a new turn invalidates the previous Stop's
      // backgroundTasks snapshot; Claude Code re-sends the full list on
      // the next Stop regardless, so there's nothing to preserve here.
      ctx.backgroundTasks = [];
      ctx.backgroundTasksAt = null;
      ctx.emitEvent("status_change", { phase: "generating" });
    },
  ],
  [
    "compact",
    (ctx, message) => {
      const compact = message as CompactHookMessage;
      ctx.compactState = compact.state === "started" ? "compacting" : "idle";
      if (compact.state === "started") {
        ctx.compactAt = Date.now();
      } else {
        ctx.compactAt = null;
      }
      ctx.emitEvent("status_change", {
        compacting: ctx.compactState === "compacting",
        trigger: compact.trigger ?? null,
      });
    },
  ],
  [
    "subagent",
    (ctx, message) => {
      const subagent = message as SubagentHookMessage;
      // Clamped at 0 defensively — a SubagentStop this session never saw a
      // matching SubagentStart for (e.g. one that started just before this
      // process restarted) must not drive the count negative.
      ctx.subagentCount = Math.max(0, ctx.subagentCount + (subagent.state === "started" ? 1 : -1));
      if (subagent.state === "started" && ctx.subagentCount > 0) {
        ctx.subagentCountAt = Date.now();
      } else if (subagent.state !== "started" && ctx.subagentCount === 0) {
        ctx.subagentCountAt = null;
      }
      // Phase 5 (Track A) — the registry is purely additive: it's only
      // populated when the hook carried an agentId (OpenCode's own
      // "subagent" events never do), so subagentCount above stays the
      // authoritative running count regardless of registry coverage.
      if (subagent.agentId !== undefined) {
        if (subagent.state === "started") {
          ctx.recordSubagentStart(subagent.agentId, subagent.agentType ?? null, Date.now());
        } else {
          ctx.recordSubagentStop(subagent.agentId, subagent.summary ?? null, Date.now());
        }
      }
      const subagentExtras: Record<string, unknown> = {
        subagentCount: ctx.subagentCount,
        agentType: subagent.agentType ?? null,
        agentId: subagent.agentId ?? null,
        // Named distinctly from the stale-blocked-clear branch's own
        // `state: "subagentCount"` (which names the FIELD that was
        // cleared, not a transition) — this one is the subagent's own
        // started/finished transition, so eventDescriptions.ts can
        // render it without the two meanings colliding on one key.
        subagentState: subagent.state,
      };
      // Issue #428 — SubagentStop is the ONLY drain signal for a
      // background subagent's own outstanding work: the parent's turn has
      // already ended by the time this fires (that's the whole point of a
      // background Agent/Task call), so no further "progress" message
      // will ever report the list shrinking. Same present-only-update
      // guard as the "progress" case — and the same reason
      // resolveDeferredTurnEnd() is called ONLY inside this guard, not
      // unconditionally for every subagent message: a plain
      // "started"/"finished" event with no backgroundTasks field (the
      // ordinary case) changes nothing about outstanding work, so calling
      // it unconditionally would re-fire `agentIdle` for an
      // already-resolved turn end the moment any unrelated subagent
      // activity arrives afterward (Hermes review, PR #453).
      let carriesBackgroundTasks = false;
      if (subagent.backgroundTasks !== undefined) {
        carriesBackgroundTasks = true;
        subagentExtras.backgroundTasks = subagent.backgroundTasks;
        ctx.setBackgroundTasks(subagent.backgroundTasks);
      }
      ctx.emitEvent("status_change", subagentExtras);
      if (carriesBackgroundTasks) ctx.resolveDeferredTurnEnd();
    },
  ],
  [
    "elicitation",
    (ctx, message) => {
      const elicitation = message as ElicitationHookMessage;
      if (elicitation.state === "started") {
        ctx.elicitationState = "pending";
        ctx.elicitationAt = Date.now();
        ctx.elicitationServer = elicitation.server ?? null;
        ctx.emitEvent("elicitation", { state: "started", server: elicitation.server ?? null });
        ctx.emitAttentionSignalWithExtras("elicitation", { server: elicitation.server ?? null });
      } else {
        ctx.elicitationState = "idle";
        ctx.elicitationServer = null;
        ctx.elicitationAt = null;
        ctx.emitEvent("elicitation", { state: "finished" });
        // Same "resolution over the hook channel itself is as
        // authoritative as a REST decision" reasoning as review_gate's own
        // non-waiting branch above.
        ctx.clearIfConfirmedKind("elicitation");
      }
    },
  ],
  [
    "question",
    (ctx, message) => {
      const q = message as QuestionHookMessage;
      if (q.state === "started") {
        ctx.questionState = "pending";
        ctx.questionHeader = q.header ?? null;
        ctx.questionAt = Date.now();
        ctx.emitEvent("question", {
          state: "started",
          header: q.header ?? null,
          summary: q.summary ?? null,
        });
        ctx.emitAttentionSignalWithExtras("question", { header: q.header ?? null });
      } else {
        ctx.questionState = "idle";
        ctx.questionHeader = null;
        ctx.questionAt = null;
        ctx.emitEvent("question", { state: "finished" });
        ctx.clearIfConfirmedKind("question");
      }
    },
  ],
  [
    "todo",
    (ctx, message) => {
      const todo = message as TodoHookMessage;
      ctx.emitEvent("todo", {
        content: todo.content,
        status: todo.status,
        priority: todo.priority,
      });
    },
  ],
  [
    "session_diff",
    (ctx, message) => {
      const sd = message as SessionDiffHookMessage;
      ctx.emitEvent("session_diff", { files: sd.files });
    },
  ],
  [
    "permission_resolved",
    (ctx) => {
      // See PermissionResolvedHookMessage's doc comment (hook-protocol.ts)
      // — a possible EXTRA release path for a pending permission_request,
      // never asserted as the only one (Claude Code's PermissionDenied can
      // fire with no preceding PermissionRequest at all, per its own
      // docs). Safe to clear unconditionally either way: if nothing was
      // pending, this is a no-op.
      ctx.permissionState = "idle";
      ctx.permissionAt = null;
      ctx.pendingPermissionTool = null;
      ctx.clearIfConfirmedKind("permissionRequest");
    },
  ],
  [
    "plan_resolved",
    (ctx) => {
      ctx.planState = "idle";
      ctx.planAt = null;
      ctx.clearIfConfirmedKind("planReady");
    },
  ],
  [
    "tool_done",
    (ctx, message) => {
      // Fix: status-clearing-semantics — a completed tool call is forward-
      // progress evidence: it means the agent is running again, which
      // clears a stale errorState (same "the agent recovered" reasoning
      // the "progress" case above already applies), and — matched by tool
      // NAME, since Claude Code has no dedicated "permission granted" hook
      // — can release a pending permission/plan that was waiting on THIS
      // tool specifically.
      //
      // Deliberately NOT a release for gateState/promoteState (Mullion's
      // own dialogs, resolved over REST — see resolveGate/resolvePromote)
      // or elicitationState (already correctly resolved by
      // ElicitationResult — see that case above); touching either here
      // would be premature, since the agent can genuinely still be
      // parked inside one of those while an unrelated tool_done arrives.
      const td = message as ToolDoneHookMessage;
      let changed = false;
      if (ctx.errorState !== "idle") {
        ctx.errorState = "idle";
        ctx.errorAt = null;
        ctx.errorDetail = null;
        changed = true;
      }
      // Tool-name matching, not a request id (the hook payloads don't
      // carry one). Accepted residual edge: two same-named tools in one
      // parallel batch (e.g. two concurrent Bash calls, one awaiting
      // permission, one completing) can release early. Narrowing further
      // would need a permission-request id Claude Code doesn't send.
      if (
        ctx.permissionState === "pending" &&
        (ctx.pendingPermissionTool === null || ctx.pendingPermissionTool === td.tool)
      ) {
        ctx.permissionState = "idle";
        ctx.permissionAt = null;
        ctx.pendingPermissionTool = null;
        ctx.clearIfConfirmedKind("permissionRequest");
        changed = true;
      }
      // ExitPlanMode resolving its own plan is the release path — see the
      // PostToolUse matcher's own comment in hook-adapters/claude-code.ts
      // for why this is unverified as an actual Claude Code behavior; the
      // progress:done release above still backstops planState regardless.
      if (td.tool === "ExitPlanMode" && ctx.planState === "pending") {
        ctx.planState = "idle";
        ctx.planAt = null;
        ctx.clearIfConfirmedKind("planReady");
        changed = true;
      }
      if (changed) ctx.emitEvent("status_change", { reason: "tool_done", tool: td.tool });
    },
  ],
]);

export type { HookMessageKind };
