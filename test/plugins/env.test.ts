import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../../src/app.js";

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
    // schema default is applied. PORT doesn't need the same treatment:
    // envPlugin skips dotenv entirely under NODE_ENV=test (see env.ts), so a
    // developer's real local .env — e.g. a PORT override to dodge a conflict
    // with another project's dev server, as on this box — never leaks in.
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
    expect(app.config.PREVIEW_BASE_HOST).toBe("");
    await app.close();
  });

  it("respects environment variable overrides", async () => {
    process.env.PORT = "4000";
    process.env.LOG_LEVEL = "debug";

    const app = await buildApp();
    expect(app.config.PORT).toBe(4000);
    expect(app.config.LOG_LEVEL).toBe("debug");
    await app.close();
  });
});
