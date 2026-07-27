import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { eq } from "drizzle-orm";
import { integrations } from "../../src/db/schema.js";
import { GITHUB_PROVIDER } from "../../src/services/github-integration.js";

const tmpDb = path.join(os.tmpdir(), `webhooks-route-test-${process.pid}.db`);
const TEST_SECRET = "test-webhook-secret-123"; // pragma: allowlist secret

function signPayload(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("webhook routes", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_WEBHOOK_BASE_URL = "https://hooks.example.com";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_WEBHOOK_BASE_URL;
  });

  beforeEach(async () => {
    // Seed the integrations row with a known webhook secret.
    const app = await buildApp();
    const secretEnc = app.encryption.encryptString(TEST_SECRET);
    app.db
      .insert(integrations)
      .values({
        provider: GITHUB_PROVIDER,
        webhookEnabled: true,
        webhookSecretEnc: secretEnc,
      })
      .onConflictDoUpdate({
        target: integrations.provider,
        set: { webhookEnabled: true, webhookSecretEnc: secretEnc },
      })
      .run();
    await app.close();
  });

  it("rejects requests without x-hub-signature-256 header", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: { action: "opened" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "missing signature" });
    await app.close();
  });

  it("rejects requests with an invalid signature", async () => {
    const app = await buildApp();
    const payload = JSON.stringify({ action: "opened" });
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=invalid",
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid signature" });
    await app.close();
  });

  it("accepts requests with a valid signature and returns 200", async () => {
    const app = await buildApp();
    const payload = JSON.stringify({ action: "opened", pull_request: { id: 1 } });
    const sig = signPayload(payload, TEST_SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it("accepts known GitHub event types (x-github-event header)", async () => {
    const app = await buildApp();
    const payload = JSON.stringify({ action: "synchronize" });
    const sig = signPayload(payload, TEST_SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-event": "pull_request",
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts unknown event types gracefully", async () => {
    const app = await buildApp();
    const payload = JSON.stringify({ zen: "anything" });
    const sig = signPayload(payload, TEST_SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-event": "ping",
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("returns 401 when no webhook secret is configured", async () => {
    // Overwrite the DB row to have no secret.
    const seedApp = await buildApp();
    seedApp.db
      .update(integrations)
      .set({ webhookSecretEnc: null })
      .where(eq(integrations.provider, GITHUB_PROVIDER))
      .run();
    await seedApp.close();

    const app = await buildApp();
    const payload = JSON.stringify({ action: "opened" });
    const sig = signPayload(payload, TEST_SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "webhook not configured" });
    await app.close();
  });
});
