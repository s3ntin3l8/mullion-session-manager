import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { disconnect } from "../../src/services/github-integration.js";
import { resetDeviceFlowForTests } from "../../src/services/github-device-flow.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const tmpDb = path.join(os.tmpdir(), `integrations-route-test-${process.pid}.db`);

// A real (but disposable, never a checked-in fixture) RSA keypair — the
// PUT route now validates the key parses via crypto.createPrivateKey, so a
// placeholder string like "fake-pem" 400s.
const { privateKey: FAKE_APP_PRIVATE_KEY } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
}); // pragma: allowlist secret

describe("integrations route (issue #27)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    resetDeviceFlowForTests();
    // Singleton row shared across this file's tests (see beforeAll) — reset
    // it so an earlier test's connected state never leaks into the next.
    const app = await buildApp();
    disconnect(app);
    await app.close();
  });

  it("GET reports disconnected with no integration configured", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/integrations/github" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({ connected: false, login: null, tokenType: null }),
    );
    await app.close();
  });

  it("PUT validates and stores a PAT, never returning the token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/integrations/github/token",
      payload: { token: "ghp_super_secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({ connected: true, tokenType: "pat", login: "octocat" }),
    );
    expect(res.body).not.toMatch(/ghp_super_secret/);
    await app.close();
  });

  it("PUT 400s when GitHub rejects the token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "Bad credentials" }));
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/integrations/github/token",
      payload: { token: "bad-token" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("PUT 400s an empty token body", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/integrations/github/token",
      payload: { token: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("DELETE disconnects and GET reflects it afterward", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    const app = await buildApp();
    await app.inject({
      method: "PUT",
      url: "/api/integrations/github/token",
      payload: { token: "ghp_abc" },
    });

    const del = await app.inject({ method: "DELETE", url: "/api/integrations/github" });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
    expect(get.json()).toEqual(expect.objectContaining({ connected: false }));
    await app.close();
  });

  describe("GitHub App (#489)", () => {
    it("PUT stores the App credentials, and GET's summary never reflects them", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).not.toMatch(/BEGIN RSA PRIVATE KEY/); // pragma: allowlist secret

      // The App credentials are write-only — not part of the PAT summary.
      const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
      expect(get.body).not.toMatch(/BEGIN RSA PRIVATE KEY/); // pragma: allowlist secret
      await app.close();
    });

    it("PUT 400s an empty appId or privateKey", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "", privateKey: FAKE_APP_PRIVATE_KEY },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("PUT 400s a non-numeric appId (Hermes review, PR #504)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "not-a-number", privateKey: FAKE_APP_PRIVATE_KEY },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("PUT 400s a privateKey that isn't a parseable PEM (Hermes review, PR #504)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "123", privateKey: "not a real key" }, // pragma: allowlist secret
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("PUT does not disturb an already-connected PAT", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_abc" },
      });

      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
      });

      const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
      expect(get.json()).toEqual(expect.objectContaining({ connected: true, login: "octocat" }));
      await app.close();
    });

    it("DELETE clears the App credentials without disconnecting the PAT", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_abc" },
      });
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
      });

      const del = await app.inject({ method: "DELETE", url: "/api/integrations/github/app" });
      expect(del.statusCode).toBe(204);

      const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
      expect(get.json()).toEqual(expect.objectContaining({ connected: true, login: "octocat" }));
      await app.close();
    });
  });

  describe("device flow (phase 4)", () => {
    const DEVICE_CODE_RESPONSE = {
      device_code: "device-code-abc",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    };

    beforeAll(() => {
      process.env.GITHUB_OAUTH_CLIENT_ID = "Iv1.test-client-id";
    });

    afterAll(() => {
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
    });

    it("GET status 404s with no attempt in progress", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/integrations/github/device/status",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("POST start returns pending + user_code, and GET status reflects it", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, DEVICE_CODE_RESPONSE));
      const app = await buildApp();

      const start = await app.inject({
        method: "POST",
        url: "/api/integrations/github/device/start",
      });
      expect(start.statusCode).toBe(200);
      expect(start.json()).toEqual({
        status: "pending",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
      });
      expect(start.body).not.toMatch(/device-code-abc/);

      const status = await app.inject({
        method: "GET",
        url: "/api/integrations/github/device/status",
      });
      expect(status.statusCode).toBe(200);
      expect(status.json().userCode).toBe("ABCD-1234");
      await app.close();
    });

    it("POST start 400s when device flow isn't configured", async () => {
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/integrations/github/device/start",
      });
      expect(res.statusCode).toBe(400);
      process.env.GITHUB_OAUTH_CLIENT_ID = "Iv1.test-client-id";
      await app.close();
    });
  });
});
