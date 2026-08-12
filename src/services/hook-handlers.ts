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
  BackgroundTask,
} from "./hook-protocol.js";
import type { AttentionSignalKind } from "./attention-detect.js";
import type { NotificationEvent } from "../shared/types.js";

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
]);

export type { HookMessageKind };
