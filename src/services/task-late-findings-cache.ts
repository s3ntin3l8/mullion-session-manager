/**
 * The late-findings sweep's per-task read caches. A leaf module (no imports)
 * so `test/setup.ts` can reset them without loading the sweep's dependency
 * graph before a test file's own `vi.mock` calls take effect.
 */

/**
 * What the last successful late read looked at, per task. A re-read with the
 * same key cannot find anything new (an exited reviewer writes nothing more; a
 * finished one only writes in a new turn, which moves `turnEndedAt`), so it is
 * skipped instead of paying a (possibly remote) read on every tick. In-memory:
 * a restart costs at most one extra read per task.
 */
export const lastLateReadKey = new Map<number, string>();

/** Per task: `<sessionId>:<sha256>` of the last unstructured late file seen. */
export const ignoredUnstructured = new Map<number, string>();

/** How many times in a row a throwing late ingest is retried on every tick. */
export const MAX_LATE_INGEST_ATTEMPTS = 3;

/** First wait after the per-tick attempts are spent; it doubles per failure. */
export const LATE_INGEST_RETRY_BASE_MS = 60_000;

/** The wait never grows past this: a long outage is still retried. */
export const LATE_INGEST_RETRY_MAX_MS = 15 * 60_000;

/**
 * Per task: consecutive ingest failures for one read key, and (once `count`
 * reaches `MAX_LATE_INGEST_ATTEMPTS`) the time before which the file is not
 * read or ingested again. The key is never recorded in `lastLateReadKey` for a
 * failure, so the file is never dropped: it is retried on a growing interval
 * until an ingest succeeds or the key moves (a new turn end or verdict).
 */
export const lateIngestFailures = new Map<
  number,
  { key: string; count: number; nextAttemptAt: number }
>();

/** Test hook: forget every remembered late-read key and ignored file hash. */
export function resetLateFindingsCaches(): void {
  lastLateReadKey.clear();
  ignoredUnstructured.clear();
  lateIngestFailures.clear();
}

/**
 * Drop all three caches' entries (`lastLateReadKey`, `ignoredUnstructured`,
 * `lateIngestFailures`) for every task not in `latchedTaskIds` (the
 * `reviewing` tasks whose inconclusive verdict is still latched): a task that
 * left `reviewing`, or whose latch was cleared, has nothing left to re-read.
 */
export function pruneLateFindingsCaches(latchedTaskIds: ReadonlySet<number>): void {
  for (const id of [...lastLateReadKey.keys()]) {
    if (!latchedTaskIds.has(id)) lastLateReadKey.delete(id);
  }
  for (const id of [...ignoredUnstructured.keys()]) {
    if (!latchedTaskIds.has(id)) ignoredUnstructured.delete(id);
  }
  for (const id of [...lateIngestFailures.keys()]) {
    if (!latchedTaskIds.has(id)) lateIngestFailures.delete(id);
  }
}
