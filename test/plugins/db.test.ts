import { describe, it, expect, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { EncryptionService } from "../../src/services/encryption.js";
import { hosts, projects } from "../../src/db/schema.js";
import { buildTestApp } from "../helpers/app.js";

const tmpDb = path.join(os.tmpdir(), `db-plugin-test-${process.pid}.db`);

describe("db plugin", () => {
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("decorates the app with db and encryption and runs migrations", async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;

    const app = await buildTestApp();
    expect(app.db).toBeDefined();
    expect(app.encryption).toBeInstanceOf(EncryptionService);

    // Migration 0008 (issue #26) seeds the "local" host and every project
    // defaults onto it — the seed is hand-added SQL (drizzle-kit only emits
    // schema DDL, never data), so this is the one thing worth asserting
    // directly rather than trusting it stayed correct across future edits.
    const seededHosts = app.db.select().from(hosts).all();
    expect(seededHosts).toEqual([
      expect.objectContaining({ id: "local", name: "Local", baseUrl: null, authTokenEnc: null }),
    ]);
    const [project] = app.db
      .insert(projects)
      .values({ name: "test", cwd: "/tmp/test" })
      .returning()
      .all();
    expect(project.hostId).toBe("local");

    // Closing the app tears down the DB without throwing.
    await expect(app.close()).resolves.not.toThrow();
  });
});

// Security audit finding AS3: DB_ENCRYPTION_KEY must decode to exactly 32
// bytes. Before this fix, EncryptionService's constructor silently
// `.subarray(0, 32)`'d whatever it decoded — a short/invalid-base64url key
// either got silently truncated (or, for an invalid-base64url passphrase,
// silently accepted at a much shorter length) rather than refusing to boot.
// This block pins src/app.ts's own boot-invariant check (added alongside
// the existing MULLION_SESSION_SECRET/OIDC/PREVIEW_AUTH_REQUIRED checks),
// which now runs before dbPlugin ever constructs an EncryptionService.
describe("DB_ENCRYPTION_KEY boot invariant (finding AS3)", () => {
  afterAll(() => {
    delete process.env.DB_ENCRYPTION_KEY;
  });

  it("refuses to boot with a key that decodes to fewer than 32 bytes", async () => {
    process.env.DB_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64url");
    await expect(buildApp()).rejects.toThrow(/DB_ENCRYPTION_KEY must decode to exactly 32 bytes/);
  });

  it("refuses to boot with a plain (non-base64url) passphrase — decodes short, not 32 bytes", async () => {
    process.env.DB_ENCRYPTION_KEY = "my-secret-passphrase!!";
    await expect(buildApp()).rejects.toThrow(/DB_ENCRYPTION_KEY must decode to exactly 32 bytes/);
  });

  it("boots fine with a proper 32-byte key", async () => {
    process.env.DB_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");
    process.env.DATABASE_URL = `file:${tmpDb}-as3`;
    const app = await buildTestApp();
    expect(app.encryption.isEnabled).toBe(true);
    await app.close();
    closeDb();
    fs.rmSync(`${tmpDb}-as3`, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("boots fine with DB_ENCRYPTION_KEY left empty — encryption stays disabled, not an error", async () => {
    delete process.env.DB_ENCRYPTION_KEY;
    process.env.DATABASE_URL = `file:${tmpDb}-as3-empty`;
    const app = await buildTestApp();
    expect(app.encryption.isEnabled).toBe(false);
    await app.close();
    closeDb();
    fs.rmSync(`${tmpDb}-as3-empty`, { force: true });
    delete process.env.DATABASE_URL;
  });
});
