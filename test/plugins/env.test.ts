import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../../src/app.js";
import { loadDotenvOverrides } from "../../src/plugins/env.js";

describe("env plugin", () => {
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
    expect(app.config.TESSERA_ROLE).toBe("primary");
    expect(app.config.TESSERA_AGENT_TOKEN).toBe("");
    expect(app.config.TESSERA_AUTH_TOKEN).toBe("");
    expect(app.config.TESSERA_SESSION_SECRET).toBe("");
    expect(app.config.PREVIEW_BASE_HOST).toBe("");
    await app.close();
  });

  it("respects environment variable overrides", async () => {
    // This only exercises the NODE_ENV=test path, where loadDotenvOverrides()
    // in env.ts returns {} and process.env is the sole config source — it
    // does NOT cover (and can't guard) the non-test path, where a real .env
    // file now wins over process.env on purpose (issue #70: an inherited
    // PORT/DATABASE_URL/etc. from a parent Tessera process must lose to the
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
      // inherited value (as if from a parent Tessera process) before .env
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
