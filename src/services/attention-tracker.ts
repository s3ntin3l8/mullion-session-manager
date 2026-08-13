// Extracted from pty-manager.ts (PR 33b, Wave 6 of the refactoring
// roadmap — the coupled follow-up to PR 33a's HOOK_HANDLERS extraction,
// hook-handlers.ts) — the attention state machine's own STATEFUL half: the
// machine's live state (`AttentionMachineState`) plus issue #428's
// outstanding-background-task tracking, and the handful of methods that
// mutate them (applyAttentionTransition/clearIfConfirmedKind/
// emitAttentionSignalWithExtras/setBackgroundTasks/resolveDeferredTurnEnd —
// byte-for-byte relocations of Session's former private methods of the same
// names, including every comment, moved verbatim: they document real latch
// semantics — `turnEndPingSent`, "absent ≠ cleared" — not decoration).
//
// advanceAttention() itself and the AttentionMachineState/AttentionTransition/
// AttentionSignalKind types stay in attention-detect.ts (the PURE,
// byte-parsing half — see that file's own header comment) entirely
// unchanged; this class is the stateful wrapper Session composes one
// instance of, same "hand it callbacks, don't let it reach into Session's
// private fields" shape as RedrawNudge (redraw-nudge.ts) — Session passes
// this class `emitEvent` (and its own `sessionId`, for the identical
// `console.debug` line applyAttentionTransition already produced) rather
// than this class importing Session or touching its private state directly.
// Mirrors RedrawNudge's/ScrollbackBuffer's/SessionStateFile's own posture:
// one instance per Session, mutated only from that Session's own
// single-threaded call sites (onData/tick/write/readStateFile/reset/
// buildHookContext/toInfo/collectState/clearStaleBlockedIfOlderThan) — no
// concurrent access to guard against. Fields are plain public properties,
// not get/set-wrapped, for the same reason Session's own inAltScreen/
// mouseTracking/detectCarry stay plain private fields: those call sites need
// direct read/write access to `state`/`backgroundTasks`/`backgroundTasksAt`/
// `lastTurnEndedAt`/`turnEndPingSent`, and advanceAttention()'s own
// transition-guards are what actually protect the invariants, not property
// encapsulation on top of them.
//
// Deliberately NOT included, despite being called from the SAME
// SessionHookContext (hook-handlers.ts) this class's methods are also
// reached through: bumpSubagentActivity/recordSubagentStart/
// recordSubagentStop and the `subagents` registry they maintain (Phase 5,
// Track A). None of those three methods ever read or write attentionState/
// backgroundTasks/lastTurnEndedAt/turnEndPingSent — they're a separate
// concern (subagent bookkeeping) that merely happens to share hook
// call-sites with the attention machine, not part of it — so they stay on
// Session unchanged, proxied by buildHookContext() exactly as before this
// PR.

import type { NotificationEvent } from "../shared/types.js";
import type { BackgroundTask } from "./hook-protocol.js";
import { filterOutstandingBackgroundTasks } from "./background-tasks.js";
import {
  advanceAttention,
  INITIAL_ATTENTION_STATE,
  type AttentionMachineState,
  type AttentionSignalKind,
  type AttentionTransition,
} from "./attention-detect.js";

/** Callbacks/identity Session provides so this class can log and emit
 * without owning the event ring buffer or state-file scheduling itself —
 * see this file's header comment for why this mirrors RedrawNudgeHost's
 * shape. */
export interface AttentionTrackerHost {
  readonly sessionId: string;
  emitEvent(kind: NotificationEvent["kind"], payload: Record<string, unknown>): void;
}

