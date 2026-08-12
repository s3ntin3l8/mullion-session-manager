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
 * with no entry (an unmigrated case still on the switch below, `"browser_action"`,
 * or any future/unrecognized kind) yields `undefined` — dispatch falls
 * through to the switch, and eventually (once every case has migrated) is a
 * plain no-op, same as the original switch's `default: return`.
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
]);

export type { HookMessageKind };
