import type Database from "better-sqlite3";

/**
 * Compaction of Mullion's OWN SQLite database (`DATABASE_URL`), run after the
 * event-retention sweep deleted rows (src/services/event-store.ts). The
 * opencode database has its own, separate compaction (opencode-storage.ts);
 * this one differs because this process is the writer.
 *
 * Concurrency: the server has exactly one connection to this file, and
 * better-sqlite3 is synchronous, so a checkpoint or VACUUM here runs to
 * completion on the event loop — no request handler on the same connection can
 * interleave with it (they wait, they do not see SQLITE_BUSY). SQLITE_BUSY
 * can only come from ANOTHER process holding a lock (a reader pinning the WAL,
 * an external `sqlite3` shell). The `busy_timeout` is therefore lowered to a
 * short bound for the duration of each operation, so the event loop is never
 * stalled for the connection's usual 5 s on top of the work itself, and then
 * restored. A VACUUM that fails (busy, disk full) rolls back and leaves the
 * database as it was.
 */

export const COMPACTION_BUSY_TIMEOUT_MS = 500;
export const VACUUM_MIN_FREE_BYTES = 64 * 1024 * 1024;
export const VACUUM_MIN_FREE_FRACTION = 0.25;
export const VACUUM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CompactionOptions {
  minFreeBytes?: number;
  minFreeFraction?: number;
  minIntervalMs?: number;
  /** Injectable clock for the once-per-24h guard. */
  now?: () => number;
  busyTimeoutMs?: number;
}

export interface CompactionResult {
  /** `wal_checkpoint(TRUNCATE)` could not finish because a reader holds the WAL. */
  checkpointBusy: boolean;
  /** Set only when a VACUUM completed. */
  vacuumed?: { beforeBytes: number; afterBytes: number };
  /** A VACUUM was attempted but another connection held the file. */
  vacuumBusy: boolean;
}

export interface DbCompactor {
  compact: (sqlite: Database.Database) => CompactionResult;
}

function isBusy(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

function fileBytes(sqlite: Database.Database): number {
  const pages = sqlite.pragma("page_count", { simple: true }) as number;
  const size = sqlite.pragma("page_size", { simple: true }) as number;
  return pages * size;
}

/** The last-VACUUM timestamp lives in the closure, so a restart may VACUUM again (accepted). */
export function createDbCompactor(opts: CompactionOptions = {}): DbCompactor {
  const minFreeBytes = opts.minFreeBytes ?? VACUUM_MIN_FREE_BYTES;
  const minFreeFraction = opts.minFreeFraction ?? VACUUM_MIN_FREE_FRACTION;
  const minIntervalMs = opts.minIntervalMs ?? VACUUM_MIN_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const busyMs = opts.busyTimeoutMs ?? COMPACTION_BUSY_TIMEOUT_MS;
  let lastVacuumAt: number | null = null;

  function compact(sqlite: Database.Database): CompactionResult {
    const result: CompactionResult = { checkpointBusy: false, vacuumBusy: false };
    const previousTimeout = sqlite.pragma("busy_timeout", { simple: true }) as number;
    sqlite.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyMs))}`);
    try {
      const rows = sqlite.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
      result.checkpointBusy = rows[0]?.busy === 1;

      if (lastVacuumAt !== null && now() - lastVacuumAt < minIntervalMs) return result;

      const pageSize = sqlite.pragma("page_size", { simple: true }) as number;
      const freeBytes = (sqlite.pragma("freelist_count", { simple: true }) as number) * pageSize;
      const total = fileBytes(sqlite);
      if (freeBytes < minFreeBytes || total <= 0 || freeBytes / total < minFreeFraction) {
        return result;
      }

      const beforeBytes = total;
      try {
        sqlite.exec("VACUUM");
      } catch (err) {
        if (isBusy(err)) {
          // Not an error and not an attempt: the next eligible tick retries.
          result.vacuumBusy = true;
          return result;
        }
        lastVacuumAt = now(); // do not stall the loop again every tick on a hard failure
        throw err;
      }
      lastVacuumAt = now();
      // VACUUM in WAL mode goes through the WAL; truncate it so the file shrinks.
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      result.vacuumed = { beforeBytes, afterBytes: fileBytes(sqlite) };
      return result;
    } finally {
      sqlite.pragma(`busy_timeout = ${previousTimeout}`);
    }
  }

  return { compact };
}
