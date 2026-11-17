// Issue #3174 — the at-most-once ledger for a RETRIED hook delivery.
//
// The hook forwarder retries a `Stop` delivery that the socket refused (or
// whose connection closed before it was acknowledged) — see
// src/hooks/forwarder.mjs's own comment for why a Stop is the one hook whose
// loss is visible (a headless Task Master worker that has finished looks
// unfinished until its budget expires).
//
// A retry is only safe if the session cannot receive the same event twice:
// the first attempt may well have landed, with only its acknowledgement lost
// on the way back. So every retried delivery carries a delivery id, and the
// server remembers which (delivery id, message index) pairs it has already
// dispatched for a session. A repeat of a pair that is already on the ledger
// is acknowledged but NOT dispatched again.
//
// Deliberately in-memory and per app instance: the ledger exists to bridge
// the gap between two attempts of the SAME delivery, which happen within the
// forwarder's own retry bound (well under two minutes). A Mullion process
// that dies mid-delivery loses the ledger along with the session state it
// describes, so there is nothing to restore — and nothing to persist.
//
// The ledger is keyed per session rather than globally so that the per-session
// cap below bounds what one long-lived session can accumulate.
//
// There is deliberately NO explicit "forget this session" entry point. A dead
// session's hook token stops resolving (see PtyManager.kill(), which drops
// the token from its map), so a late retry of one of its deliveries is
// refused at the handshake and never reaches the ledger — those entries would
// only ever be dead weight. Wiring such a hook into session teardown would
// also have to be placed exactly right: PtyManager.kill() is NOT terminal (a
// graceful redeploy leaves the agent process running), so forgetting a
// session there would drop the ledger of a session that is still alive and
// possibly still retrying its `Stop` — which is precisely the duplicate this
// ledger exists to prevent. The TTL sweep in claim() is what actually bounds
// the memory: it drops every expired entry of every session, so a session
// that stopped delivering long ago does not sit in memory until the process
// restarts.

/** How long a delivery id stays on the ledger. Comfortably longer than the
 * forwarder's own retry bound (~97s in the worst case, see
 * STOP_RETRY_DELAYS_MS in src/hooks/forwarder.mjs), so a retry can never be
 * mistaken for a first attempt — and short enough that a session's ledger
 * does not grow without bound over a long-lived session's lifetime. */
const DEFAULT_TTL_MS = 5 * 60_000;

/** How many delivery keys one session may hold. A `Stop` delivery carries
 * one or two messages (a `progress` and, for an error-terminated turn, a
 * `stop_failure`), so this is a few hundred turns' worth of deliveries for a
 * single session — far more than the retry bound can ever need, while still
 * bounding the memory a long session holds. */
const DEFAULT_MAX_PER_SESSION = 256;

export interface HookDeliveryRegistryOptions {
  /** How long a claimed key stays claimed. */
  ttlMs?: number;
  /** How many keys one session may hold at a time. */
  maxPerSession?: number;
  /** Clock injection point for tests. */
  now?: () => number;
}

export class HookDeliveryRegistry {
  /** session id -> (delivery key -> expiry timestamp). A Map (rather than a
   * plain object) because its iteration order is insertion order, which is
   * what the per-session cap below relies on to evict the OLDEST entry. */
  private readonly seen = new Map<string, Map<string, number>>();

  private readonly ttlMs: number;
  private readonly maxPerSession: number;
  private readonly now: () => number;

  constructor(options: HookDeliveryRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPerSession = options.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Claims `deliveryKey` for `sessionId`.
   *
   * Returns TRUE when the key was not on the ledger before — the caller
   * should dispatch the message. Returns FALSE when it was already claimed —
   * the caller must NOT dispatch it again (this delivery already landed on
   * an earlier attempt) and should only acknowledge it.
   */
  claim(sessionId: string, deliveryKey: string): boolean {
    const now = this.now();
    // Sweep every session's expired entries first, not just this one's: the
    // ledger is in-memory and lives as long as the server does, so an entry
    // for a session that stopped delivering long ago would otherwise sit in
    // memory until the process restarts.
    this.pruneExpired(now);
    const forSession = this.seen.get(sessionId) ?? new Map<string, number>();
    if (forSession.has(deliveryKey)) return false;
    forSession.set(deliveryKey, now + this.ttlMs);
    // The cap keeps one long-lived session's ledger bounded. Insertion order
    // is eviction order, so the oldest entry goes first.
    while (forSession.size > this.maxPerSession) {
      const oldest = forSession.keys().next();
      if (oldest.done) break;
      forSession.delete(oldest.value);
    }
    this.seen.set(sessionId, forSession);
    return true;
  }

  /** Drops every entry whose TTL has passed, and every session left empty
   * by that sweep. This is the ledger's only memory bound — see this file's
   * own header for why there is no explicit per-session forget. */
  private pruneExpired(now: number): void {
    for (const [sessionId, forSession] of this.seen) {
      for (const [key, expiresAt] of forSession) {
        if (expiresAt <= now) forSession.delete(key);
      }
      if (forSession.size === 0) this.seen.delete(sessionId);
    }
  }
}
