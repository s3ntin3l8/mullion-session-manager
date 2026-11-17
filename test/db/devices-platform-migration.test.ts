import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// The migration that adds `devices.platform` / `devices.udid` (#3202) must leave
// every row that already exists readable as an Android device with no data
// change. This builds a database at the migration BEFORE it, inserts rows, then
// applies the rest of the migrations — the upgrade an installed Mullion takes.
const FOLDER = path.resolve("drizzle");
const ADDS_PLATFORM = /ALTER TABLE `devices` ADD `platform`/;

interface Journal {
  entries: { idx: number; tag: string }[];
}

describe("devices.platform migration (#3202)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("reads rows that predate it as android with a null udid, without rewriting them", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(FOLDER, "meta", "_journal.json"), "utf8"),
    ) as Journal;
    const target = journal.entries.find((e) =>
      ADDS_PLATFORM.test(fs.readFileSync(path.join(FOLDER, `${e.tag}.sql`), "utf8")),
    );
    expect(target, "no migration adds devices.platform").toBeDefined();

    // A migrations folder that stops just before it.
    const before = fs.mkdtempSync(path.join(os.tmpdir(), "mig-before-"));
    dirs.push(before);
    fs.mkdirSync(path.join(before, "meta"));
    for (const e of journal.entries.filter((x) => x.idx < target!.idx)) {
      fs.copyFileSync(path.join(FOLDER, `${e.tag}.sql`), path.join(before, `${e.tag}.sql`));
    }
    fs.writeFileSync(
      path.join(before, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.filter((x) => x.idx < target!.idx) }),
    );

    const file = path.join(os.tmpdir(), `devices-platform-migration-${process.pid}.db`);
    dirs.push(file);
    const sqlite = new Database(file);
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: before });
      expect(
        sqlite.prepare("SELECT 1 FROM pragma_table_info('devices') WHERE name = 'platform'").get(),
      ).toBeUndefined();

      sqlite.pragma("foreign_keys = OFF");
      const insert = sqlite.prepare(
        "INSERT INTO devices (kind, avd_name, serial, port, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run("emulator", "dev35", null, 5554, "active", 1_700_000_000);
      insert.run("physical", null, "192.168.1.23:37251", null, "killed", 1_700_000_001);

      migrate(db, { migrationsFolder: FOLDER });

      const rows = sqlite
        .prepare(
          "SELECT kind, avd_name, serial, port, status, platform, udid FROM devices ORDER BY id",
        )
        .all();
      expect(rows).toEqual([
        {
          kind: "emulator",
          avd_name: "dev35",
          serial: null,
          port: 5554,
          status: "active",
          platform: "android",
          udid: null,
        },
        {
          kind: "physical",
          avd_name: null,
          serial: "192.168.1.23:37251",
          port: null,
          status: "killed",
          platform: "android",
          udid: null,
        },
      ]);
    } finally {
      sqlite.close();
      for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
    }
  });
});