export class AttentionTracker {
  // The attention state machine's own state (issue #171/#98) — see
  // advanceAttention() in attention-detect.ts. Replaces the old bare
  // `attentionAt: number | null` field entirely: `attentionState.confirmedAt`
  // IS this session's public attentionAt (see toInfo()), folded into the
  // machine's state so there's only ever one timestamp to keep in sync.
  state: AttentionMachineState = INITIAL_ATTENTION_STATE;
  lastTurnEndedAt: number | null = null;
  // Issue #428 — see SessionInfo.backgroundTasks/.backgroundTasksAt's own
  // doc comments.
  backgroundTasks: BackgroundTask[] = [];
  backgroundTasksAt: number | null = null;
  // Issue #428 — one-shot guard for resolveDeferredTurnEnd()'s `agentIdle`
  // ping (Hermes review, PR #453): without this, a repeated hook message
  // reporting the SAME already-drained (or already-empty) backgroundTasks
  // state — a late/reordered SubagentStop, or a second progress:done with
  // no new information — would call resolveDeferredTurnEnd() again while
  // lastTurnEndedAt is still latched, re-firing a duplicate "Finished" ping
  // for a turn that already got its one. Scoped to the CURRENT latch: reset
  // to false everywhere lastTurnEndedAt is freshly set OR cleared, so the
  // next genuine turn end gets its own single ping.
  turnEndPingSent = false;

  constructor(private readonly host: AttentionTrackerHost) {}

  /**
   * Apply one advanceAttention() result: adopt the new machine state, turn
   * any `log` entries into debug lines (the issue's "add debug logging on
   * attention state transitions" ask — matches this file's existing
   * console.error(...) logging shape; Session has no Fastify logger to hang
   * this off, see spawn()'s own console.error call), and turn any `emit`
   * entries into real emitEvent("attention", ...) calls. The one place
   * onData/tick() ever touch `this.attentionState` — keeps every call site
   * from having to duplicate this bookkeeping.
   */
  applyAttentionTransition(transition: AttentionTransition): void {
    for (const entry of transition.log) {
      // Skip PENDING_ATTENTION churn (entering it from idle, or being
      // cancelled back to idle from it without ever confirming) — during
      // exactly the bursty-signal scenario issue #171 exists to fix, this
      // is by far the highest-frequency transition, and logging every one
      // would spam stdout at the same frequency this PR is suppressing
      // false positives for (console.debug bypasses pino's level filter
      // entirely — see spawn()'s console.error for why Session logs this
      // way at all). Only the meaningful edges — a signal actually
      // CONFIRMING attention, or a confirmed session actually CLEARING
      // back to idle — are worth a line.
      const isPendingChurn =
        entry.to === "pending_attention" ||
        (entry.from === "pending_attention" && entry.to === "idle");
      if (isPendingChurn) continue;
      console.debug(
        `[pty-manager] session ${this.host.sessionId} attention: ${entry.from} -> ${entry.to}` +
          (entry.kind ? ` (${entry.kind})` : ""),
      );
    }
    this.state = transition.next;
    // Spread into a plain object: AttentionEmit's fixed shape (no index
    // signature) doesn't structurally satisfy emitEvent's deliberately
    // loose Record<string, unknown> payload type otherwise.
    for (const emit of transition.emit) this.host.emitEvent("attention", { ...emit });
  }

  /**
   * Follow-up to #275 (gap #3): a delivered decision — resolveGate(),
   * resolvePromote(), or a resolved `review_gate` hook message — is a
   * superseding authoritative resolution, exactly as `userInput` is (see
   * write()), for the ONE kind of OUTPUT_IMMUNE_KINDS confirmation it
   * actually resolves. Gated on `kind` matching the CURRENT confirmedKind so
   * a decision arriving after a newer, unrelated confirmed flag has already
   * superseded it (e.g. a fresh hookNotification while a reviewGate
   * resolution is still in flight) doesn't wrongly dismiss that newer flag.
   * A no-op outside "attention" or for any other confirmedKind.
   */
  clearIfConfirmedKind(kind: AttentionSignalKind): void {
    if (this.state.state === "attention" && this.state.confirmedKind === kind) {
      this.applyAttentionTransition(
        advanceAttention(this.state, { type: "userInput", now: Date.now() }),
      );
    }
  }

