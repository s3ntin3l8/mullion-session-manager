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
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/server-info" });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toMatchObject({
      nodeEnv: "test",
      encryptionEnabled: false,
      sessionsDir: expect.any(String),
      dbPath: tmpDb,
      uptimeSeconds: expect.any(Number),
      rateLimit: { max: expect.any(Number), window: expect.any(String) },
      projectsRoots: expect.any(String),
      crsConfigDir: expect.any(String),
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
});
