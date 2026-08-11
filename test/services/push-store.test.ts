import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { pushKeys, pushSubscriptions } from "../../src/db/schema.js";
import {
  getOrCreateVapidKeys,
  getSubscriptionsForSend,
  recordSendFailure,
  recordSendSuccess,
  upsertSubscription,
} from "../../src/services/push-store.js";

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
    const app = await buildTestApp();
    const first = getOrCreateVapidKeys(app);
    const second = getOrCreateVapidKeys(app);
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.privateKey).toBe(second.privateKey);

    const rows = app.db.select().from(pushKeys).all();
    expect(rows).toHaveLength(1);
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
      const app = await buildTestApp();
      const { privateKey } = getOrCreateVapidKeys(app);

      const [row] = app.db.select().from(pushKeys).where(eq(pushKeys.id, 1)).all();
      expect(row).toBeDefined();
      expect(row!.privateKeyEnc).not.toBe(privateKey);
      expect(row!.privateKeyEnc.startsWith("enc:")).toBe(true);
    });

    it("stores a subscription's auth key encrypted, not in plaintext", async () => {
      const app = await buildTestApp();
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
    });

    it("getSubscriptionsForSend skips an undecryptable row instead of aborting the whole batch", async () => {
      const app = await buildTestApp();
      // This describe block shares one DB across tests — clear it first so
      // an earlier test's still-present, validly-encrypted row doesn't
      // count toward this test's own length assertions.
      app.db.delete(pushSubscriptions).run();
      upsertSubscription(app, {
        endpoint: "https://push.example.com/good",
        p256dh: "p256dh-good",
        auth: "auth-good",
      });
      // Simulate a corrupted/misconfigured row directly — a malformed
      // "enc:"-prefixed value that decryptString will throw on.
      app.db
        .update(pushSubscriptions)
        .set({ authKeyEnc: "enc:not-valid-ciphertext" }) // pragma: allowlist secret
        .where(eq(pushSubscriptions.endpoint, "https://push.example.com/good"))
        .run();
      upsertSubscription(app, {
        endpoint: "https://push.example.com/bad",
        p256dh: "p256dh-bad",
        auth: "auth-bad",
      });
      app.db
        .update(pushSubscriptions)
        .set({ authKeyEnc: "enc:also-not-valid" }) // pragma: allowlist secret
        .where(eq(pushSubscriptions.endpoint, "https://push.example.com/bad"))
        .run();

      // Both rows are now undecryptable — should skip both, not throw.
      expect(() => getSubscriptionsForSend(app)).not.toThrow();
      expect(getSubscriptionsForSend(app)).toHaveLength(0);

      // A THIRD, valid row alongside the two broken ones must still come
      // back — one bad row can't poison the batch for the others.
      upsertSubscription(app, {
        endpoint: "https://push.example.com/valid",
        p256dh: "p256dh-valid",
        auth: "auth-valid",
      });
      const results = getSubscriptionsForSend(app);
      expect(results).toHaveLength(1);
      expect(results[0].endpoint).toBe("https://push.example.com/valid");
      expect(results[0].auth).toBe("auth-valid");
    });
  });

  it("recordSendSuccess clears a stale lastFailureAt", async () => {
    const app = await buildTestApp();
    upsertSubscription(app, {
      endpoint: "https://push.example.com/recovers",
      p256dh: "p256dh",
      auth: "auth",
    });
    recordSendFailure(app, "https://push.example.com/recovers");

    const [beforeRow] = app.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, "https://push.example.com/recovers"))
      .all();
    expect(beforeRow!.lastFailureAt).not.toBeNull();

    recordSendSuccess(app, "https://push.example.com/recovers");

    const [afterRow] = app.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, "https://push.example.com/recovers"))
      .all();
    expect(afterRow!.lastFailureAt).toBeNull();
    expect(afterRow!.lastSuccessAt).not.toBeNull();
  });
});
