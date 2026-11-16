import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDbCompactor } from "../../src/services/db-compaction.js";

let dir: string;
let db: Database.Database;

function setup(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-"));
  const file = path.join(dir, "t.db");
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
  db.transaction(() => {
    for (let i = 0; i < 4000; i++) ins.run("x".repeat(1000));
  })();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("DELETE FROM t WHERE id > 100");
  return file;
}

afterEach(() => {
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("createDbCompactor", () => {
  it("truncates the WAL and VACUUMs over the thresholds, shrinking the file", () => {
    const file = setup();
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
    const before = fs.statSync(file).size;
    const c = createDbCompactor({ minFreeBytes: 1024, minFreeFraction: 0.1 });
    const r = c.compact(db);
    expect(r.vacuumed).toBeDefined();
    expect(fs.statSync(file).size).toBeLessThan(before);
    expect(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0).toBe(0);
  });

  it("truncates the WAL but does not VACUUM under the thresholds", () => {
    const file = setup();
    const before = fs.statSync(file).size;
    const r = createDbCompactor().compact(db);
    expect(r.vacuumed).toBeUndefined();
    expect(fs.statSync(file).size).toBe(before);
    expect(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0).toBe(0);
  });

  it("does not VACUUM twice within 24 hours (injected clock)", () => {
    setup();
    let t = 1_000_000;
    const c = createDbCompactor({ minFreeBytes: 1024, minFreeFraction: 0.1, now: () => t });
    expect(c.compact(db).vacuumed).toBeDefined();
    db.exec("INSERT INTO t (v) SELECT v FROM t");
    db.exec("DELETE FROM t WHERE id > 50");
    t += 23 * 60 * 60 * 1000;
    expect(c.compact(db).vacuumed).toBeUndefined();
    t += 2 * 60 * 60 * 1000;
    // Re-create free pages so the thresholds are met again.
    const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) ins.run("y".repeat(1000));
    })();
    db.exec("DELETE FROM t WHERE id > 100");
    expect(c.compact(db).vacuumed).toBeDefined();
  });

  it("restores the connection's busy_timeout", () => {
    setup();
    db.pragma("busy_timeout = 4321");
    createDbCompactor().compact(db);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(4321);
  });
});
