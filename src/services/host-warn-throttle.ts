// Throttles the log lines an unreachable remote host produces on every poll.
//
// A host that stays down is reported by every poller that touches it (git
// batch routes, live status, the reconciler, the stream fanouts), once per
// poll — about 25,000 lines a day for one host (#2753), which buries the
// warnings anyone is looking for. This logs the FIRST occurrence per
// (hostId, message) at the caller's level, swallows repeats for
// HOST_WARN_INTERVAL_MS, and carries a `suppressed` count on the next line
// that does get logged. `noteHostReachable` logs one `info` line when a
// throttled stream's host answers again and forgets that stream, so the next
// outage warns immediately.
//
// Entries live until the host answers again (`noteHostReachable`) or the host
// is deleted (`forgetHostWarnings`, called by the host-registry removal path);
// a host that stays down and registered keeps its few entries until restart.
//
// In-memory only: a restart costs at most one extra line per key. Behaviour
// of the callers is untouched — only whether a line is written changes.

import type { FastifyBaseLogger } from "fastify";

export const HOST_WARN_INTERVAL_MS = 10 * 60_000;

interface Entry {
  loggedAt: number;
  suppressed: number;
}

// hostId -> message -> state. Bounded by hosts x distinct messages.
const state = new Map<string, Map<string, Entry>>();

/**
 * Logs `message` at warn for `hostId` unless it was already logged for that
 * host within the last 10 minutes. Returns whether a line was written.
 */
export function warnHostThrottled(
  log: Pick<FastifyBaseLogger, "warn">,
  hostId: string,
  fields: Record<string, unknown>,
  message: string,
): boolean {
  const now = Date.now();
  let byMessage = state.get(hostId);
  if (!byMessage) {
    byMessage = new Map();
    state.set(hostId, byMessage);
  }
  const entry = byMessage.get(message);
  if (entry && now - entry.loggedAt < HOST_WARN_INTERVAL_MS) {
    entry.suppressed++;
    return false;
  }
  const suppressed = entry?.suppressed ?? 0;
  byMessage.set(message, { loggedAt: now, suppressed: 0 });
  log.warn(suppressed > 0 ? { ...fields, hostId, suppressed } : { ...fields, hostId }, message);
  return true;
}

/**
 * Call where a request to `hostId` just succeeded. If any of `messages` was
 * being throttled for that host, logs one `info` line and forgets them.
 * A no-op (no line, no allocation) for a host that never warned.
 */
export function noteHostReachable(
  log: Pick<FastifyBaseLogger, "info">,
  hostId: string,
  ...messages: string[]
): void {
  const byMessage = state.get(hostId);
  if (!byMessage) return;
  const cleared: string[] = [];
  let suppressed = 0;
  for (const message of messages) {
    const entry = byMessage.get(message);
    if (!entry) continue;
    cleared.push(message);
    suppressed += entry.suppressed;
    byMessage.delete(message);
  }
  if (byMessage.size === 0) state.delete(hostId);
  if (cleared.length === 0) return;
  log.info({ hostId, suppressed, recovered: cleared }, "host reachable again");
}

/** Drops every throttle entry for `hostId`; called when the host is deleted. */
export function forgetHostWarnings(hostId: string): void {
  state.delete(hostId);
}

/**
 * Per-poll tally for a loop that talks to a host once per item. A host counts
 * as recovered only when it answered at least one item and failed none: an item
 * the host rejects (a 4xx) lands in the same catch as an unreachable host, so
 * one success must not clear the throttle for a host that still has failures.
 */
export class HostOutcomes {
  private readonly succeeded = new Set<string>();
  private readonly failedHosts = new Set<string>();

  ok(hostId: string): void {
    this.succeeded.add(hostId);
  }

  failed(hostId: string): void {
    this.failedHosts.add(hostId);
  }

  /** Call once after the loop: reports recovery for the clean hosts only. */
  settle(log: Pick<FastifyBaseLogger, "info">, ...messages: string[]): void {
    for (const hostId of this.succeeded) {
      if (!this.failedHosts.has(hostId)) noteHostReachable(log, hostId, ...messages);
    }
  }
}

/** Test-only reset: the state is module-scope. */
export function resetHostWarnThrottle(): void {
  state.clear();
}
