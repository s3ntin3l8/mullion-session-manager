import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// opencode keeps every session in one SQLite file, `<data home>/opencode/
// opencode.db`, and never gives freed pages back: `auto_vacuum` is off, so after
// sessions are deleted or migrated the file keeps its size (issue #1604: 17 GB
// on disk, ~2.7 GB of it live). Only a VACUUM returns that space, and it is
// lossless — it rewrites the same rows into a compact file.
//
// This is the one place Mullion opens a SQLite file it doesn't own for writing,
// and a VACUUM holds the write lock for the whole rebuild, so it only ever runs
// while no process has the database open (see `findHolders`), never starts or
// stops opencode, and never changes the schema or any pragma of the file.

const BUSY_TIMEOUT_MS = 5_000;
// In WAL mode VACUUM writes the compacted copy into the WAL before it is
// checkpointed back, so the volume needs roughly the live size free, plus
// slack for the copy's own overhead.
const SPACE_MARGIN = 1.2;

export interface OpencodeStorageOptions {
  /** Defaults to `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db`. */
  dbPath?: string;
  /** Test seam: the /proc used to find processes holding the database open. */
  procDir?: string;
  /** Test seam: free bytes on the volume holding the database. */
  freeBytes?: (dir: string) => Promise<number>;
  /** How long VACUUM waits for the write lock before giving up. */
  busyTimeoutMs?: number;
}

export interface OpencodeStorageStatus {
  /** False when there is no database, or it couldn't be read. */
  available: boolean;
  path: string;
  /** The database plus its write-ahead log, as on disk. */
  fileBytes: number;
  /** Free pages a VACUUM would return (`freelist_count * page_size`). Exact. */
  reclaimableBytes: number;
  /** What the compacted database would take. */
  liveBytes: number;
  /** Some other process has it open; a VACUUM would lock it out, so it is skipped. */
  inUse: boolean;
  error?: string;
}

export interface OpencodePruneResult {
  output: string;
  reclaimedBytes: number;
  error?: string;
}

export function defaultOpencodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

const sidecars = (dbPath: string) => [`${dbPath}-wal`, `${dbPath}-shm`];

async function sizeOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * Pids (other than this process) with the database, its WAL or its shared-memory
 * file open. Only descriptors we are allowed to read are seen, i.e. this user's
 * own processes — which is every process that could be opencode.
 */
export async function findHolders(dbPath: string, procDir = "/proc"): Promise<number[]> {
  const watched = new Set([dbPath, ...sidecars(dbPath)]);
  let pids: string[];
  try {
    pids = await fs.readdir(procDir);
  } catch {
    return [];
  }
  const holders: number[] = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const fdDir = path.join(procDir, pid, "fd");
    let fds: string[];
    try {
      fds = await fs.readdir(fdDir);
    } catch {
      continue; // another user's process, or gone
    }
    for (const fd of fds) {
      const target = await fs.readlink(path.join(fdDir, fd)).catch(() => null);
      if (target !== null && watched.has(target)) {
        holders.push(Number(pid));
        break;
      }
    }
  }
  return holders;
}

export async function inspectOpencodeStorage(
  options: OpencodeStorageOptions = {},
): Promise<OpencodeStorageStatus> {
  const dbPath = options.dbPath ?? defaultOpencodeDbPath();
  const unavailable: OpencodeStorageStatus = {
    available: false,
    path: dbPath,
    fileBytes: 0,
    reclaimableBytes: 0,
    liveBytes: 0,
    inUse: false,
  };
  try {
    if (!(await fs.stat(dbPath)).isFile()) return unavailable;
  } catch (error) {
    // No opencode on this host is not a problem worth reporting.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return unavailable;
    return { ...unavailable, error: error instanceof Error ? error.message : "cannot read" };
  }
  try {
    // Checked before this process opens the file itself.
    const holders = await findHolders(dbPath, options.procDir);
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const pageSize = db.pragma("page_size", { simple: true }) as number;
      const pageCount = db.pragma("page_count", { simple: true }) as number;
      const free = db.pragma("freelist_count", { simple: true }) as number;
      return {
        available: true,
        path: dbPath,
        fileBytes: (await sizeOf(dbPath)) + (await sizeOf(`${dbPath}-wal`)),
        reclaimableBytes: free * pageSize,
        liveBytes: (pageCount - free) * pageSize,
        inUse: holders.length > 0,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ...unavailable,
      error: error instanceof Error ? error.message : "Could not read the opencode database",
    };
  }
}

const defaultFreeBytes = async (dir: string) => {
  const stats = await fs.statfs(dir);
  return stats.bavail * stats.bsize;
};

let pruneRunning = false;

/**
 * Compacts opencode's database in place. Skips (without error) when opencode
 * has it open, when there is nothing to reclaim, or when the volume lacks the
 * room a VACUUM needs; a failed VACUUM is atomic, so the database is left as it was.
 */
export async function pruneOpencodeStorage(
  options: OpencodeStorageOptions = {},
): Promise<OpencodePruneResult> {
  // Check-and-set with no await between them, as in cache-storage.ts.
  if (pruneRunning) throw new Error("OPENCODE_PRUNE_IN_PROGRESS");
  pruneRunning = true;
  try {
    const status = await inspectOpencodeStorage(options);
    if (!status.available) {
      return status.error
        ? { output: "", reclaimedBytes: 0, error: status.error }
        : { output: "No opencode database found.", reclaimedBytes: 0 };
    }
    if (status.inUse) {
      return {
        output: "opencode is running; its database was skipped. Close it and run again.",
        reclaimedBytes: 0,
      };
    }
    if (status.reclaimableBytes === 0) {
      return { output: "The opencode database has nothing to reclaim.", reclaimedBytes: 0 };
    }
    const dir = path.dirname(status.path);
    const needed = Math.ceil(status.liveBytes * SPACE_MARGIN);
    const free = await (options.freeBytes ?? defaultFreeBytes)(dir);
    if (free < needed) {
      return {
        output: "",
        reclaimedBytes: 0,
        error: `Not enough free space to compact the opencode database (needs about ${String(needed)} bytes, ${String(free)} free).`,
      };
    }
    // Another look right before taking the write lock.
    if ((await findHolders(status.path, options.procDir)).length > 0) {
      return { output: "opencode started; its database was skipped.", reclaimedBytes: 0 };
    }
    try {
      const db = new Database(status.path, {
        fileMustExist: true,
        timeout: options.busyTimeoutMs ?? BUSY_TIMEOUT_MS,
      });
      try {
        db.exec("VACUUM");
        // Without this the freed pages stay in the file until the next checkpoint.
        db.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
    } catch (error) {
      return {
        output: "",
        reclaimedBytes: 0,
        error: error instanceof Error ? error.message : "Compacting the opencode database failed",
      };
    }
    const after = (await sizeOf(status.path)) + (await sizeOf(`${status.path}-wal`));
    const reclaimedBytes = Math.max(0, status.fileBytes - after);
    return { output: `Compacted ${path.basename(status.path)}.`, reclaimedBytes };
  } finally {
    pruneRunning = false;
  }
}
