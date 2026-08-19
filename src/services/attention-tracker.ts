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

/** Which hook-originated attention kinds get a settle window before they
 * ever reach the user, and how long. Deliberately separate from
 * attention-detect.ts's ATTENTION_CONFIRM_MS (which stays at 0 for every one
 * of these kinds, unchanged) — the two answer different questions. See this
 * class's own header comment for the full "why not just raise
 * ATTENTION_CONFIRM_MS" rationale; in short, `advanceAttention`'s single
 * `pendingKind` slot would let one deferred kind silently displace another
 * (Claude Code fires `hookNotification` alongside `permissionRequest`), and
 * its output-cancels-pending rule would kill `agentIdle` on the agent's own
 * post-Stop prompt redraw. Measured against 7 days of real session_events
 * (see the PR description): `permissionRequest` resolves in a mean of 26ms
 * when auto-approved (537/538 raised events), `toolFailure`/`apiError`
 * resolve on the agent's own very next output chunk (140/140), and
 * `agentIdle` flaps within ~3s when a background Task/Agent call reopens the
 * turn (465/517). Every other kind keeps firing immediately via
 * emitAttentionSignalWithExtras — they're either already zero-debounce by
 * construction (reviewGate/planReady/promoteRequest/elicitation/question —
 * see that method's own doc comment) or, for hookNotification specifically,
 * the generic catch-all Claude Code fires ALONGSIDE a specific kind, where
 * delaying it too would just duplicate the specific kind's own window for no
 * benefit. */
const ATTENTION_SETTLE_MS: Partial<Record<AttentionSignalKind, number>> = {
  permissionRequest: 2000,
  agentIdle: 3000,
  toolFailure: 2000,
  apiError: 2000,
};

/** One notification event kind + payload to emit alongside the eventual
 * "attention" event, in the same order Session's hook handlers already
 * produce them today (e.g. permission_request before attention) — see
 * emitAttentionSignalDeferred's doc comment. */
interface AlsoEmit {
  kind: NotificationEvent["kind"];
  payload: Record<string, unknown>;
}

