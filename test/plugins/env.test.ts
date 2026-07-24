import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../../src/app.js";
import { loadDotenvOverrides } from "../../src/plugins/env.js";

describe("env plugin", () => {
  // Load-bearing: PORT/LOG_LEVEL are set by "respects environment variable
  // overrides" below and must be cleared before the next test in this file
  // runs. DATABASE_URL restores the per-file value test/setup.ts assigns
  // (which "loads with default values" clears to assert the schema default).
  // DB_ENCRYPTION_KEY/CORS_ORIGIN/RATE_LIMIT_* are backstops only — no test
  // in this file currently sets them via process.env, since test/setup.ts's
  // global reset already keeps them clean per file; kept here in case a
  // future test in this file does.
  afterEach(async () => {
    delete process.env.PORT;
    delete process.env.LOG_LEVEL;
    delete process.env.DATABASE_URL;
    delete process.env.DB_ENCRYPTION_KEY;
    delete process.env.CORS_ORIGIN;
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW;
  });

  it("loads with default values (NODE_ENV may be set by test runner)", async () => {
    // Clear the per-file DATABASE_URL injected by test/setup.ts to assert the
    // schema default is applied. No other var needs the same treatment here:
    // test/setup.ts now clears every other schema-defined config var once per
    // test file too, so a developer's shell (PORT, DB_ENCRYPTION_KEY,
    // PREVIEW_BASE_HOST, ...) never leaks into app.config in the first place.
    delete process.env.DATABASE_URL;
    const app = await buildApp();
    expect(app.config.PORT).toBe(3000);
    expect(app.config.LOG_LEVEL).toBe("info");
    expect(app.config.DATABASE_URL).toBe("file:./data/app.db");
    expect(app.config.DB_ENCRYPTION_KEY).toBe("");
    expect(app.config.CORS_ORIGIN).toBe("");
    expect(app.config.RATE_LIMIT_MAX).toBe(100);
    expect(app.config.RATE_LIMIT_WINDOW).toBe("1 minute");
    expect(app.config.PROJECTS_ROOTS).toBe("");
    expect(app.config.CRS_CONFIG_DIR).toBe("~/.config/crs");
    expect(app.config.MULLION_ROLE).toBe("primary");
    expect(app.config.MULLION_AGENT_TOKEN).toBe("");
    expect(app.config.MULLION_AUTH_TOKEN).toBe("");
    expect(app.config.MULLION_SESSION_SECRET).toBe("");
    expect(app.config.PREVIEW_BASE_HOST).toBe("");
    // MULLION_REVIEW_GATE_ENABLED is the schema's first `type: "boolean"`
    // entry (every prior key is string/number) — assert its unset default
    // resolves to the real boolean `false`, not the schema's raw `default`
    // value going unconverted.
    expect(app.config.MULLION_REVIEW_GATE_ENABLED).toBe(false);
    await app.close();
  });

  it("respects environment variable overrides", async () => {
    // This only exercises the NODE_ENV=test path, where loadDotenvOverrides()
    // in env.ts returns {} and process.env is the sole config source — it
    // does NOT cover (and can't guard) the non-test path, where a real .env
    // file now wins over process.env on purpose (issue #70: an inherited
    // PORT/DATABASE_URL/etc. from a parent Mullion process must lose to the
    // project's own .env). That path is covered separately below, against a
    // fixture file rather than through buildApp() (which always resolves
    // ".env" at cwd — this repo's own real, gitignored dev .env — so it
    // can't be safely pointed at a fixture from a test).
    process.env.PORT = "4000";
    process.env.LOG_LEVEL = "debug";

    const app = await buildApp();
    expect(app.config.PORT).toBe(4000);
    expect(app.config.LOG_LEVEL).toBe("debug");
    await app.close();
  });

  // Env vars are always strings on the wire (process.env, a real .env file,
  // systemd EnvironmentFile, ...) — this is the load-bearing check that
  // @fastify/env's ajv-backed coercion actually turns the STRING "true"/
  // "false" a user writes in .env.example into the real boolean app.config
  // consumes (src/services/hook-adapters/claude-code.ts's
  // ctx.reviewGateEnabled, pty-manager.ts's Session.reviewGateEnabled). If
  // coercion silently didn't happen, the *string* "false" is truthy in JS —
  // reaching an `if (ctx.reviewGateEnabled)` check as "enabled" — which
  // would quietly re-introduce the exact stuck-Bash regression this flag
  // exists to prevent for anyone who copies .env.example's
  // `MULLION_REVIEW_GATE_ENABLED=false` verbatim.
  describe("MULLION_REVIEW_GATE_ENABLED boolean coercion", () => {
    afterEach(() => {
      delete process.env.MULLION_REVIEW_GATE_ENABLED;
    });

    it('coerces the string "true" to the real boolean true', async () => {
      process.env.MULLION_REVIEW_GATE_ENABLED = "true";
      const app = await buildApp();
      expect(app.config.MULLION_REVIEW_GATE_ENABLED).toBe(true);
      await app.close();
    });

    it('coerces the string "false" to the real boolean false', async () => {
      process.env.MULLION_REVIEW_GATE_ENABLED = "false";
      const app = await buildApp();
      expect(app.config.MULLION_REVIEW_GATE_ENABLED).toBe(false);
      await app.close();
    });
  });

  describe("loadDotenvOverrides", () => {
    let tmpDir: string | undefined;
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    });

    function writeFixtureEnv(contents: string): string {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-plugin-test-"));
      const fixturePath = path.join(tmpDir, ".env");
      fs.writeFileSync(fixturePath, contents);
      return fixturePath;
    }

    it("loads and wins over an already-set process.env value outside test mode", () => {
      // The actual issue #70 scenario: process.env.PORT already has an
      // inherited value (as if from a parent Mullion process) before .env
      // is consulted — loadDotenvOverrides()'s result is exactly what
      // env.ts hands to env-schema's `data` option, which wins over
      // process.env in its merge order (verified separately against
      // env-schema's own source).
      process.env.NODE_ENV = "development";
      process.env.PORT = "9999";
      const fixturePath = writeFixtureEnv("PORT=5555\n");

      const overrides = loadDotenvOverrides(fixturePath);

      expect(overrides).toEqual({ PORT: "5555" });
      expect(process.env.PORT).toBe("9999"); // process.env itself is untouched
    });

    it("still no-ops under NODE_ENV=test even when the fixture file exists", () => {
      process.env.NODE_ENV = "test";
      const fixturePath = writeFixtureEnv("PORT=5555\n");

      expect(loadDotenvOverrides(fixturePath)).toEqual({});
    });

    it("returns {} when the file doesn't exist", () => {
      process.env.NODE_ENV = "development";

      expect(loadDotenvOverrides("/nonexistent/path/.env")).toEqual({});
    });
  });
});
