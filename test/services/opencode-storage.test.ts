import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultOpencodeDbPath,
  findHolders,
  inspectOpencodeStorage,
  pruneOpencodeStorage,
} from "../../src/services/opencode-storage.js";

let base: string;
let dbPath: string;
let procDir: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-storage-test-"));
  dbPath = path.join(base, "opencode.db");
  procDir = path.join(base, "proc");
  await fs.mkdir(procDir);
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const opts = () => ({ dbPath, procDir });

// Like opencode's: WAL mode, auto_vacuum off. Rows are inserted then mostly
// deleted so the file keeps pages it no longer needs.
function makeDb({ keep = 20, drop = 400 } = {}) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE part (id INTEGER PRIMARY KEY, data BLOB)");
  const insert = db.prepare("INSERT INTO part (data) VALUES (?)");
  db.transaction(() => {
    for (let i = 0; i < keep + drop; i++) insert.run(Buffer.alloc(8192, i % 251));
  })();
  db.prepare("DELETE FROM part WHERE id > ?").run(keep);
  db.close();
}

const rows = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM part").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

const sizeOnDisk = async () => (await fs.stat(dbPath)).size;

async function holdOpen(pid: number, file: string) {
  await fs.mkdir(path.join(procDir, String(pid), "fd"), { recursive: true });
  await fs.symlink(file, path.join(procDir, String(pid), "fd", "7"));
}

