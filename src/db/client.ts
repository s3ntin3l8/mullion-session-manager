import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";

let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqliteInstance: Database.Database | null = null;

export function getDb(databaseUrl?: string) {
  if (dbInstance) return dbInstance;

  const url = databaseUrl || process.env.DATABASE_URL || "file:./data/app.db";
  const dbPath = url.replace("file:", "");

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  sqliteInstance = new Database(dbPath);
  // Off by default per-connection in SQLite — required for sessions'
  // `ON DELETE CASCADE` (deleting a project should kill its sessions' rows
  // too) to actually fire.
  sqliteInstance.pragma("foreign_keys = ON");
  // Rollback-journal (the SQLite default) takes an exclusive lock over the
  // whole DB file for the duration of a write, blocking every reader. This
  // process is a long-lived server with several concurrent writers (batched
  // event writer, task watcher, PR poller, webhook reconciler, heartbeat
  // sweeper, retention sweep) alongside HTTP/WS readers — WAL lets readers
  // proceed against the last-committed snapshot while a writer is active,
  // which is what this workload actually needs.
  sqliteInstance.pragma("journal_mode = WAL");
  // FULL (the default) fsyncs on every transaction commit; WAL's own
  // durability guarantees make NORMAL safe (at most the last commit is lost
  // on an OS crash, not corruption) while avoiding that fsync on the hot
  // path.
  sqliteInstance.pragma("synchronous = NORMAL");
  // Without this, a writer that finds the DB momentarily busy fails
  // immediately with SQLITE_BUSY instead of waiting. 5s is long enough to
  // ride out this app's normal write bursts without masking a genuine
  // deadlock forever.
  sqliteInstance.pragma("busy_timeout = 5000");
  dbInstance = drizzle(sqliteInstance, { schema });

  return dbInstance;
}

export function closeDb() {
  if (sqliteInstance) {
    sqliteInstance.close();
  }
  sqliteInstance = null;
  dbInstance = null;
}

export function ensureDb(databaseUrl?: string) {
  const db = getDb(databaseUrl);
  const migrationsFolder = path.resolve("drizzle");
  migrate(db, { migrationsFolder });
  return db;
}
