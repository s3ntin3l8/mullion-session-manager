import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { afterAll } from "vitest";

// Give every test file an isolated SQLite database so parallel workers never
// contend on the default ./data/app.db file. Tests that need specific values
// (e.g. the env defaults test) override or delete these before building the app.
const tmpDb = path.join(
  os.tmpdir(),
  `vitest-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
);
const tmpSessionsDir = path.join(
  os.tmpdir(),
  `vitest-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
);

process.env.DATABASE_URL = `file:${tmpDb}`;
// Same reasoning as DATABASE_URL above: ptyPlugin constructs a PtyManager on
// every buildApp() call (even in tests that have nothing to do with
// terminals), which mkdirSync's this directory — isolate it so test runs
// don't leave a stray data/sessions/ under the repo root.
process.env.SESSIONS_DIR = tmpSessionsDir;

afterAll(() => {
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(tmpSessionsDir, { recursive: true, force: true });
});
