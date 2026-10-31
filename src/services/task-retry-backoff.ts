/**
 * One bounded, exponential-backoff retry ledger — the single implementation
 * behind every retry site in the Task Master reconciler.
 *
 * WHY THIS EXISTS: the reconciler had FOUR copies of the same shape (the
 * draft-PR, merge, release and auto-approve sweeps), each with its own
 * `Map`, its own `backoffMs(attempts)` helper and its own hand-rolled
 * oldest-entry eviction. The copies had already drifted apart:
 *
 *  - the draft-PR and auto-approve ledgers are keyed by task id, the release
 *    one by project id (the release sweep acts once per PROJECT per tick —
 *    a burst of N task merges coalesces into ONE release-PR merge attempt);
 *  - the merge ledger carries an extra optional field (`lastReassertedSha`,
 *    the head SHA a re-assert APPROVE was last posted for) that the other
 *    three have no use for;
 *  - each site has its own TTL and its own ceiling, and its own curve.
 *
 * and — the part that actually bites — the eviction was implemented TWICE
 * over: once inside a helper and once inline at each of the four call sites,
 * so whether a ledger stayed inside its cap depended on WHICH path reached
 * it. This module is the one place that decides any of that.
 *
 * WHAT IT DOES NOT DO: it knows nothing about tasks, projects, GitHub or
 * sweeps. It is a rate limiter over a key, and every policy decision (the
 * TTL, the ceiling, the cap, what a key means) stays with the call site —
 * which is why the four sites keep their own constants and their own
 * call-site helper names.
 */

/**
 * The state every retry site records per key.
 */
export interface RetryBackoffEntry {
  /** When the last attempt was made (epoch milliseconds). */
  lastAttemptedAt: number;
  /**
   * How many attempts have been made — stored POST-INCREMENT, so the count
   * is 1 after the very first attempt.
   */
  attempts: number;
}

/**
 * The per-site fields a ledger carries alongside the shared retry state.
 * The default is "no extra fields"; the merge site overrides it with its
 * own `lastReassertedSha`.
 */
export type RetryBackoffFields = Record<string, never>;

/**
 * How a ledger is configured. Every value is a policy the call site owns.
 */
export interface RetryBackoffOptions {
  /**
   * The base backoff interval in milliseconds — the wait after the FIRST
   * attempt. Every later wait doubles from here.
   */
  ttlMs: number;
  /**
   * The ceiling for the exponential backoff, in milliseconds. The backoff
   * doubles until it reaches this and then stays there — deliberately not a
   * give-up cap: a task that becomes resolvable again after a long time
   * must never be stranded forever.
   */
  maxTtlMs: number;
  /**
   * How many entries the ledger keeps. Recording an attempt for a key that
   * is not already present evicts the OLDEST entry first (a Map's iteration
   * order is its insertion order), so the ledger never grows past this.
   */
  maxEntries: number;
}

/**
 * Per-call options for {@link RetryBackoff.record}.
 */
export interface RetryBackoffRecordOptions<E extends object> {
  /**
   * An explicit attempt count, for the call sites that PIN the counter
   * instead of incrementing it: a permanent failure parks at the ceiling
   * (so it skips the doubling ramp), and a memoized write keeps the count
   * it read. Defaults to the recorded count plus one.
   */
  attempts?: number;
  /**
   * Per-site fields, merged over the ones already recorded. This is how the
   * merge site carries its `lastReassertedSha` without needing a fourth
   * ledger shape for it.
   */
  extra?: Partial<E>;
}

/**
 * A bounded retry ledger over a key.
 *
 * @typeParam K - what the ledger is keyed by (a task id, a project id, ...).
 * @typeParam E - the per-site fields carried alongside the retry state.
 */
export interface RetryBackoff<K, E extends object = RetryBackoffFields> {
  /** The recorded state for `key`, if any. */
  get(key: K): (RetryBackoffEntry & E) | undefined;
  /**
   * Whether an attempt may be made for `key` at `now` — true when nothing
   * has been recorded for it yet, or when the backoff window for the
   * recorded attempt count has elapsed.
   */
  shouldAttempt(key: K, now: number): boolean;
  /**
   * Records an attempt for `key` and returns the state it wrote.
   *
   * Records OPTIMISTICALLY, before the work the attempt implies has
   * happened: a caller records the attempt and then makes the call, so a
   * call that throws still counts as an attempt (the whole point of the
   * backoff is to bound how often a failing call is repeated).
   */
  record(key: K, now: number, options?: RetryBackoffRecordOptions<E>): RetryBackoffEntry & E;
  /**
   * Drops the entry for `key`, so the next attempt happens immediately
   * (the backoff is re-armed).
   */
  reset(key: K): void;
  /**
   * Drops the entry for `key` — the same operation as {@link reset}, under
   * the name the call sites use where the entry is obsolete rather than
   * merely backed off (a resolved task, a shipped release). Both names are
   * kept because the two call-site vocabularies this helper replaces
   * (`resetMergeBackoff` vs `clearMergeState`) are both real, and each call
   * site should keep reading the way it did before.
   */
  clear(key: K): void;
}

/**
 * Creates a bounded retry ledger.
 *
 * @param options - the policy: the base interval, its ceiling, and how many
 *   entries the ledger keeps.
 */
export function createRetryBackoff<K, E extends object = RetryBackoffFields>(
  options: RetryBackoffOptions,
): RetryBackoff<K, E> {
  const { ttlMs, maxTtlMs, maxEntries } = options;
  const entries = new Map<K, RetryBackoffEntry & E>();

  /**
   * The wait before the next attempt, given how many attempts have been
   * made.
   *
   * `attempts` is stored post-increment (1 after the very first attempt),
   * so the exponent is `attempts - 1` and the FIRST wait is exactly
   * `ttlMs` — using `attempts` directly here made the very first backoff
   * twice as long as the constant's name implies.
   */
  const backoffMs = (attempts: number): number => Math.min(ttlMs * 2 ** (attempts - 1), maxTtlMs);

  return {
    get(key) {
      return entries.get(key);
    },

    shouldAttempt(key, now) {
      const entry = entries.get(key);
      if (entry === undefined) return true;
      return now - entry.lastAttemptedAt >= backoffMs(entry.attempts);
    },

    record(key, now, recordOptions) {
      const existing = entries.get(key);
      // Oldest-first eviction, and only for a key that is not already
      // present: an entry that is still being retried must never be the
      // one evicted, or its backoff (and attempt count) would silently
      // reset under it.
      if (existing === undefined && entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      const attempts = recordOptions?.attempts ?? (existing?.attempts ?? 0) + 1;
      // The per-site fields already recorded survive this write unless the
      // caller overrides them — which is what lets the merge site keep the
      // SHA its last re-assert was posted for. The one cast is the generic
      // spread: TypeScript cannot see that `extra` holds the site's own
      // fields once they are merged into a fresh object.
      const entry = {
        ...(existing ?? { lastAttemptedAt: 0, attempts: 0 }),
        ...(recordOptions?.extra ?? {}),
        lastAttemptedAt: now,
        attempts,
      } as RetryBackoffEntry & E;
      entries.set(key, entry);
      return entry;
    },

    reset(key) {
      entries.delete(key);
    },

    clear(key) {
      entries.delete(key);
    },
  };
}
