import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { pushKeys, pushSubscriptions } from "../../src/db/schema.js";
import { getOrCreateVapidKeys, upsertSubscription } from "../../src/services/push-store.js";

const tmpDb = path.join(os.tmpdir(), `push-store-test-${process.pid}.db`);

describe("push-store (issue #95 prerequisite)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("getOrCreateVapidKeys generates once and is idempotent across calls", async () => {
    const app = await buildApp();
    const first = getOrCreateVapidKeys(app);
    const second = getOrCreateVapidKeys(app);
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.privateKey).toBe(second.privateKey);

    const rows = app.db.select().from(pushKeys).all();
    expect(rows).toHaveLength(1);
    await app.close();
  });

  describe("with DB_ENCRYPTION_KEY set", () => {
    // Its own DB, isolated from the outer describe's tmpDb: push_keys is a
    // singleton row (id=1), and reusing the outer DB here would read back
    // the unencrypted row the "idempotent across calls" test above already
    // created, rather than exercising a fresh, encrypted insert.
    const encTmpDb = path.join(os.tmpdir(), `push-store-enc-test-${process.pid}.db`);

    beforeAll(() => {
      // getDb()'s connection is a module-level singleton (see
      // db/client.ts) — must close it before pointing DATABASE_URL at a
      // different file, or the next buildApp() would keep reusing the
      // outer describe's already-open connection.
      closeDb();
      fs.rmSync(encTmpDb, { force: true });
      process.env.DATABASE_URL = `file:${encTmpDb}`;
      process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
    });

    afterAll(() => {
      closeDb();
      fs.rmSync(encTmpDb, { force: true });
      process.env.DATABASE_URL = `file:${tmpDb}`;
      delete process.env.DB_ENCRYPTION_KEY;
    });

    it("stores the VAPID private key encrypted, not in plaintext", async () => {
      const app = await buildApp();
      const { privateKey } = getOrCreateVapidKeys(app);

      const [row] = app.db.select().from(pushKeys).where(eq(pushKeys.id, 1)).all();
      expect(row).toBeDefined();
      expect(row!.privateKeyEnc).not.toBe(privateKey);
      expect(row!.privateKeyEnc.startsWith("enc:")).toBe(true);
      await app.close();
    });

    it("stores a subscription's auth key encrypted, not in plaintext", async () => {
      const app = await buildApp();
      upsertSubscription(app, {
        endpoint: "https://push.example.com/encryption-test",
        p256dh: "p256dh-plain",
        auth: "auth-secret-plain",
      });

      const [row] = app.db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, "https://push.example.com/encryption-test"))
        .all();
      expect(row).toBeDefined();
      // p256dh is public key material, stored plaintext by design.
      expect(row!.p256dhKey).toBe("p256dh-plain");
      expect(row!.authKeyEnc).not.toBe("auth-secret-plain");
      expect(row!.authKeyEnc.startsWith("enc:")).toBe(true);
      await app.close();
    });
  });
});