describe("opencode-storage", () => {
  it("defaults to the XDG data home", () => {
    const saved = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = "/data/xdg";
      expect(defaultOpencodeDbPath()).toBe(path.join("/data/xdg", "opencode", "opencode.db"));
      process.env.XDG_DATA_HOME = "";
      expect(defaultOpencodeDbPath()).toBe(
        path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
      );
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved;
    }
  });

  describe("inspect", () => {
    it("reports unavailable, without an error, when opencode has no database", async () => {
      const status = await inspectOpencodeStorage(opts());
      expect(status).toMatchObject({ available: false, path: dbPath, reclaimableBytes: 0 });
      expect(status.error).toBeUndefined();
    });

    it("reports unavailable for a directory, or a file that isn't a database", async () => {
      await fs.mkdir(dbPath);
      expect((await inspectOpencodeStorage(opts())).available).toBe(false);
      await fs.rm(dbPath, { recursive: true });
      await fs.writeFile(dbPath, "this is not sqlite".repeat(100));
      const status = await inspectOpencodeStorage(opts());
      expect(status.available).toBe(false);
      expect(status.error).toBeTruthy();
    });

    it("computes the reclaimable bytes exactly from the free pages", async () => {
      makeDb();
      const db = new Database(dbPath, { readonly: true });
      const pageSize = db.pragma("page_size", { simple: true }) as number;
      const free = db.pragma("freelist_count", { simple: true }) as number;
      const count = db.pragma("page_count", { simple: true }) as number;
      db.close();
      expect(free).toBeGreaterThan(0);
      const status = await inspectOpencodeStorage(opts());
      expect(status).toMatchObject({
        available: true,
        reclaimableBytes: free * pageSize,
        liveBytes: (count - free) * pageSize,
        inUse: false,
      });
      expect(status.fileBytes).toBeGreaterThanOrEqual(await sizeOnDisk());
    });

    it("reports holdersUnknown, not inUse, when it can't tell who has it open", async () => {
      makeDb();
      const status = await inspectOpencodeStorage({ dbPath, procDir: path.join(base, "no-proc") });
      expect(status).toMatchObject({ available: true, inUse: false, holdersUnknown: true });
    });

    it("sees a process holding the database or its WAL open, but not this one", async () => {
      makeDb();
      await holdOpen(process.pid, dbPath);
      expect((await inspectOpencodeStorage(opts())).inUse).toBe(false);
      await holdOpen(4242, `${dbPath}-wal`);
      expect((await inspectOpencodeStorage(opts())).inUse).toBe(true);
    });
  });

  describe("findHolders", () => {
    it("sees a holder through a symlinked data dir, since /proc reports resolved paths", async () => {
      const real = path.join(base, "real");
      await fs.mkdir(real);
      await fs.writeFile(path.join(real, "opencode.db"), "");
      await fs.symlink(real, path.join(base, "link"));
      await holdOpen(21, path.join(real, "opencode.db"));
      expect(await findHolders(path.join(base, "link", "opencode.db"), procDir)).toEqual([21]);
    });

    it("ignores unrelated descriptors and unreadable or missing proc entries", async () => {
      await holdOpen(11, path.join(base, "other.db"));
      await fs.mkdir(path.join(procDir, "12")); // no fd dir: not ours to read
      await fs.mkdir(path.join(procDir, "self"));
      await holdOpen(13, `${dbPath}-shm`);
      expect(await findHolders(dbPath, procDir)).toEqual([13]);
    });

    it("can't tell, rather than saying nobody, when /proc is unreadable", async () => {
      expect(await findHolders(dbPath, path.join(base, "no-proc"))).toBeNull();
    });

    it("can't tell when one of this user's own processes can't be looked into", async () => {
      if (process.getuid?.() === 0) return; // root reads everything
      await holdOpen(31, path.join(base, "other.db"));
      const fdDir = path.join(procDir, "31", "fd");
      await fs.chmod(fdDir, 0o000);
      try {
        expect(await findHolders(dbPath, procDir)).toBeNull();
      } finally {
        await fs.chmod(fdDir, 0o700);
      }
    });
  });

  describe("prune", () => {
    it("compacts the database losslessly and reports what it freed", async () => {
      makeDb();
      const before = await sizeOnDisk();
      const result = await pruneOpencodeStorage(opts());
      expect(result.error).toBeUndefined();
      expect(result.output).toContain("opencode.db");
      expect(await sizeOnDisk()).toBeLessThan(before / 2);
      expect(result.reclaimedBytes).toBeGreaterThan(before / 2);
      expect(rows()).toBe(20);
      // Nothing left to give back, and the schema's own settings are untouched.
      const db = new Database(dbPath, { readonly: true });
      expect(db.pragma("freelist_count", { simple: true })).toBe(0);
      expect(db.pragma("auto_vacuum", { simple: true })).toBe(0);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      db.close();
    });

    it("leaves the database alone while another process has it open", async () => {
      makeDb();
      const before = await sizeOnDisk();
      await holdOpen(4242, dbPath);
      const result = await pruneOpencodeStorage(opts());
      expect(result.reclaimedBytes).toBe(0);
      expect(result.output).toContain("opencode is running");
      expect(result.error).toBeUndefined();
      expect(await sizeOnDisk()).toBe(before);
    });

    it("skips when opencode starts between the preview and the lock", async () => {
      makeDb();
      const before = await sizeOnDisk();
      const result = await pruneOpencodeStorage({
        ...opts(),
        // The free-space check sits between the two looks at /proc.
        freeBytes: async () => {
          await holdOpen(4242, dbPath);
          return Number.MAX_SAFE_INTEGER;
        },
      });
      expect(result.output).toContain("opencode started");
      expect(await sizeOnDisk()).toBe(before);
    });

    it("skips when it can't tell whether opencode is running", async () => {
      makeDb();
      const before = await sizeOnDisk();
      const result = await pruneOpencodeStorage({ dbPath, procDir: path.join(base, "no-proc") });
      expect(result.output).toContain("Couldn't tell whether opencode is running");
      expect(result.reclaimedBytes).toBe(0);
      expect(result.error).toBeUndefined();
      expect(await sizeOnDisk()).toBe(before);
    });

    it("skips when /proc becomes unreadable between the preview and the lock", async () => {
      makeDb();
      const before = await sizeOnDisk();
      const result = await pruneOpencodeStorage({
        ...opts(),
        freeBytes: async () => {
          await fs.rm(procDir, { recursive: true });
          return Number.MAX_SAFE_INTEGER;
        },
      });
      expect(result.output).toContain("Couldn't tell whether opencode is running");
      expect(await sizeOnDisk()).toBe(before);
      expect(rows()).toBe(20);
    });

    it("says when the write-ahead log couldn't be fully truncated", async () => {
      makeDb();
      // A reader on an open snapshot (in this process, so the gate can't see it)
      // keeps the checkpoint from truncating the WAL.
      const reader = new Database(dbPath);
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM part").get();
      try {
        const result = await pruneOpencodeStorage({ ...opts(), busyTimeoutMs: 50 });
        expect(result.error).toBeUndefined();
        expect(result.output).toContain("couldn't be fully truncated");
      } finally {
        reader.exec("ROLLBACK");
        reader.close();
      }
      expect(rows()).toBe(20);
    });

    it("says so when there is no database or nothing to reclaim", async () => {
      expect((await pruneOpencodeStorage(opts())).output).toContain("No opencode database");
      makeDb({ keep: 5, drop: 0 });
      const result = await pruneOpencodeStorage(opts());
      expect(result.output).toContain("nothing to reclaim");
      expect(result.reclaimedBytes).toBe(0);
    });

    it("reports an unreadable database as an error", async () => {
      await fs.writeFile(dbPath, "this is not sqlite".repeat(100));
      const result = await pruneOpencodeStorage(opts());
      expect(result.error).toBeTruthy();
      expect(result.reclaimedBytes).toBe(0);
    });

    it("refuses when the volume lacks the room a VACUUM needs", async () => {
      makeDb();
      const before = await sizeOnDisk();
      const status = await inspectOpencodeStorage(opts());
      const result = await pruneOpencodeStorage({
        ...opts(),
        freeBytes: async () => status.liveBytes, // less than live * margin
      });
      expect(result.error).toContain("Not enough free space");
      expect(await sizeOnDisk()).toBe(before);
      expect(rows()).toBe(20);
    });

    it("gives up cleanly when something else holds the write lock", async () => {
      makeDb();
      const before = await sizeOnDisk();
      // In this process, so the in-use gate (which skips our own pid) can't see it.
      const writer = new Database(dbPath);
      writer.exec("BEGIN IMMEDIATE");
      try {
        const result = await pruneOpencodeStorage({ ...opts(), busyTimeoutMs: 50 });
        expect(result.error).toMatch(/locked|busy/i);
        expect(result.reclaimedBytes).toBe(0);
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
      expect(await sizeOnDisk()).toBe(before);
      expect(rows()).toBe(20);
    });

    it("gives up on a VACUUM that runs too long, leaving the database intact", async () => {
      makeDb();
      const before = await sizeOnDisk();
      const writer = new Database(dbPath);
      writer.exec("BEGIN IMMEDIATE");
      try {
        // Waiting for the lock far longer than the whole run may last.
        const result = await pruneOpencodeStorage({
          ...opts(),
          busyTimeoutMs: 60_000,
          vacuumTimeoutMs: 300,
        });
        expect(result.error).toContain("timed out");
        expect(result.reclaimedBytes).toBe(0);
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
      expect(await sizeOnDisk()).toBe(before);
      expect(rows()).toBe(20);
    });

    it("keeps this process free while the VACUUM runs", async () => {
      makeDb({ keep: 20, drop: 4000 });
      let ticks = 0;
      const timer = setInterval(() => ticks++, 5);
      try {
        const result = await pruneOpencodeStorage(opts());
        expect(result.error).toBeUndefined();
      } finally {
        clearInterval(timer);
      }
      // A synchronous VACUUM in this process would have starved the timer.
      expect(ticks).toBeGreaterThan(3);
    });

    it("refuses a second prune while one is running", async () => {
      makeDb();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = pruneOpencodeStorage({
        ...opts(),
        freeBytes: async () => {
          await gate;
          return Number.MAX_SAFE_INTEGER;
        },
      });
      await new Promise((r) => setTimeout(r, 50));
      await expect(pruneOpencodeStorage(opts())).rejects.toThrow("OPENCODE_PRUNE_IN_PROGRESS");
      release();
      await first;
    });
  });
});