  /**
   * Drives the attention state machine with a zero-threshold hook signal
   * (hookNotification/reviewGate — see ATTENTION_CONFIRM_MS) to keep
   * `attentionState`/`SessionInfo.attention` correct, and unconditionally
   * emits an "attention" event with `extras` merged into its payload —
   * deliberately NOT gated on whether the transition itself produced a new
   * `emit` entry. confirmAttention()'s `alreadyConfirmed` guard suppresses
   * emitting again when attention was already confirmed, which is correct
   * for the generic, content-free PTY-parsed signals applyAttentionTransition()
   * handles (a second bell while already confirmed is genuinely nothing
   * new) — but a hook notification's title/body (or a review_gate's prompt)
   * is never "nothing new": each one is distinct content the event feed
   * must surface even if the boolean itself was already true. Deliberately
   * does NOT go through applyAttentionTransition() above for this reason,
   * and also because AttentionEmit's fixed `{attention, signal}` shape has
   * no room for title/body/prompt anyway — threading hook-specific display
   * text through the otherwise-pure, byte-driven attention state machine
   * isn't worth it for two call sites. Skips the console.debug transition
   * logging applyAttentionTransition() does (kept only on the byte-driven
   * path). `agentIdle` reuses this same call site (rather than getting its
   * own): it carries no title/body/prompt of its own, but "the agent just
   * finished" is exactly as one-shot/deliberate as a hook notification or
   * review gate, so the same always-emit semantics apply — though unlike
   * `hookNotification`/`reviewGate`/`promoteRequest`, `agentIdle` is NOT one
   * of attention-detect.ts's OUTPUT_IMMUNE_KINDS (follow-up to #275, gap #3):
   * it stays output-clearable, since it's purely informational ("turn over")
   * rather than "blocked pending a human decision", and it's the only
   * attention trigger opencode/codex/agy have at all.
   */
  emitAttentionSignalWithExtras(
    kind: Extract<
      AttentionSignalKind,
      | "hookNotification"
      | "reviewGate"
      | "agentIdle"
      | "promoteRequest"
      | "permissionRequest"
      | "planReady"
      | "elicitation"
      | "question"
    >,
    extras: Record<string, unknown>,
  ): void {
    const transition = advanceAttention(this.state, {
      type: "signal",
      kind,
      now: Date.now(),
    });
    this.state = transition.next;
    this.host.emitEvent("attention", { attention: true, signal: kind, ...extras });
  }

  /** Issue #428 — the ONLY place `backgroundTasks`/`backgroundTasksAt` are
   * written. Called from both the "progress" and "subagent" hook cases,
   * each with their own present-only-update guard around the call (a
   * message with no `backgroundTasks` field must leave a previously-latched
   * outstanding set untouched). Re-stamps `backgroundTasksAt` on every call
   * that still has outstanding work, matching subagentCountAt's own
   * re-stamp-on-every-start (not just the initial idle -> busy transition)
   * precedent — the staleness sweep's silence window should reset on each
   * fresh report, not just the first. */
  setBackgroundTasks(tasks: BackgroundTask[]): void {
    this.backgroundTasks = tasks;
    this.backgroundTasksAt = filterOutstandingBackgroundTasks(tasks).length > 0 ? Date.now() : null;
  }

  /** Issue #428 — fires the deferred "turn really is over" attention ping.
   * `progress:done` always latches `lastTurnEndedAt` (see its own doc
   * comment: that stays an honest "the Stop hook fired" signal regardless
   * of outstanding background work), but firing `agentIdle` right then would
   * be the premature ping issue #428 is about, when a background
   * `Agent`/`Task` call from this same turn hasn't returned yet. No-op
   * unless the turn has already ended, nothing outstanding remains, AND the
   * ping for THIS latch hasn't already fired (`turnEndPingSent` — see its
   * own doc comment; Hermes review, PR #453) — safe to call unconditionally
   * after any `backgroundTasks` update (a plain Stop with no background work
   * resolves it immediately; a SubagentStop or the staleness sweep resolves
   * it late instead of never; a repeated report of the same already-drained
   * state is a no-op instead of a duplicate ping). */
  resolveDeferredTurnEnd(): void {
    if (this.lastTurnEndedAt === null) return;
    if (this.turnEndPingSent) return;
    if (filterOutstandingBackgroundTasks(this.backgroundTasks).length > 0) return;
    this.turnEndPingSent = true;
    this.emitAttentionSignalWithExtras("agentIdle", {});
  }
}
