import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { getDb, ensureDb, closeDb } from "../../src/db/client.js";

// Perf audit finding A2: getDb() must open the SQLite connection in WAL mode
// (not the rollback-journal default) with synchronous=NORMAL and a
// busy_timeout, so concurrent readers aren't blocked behind this
// long-lived server's several concurrent writers. Pinned directly against
// the opened connection's own PRAGMA output rather than just trusting the
// pragma() calls in client.ts stayed correct.
describe("getDb() journal mode (finding A2)", () => {
  const tmpDb = path.join(os.tmpdir(), `db-client-a2-test-${process.pid}.db`);

  afterEach(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${tmpDb}${suffix}`, { force: true });
    }
  });

  it("opens the database in WAL mode with synchronous=NORMAL and a busy_timeout", () => {
    const db = getDb(`file:${tmpDb}`);
    expect(db).toBeDefined();

    // The -wal sidecar is only materialized on disk once a write transaction
    // actually happens (setting the pragma alone doesn't create it) — do a
    // trivial write so the sidecar-file assertions below are meaningful.
    db.$client.exec("CREATE TABLE IF NOT EXISTS a2_test (id INTEGER PRIMARY KEY)");

    // Read the pragmas back from a second, independent connection to the
    // same file — WAL mode is a property of the database file itself (not
    // just the connection that set it), so this also proves it was
    // persisted, not merely requested on a connection that immediately
    // reverted it.
    const verify = new Database(tmpDb);
    try {
      const journalMode = verify.pragma("journal_mode", { simple: true });
      expect(journalMode).toBe("wal");

      const synchronous = verify.pragma("synchronous", { simple: true });
      // SQLite reports synchronous as an integer: 0=OFF, 1=NORMAL, 2=FULL.
      expect(synchronous).toBe(1);
    } finally {
      verify.close();
    }

    // busy_timeout is per-connection, not persisted to the file, so check
    // it on the getDb()-opened connection itself.
    const busyTimeout = db.$client.pragma("busy_timeout", { simple: true });
    expect(busyTimeout).toBe(5000);

    // WAL mode creates -wal/-shm sidecar files alongside the main DB file.
    expect(fs.existsSync(`${tmpDb}-wal`)).toBe(true);
    expect(fs.existsSync(`${tmpDb}-shm`)).toBe(true);
  });
});

// Perf audit finding A3 — `sessions.project_id` is an unindexed FK column
// hit by every project-scoped session query. Before the
// `sessions_project_id_idx` index (schema.ts), this was a full
// `SCAN sessions`. Pinned against the query planner's own output, applied
// through a real migration run (ensureDb), not just asserted from the
// schema declaration.
describe("sessions.project_id index (finding A3)", () => {
  const tmpDb = path.join(os.tmpdir(), `db-client-a3-test-${process.pid}.db`);

  afterEach(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${tmpDb}${suffix}`, { force: true });
    }
  });

  it("uses the project_id index, not a full table scan, for a project-scoped session query", () => {
    const db = ensureDb(`file:${tmpDb}`);
    const plan = db.$client
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE project_id = ?")
      .all(1) as Array<{ detail: string }>;

    expect(
      plan.some((row) => /SEARCH sessions USING INDEX sessions_project_id_idx/.test(row.detail)),
    ).toBe(true);
    expect(plan.some((row) => /SCAN sessions/.test(row.detail))).toBe(false);
  });
});
