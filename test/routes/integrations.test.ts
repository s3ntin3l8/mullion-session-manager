import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  disconnect,
  clearGitHubApp,
  setGitHubApp,
  GITHUB_REVIEWER_PROVIDER,
} from "../../src/services/github-integration.js";
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

  // #514 — the App PUT route now makes a live GET /app call to verify the
  // credential before persisting, so every test that PUTs App credentials
  // and expects success needs api.github.com's various endpoints routed to
  // something sane, not just a single flat mockResolvedValue (which would
  // otherwise serve the SAME body to /user, /app, and /app/installations
  // alike). Defaults match the FAKE_APP_PRIVATE_KEY/appId "123" shape most
  // tests below use; override per test as needed.
  function stubGithubFetch(
    overrides: { appId?: string; appSlug?: string; patLogin?: string } = {},
  ) {
    const { appId = "123", appSlug = "test-app", patLogin = "octocat" } = overrides;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/user")) return Promise.resolve(jsonResponse(200, { login: patLogin }));
      if (url.endsWith("/app")) {
        return Promise.resolve(jsonResponse(200, { id: Number(appId), slug: appSlug }));
      }
      if (url.includes("/app/installations")) return Promise.resolve(jsonResponse(200, []));
      return Promise.resolve(jsonResponse(200, {}));
    });
  }

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
    // #737 — also clears BOTH App rows: the Reviewer App describe block
    // below depends on a clean primary-App slate (e.g. "no primary App
    // configured yet"), which a prior "GitHub App" test leaving appId
    // "123" configured would otherwise silently violate.
    const app = await buildApp();
    disconnect(app);
    clearGitHubApp(app);
    clearGitHubApp(app, GITHUB_REVIEWER_PROVIDER);
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
    it("PUT stores the App credentials, verifies them, and GET's summary never reflects the key", async () => {
      stubGithubFetch({ appId: "123" });
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
      });
      // #514 — no longer a bare 204: the successful verification result is
      // returned so the caller (and Settings' UI) can confirm the App id
      // it just configured.
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({
          verified: true,
          appSlug: "test-app",
          keyFingerprint: expect.any(String),
        }),
      );
      expect(res.body).not.toMatch(/BEGIN RSA PRIVATE KEY/); // pragma: allowlist secret

      // The App credentials are write-only — not part of the PAT summary.
      const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
      expect(get.body).not.toMatch(/BEGIN RSA PRIVATE KEY/); // pragma: allowlist secret
      expect(get.json().githubApp).toEqual(
        expect.objectContaining({ configured: true, appId: "123" }),
      );
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

    it("PUT 400s a valid but non-RSA private key (Hermes review, PR #504, round 4)", async () => {
      // signAppJwt signs with RSA-SHA256 specifically — a parseable EC key
      // would otherwise pass config-time validation and only fail (or
      // silently PAT-fallback) on the next write.
      const { privateKey: ecKey } = crypto.generateKeyPairSync("ec", {
        namedCurve: "P-256",
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "123", privateKey: ecKey },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("PUT does not disturb an already-connected PAT", async () => {
      stubGithubFetch({ appId: "123" });
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
      stubGithubFetch({ appId: "123" });
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

    // #514 — verification against GitHub's own GET /app, on top of the
    // local parse/type checks above.
    describe("verification (#514)", () => {
      it("PUT 400s on a 401 (GitHub rejected the key/App-id pair) and persists nothing", async () => {
        fetchMock.mockResolvedValue(jsonResponse(401, {}));
        const app = await buildApp();
        const res = await app.inject({
          method: "PUT",
          url: "/api/integrations/github/app",
          payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
        });
        expect(res.statusCode).toBe(400);

        const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
        expect(get.json().githubApp).toEqual(expect.objectContaining({ configured: false }));
        await app.close();
      });

      it("PUT 400s when the key belongs to a DIFFERENT App, naming which one, and persists nothing", async () => {
        fetchMock.mockResolvedValue(jsonResponse(200, { id: 999, slug: "someone-elses-app" }));
        const app = await buildApp();
        const res = await app.inject({
          method: "PUT",
          url: "/api/integrations/github/app",
          payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toMatch(/999/);

        const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
        expect(get.json().githubApp).toEqual(expect.objectContaining({ configured: false }));
        await app.close();
      });

      // Deliberately narrower than "any 4xx rejects" — a 403 (e.g. a
      // secondary rate limit) or 404 means "GitHub had a bad moment," not
      // "this credential is wrong," and must not block a rotation.
      it("PUT persists on a 403 from GET /app, reporting verified:false rather than rejecting", async () => {
        fetchMock.mockResolvedValue(jsonResponse(403, { message: "rate limited" }));
        const app = await buildApp();
        const res = await app.inject({
          method: "PUT",
          url: "/api/integrations/github/app",
          payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(
          expect.objectContaining({ verified: false, keyFingerprint: expect.any(String) }),
        );

        const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
        expect(get.json().githubApp).toEqual(expect.objectContaining({ configured: true }));
        await app.close();
      });

      it("PUT persists on a network error, reporting verified:false rather than 500ing", async () => {
        fetchMock.mockRejectedValue(new TypeError("fetch failed"));
        const app = await buildApp();
        const res = await app.inject({
          method: "PUT",
          url: "/api/integrations/github/app",
          payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().verified).toBe(false);

        const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
        expect(get.json().githubApp).toEqual(expect.objectContaining({ configured: true }));
        await app.close();
      });

      // Nothing exercised a re-PUT over an already-configured App before
      // #514 — the frontend form used to unmount entirely once configured
      // (Settings.tsx's GitHubAppSection), so this path only became
      // reachable once Part D added the "Rotate key" disclosure.
      it("a re-PUT over an already-configured App rotates it", async () => {
        stubGithubFetch({ appId: "123" });
        const app = await buildApp();
        const first = await app.inject({
          method: "PUT",
          url: "/api/integrations/github/app",
          payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
        });
        expect(first.statusCode).toBe(200);

        const { privateKey: newKey } = crypto.generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs1", format: "pem" },
          publicKeyEncoding: { type: "pkcs1", format: "pem" },
        }); // pragma: allowlist secret
        const second = await app.inject({
          method: "PUT",
          url: "/api/integrations/github/app",
          payload: { appId: "123", privateKey: newKey },
        });

        expect(second.statusCode).toBe(200);
        expect(second.json().keyFingerprint).not.toBe(first.json().keyFingerprint);
        await app.close();
      });
    });
  });

  describe("Reviewer App (#737)", () => {
    it("PUT stores the reviewer App credentials independently of the primary App", async () => {
      stubGithubFetch({ appId: "222", appSlug: "test-reviewer-app" });
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/reviewer-app",
        payload: { appId: "222", privateKey: FAKE_APP_PRIVATE_KEY },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({
          verified: true,
          appSlug: "test-reviewer-app",
          keyFingerprint: expect.any(String),
        }),
      );
      expect(res.body).not.toMatch(/BEGIN RSA PRIVATE KEY/); // pragma: allowlist secret

      const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
      expect(get.body).not.toMatch(/BEGIN RSA PRIVATE KEY/); // pragma: allowlist secret
      expect(get.json().reviewerApp).toEqual(
        expect.objectContaining({ configured: true, appId: "222" }),
      );
      // The primary App is untouched — never configured in this test.
      expect(get.json().githubApp).toEqual(expect.objectContaining({ configured: false }));
      await app.close();
    });

    it("PUT 400s the same appId as the already-configured primary App", async () => {
      stubGithubFetch({ appId: "123" });
      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
      });

      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/reviewer-app",
        payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/same App id as the primary/);

      // Nothing persisted for the reviewer row.
      const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
      expect(get.json().reviewerApp).toEqual(expect.objectContaining({ configured: false }));
      await app.close();
    });

    // Hermes review, PR #826: the guard used to be one-directional — only
    // the reviewer route checked against the primary's id, so re-pointing
    // the PRIMARY at the reviewer's already-configured id sailed through.
    it("PUT 400s the primary App id matching the already-configured reviewer App (the reverse direction)", async () => {
      stubGithubFetch({ appId: "222" });
      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/reviewer-app",
        payload: { appId: "222", privateKey: FAKE_APP_PRIVATE_KEY },
      });

      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "222", privateKey: FAKE_APP_PRIVATE_KEY },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/same App id as the reviewer App/);

      // Nothing persisted for the primary row.
      const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
      expect(get.json().githubApp).toEqual(expect.objectContaining({ configured: false }));
      await app.close();
    });

    // Independent review (fresh subagent, PR #826): the first version of
    // the symmetric guard read the OTHER identity's appId once, before
    // `verifyAppCredentials`'s network round trip — leaving a window where
    // a concurrent PUT to the other route could persist the same appId in
    // between. Simulates that race by having the fake GET /app response
    // (awaited mid-request) itself write the OTHER row, then asserts the
    // second, pre-persist re-check catches it rather than reusing the
    // stale pre-network-call value.
    it("PUT 400s when the OTHER identity is configured to the same appId WHILE this request's own verify call is in flight (TOCTOU)", async () => {
      const app = await buildApp();
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith("/app")) {
          // The race: by the time this (awaited) response resolves, the
          // reviewer row now holds the same appId this primary-App PUT is
          // trying to configure — something only a CONCURRENT request
          // could do in production, injected here deterministically.
          setGitHubApp(app, "999", FAKE_APP_PRIVATE_KEY, GITHUB_REVIEWER_PROVIDER);
          return Promise.resolve(jsonResponse(200, { id: 999, slug: "test-app" }));
        }
        return Promise.resolve(jsonResponse(200, {}));
      });

      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "999", privateKey: FAKE_APP_PRIVATE_KEY },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/same App id as the reviewer App/);
      // The primary row must NOT have been persisted — the whole point of
      // the pre-persist re-check.
      const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
      expect(get.json().githubApp).toEqual(expect.objectContaining({ configured: false }));
      await app.close();
    });

    it("PUT allows the reviewer App id when no primary App is configured yet", async () => {
      stubGithubFetch({ appId: "123" });
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/reviewer-app",
        payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("DELETE clears only the reviewer App, leaving the primary App configured", async () => {
      const app = await buildApp();
      stubGithubFetch({ appId: "123" });
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/app",
        payload: { appId: "123", privateKey: FAKE_APP_PRIVATE_KEY },
      });
      stubGithubFetch({ appId: "222" });
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/reviewer-app",
        payload: { appId: "222", privateKey: FAKE_APP_PRIVATE_KEY },
      });

      const del = await app.inject({
        method: "DELETE",
        url: "/api/integrations/github/reviewer-app",
      });
      expect(del.statusCode).toBe(204);

      const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
      expect(get.json().reviewerApp).toEqual(expect.objectContaining({ configured: false }));
      expect(get.json().githubApp).toEqual(
        expect.objectContaining({ configured: true, appId: "123" }),
      );
      await app.close();
    });

    it("PUT 400s a non-numeric reviewer appId", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/integrations/github/reviewer-app",
        payload: { appId: "not-a-number", privateKey: FAKE_APP_PRIVATE_KEY },
      });
      expect(res.statusCode).toBe(400);
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
