import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { pushSubscriptions } from "../../src/db/schema.js";

const tmpDb = path.join(os.tmpdir(), `push-route-test-${process.pid}.db`);

describe("push route (issue #95 prerequisite)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("GET vapid-public-key returns a stable key across two calls", async () => {
    const app = await buildApp();
    const res1 = await app.inject({ method: "GET", url: "/api/push/vapid-public-key" });
    const res2 = await app.inject({ method: "GET", url: "/api/push/vapid-public-key" });
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    const { publicKey: key1 } = res1.json();
    const { publicKey: key2 } = res2.json();
    expect(typeof key1).toBe("string");
    expect(key1.length).toBeGreaterThan(0);
    expect(key1).toBe(key2);
    await app.close();
  });

  it("GET vapid-public-key returns the same key across a fresh app instance (persisted, not regenerated)", async () => {
    const app1 = await buildApp();
    const res1 = await app1.inject({ method: "GET", url: "/api/push/vapid-public-key" });
    await app1.close();

    const app2 = await buildApp();
    const res2 = await app2.inject({ method: "GET", url: "/api/push/vapid-public-key" });
    await app2.close();

    expect(res1.json().publicKey).toBe(res2.json().publicKey);
  });

  it("POST subscribe stores a subscription and returns 204", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: {
        endpoint: "https://push.example.com/abc",
        keys: { p256dh: "p256dh-value", auth: "auth-value" },
      },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("POST subscribe with the same endpoint twice upserts to one row, not two", async () => {
    const app = await buildApp();
    const endpoint = "https://push.example.com/upsert-test";
    await app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: { endpoint, keys: { p256dh: "p256dh-1", auth: "auth-1" } },
    });
    await app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: { endpoint, keys: { p256dh: "p256dh-2", auth: "auth-2" } },
    });

    // Scoped by endpoint, not listSubscriptions()'s full table — this
    // describe block shares one DB across tests (see beforeAll), so an
    // unscoped count would double-count rows other tests already inserted.
    const rows = app.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dhKey).toBe("p256dh-2");
    // Encryption is disabled in this describe block (no DB_ENCRYPTION_KEY),
    // so authKeyEnc is the plaintext auth value — confirms re-subscribing
    // rotates BOTH keys, not just p256dh/userAgent.
    expect(rows[0].authKeyEnc).toBe("auth-2");
    await app.close();
  });

  it("POST subscribe 400s on a malformed body", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: { endpoint: "https://push.example.com/x" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("DELETE unsubscribe removes a stored subscription", async () => {
    const app = await buildApp();
    const endpoint = "https://push.example.com/to-remove";
    await app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: { endpoint, keys: { p256dh: "p256dh", auth: "auth" } },
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/push/unsubscribe",
      payload: { endpoint },
    });
    expect(res.statusCode).toBe(204);

    const rows = app.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .all();
    expect(rows).toHaveLength(0);
    await app.close();
  });

  it("DELETE unsubscribe on an unknown endpoint doesn't 500", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/push/unsubscribe",
      payload: { endpoint: "https://push.example.com/never-subscribed" },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  // Regression test for the #535/#534 class of mistake — a new /api/* route
  // silently exempted from (or never covered by) authPlugin's global gate.
  // Push has no reason to be its own auth boundary, so it must NOT be added
  // to auth.ts's exemption ladder; this pins that.
  describe("with in-process auth enabled", () => {
    const TEST_TOKEN = "push-route-test-token";

    beforeAll(() => {
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = crypto.randomBytes(32).toString("base64url");
    });

    afterAll(() => {
      delete process.env.MULLION_AUTH_TOKEN;
      delete process.env.MULLION_SESSION_SECRET;
    });

    it("401s GET /api/push/vapid-public-key with no credential", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/push/vapid-public-key" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("401s POST /api/push/subscribe with no credential", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/push/subscribe",
        payload: { endpoint: "https://push.example.com/x", keys: { p256dh: "a", auth: "b" } },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("401s DELETE /api/push/unsubscribe with no credential", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/push/unsubscribe",
        payload: { endpoint: "https://push.example.com/x" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("200s GET /api/push/vapid-public-key with a valid bearer token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/push/vapid-public-key",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });
});
