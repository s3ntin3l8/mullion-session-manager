// The Session-state restore sequence shared by its two callers (issue #1544),
// extracted from pty-manager.ts's Session.readStateFile() and spawn():
//
//   - readStateFile() — the constructor-time restore of a `.state.json` that
//     outlived the process (issue #323);
//   - spawn()'s reattach — re-applying the in-memory snapshot (collectState())
//     taken just before spawn() resets every latch to idle.
//
// The two used to be near-duplicate ~80-line blocks. They differ in exactly
// the ways named by {@link ApplyStoredStateOptions}; everything else is one
// sequence, applied in ONE fixed field order (the order is load-bearing for
// the gate-lapse emit — see `lapseWaitingGate`).
//
// Per-field `!== undefined` guards: readStateFile needs them (an older
// `.state.json` may lack a field). spawn()'s snapshot is complete by
// construction — collectState() assigns every StoredStateFields key from a
// non-undefined Session field — so the guards never skip anything there and
// applying them uniformly is behaviour-preserving (pinned by this module's
// test).
//
// NOT part of applyStoredState (readStateFile-only bookkeeping): stateRestored
// / restoredVersion / staleHooks.

import type { SessionInfo } from "./session-types.js";
import type { AttentionTracker } from "./attention-tracker.js";
import type { GateRegistry } from "./gate-registry.js";
import type { TerminalModeTracker, StoredTermModes } from "./terminal-mode-tracker.js";
import { advanceAttention } from "./attention-detect.js";
import { filterOutstandingBackgroundTasks } from "./background-tasks.js";

// Terminal-transport mode state (issue #93 one layer deeper). Deliberately NOT
// part of the `Pick<SessionInfo, ...>` below: these bytes are scrollback-replay
// plumbing, not UI-facing session state, so they must never leak into the
// `SessionInfo` API payload. Intersected onto StoredStateFields instead, and
// optional, so a `.state.json` written before this field existed still parses
// at schema `v: 1` and falls back to today's in-memory defaults (same posture
// as `subagents`'s `Array.isArray(s.subagents)` guard) — no version bump
// needed.
export type StoredStateFields = Pick<
  SessionInfo,
  | "permissionState"
  | "planState"
  | "errorState"
  | "errorAt"
  | "errorDetail"
  | "gateState"
  | "gatePrompt"
  | "promoteState"
  | "promoteSummary"
  | "promoteSuggestedBaseRef"
  | "attentionKind"
  | "compactState"
  | "subagentCount"
  | "subagents"
  | "elicitationState"
  | "elicitationServer"
  | "questionState"
  | "questionHeader"
  | "questionAt"
  | "lastTurnEndedAt"
  | "lastAssistantMessage"
  | "currentTodo"
  | "backgroundTasks"
> & {
  termModes?: StoredTermModes;
};

/** The plain Session fields applyStoredState assigns through `host.set`. */
type SetterKey =
  | "permissionState"
  | "planState"
  | "errorState"
  | "errorAt"
  | "errorDetail"
  | "promoteState"
  | "promoteSummary"
  | "promoteSuggestedBaseRef"
  | "compactState"
  | "subagentCount"
  | "subagents"
  | "elicitationState"
  | "elicitationServer"
  | "questionState"
  | "questionHeader"
  | "questionAt"
  | "lastAssistantMessage"
  | "currentTodo";

export type StoredFieldSetters = {
  [K in SetterKey]: (value: Exclude<StoredStateFields[K], undefined>) => void;
};

/** What applyStoredState needs from its owning Session. */
export interface StoredStateHost {
  set: StoredFieldSetters;
  attention: AttentionTracker;
  gates: GateRegistry;
  modes: TerminalModeTracker;
  emitEvent(kind: "review_gate", payload: Record<string, unknown>): void;
  /** H6 — baseline each non-idle latch's `*At` (Session.stampRestoredLatches). */
  stampRestoredLatches(): void;
}

export interface ApplyStoredStateOptions {
  /**
   * spawn()'s reattach only. A restored `gateState === "waiting"` is known
   * stale (issue #844: the hooks.ts socket/timer it depended on died with the
   * previous process, and no per-gate id survives to resolve individually), so
   * it is resolved to "lapsed" — prompt/at nulled, a `review_gate` "lapsed"
   * event emitted, the `reviewGate` attention kind cleared — AT THE GATE'S
   * POSITION in the field sequence (before promote and every later field is
   * applied), so a synchronous listener sees the same partial state as
   * before. When false (readStateFile, mid-constructor, before any event
   * subscription exists), a "waiting" gate is restored verbatim and silently.
   */
  lapseWaitingGate: boolean;
  /**
   * readStateFile only: re-signal the persisted `attentionKind` into the
   * attention machine so the UI sees what was pending. spawn() deliberately
   * does NOT — it has just reset the machine to INITIAL_ATTENTION_STATE and
   * lets its tick-based confirmations re-establish. A null kind is a no-op
   * either way.
   */
  restoreAttentionKind: boolean;
  /**
   * readStateFile only: restore `termModes` (alt-screen/mouse; bracketed paste
   * is forced false — see TerminalModeTracker.restore()). spawn() never
   * touches them: the tracker's modes deliberately persist across a respawn.
   */
  restoreTermModes: boolean;
}

