import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

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
// A VACUUM builds the compacted copy in a temporary file, and in WAL mode then
// writes it into the WAL before it is checkpointed back: two live-size copies
// at the peak, both kept on the database's own volume (see `runVacuum`), plus
// slack for their overhead.
const SPACE_FACTOR = 2 * 1.2;
// The rebuild of a large database takes minutes; this only bounds a hung one.
// Killing it midway is safe: a VACUUM that doesn't commit changes nothing.
const VACUUM_TIMEOUT_MS = 30 * 60_000;
// Runs in a child process: better-sqlite3 is synchronous, so in this process a
// VACUUM would freeze every terminal and request for as long as it takes. It
// boots, then waits to be told "go" on stdin: the parent's last look at who has
// the database open happens just before that, so nothing but a pipe write
// separates that check from the VACUUM taking the write lock. Stdin closing
// without a "go" means the parent decided against it (exit 4).
const EXIT_NOT_STARTED = 4;
const VACUUM_SCRIPT = `
const [moduleFile, dbFile, busyMs] = process.argv.slice(1);
let started = false;
function run() {
  if (started) return;
  started = true;
  try {
    const db = new (require(moduleFile))(dbFile, { fileMustExist: true, timeout: Number(busyMs) });
    try {
      db.exec("VACUUM");
      const [checkpoint] = db.pragma("wal_checkpoint(TRUNCATE)");
      if (checkpoint && checkpoint.busy) console.log("WAL_BUSY");
    } finally {
      db.close();
    }
    process.exit(0);
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.includes("go")) run();
});
process.stdin.on("end", () => {
  if (!started) process.exit(${EXIT_NOT_STARTED});
});
`;

export interface OpencodeStorageOptions {
  /** Defaults to `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db`. */
  dbPath?: string;
  /** Test seam: the /proc used to find processes holding the database open. */
  procDir?: string;
  /** Test seam: free bytes on the volume holding the database. */
  freeBytes?: (dir: string) => Promise<number>;
  /** How long VACUUM waits for the write lock before giving up. */
  busyTimeoutMs?: number;
  /** Test seam: how long the whole VACUUM may run. */
  vacuumTimeoutMs?: number;
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
  /**
   * Who has it open couldn't be established (no readable /proc, or one of this
   * user's own processes can't be looked into). Unknown is not "nobody": it is
   * skipped just like `inUse`.
   */
  holdersUnknown: boolean;
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
 * file open, or `null` when that can't be established: no readable /proc, or a
 * process of this same user whose descriptors can't be listed. Another user's
 * processes can't be opencode (it runs as the server's user) and are skipped.
 */
export async function findHolders(dbPath: string, procDir = "/proc"): Promise<number[] | null> {
  // /proc reports resolved paths, so a data dir reached through a symlink (or a
  // bind mount) would otherwise hide a running opencode.
  const real = await fs.realpath(dbPath).catch(() => dbPath);
  const watched = new Set([dbPath, ...sidecars(dbPath), real, ...sidecars(real)]);
  let pids: string[];
  try {
    pids = await fs.readdir(procDir);
  } catch {
    return null;
  }
  const holders: number[] = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const fdDir = path.join(procDir, pid, "fd");
    let fds: string[];
    try {
      fds = await fs.readdir(fdDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // gone
      const owner = await fs.stat(path.join(procDir, pid)).then(
        (st) => st.uid,
        () => null,
      );
      if (owner !== null && owner === process.getuid?.()) return null;
      continue; // another user's process
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
    holdersUnknown: false,
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
        inUse: (holders?.length ?? 0) > 0,
        holdersUnknown: holders === null,
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

interface VacuumOutcome {
  /** The gate said no, so the child exited without touching the database. */
  skipped: boolean;
  /** The checkpoint couldn't truncate the WAL (a reader was still on it). */
  walBusy: boolean;
}

/**
 * Starts the child, then lets `proceed` have the last word: it runs while the
 * child boots, and the VACUUM only starts once it resolves true.
 */
function runVacuum(
  dbPath: string,
  busyTimeoutMs: number,
  timeoutMs: number,
  proceed: () => Promise<boolean>,
): Promise<VacuumOutcome> {
  return new Promise((resolve, reject) => {
    // SQLITE_TMPDIR keeps the temporary copy on the volume the space check
    // looked at, not whatever small or RAM-backed /tmp the host has.
    const child = spawn(
      process.execPath,
      ["-e", VACUUM_SCRIPT, require.resolve("better-sqlite3"), dbPath, String(busyTimeoutMs)],
      { env: { SQLITE_TMPDIR: path.dirname(dbPath) }, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.on("error", () => undefined); // the child may already be gone
    void proceed().then(
      (go) => child.stdin.end(go ? "go\n" : undefined),
      () => child.stdin.end(),
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 256) stdout += chunk.toString("utf8");
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Compacting the opencode database timed out"));
    }, timeoutMs);
    timer.unref();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ skipped: false, walBusy: stdout.includes("WAL_BUSY") });
      else if (code === EXIT_NOT_STARTED) resolve({ skipped: true, walBusy: false });
      else reject(new Error(stderr.trim() || `VACUUM exited with code ${String(code)}`));
    });
  });
}

const defaultFreeBytes = async (dir: string) => {
  const stats = await fs.statfs(dir);
  return stats.bavail * stats.bsize;
};

const UNKNOWN_HOLDERS_OUTPUT =
  "Couldn't tell whether opencode is running; its database was skipped.";

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
    if (status.holdersUnknown) {
      return { output: UNKNOWN_HOLDERS_OUTPUT, reclaimedBytes: 0 };
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
    const needed = Math.ceil(status.liveBytes * SPACE_FACTOR);
    const free = await (options.freeBytes ?? defaultFreeBytes)(dir);
    if (free < needed) {
      return {
        output: "",
        reclaimedBytes: 0,
        error: `Not enough free space to compact the opencode database (needs about ${String(needed)} bytes, ${String(free)} free).`,
      };
    }
    let outcome: VacuumOutcome;
    const lastLook = { value: "clear" as "clear" | "running" | "unknown" };
    try {
      outcome = await runVacuum(
        status.path,
        options.busyTimeoutMs ?? BUSY_TIMEOUT_MS,
        options.vacuumTimeoutMs ?? VACUUM_TIMEOUT_MS,
        // The last look, taken while the child boots and acted on a pipe write
        // before it takes the write lock.
        async () => {
          const holders = await findHolders(status.path, options.procDir);
          lastLook.value = holders === null ? "unknown" : holders.length > 0 ? "running" : "clear";
          return lastLook.value === "clear";
        },
      );
    } catch (error) {
      return {
        output: "",
        reclaimedBytes: 0,
        error: error instanceof Error ? error.message : "Compacting the opencode database failed",
      };
    }
    if (outcome.skipped) {
      return {
        output:
          lastLook.value === "unknown"
            ? UNKNOWN_HOLDERS_OUTPUT
            : "opencode started; its database was skipped.",
        reclaimedBytes: 0,
      };
    }
    const after = (await sizeOf(status.path)) + (await sizeOf(`${status.path}-wal`));
    const reclaimedBytes = Math.max(0, status.fileBytes - after);
    const name = path.basename(status.path);
    return {
      output: outcome.walBusy
        ? `Compacted ${name}; its write-ahead log couldn't be fully truncated and will shrink at its next checkpoint.`
        : `Compacted ${name}.`,
      reclaimedBytes,
    };
  } finally {
    pruneRunning = false;
  }
}
