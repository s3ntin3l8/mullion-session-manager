// Table-driven core of Session.clearStaleBlockedIfOlderThan (issue #320's
// blocked/busy staleness backstop), extracted from pty-manager.ts (issue
// #1544) to replace nine hand-repeated blocks. Behaviour is unchanged.
//
// Each latch is evaluated lazily and IN ORDER — active check, then staleness
// check, then its clear — never all predicates up front, because an earlier
// latch's clear emits an event (synchronous listeners may observe state) and
// a later latch's predicate reads live state (including the gate latch's
// resolve-as-lapsed loop, which nulls `gateAt`).

import type { AttentionSignalKind } from "./attention-detect.js";

export interface StaleLatch {
  /** The `state` carried by the emitted `stale_blocked_cleared` status_change. */
  name: string;
  /** "blocked" latches use the short blocked TTL, "busy" ones the longer busy TTL. */
  tier: "blocked" | "busy";
  /** Whether the latch is currently non-idle. */
  isActive(): boolean;
  /** The latch's own set-at timestamp (null = no baseline, never stale). */
  at(): number | null;
  /** Reset the latch's own fields. Runs BEFORE the attention clear and the emit. */
  clear(): void;
  /** The confirmed attention kind this latch owns, cleared once it is swept. */
  attentionKind?: AttentionSignalKind;
}

export interface StaleSweepContext {
  now: number;
  blockedMaxAgeMs: number;
  busyMaxAgeMs: number;
  /** Activity within this window of a latch's timestamp is part of the same
   *  triggering event (e.g. the dialog render after a hook), not new work. */
  graceMs: number;
  /** Read live (not snapshotted) so a clear's side effects are visible to later latches. */
  lastActivityAt(): number | null;
  clearAttention(kind: AttentionSignalKind): void;
  emit(name: string): void;
}

/**
 * A latch timestamp is stale when it is past `maxAgeMs` AND the agent hasn't
 * produced genuine new output since it was set.
 */
export function isLatchStale(
  at: number | null,
  maxAgeMs: number,
  now: number,
  lastActivityAt: number | null,
  graceMs: number,
): boolean {
  return (
    at !== null &&
    now - at >= maxAgeMs &&
    (lastActivityAt === null || lastActivityAt <= at + graceMs)
  );
}

/** Sweeps `latches` in order; returns true if any was cleared. */
export function sweepStaleLatches(latches: readonly StaleLatch[], ctx: StaleSweepContext): boolean {
  let changed = false;
  for (const latch of latches) {
    if (!latch.isActive()) continue;
    const maxAgeMs = latch.tier === "blocked" ? ctx.blockedMaxAgeMs : ctx.busyMaxAgeMs;
    if (!isLatchStale(latch.at(), maxAgeMs, ctx.now, ctx.lastActivityAt(), ctx.graceMs)) continue;
    latch.clear();
    if (latch.attentionKind !== undefined) ctx.clearAttention(latch.attentionKind);
    ctx.emit(latch.name);
    changed = true;
  }
  return changed;
}