export function applyStoredState(
  host: StoredStateHost,
  s: Partial<StoredStateFields>,
  opts: ApplyStoredStateOptions,
): void {
  const { set, attention, gates } = host;

  if (s.permissionState !== undefined) set.permissionState(s.permissionState);
  if (s.planState !== undefined) set.planState(s.planState);
  if (s.errorState !== undefined) set.errorState(s.errorState);
  if (s.errorAt !== undefined) set.errorAt(s.errorAt);
  if (s.errorDetail !== undefined) set.errorDetail(s.errorDetail);

  if (opts.lapseWaitingGate && s.gateState === "waiting") {
    gates.lapseRestoredSummary();
    host.emitEvent("review_gate", {
      state: "lapsed",
      reason: "Mullion restarted while this request was pending",
    });
    attention.clearIfConfirmedKind("reviewGate");
  } else {
    if (s.gateState !== undefined) gates.state = s.gateState;
    if (s.gatePrompt !== undefined) gates.prompt = s.gatePrompt;
  }

  if (s.promoteState !== undefined) set.promoteState(s.promoteState);
  if (s.promoteSummary !== undefined) set.promoteSummary(s.promoteSummary);
  if (s.promoteSuggestedBaseRef !== undefined) {
    set.promoteSuggestedBaseRef(s.promoteSuggestedBaseRef);
  }
  if (opts.restoreAttentionKind && s.attentionKind !== undefined && s.attentionKind !== null) {
    // We can't fully reconstruct the attention machine, but setting
    // confirmedKind signals to the UI what was pending. (null = explicitly
    // cleared — the machine is already idle.)
    attention.applyAttentionTransition(
      advanceAttention(attention.state, { type: "signal", kind: s.attentionKind, now: Date.now() }),
    );
  }
  if (s.compactState !== undefined) set.compactState(s.compactState);
  if (s.subagentCount !== undefined) set.subagentCount(s.subagentCount);
  // Phase 5 (Track A) — a state file written before the subagent registry
  // existed has no `subagents` key; `Array.isArray` also guards a corrupt
  // value (skip, don't throw).
  if (Array.isArray(s.subagents)) set.subagents(s.subagents);
  if (s.elicitationState !== undefined) set.elicitationState(s.elicitationState);
  if (s.elicitationServer !== undefined) set.elicitationServer(s.elicitationServer);
  if (s.questionState !== undefined) set.questionState(s.questionState);
  if (s.questionHeader !== undefined) set.questionHeader(s.questionHeader);
  if (s.questionAt !== undefined) set.questionAt(s.questionAt);
  if (s.lastTurnEndedAt !== undefined) attention.lastTurnEndedAt = s.lastTurnEndedAt;
  if (s.lastAssistantMessage !== undefined) set.lastAssistantMessage(s.lastAssistantMessage);
  if (s.currentTodo !== undefined) set.currentTodo(s.currentTodo);
  // Issue #428 — the persisted `backgroundTasksAt` itself is NOT restored (a
  // restored process shouldn't trust a pre-restart clock), but going through
  // setBackgroundTasks() re-stamps it to NOW when the restored list still has
  // outstanding entries, so the busy-TTL sweep has a baseline to measure from
  // (Hermes review, PR #453).
  if (Array.isArray(s.backgroundTasks)) attention.setBackgroundTasks(s.backgroundTasks);
  host.stampRestoredLatches();
  if (opts.restoreTermModes) host.modes.restore(s.termModes);
  // `turnEndPingSent` isn't persisted either, so it would otherwise restore to
  // its class default `false` — wrong when the restored state is an ended,
  // fully-drained turn (the ORIGINAL process already sent that ping; "not yet
  // sent" risks a duplicate "Finished"). Derived: already-pinged exactly when
  // the turn is latched AND nothing is outstanding — the same condition
  // resolveDeferredTurnEnd() checks before firing.
  if (attention.lastTurnEndedAt !== null) {
    attention.turnEndPingSent =
      filterOutstandingBackgroundTasks(attention.backgroundTasks).length === 0;
  }
}
