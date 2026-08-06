// Issue #249 / roadmap 7.5 — replay protection for HMAC-signed requests.
// Agent-role-only (see plugins/request-nonce.ts): the primary never verifies
// an inbound request today, only ever signs its own outbound ones, so
// nothing on the primary side needs a nonce store.
//
// In-memory, one instance per app (decorated onto it, not a module-level
// Map) — same per-instance-not-module-level reasoning as
// HostHeartbeatTracker: state must not leak across the many buildApp()
// instances a single test run creates. An agent restart empties this store,
// which re-opens the full ±DRIFT_WINDOW_MS replay window — bounded by the
// drift check itself, and no worse than the exposure any restart already
// has (a freshly-booted process has no memory of anything that happened
// before it).
// Hermes review, PR #531: TTL + periodic sweep bound this store to roughly
// (sustained request rate × TTL) entries, not literally unboundedly — but a
// leaked session id (the exact credential this whole feature exists to
// blunt the impact of) is all that's needed to pump fresh-timestamp,
// random-nonce requests into it at whatever rate the surrounding rate
// limiter allows, across every /internal/* route independently. A hard cap
// closes that residual memory-growth surface without weakening the replay
// check itself: each entry is ~40 bytes, so even a generous cap costs only
// a few MB.
const MAX_NONCES = 100_000;

export class NonceStore {
  private seen = new Map<string, number>(); // nonce -> expiresAtMs

  /**
   * Returns true and records `nonce` if it hasn't been seen (or its prior
   * record has already expired); returns false — a replay — if it's still
   * live. Records-then-checks is not the shape here on purpose: a request
   * that fails a LATER check (e.g. an invalid signature) still burns its
   * nonce, so retrying the same nonce with a tampered body can't be used to
   * probe past this check on a second attempt.
   */
  checkAndRecord(nonce: string, ttlMs: number, now: number = Date.now()): boolean {
    const expiresAt = this.seen.get(nonce);
    if (expiresAt !== undefined && expiresAt > now) return false;
    // Evict the single oldest entry (Map iterates in insertion order) when
    // at capacity, rather than rejecting the incoming request outright —
    // a full store must never itself become a way to deny a legitimate,
    // correctly-signed request.
    if (this.seen.size >= MAX_NONCES) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(nonce, now + ttlMs);
    return true;
  }

  /** Drops expired entries — called on a periodic timer (request-nonce.ts),
   * not on every check, so this store stays bounded without a per-check
   * sweep cost. */
  sweep(now: number = Date.now()): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(nonce);
    }
  }

  /** Test-only introspection. */
  size(): number {
    return this.seen.size;
  }

  /** Test-only reset. */
  clearForTests(): void {
    this.seen.clear();
  }
}
