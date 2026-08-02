import { describe, it, expect, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

// Pure config read-out — no PtyManager/DB content involved beyond the
// standard per-test-file isolated DB, matching test/setup.ts's convention.
const tmpDb = path.join(os.tmpdir(), `server-info-test-${process.pid}.db`);

describe("server-info route", () => {
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
  });

  it("returns read-only diagnostics without ever exposing DB_ENCRYPTION_KEY", async () => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
    // No need to restore NODE_ENV or clear DB_ENCRYPTION_KEY/PREVIEW_BASE_HOST
    // here — test/setup.ts now forces NODE_ENV to "test" and clears every
    // other schema-defined config var once per test file, so a developer's
    // shell never leaks into these assertions.
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/server-info" });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toMatchObject({
      role: "primary",
      nodeEnv: "test",
      encryptionEnabled: false,
      sessionsDir: expect.any(String),
      dbPath: tmpDb,
      uptimeSeconds: expect.any(Number),
      rateLimit: { max: expect.any(Number), window: expect.any(String) },
      projectsRoots: expect.any(String),
      crsConfigDir: expect.any(String),
      previewsEnabled: false,
      previewBaseHost: "",
      previewAuthRequired: false,
      taskMasterEnabled: false,
      taskMasterEnv: {
        enabled: false,
        maxConcurrent: expect.any(Number),
        budgetMinutes: expect.any(Number),
        progressCommentMinutes: expect.any(Number),
        issueLabel: expect.any(String),
        pollIntervalSeconds: expect.any(Number),
      },
    });
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("DB_ENCRYPTION_KEY");

    await app.close();
    delete process.env.DATABASE_URL;
  });

  it("reports encryptionEnabled true when a key is configured", async () => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.DB_ENCRYPTION_KEY = "a".repeat(44);
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/server-info" });
    expect(res.json().encryptionEnabled).toBe(true);

    await app.close();
    delete process.env.DATABASE_URL;
    delete process.env.DB_ENCRYPTION_KEY;
  });

  it("reports previewsEnabled true and the configured base host when PREVIEW_BASE_HOST is set", async () => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_BASE_HOST = "preview.example.com";
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/server-info" });
    expect(res.json()).toMatchObject({
      previewsEnabled: true,
      previewBaseHost: "preview.example.com",
    });

    await app.close();
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
  });

  it("reports previewAuthRequired true when PREVIEW_AUTH_REQUIRED is set (issue #383)", async () => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_AUTH_REQUIRED = "true";
    // app.ts's own boot invariant requires in-process auth to be configured
    // whenever PREVIEW_AUTH_REQUIRED is on — this also turns authPlugin's
    // gate on for /api/server-info itself, hence the Bearer header below.
    const testAuthToken = "test-server-info-auth-token-0123456789";
    process.env.MULLION_AUTH_TOKEN = testAuthToken;
    process.env.MULLION_SESSION_SECRET = "test-session-secret-0123456789";
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/server-info",
      headers: { authorization: `Bearer ${testAuthToken}` },
    });
    expect(res.json().previewAuthRequired).toBe(true);

    await app.close();
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_AUTH_REQUIRED;
    delete process.env.MULLION_AUTH_TOKEN;
    delete process.env.MULLION_SESSION_SECRET;
  });

  it("reports taskMasterEnabled true when MULLION_TASK_MASTER_ENABLED is set", async () => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/server-info" });
    expect(res.json().taskMasterEnabled).toBe(true);

    await app.close();
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  // Settings UI follow-up — taskMasterEnabled now reports the *resolved*
  // value: a settings override must win over the env default in both
  // directions (env true, settings off; and, in the sibling test below,
  // env false, settings on), while taskMasterEnv keeps reporting the raw
  // env value unchanged either way.
  it("resolves taskMasterEnabled from settings when it overrides an env default of true", async () => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    const app = await buildApp();

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { taskMaster: { enabled: "off" } },
    });

    const res = await app.inject({ method: "GET", url: "/api/server-info" });
    const body = res.json();
    expect(body.taskMasterEnabled).toBe(false);
    expect(body.taskMasterEnv.enabled).toBe(true);

    await app.close();
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  it("resolves taskMasterEnabled from settings when it overrides an env default of false", async () => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
    const app = await buildApp();

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { taskMaster: { enabled: "on" } },
    });

    const res = await app.inject({ method: "GET", url: "/api/server-info" });
    const body = res.json();
    expect(body.taskMasterEnabled).toBe(true);
    expect(body.taskMasterEnv.enabled).toBe(false);

    await app.close();
    delete process.env.DATABASE_URL;
  });
});
