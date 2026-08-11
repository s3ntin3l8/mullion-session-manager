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
    delete process.env.BROWSER_ENABLED;
    delete process.env.BROWSER_MAX_INSTANCES;
    delete process.env.BROWSER_FRAMERATE;
    delete process.env.BROWSER_DATA_DIR;
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
    expect(app.config.HOST).toBe("127.0.0.1");
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
    expect(app.config.PREVIEW_AUTH_REQUIRED).toBe(false);
    // MULLION_REVIEW_GATE_ENABLED is the schema's first `type: "boolean"`
    // entry (every prior key is string/number) — assert its unset default
    // resolves to the real boolean `false`, not the schema's raw `default`
    // value going unconverted.
    expect(app.config.MULLION_REVIEW_GATE_ENABLED).toBe(false);
    expect(app.config.MULLION_TASK_MASTER_ENABLED).toBe(false);
    expect(app.config.MULLION_TASK_LABEL).toBe("mullion-task");
    expect(app.config.MULLION_TASK_POLL_INTERVAL).toBe(60);
    expect(app.config.BROWSER_ENABLED).toBe(false);
    expect(app.config.BROWSER_MAX_INSTANCES).toBe(4);
    expect(app.config.BROWSER_FRAMERATE).toBe(10);
    expect(app.config.BROWSER_DATA_DIR).toBe("./data/browsers");
    expect(app.config.MULLION_SOCKET_PATH).toBe("");
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

  // Same "string -> real boolean" coercion concern as
  // MULLION_REVIEW_GATE_ENABLED above, for issue #383's new flag.
  describe("PREVIEW_AUTH_REQUIRED boolean coercion", () => {
    afterEach(() => {
      delete process.env.PREVIEW_AUTH_REQUIRED;
      delete process.env.PREVIEW_BASE_HOST;
      delete process.env.MULLION_SESSION_SECRET;
      delete process.env.MULLION_AUTH_TOKEN;
    });

    it('coerces the string "true" to the real boolean true', async () => {
      process.env.PREVIEW_AUTH_REQUIRED = "true";
      // Avoid app.ts's boot-time invariants that require in-process auth to
      // be configured (MULLION_AUTH_TOKEN) and a session secret to be set
      // whenever this flag is true — irrelevant to what this test covers
      // (schema coercion), so both are set here just so buildApp() doesn't throw.
      process.env.MULLION_AUTH_TOKEN = "test-auth-token-0123456789";
      process.env.MULLION_SESSION_SECRET = "test-session-secret-0123456789";
      const app = await buildApp();
      expect(app.config.PREVIEW_AUTH_REQUIRED).toBe(true);
      await app.close();
    });

    it('coerces the string "false" to the real boolean false', async () => {
      process.env.PREVIEW_AUTH_REQUIRED = "false";
      const app = await buildApp();
      expect(app.config.PREVIEW_AUTH_REQUIRED).toBe(false);
      await app.close();
    });
  });

  // Issue #245 / roadmap 7.1 — Hermes review, PR #528: new URL() accepts
  // any scheme, so without an explicit protocol check a typo'd
  // MULLION_PRIMARY_URL/MULLION_AGENT_ADVERTISE_URL would pass boot
  // validation and only fail later, silently and repeatedly, in
  // agent-enrollment.ts's retry loop.
  describe("MULLION_PRIMARY_URL / MULLION_AGENT_ADVERTISE_URL validation", () => {
    afterEach(() => {
      delete process.env.MULLION_PRIMARY_URL;
      delete process.env.MULLION_AGENT_ADVERTISE_URL;
    });

    it("accepts an http(s) MULLION_PRIMARY_URL", async () => {
      process.env.MULLION_PRIMARY_URL = "http://primary.example.com";
      const app = await buildApp();
      expect(app.config.MULLION_PRIMARY_URL).toBe("http://primary.example.com");
      await app.close();
    });

    it("rejects a non-http(s) MULLION_PRIMARY_URL scheme", async () => {
      process.env.MULLION_PRIMARY_URL = "ftp://primary.example.com";
      await expect(buildApp()).rejects.toThrow(/MULLION_PRIMARY_URL must be an http\(s\) URL/);
    });

    it("rejects a malformed MULLION_PRIMARY_URL", async () => {
      process.env.MULLION_PRIMARY_URL = "not a url";
      await expect(buildApp()).rejects.toThrow(/MULLION_PRIMARY_URL is not a valid URL/);
    });

    it("accepts an http(s) MULLION_AGENT_ADVERTISE_URL", async () => {
      process.env.MULLION_AGENT_ADVERTISE_URL = "https://192.168.1.20:4000";
      const app = await buildApp();
      expect(app.config.MULLION_AGENT_ADVERTISE_URL).toBe("https://192.168.1.20:4000");
      await app.close();
    });

    it("rejects a non-http(s) MULLION_AGENT_ADVERTISE_URL scheme", async () => {
      process.env.MULLION_AGENT_ADVERTISE_URL = "file:///etc/passwd";
      await expect(buildApp()).rejects.toThrow(
        /MULLION_AGENT_ADVERTISE_URL must be an http\(s\) URL/,
      );
    });
  });

  // Finding AS5 (Hermes + independent review follow-up on PR #575) —
  // hitFixedWindow's check is `entry.count > max`, so PREVIEW_RATE_LIMIT_MAX=0
  // (an operator's natural "no limit" instinct, and the convention this
  // schema uses for several *other* vars — see MULLION_TASK_BUDGET_MINUTES)
  // does NOT disable the limiter here: it silently 429s every preview
  // request past the first per window instead. `minimum: 1` on the schema
  // entry rejects this at boot (ajv, via @fastify/env) rather than letting
  // it surface as a confusing runtime failure — same pattern as
  // MULLION_TASK_MAX_CONCURRENT's own `minimum: 1`.
  describe("PREVIEW_RATE_LIMIT_MAX validation", () => {
    afterEach(() => {
      delete process.env.PREVIEW_RATE_LIMIT_MAX;
    });

    it("accepts a positive value", async () => {
      process.env.PREVIEW_RATE_LIMIT_MAX = "500";
      const app = await buildApp();
      expect(app.config.PREVIEW_RATE_LIMIT_MAX).toBe(500);
      await app.close();
    });

    it("rejects 0 at boot instead of silently 429ing every preview request past the first", async () => {
      process.env.PREVIEW_RATE_LIMIT_MAX = "0";
      await expect(buildApp()).rejects.toThrow(/PREVIEW_RATE_LIMIT_MAX must be >= 1/);
    });

    it("rejects a negative value at boot", async () => {
      process.env.PREVIEW_RATE_LIMIT_MAX = "-5";
      await expect(buildApp()).rejects.toThrow(/PREVIEW_RATE_LIMIT_MAX must be >= 1/);
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
