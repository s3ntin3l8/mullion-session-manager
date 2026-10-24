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
  | "workFinishedAt"
  | "lastAssistantMessage"
  | "currentTodo"
  | "backgroundTasks"
> & {
  termModes?: StoredTermModes;
  // Issue #1734 — Codex's session rollout file path, as reported by the
  // `SessionStart` hook's `transcript_path`. Deliberately NOT part of the
  // `Pick<SessionInfo, ...>` above: it is internal plumbing (it names a file
  // on this host), not UI-facing session state, so it must never leak into
  // the `SessionInfo` API payload — the same posture `termModes` takes.
  // Optional, so a `.state.json` written before this field existed still
  // parses and falls back to today's in-memory default.
  //
  // Restored so a codex session that survives a Mullion restart keeps being
  // watched: codex's `SessionStart` fires once per codex session, so without
  // this the rollout path — and with it the only visible rate-limit signal —
  // would be lost for the rest of that session's life.
  codexTranscriptPath?: string | null;
  // Issue #1734 — the codex home resolved ALONGSIDE that path. The path
  // alone is not enough: the session's own `CODEX_HOME` (which may differ
  // from the backend's) is not otherwise persisted, so a restored session
  // would resolve the BACKEND's home, reject its own stored path, and
  // silently stop being watched.
  codexTranscriptHome?: string | null;
  // Issue #1735 — who authored the current turn, as the CLI's turn-start hook
  // reported it. Deliberately NOT part of the `Pick<SessionInfo, ...>`
  // above: it is the latch's INPUT (see hook-protocol.ts's
  // turnSourceEndsTurn), not a user-facing status, so it must never leak
  // into the `SessionInfo` API payload — the same posture `termModes`
  // takes.
  //
  // Persisted so a session resumed from its state file keeps knowing who
  // authored the turn in flight: without it the restored session would treat
  // the next `progress: done` as an unknown-source turn end and latch it,
  // which is the very mid-loop advance this exists to prevent.
  turnPromptSource?: string | null;
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
  /**
   * Issue #1734 — restore Codex's session rollout path (see
   * StoredStateFields' own comment). Optional so a host that does not track
   * it simply skips the restore.
   */
  setCodexTranscriptPath?(path: string): void;
  /**
   * Issue #1734 — restore the codex home resolved alongside that path, so a
   * restored session keeps looking under the home its own codex ran under.
   */
  setCodexTranscriptHome?(home: string): void;
  /**
   * Issue #1735 — restore who authored the turn in flight, so a resumed
   * session's next `progress: done` is judged against the right source.
   */
  setTurnPromptSource?(source: string | null): void;
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
  // Issue #1735 — the "the work is done" signal, restored with the "a turn
  // ended" one: the reconciler's worker->review gate reads it, and a
  // restored session must reach the same conclusion it would have reached
  // before the restart.
  if (s.workFinishedAt !== undefined) attention.workFinishedAt = s.workFinishedAt;
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
  // Issue #1734 — Codex's rollout path. Restored on BOTH the readStateFile
  // and the spawn()-reattach paths: on a reattach the codex process (and so
  // its rollout file) is the SAME one, so the path is still correct; and
  // codex's `SessionStart` — which would otherwise be the only way to learn
  // it — does not fire again for a session that is already running.
  if (typeof s.codexTranscriptPath === "string" && s.codexTranscriptPath.length > 0) {
    host.setCodexTranscriptPath?.(s.codexTranscriptPath);
  }
  // The home is restored AFTER the path, so the path setter — which
  // resolves a home of its own — does not overwrite the persisted one.
  if (typeof s.codexTranscriptHome === "string" && s.codexTranscriptHome.length > 0) {
    host.setCodexTranscriptHome?.(s.codexTranscriptHome);
  }
  // Issue #1735 — who authored the turn in flight. Restored so a resumed
  // session judges its next `progress: done` against the right source: an
  // unknown source counts as "the work is done", but a machine-woken one
  // with a wakeup still pending does not — and that is exactly the
  // mid-loop advance this exists to prevent.
  if (typeof s.turnPromptSource === "string") {
    host.setTurnPromptSource?.(s.turnPromptSource);
  }
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
