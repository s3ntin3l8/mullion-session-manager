// The live review-gate registry for one Session (Phase 2, issue #178;
// concurrent-gate correlation per Hermes review, PR #912). Extracted from
// pty-manager.ts's Session (issue #1544); behaviour is unchanged.
//
// `state`/`prompt`/`at` are DERIVED SUMMARIES, not the source of truth: the
// real, live set of currently-waiting gates is `pending` — an in-memory-only
// map (deliberately NOT persisted; a restart drops it by construction, same as
// hooks.ts's own pendingGates socket/timer map, so there is no live connection
// left to correlate a restored gate against). `state` reflects whether
// `pending.size > 0` ("waiting") or the last resolved outcome; `prompt`/`at`
// mirror the OLDEST still-waiting gate (or null once none remain) for every
// consumer that only ever needed one representative gate. The summary fields
// are public and mutable on purpose: the hook context (hook-handlers.ts) and
// Session's restore/reset paths write them directly.

export type GateState = "idle" | "waiting" | "approved" | "denied" | "lapsed";
export type GateDecision = "approved" | "denied" | "lapsed";

/** What the registry needs from its owning Session — injected so the emit /
 *  attention-clear order stays exactly where Session had it. */
export interface GateRegistryHost {
  emitEvent(kind: "review_gate", payload: Record<string, unknown>): void;
  /** Clears the `reviewGate` attention kind if (and only if) it is the confirmed one. */
  clearReviewGateAttention(): void;
}

export class GateRegistry {
  state: GateState = "idle";
  prompt: string | null = null;
  at: number | null = null;
  private readonly pending = new Map<string, { prompt: string; at: number }>();

  constructor(private readonly host: GateRegistryHost) {}

  /**
   * Registers a newly-waiting gate. `state` becomes "waiting" on the FIRST
   * gate and stays so for every later one; `prompt`/`at` are set ONLY on that
   * first arrival — a second/third gate must not swap the displayed prompt to
   * a newer one, nor reset "waiting since" for the OLDEST gate (which the
   * stale sweep's TTL is measured against). Does not raise attention — the
   * caller does.
   */
  register(gateId: string, prompt: string): void {
    const isFirstGate = this.pending.size === 0;
    this.pending.set(gateId, { prompt, at: Date.now() });
    this.state = "waiting";
    if (isFirstGate) {
      this.prompt = prompt;
      this.at = Date.now();
    }
  }

  /** Ids of every currently-waiting gate, oldest first. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /** The full live list, oldest first (SessionInfo.gates). */
  entries(): Array<{ gateId: string; prompt: string; at: number }> {
    return [...this.pending].map(([gateId, g]) => ({ gateId, prompt: g.prompt, at: g.at }));
  }

  /**
   * Resolves ONE pending gate by id; an unknown/already-resolved id is a
   * silent no-op. Emits `review_gate` with the resolved state, gateId, the
   * ORIGINAL prompt and (for a denial) `reason`. The summary and the attention
   * badge only update once the LAST gate resolves; while another is waiting
   * the summary re-points at the new oldest and attention is untouched.
   */
  resolve(gateId: string, decision: GateDecision, reason?: string): void {
    const pending = this.pending.get(gateId);
    if (!pending) return;
    this.pending.delete(gateId);
    this.host.emitEvent("review_gate", {
      state: decision,
      gateId,
      prompt: pending.prompt,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (this.pending.size === 0) {
      this.state = decision;
      this.prompt = null;
      this.at = null;
      this.host.clearReviewGateAttention();
    } else {
      // At least one other gate is still waiting — the summary now represents
      // the OLDEST of those (insertion order), not the one that just resolved.
      const oldest = this.pending.values().next().value!;
      this.prompt = oldest.prompt;
      this.at = oldest.at;
    }
  }

  /**
   * The stale sweep's clear (issue #320, M4/#1528): resolve every still-
   * pending gate as lapsed (the "nobody answered" outcome) so the live map
   * doesn't outlive the scalar summary, then reset the summary to idle.
   */
  clearStale(): void {
    for (const gateId of this.pendingIds()) {
      this.resolve(gateId, "lapsed", "stale gate cleared");
    }
    this.resetSummary();
  }

  /** Reset the derived summary to idle (spawn()'s fresh-session reset). Does
   *  not touch the live map — a brand-new Session's is empty already. */
  resetSummary(): void {
    this.state = "idle";
    this.at = null;
    this.prompt = null;
  }

  /** The restart-lapse (issue #844): a restored "waiting" summary is known
   *  stale (no per-gate id survives a restart to resolve individually). */
  lapseRestoredSummary(): void {
    this.state = "lapsed";
    this.prompt = null;
    this.at = null;
  }
}
