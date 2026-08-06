import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { afterAll } from "vitest";
import { schema } from "../src/plugins/env.js";

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
// Deliberately never created. root.test.ts and staticPlugin's own tests
// assume the frontend isn't built — pointing this at a real path would make
// that assumption (and so the tests) depend on whether *this specific
// machine* happens to have run `npm run build` under frontend/, which is
// exactly the flakiness SESSIONS_DIR isolation above already avoids for the
// sessions dir.
const tmpFrontendDist = path.join(
  os.tmpdir(),
  `vitest-frontend-dist-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
);

// Forced (not just defaulted) regardless of what the invoking shell already
// has, since env.ts's loadDotenvOverrides() only skips .env loading when
// this is exactly "test" — Vitest itself only sets NODE_ENV=test when it's
// unset, so a dev shell exporting NODE_ENV=production/development (e.g. to
// run a local prod-like server) would otherwise leak through, both
// mismatching what tests assert (see server-info.test.ts) and silently
// re-enabling .env loading for the whole suite.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${tmpDb}`;
// Same reasoning as DATABASE_URL above: ptyPlugin constructs a PtyManager on
// every buildApp() call (even in tests that have nothing to do with
// terminals), which mkdirSync's this directory — isolate it so test runs
// don't leave a stray data/sessions/ under the repo root.
process.env.SESSIONS_DIR = tmpSessionsDir;
process.env.FRONTEND_DIST = tmpFrontendDist;
// Off by default in tests (schema default is 30s = on) — issue #246's
// heartbeat poller pings every remote host row in whichever app.db happens
// to be open, using the real global `fetch`. A test that builds a primary
// app, creates an "unreachable" host (a common fixture — see
// test/routes/projects.test.ts's many `baseUrl: "http://127.0.0.1:1"`
// hosts), and is slow to close it (or simply outlives 30s of wall-clock
// suite time before doing so) would otherwise leave this timer ticking in
// the background — and if any *later*, unrelated test in the same run
// swaps globalThis.fetch for its own vi.fn() mock, that stray ping lands
// there, incrementing its call count and breaking an
// expect(fetchMock).not.toHaveBeenCalled()-style assertion with no
// connection to what that test is actually about. A file that specifically
// exercises this poller (test/plugins/host-heartbeat.test.ts,
// test/routes/hosts.test.ts) already sets this explicitly for its own
// scope, same as every other var here.
process.env.HOST_HEARTBEAT_INTERVAL_SECONDS = "0";

// Give every OTHER config var from the schema a clean (unset) starting
// value too, once per test file, before that file's own beforeAll/beforeEach/
// it code runs — @fastify/env's env:true always merges process.env over the
// schema defaults (see env.ts), so whichever Mullion-specific vars a
// developer's shell happens to export (PORT, DB_ENCRYPTION_KEY, MULLION_HOME,
// GITHUB_OAUTH_CLIENT_ID, ...) would otherwise leak into app.config and break
// any test asserting a default. Deleting them one by one, only in whichever
// specific test happened to fail on a given machine, doesn't scale — the
// next inherited var just breaks a different test the same way. A file's own
// explicit process.env.X assignment (in a beforeAll, an it, etc.) still wins
// for the rest of that file's run, same as today, since this only runs once,
// before any of that.
const PRESERVED_VARS = new Set([
  "NODE_ENV",
  "DATABASE_URL",
  "SESSIONS_DIR",
  "FRONTEND_DIST",
  "HOST_HEARTBEAT_INTERVAL_SECONDS",
]);
for (const key of Object.keys(schema.properties)) {
  if (!PRESERVED_VARS.has(key)) delete process.env[key];
}

// Agent-owned config-root overrides — not Mullion's own schema vars above, but
// read live by agent-rules.ts / skills.ts / the claude-code and opencode hook
// adapters (issue #470). A developer's or CI runner's ambient XDG_CONFIG_HOME
// (GitHub Actions runners set this) or CLAUDE_CONFIG_DIR would otherwise
// silently redirect every global-scope path assertion in those suites away
// from the test's own fake HOME. CODEX_HOME is deliberately NOT included
// here: agent-rules.test.ts already deletes/restores it per-test, and other
// suites set it intentionally within their own scope.
for (const key of ["XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PLUGIN_CACHE_DIR"]) {
  delete process.env[key];
}

afterAll(() => {
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(tmpSessionsDir, { recursive: true, force: true });
});