interface DeferredEmit {
  extras: Record<string, unknown>;
  alsoEmit: AlsoEmit[];
  dueAt: number;
}

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

  // Kinds currently waiting out their ATTENTION_SETTLE_MS window before
  // ever reaching the user — keyed by kind, NOT a single slot, so two
  // deferred kinds legitimately in flight at once (see ATTENTION_SETTLE_MS's
  // own comment) each get their own timer and neither can silently displace
  // the other. Drained by drainDeferred() from the existing 500ms tick
  // (pty-manager.ts's ATTENTION_EVAL_INTERVAL_MS) — no new timer.
  private deferred = new Map<AttentionSignalKind, DeferredEmit>();

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
   *
   * Also cancels a still-PENDING deferred emit of this kind (see
   * ATTENTION_SETTLE_MS) — this is the primary way a deferred emit ever
   * dies before reaching the user: the machine itself hasn't seen the
   * signal yet (emitAttentionSignalDeferred doesn't touch `state` until the
   * window elapses), so the `state.state === "attention"` branch above
   * can't have fired for it. permission_resolved/plan_resolved/tool_done
   * (hook-handlers.ts) all call this on exactly the same kind they'd have
   * raised, which is what makes a genuinely-fast resolution — the 537/538
   * auto-approved opencode permissions the settle window exists for —
   * produce zero events at all rather than a race between "confirm" and
   * "clear".
   */
  clearIfConfirmedKind(kind: AttentionSignalKind): void {
    this.cancelDeferred(kind);
    if (this.state.state === "attention" && this.state.confirmedKind === kind) {
      this.applyAttentionTransition(
        advanceAttention(this.state, { type: "userInput", now: Date.now() }),
      );
    }
  }

  /** Drops a pending deferred emit for `kind` without emitting anything —
   * the settle window's cancel path. Safe to call whether or not `kind` is
   * actually pending. Public (not just used internally by
   * clearIfConfirmedKind above): pty-manager.ts's onData also calls this
   * directly for toolFailure/apiError, whose cancel IS a plain output chunk
   * rather than a resolved-decision hook message (see ATTENTION_SETTLE_MS's
   * own comment — "the agent recovered on its own next turn" needs no hook
   * round-trip to know that), and hook-handlers.ts's `progress` case calls
   * it for agentIdle on a `phase: "generating"` message (the agent resumed
   * work before the turn-complete ping ever fired). */
  cancelDeferred(kind: AttentionSignalKind): void {
    this.deferred.delete(kind);
  }

  /**
   * Fix: sticky needs_input (D2/D4) — an unconditional, kind-agnostic clear,
   * for a signal as authoritative as a genuine keystroke but that isn't one:
   * Claude Code's UserPromptSubmit (mapped to `turn_start`) is the
   * deterministic "a new turn genuinely started" signal, i.e. the human
   * just gave fresh input. Unlike clearIfConfirmedKind(), this isn't gated
   * on `kind` — a confirmedKind can be silently orphaned by a specific-vs-
   * generic hookNotification race (see attention-detect.ts's
   * GENERIC_IMMUNE_KINDS), at which point nothing will ever match it again;
   * `turn_start`'s own handler already unconditionally clears every other
   * per-state latch (permissionState/planState/questionState/...) for the
   * same reason. Routed through applyAttentionTransition (not a direct
   * state mutation) so the resulting `{attention:false}` is actually
   * emitted, same as write()'s own userInput clear.
   *
   * Also drops EVERY pending deferred emit, not just one kind — a fresh
   * human prompt (or a genuine keystroke, see write()) supersedes whatever
   * was still settling; none of it is worth surfacing once the user has
   * already moved the session forward themselves.
   */
  clearAttention(): void {
    this.deferred.clear();
    this.applyAttentionTransition(
      advanceAttention(this.state, { type: "userInput", now: Date.now() }),
    );
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
      | "toolFailure"
      | "apiError"
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

  /**
   * The settle-window counterpart to emitAttentionSignalWithExtras above,
   * for the kinds listed in ATTENTION_SETTLE_MS. Deliberately does NOT touch
   * `this.state`/advanceAttention at all yet — the machine, SessionInfo's
   * `attention`/`attentionAt`/`attentionKind`, the favicon badge, and every
   * NotificationEvent stay exactly as they were until drainDeferred() below
   * either confirms this (the window elapses untouched) or a resolution
   * arrives first and cancels it (cancelDeferred/clearIfConfirmedKind/
   * clearAttention) — in which case NOTHING is ever emitted: no attention
   * event, no `alsoEmit` event, no timeline row, no push, no DB row. That
   * silence is the point: it's how the 537-of-538 opencode permissions this
   * class was built to stop reporting (auto-approved in a measured mean of
   * 26ms, see ATTENTION_SETTLE_MS) disappear instead of flashing and
   * clearing.
   *
   * `alsoEmit` lets a caller (permission_request today) defer its own
   * structured NotificationEvent alongside the attention signal, so a
   * phantom permission produces no timeline row either — not just no bell
   * ring. Replaces any earlier still-pending deferred emit of the SAME
   * kind (a second permission_request for a different tool while the first
   * is still settling is exceedingly rare in practice, and "the newest
   * candidate wins" matches confirmAttention's own "refresh, don't queue"
   * semantics) — but never touches a DIFFERENT kind's own pending entry,
   * which is the whole reason `deferred` is a Map and not a single field.
   */
  emitAttentionSignalDeferred(
    kind: Extract<
      AttentionSignalKind,
      "permissionRequest" | "agentIdle" | "toolFailure" | "apiError"
    >,
    extras: Record<string, unknown>,
    alsoEmit: AlsoEmit[] = [],
  ): void {
    const settleMs = ATTENTION_SETTLE_MS[kind] ?? 0;
    this.deferred.set(kind, { extras, alsoEmit, dueAt: Date.now() + settleMs });
  }

  /**
   * Flushes every deferred emit whose settle window has elapsed. Called
   * from Session.tick() (pty-manager.ts), which already runs every
   * ATTENTION_EVAL_INTERVAL_MS (500ms) and already feeds the machine a
   * `{type:"tick"}` input — piggy-backing here means no second timer.
   *
   * Order matters and is deliberate: `alsoEmit` first (so a flushed
   * permission_request's own NotificationEvent still precedes its
   * "attention" event, matching today's pre-settle-window ordering), THEN
   * advanceAttention sees the signal for the first time (so `state`/
   * SessionInfo.attention only change at the exact moment the user is
   * actually told — not 2-3s earlier when the hook message first arrived),
   * THEN the attention event itself. Skips applyAttentionTransition() for
   * the same reason emitAttentionSignalWithExtras does (see its own doc
   * comment): extras never fit AttentionEmit's fixed shape, and this is
   * already an always-emit call site, not a re-emit-suppressible one.
   */
  drainDeferred(now: number): void {
    for (const [kind, entry] of this.deferred) {
      if (entry.dueAt > now) continue;
      this.deferred.delete(kind);
      for (const also of entry.alsoEmit) this.host.emitEvent(also.kind, also.payload);
      this.state = advanceAttention(this.state, { type: "signal", kind, now }).next;
      this.host.emitEvent("attention", { attention: true, signal: kind, ...entry.extras });
    }
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
   * state is a no-op instead of a duplicate ping).
   *
   * Now schedules through emitAttentionSignalDeferred rather than firing
   * immediately — 465 of 517 measured turn-ends were flaps where a further
   * `progress: {phase: "generating"}` arrived within ~3s of this call (the
   * agent reopened the same turn, e.g. a background Task/Agent call this
   * class's own #428 doc comment already accounts for elsewhere). The
   * hook-handlers.ts `progress` case's non-"done" branch cancels this via
   * `ctx.cancelDeferred("agentIdle")` when that happens — see that call
   * site's own comment for why `turnEndPingSent` needs no extra handling on
   * cancel (every `done` message unconditionally resets it before calling
   * back in here, regardless of whether the PRIOR latch's ping fired,
   * settled, or was cancelled). */
  resolveDeferredTurnEnd(): void {
    if (this.lastTurnEndedAt === null) return;
    if (this.turnEndPingSent) return;
    if (filterOutstandingBackgroundTasks(this.backgroundTasks).length > 0) return;
    this.turnEndPingSent = true;
    this.emitAttentionSignalDeferred("agentIdle", {});
  }

  /** Drops every pending deferred emit with no attempt to emit anything —
   * distinct from clearAttention() (which also runs a real userInput
   * transition through the machine and emits {attention:false}). Called on
   * session exit (pty-manager.ts's exit path) and on respawn/reset
   * (alongside the existing `this.attention.state = INITIAL_ATTENTION_STATE`
   * reset there): a settling permission/tool-failure/turn-end ping for a
   * process that no longer exists, or is about to be replaced by a fresh
   * incarnation with `eventSeq`/state of its own, has nothing left to
   * settle FOR. */
  clearDeferred(): void {
    this.deferred.clear();
  }
}
