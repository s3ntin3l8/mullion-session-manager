import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const mockGetInstallationToken = vi.hoisted(() => vi.fn());
const mockClearInstallationTokenCacheForApp = vi.hoisted(() => vi.fn());
// Hermes review, PR #504 (round 7): keeps every OTHER real export
// (`GitHubAppError` in particular — `resolveGitHubToken`'s narrowed catch
// does `err instanceof GitHubAppError`, which needs the real class, not a
// mock-erased `undefined`) while still swapping out the two functions this
// suite drives directly.
vi.mock("../../src/services/github-app.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getInstallationToken: mockGetInstallationToken,
    clearInstallationTokenCacheForApp: mockClearInstallationTokenCacheForApp,
  };
});

import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { integrations } from "../../src/db/schema.js";
import { GitHubAppError, computeKeyFingerprint } from "../../src/services/github-app.js";
import {
  disconnect,
  getIntegration,
  getGitHubAppStatus,
  getConfiguredAppId,
  getToken,
  InvalidTokenError,
  setPat,
  setGitHubApp,
  clearGitHubApp,
  resolveGitHubToken,
  resolveReviewerToken,
  resolveMullionReviewLogins,
  verifyAppCredentials,
  GITHUB_PROVIDER,
  GITHUB_REVIEWER_PROVIDER,
  clearGitHubAppStatusCacheForTests,
} from "../../src/services/github-integration.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// A fake PEM, never a real key.
const FAKE_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----"; // pragma: allowlist secret

// A real, disposable RSA keypair, generated per test run (never a checked-in
// PEM — see github-app.test.ts's own comment on why) — needed for
// getGitHubAppStatus's tests specifically: unlike resolveGitHubToken's own
// tests above, getInstallationToken is mocked out entirely, but
// getGitHubAppStatus calls the REAL signAppJwt/listInstallations, which
// need a real key `crypto.sign` can actually use.
const { privateKey: REAL_APP_PRIVATE_KEY } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

const tmpDb = path.join(os.tmpdir(), `github-integration-test-${process.pid}.db`);

describe("github-integration service", () => {
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
    mockGetInstallationToken.mockReset();
    mockClearInstallationTokenCacheForApp.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // `integrations` is a singleton row per provider (like `settings`), and
    // this file's tests share one tmpDb across `it`s (see beforeAll) — reset
    // it after every test so an earlier test's connected state can't leak
    // into a later one that expects to start disconnected. disconnect()
    // alone isn't enough for full isolation any more (Hermes review, PR
    // #504: it deliberately only clears the PAT columns now, not the App
    // ones), so this also clears the App config directly.
    const app = await buildApp();
    disconnect(app);
    clearGitHubApp(app);
    // #737 — a second, independent `integrations` row; leaking it between
    // tests would let a reviewer-App configuration from one test silently
    // survive into a later one that expects it unconfigured.
    clearGitHubApp(app, GITHUB_REVIEWER_PROVIDER);
    await app.close();
  });

  it("reports disconnected with no row", async () => {
    const app = await buildApp();
    expect(getIntegration(app)).toEqual(
      expect.objectContaining({ connected: false, tokenType: null, login: null, scopes: null }),
    );
    await app.close();
  });

  it("validates against GitHub, then round-trips the token through setPat/getToken", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { login: "octocat" }, { "x-oauth-scopes": "repo, read:org" }),
    );
    const app = await buildApp();
    const summary = await setPat(app, "ghp_abc123");
    expect(summary).toEqual(
      expect.objectContaining({
        connected: true,
        tokenType: "pat",
        login: "octocat",
        scopes: ["repo", "read:org"],
      }),
    );
    expect(getToken(app)).toBe("ghp_abc123");
    await app.close();
  });

  it("sends a User-Agent and bearer auth when validating (GitHub 400s requests without one)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    const app = await buildApp();
    await setPat(app, "ghp_abc123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_abc123",
          "User-Agent": expect.any(String),
        }),
      }),
    );
    await app.close();
  });

  it("stores the token opaque to EncryptionService when DB_ENCRYPTION_KEY is set", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
    const app = await buildApp();
    await setPat(app, "s3cr3t-token");
    expect(getToken(app)).toBe("s3cr3t-token");
    await app.close();
    delete process.env.DB_ENCRYPTION_KEY;
  });

  it("rejects a token GitHub itself rejects, without persisting anything", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "Bad credentials" }));
    const app = await buildApp();
    await expect(setPat(app, "bad-token")).rejects.toThrow(InvalidTokenError);
    expect(getIntegration(app).connected).toBe(false);
    await app.close();
  });

  it("rejects when GitHub is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const app = await buildApp();
    await expect(setPat(app, "any-token")).rejects.toThrow(InvalidTokenError);
    await app.close();
  });

  it("disconnect clears a stored token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    const app = await buildApp();
    await setPat(app, "ghp_abc123");
    expect(getIntegration(app).connected).toBe(true);
    disconnect(app);
    expect(getIntegration(app)).toEqual(expect.objectContaining({ connected: false }));
    expect(getToken(app)).toBeNull();
    await app.close();
  });

  it("disconnect preserves an independently-configured GitHub App (Hermes review, PR #504)", async () => {
    // Previously disconnect() deleted the whole integrations row —
    // silently wiping the App credentials too, contradicting
    // setGitHubApp's own "neither requires nor disturbs" contract.
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    const app = await buildApp();
    await setPat(app, "ghp_abc123");
    setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
    mockGetInstallationToken.mockResolvedValue({
      token: "ghs_installation_token",
      installationsChecked: null,
    });

    disconnect(app);

    expect(getIntegration(app)).toEqual(expect.objectContaining({ connected: false }));
    expect(getToken(app)).toBeNull();
    // The App itself is still configured and still resolvable — no PAT to
    // fall back to, but the installation token path still works.
    const token = await resolveGitHubToken(app, { owner: "acme", repo: "widgets" });
    expect(token).toBe("ghs_installation_token");
    await app.close();
  });

  it("reconnecting with a new token overwrites the old one (onConflictDoUpdate)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { login: "first" }));
    const app = await buildApp();
    await setPat(app, "token-1");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { login: "second" }));
    const summary = await setPat(app, "token-2");
    expect(summary.login).toBe("second");
    expect(getToken(app)).toBe("token-2");
    await app.close();
  });

  it("deviceFlowAvailable reflects whether GITHUB_OAUTH_CLIENT_ID is configured", async () => {
    // No need to clear GITHUB_OAUTH_CLIENT_ID before the first assertion here
    // — test/setup.ts now clears every schema-defined config var once per
    // test file, so a developer's shell can't leak into the "unconfigured"
    // default this asserts.
    const app = await buildApp();
    expect(getIntegration(app).deviceFlowAvailable).toBe(false);
    await app.close();

    process.env.GITHUB_OAUTH_CLIENT_ID = "Iv1.abc123";
    const app2 = await buildApp();
    expect(getIntegration(app2).deviceFlowAvailable).toBe(true);
    await app2.close();
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
  });

  describe("resolveGitHubToken (#489)", () => {
    it("falls back to the shared PAT when no GitHub App is configured", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      const token = await resolveGitHubToken(app, { owner: "acme", repo: "widgets" });
      expect(token).toBe("ghp_shared");
      expect(mockGetInstallationToken).not.toHaveBeenCalled();
      await app.close();
    });

    it("returns null when neither an App nor a PAT is configured", async () => {
      const app = await buildApp();
      const token = await resolveGitHubToken(app, { owner: "acme", repo: "widgets" });
      expect(token).toBeNull();
      await app.close();
    });

    it("uses the App installation token when one is configured and covers the repo", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      mockGetInstallationToken.mockResolvedValue({
        token: "ghs_installation_token",
        installationsChecked: null,
      });

      const token = await resolveGitHubToken(app, { owner: "acme", repo: "widgets" });

      expect(token).toBe("ghs_installation_token");
      // Defaults to "write" scope when the caller doesn't specify one
      // (#489 remaining scope) — Task Master's own write paths, which
      // never pass a third argument, keep resolving exactly this way.
      expect(mockGetInstallationToken).toHaveBeenCalledWith(
        "123",
        expect.any(String),
        "acme",
        "widgets",
        "write",
      );
      await app.close();
    });

    // #489 remaining scope
    it("passes through an explicit 'read' scope to getInstallationToken", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      mockGetInstallationToken.mockResolvedValue({
        token: "ghs_read_token",
        installationsChecked: null,
      });

      const token = await resolveGitHubToken(app, { owner: "acme", repo: "widgets" }, "read");

      expect(token).toBe("ghs_read_token");
      expect(mockGetInstallationToken).toHaveBeenCalledWith(
        "123",
        expect.any(String),
        "acme",
        "widgets",
        "read",
      );
      await app.close();
    });

    it("falls back to the PAT when the App is configured but not installed on this owner", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      mockGetInstallationToken.mockResolvedValue({ token: null, installationsChecked: 3 });

      const token = await resolveGitHubToken(app, { owner: "acme", repo: "widgets" });

      expect(token).toBe("ghp_shared");
      await app.close();
    });

    it("falls back to the PAT when the App token mint throws (e.g. a transient GitHub outage)", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      // github-app.ts (round 7) consistently wraps every one of its own
      // expected failure modes — including a raw network/timeout failure —
      // into GitHubAppError, which is what resolveGitHubToken's narrowed
      // catch actually falls back on below.
      mockGetInstallationToken.mockRejectedValue(new GitHubAppError("GitHub is down"));

      const token = await resolveGitHubToken(app, { owner: "acme", repo: "widgets" });

      expect(token).toBe("ghp_shared");
      await app.close();
    });

    it("rethrows an unexpected error rather than silently falling back (Hermes review, PR #504, round 7)", async () => {
      // A bug in this code path — a TypeError from a null deref, say —
      // must NOT be swallowed into the same silent warn-log fallback as
      // github-app.ts's own documented failure modes; the narrowed catch
      // in resolveGitHubToken only catches GitHubAppError/DecryptionError/
      // GitHubApiError, so anything else propagates and fails loudly.
      const app = await buildApp();
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      mockGetInstallationToken.mockRejectedValue(
        new TypeError("Cannot read properties of undefined"),
      );

      await expect(resolveGitHubToken(app, { owner: "acme", repo: "widgets" })).rejects.toThrow(
        TypeError,
      );
      await app.close();
    });

    it("falls back to the PAT when the stored App private key can't be decrypted (Hermes review, PR #504)", async () => {
      // Encryption is a pass-through no-op with no DB_ENCRYPTION_KEY (see
      // EncryptionService.decryptString) — this needs a real key so a
      // malformed "enc:" value actually exercises the DecryptionError path.
      process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      // Corrupts the stored ciphertext directly (simulating e.g. a
      // DB_ENCRYPTION_KEY rotation) — malformed "enc:"-prefixed value with
      // the wrong part count throws DecryptionError.
      app.db
        .update(integrations)
        .set({ githubAppPrivateKeyEnc: "enc:not-valid-ciphertext" }) // pragma: allowlist secret
        .where(eq(integrations.provider, GITHUB_PROVIDER))
        .run();

      const token = await resolveGitHubToken(app, { owner: "acme", repo: "widgets" });

      expect(token).toBe("ghp_shared");
      expect(mockGetInstallationToken).not.toHaveBeenCalled();
      await app.close();
      delete process.env.DB_ENCRYPTION_KEY;
    });

    it("clearGitHubApp reverts resolution back to the shared PAT", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      mockGetInstallationToken.mockResolvedValue({
        token: "ghs_installation_token",
        installationsChecked: null,
      });
      expect(await resolveGitHubToken(app, { owner: "acme", repo: "widgets" })).toBe(
        "ghs_installation_token",
      );

      clearGitHubApp(app);
      // Hermes review, PR #504: clearGitHubApp must also evict that App's
      // cached installation tokens (github-app.ts's own cache), not just
      // the DB row — asserted here rather than only inferred from the
      // fallback behavior below.
      expect(mockClearInstallationTokenCacheForApp).toHaveBeenCalledWith("123");

      const token = await resolveGitHubToken(app, { owner: "acme", repo: "widgets" });
      expect(token).toBe("ghp_shared");
      expect(mockGetInstallationToken).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("clearGitHubApp is a no-op (doesn't call the cache evictor) when no App was ever configured", async () => {
      const app = await buildApp();
      clearGitHubApp(app);
      expect(mockClearInstallationTokenCacheForApp).not.toHaveBeenCalled();
      await app.close();
    });

    it("setGitHubApp evicts stale cache entries for the same appId (Hermes review, PR #504)", async () => {
      // Covers e.g. an uninstall→reinstall on GitHub's side (changing the
      // underlying installation id) or a rotated key — re-PUTting the SAME
      // appId must not keep serving a token/installation-id resolved under
      // the previous configuration for up to an hour.
      const app = await buildApp();
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      mockClearInstallationTokenCacheForApp.mockClear();

      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);

      expect(mockClearInstallationTokenCacheForApp).toHaveBeenCalledWith("123");
      await app.close();
    });

    // #514 — setGitHubApp previously only evicted the INCOMING appId's
    // cache entries. Changing the configured App from one id to another
    // left the outgoing id's entries sitting unreachable-but-not-evicted,
    // so swapping back to it within the hour (exactly what happens while
    // troubleshooting a botched rotation) would serve a stale token again.
    it("evicts the OUTGOING appId's cache entries too when the appId itself changes", async () => {
      const app = await buildApp();
      setGitHubApp(app, "app-one", FAKE_APP_PRIVATE_KEY);
      mockClearInstallationTokenCacheForApp.mockClear();

      setGitHubApp(app, "app-two", FAKE_APP_PRIVATE_KEY);

      expect(mockClearInstallationTokenCacheForApp).toHaveBeenCalledWith("app-two");
      expect(mockClearInstallationTokenCacheForApp).toHaveBeenCalledWith("app-one");
      await app.close();
    });

    it("does not evict anything extra when there was no previously-configured App", async () => {
      const app = await buildApp();
      mockClearInstallationTokenCacheForApp.mockClear();

      setGitHubApp(app, "app-one", FAKE_APP_PRIVATE_KEY);

      expect(mockClearInstallationTokenCacheForApp).toHaveBeenCalledTimes(1);
      expect(mockClearInstallationTokenCacheForApp).toHaveBeenCalledWith("app-one");
      await app.close();
    });

    it("setGitHubApp does not disturb the shared PAT/OAuth token row", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      expect(getToken(app)).toBe("ghp_shared");
      await app.close();
    });
  });

  // #737 — the reviewer App's own resolver. Deliberately NOT modeled after
  // every resolveGitHubToken case above: the one behavior that actually
  // needs its own coverage is "no PAT fallback, ever" — everything else
  // (mint success/failure/not-installed/decrypt-failure) is the same
  // getInstallationToken plumbing resolveGitHubToken already exercises.
  // Hermes review, PR #826: added to back the symmetric same-appId guard in
  // routes/integrations.ts, which reads both identities' ids via this
  // cheap, local-only accessor rather than the network-calling
  // getGitHubAppStatus.
  describe("getConfiguredAppId (#737)", () => {
    it("returns null when nothing is configured for that provider", async () => {
      const app = await buildApp();
      expect(getConfiguredAppId(app)).toBeNull();
      expect(getConfiguredAppId(app, GITHUB_REVIEWER_PROVIDER)).toBeNull();
      await app.close();
    });

    it("returns each provider's own appId independently, with no network call", async () => {
      const app = await buildApp();
      setGitHubApp(app, "111", FAKE_APP_PRIVATE_KEY);
      setGitHubApp(app, "222", FAKE_APP_PRIVATE_KEY, GITHUB_REVIEWER_PROVIDER);

      expect(getConfiguredAppId(app)).toBe("111");
      expect(getConfiguredAppId(app, GITHUB_REVIEWER_PROVIDER)).toBe("222");
      expect(fetchMock).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("resolveReviewerToken (#737)", () => {
    it("returns null (never the PAT) when no reviewer App is configured", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      const token = await resolveReviewerToken(app, { owner: "acme", repo: "widgets" });
      expect(token).toBeNull();
      expect(mockGetInstallationToken).not.toHaveBeenCalled();
      await app.close();
    });

    it("mints with the 'review' scope from the reviewer row, independent of the primary App", async () => {
      const app = await buildApp();
      // A primary App is ALSO configured, with a different appId — proves
      // resolveReviewerToken reads its own row, not the primary's.
      setGitHubApp(app, "111", FAKE_APP_PRIVATE_KEY);
      setGitHubApp(app, "222", FAKE_APP_PRIVATE_KEY, GITHUB_REVIEWER_PROVIDER);
      mockGetInstallationToken.mockResolvedValue({
        token: "ghs_reviewer_token",
        installationsChecked: null,
      });

      const token = await resolveReviewerToken(app, { owner: "acme", repo: "widgets" });

      expect(token).toBe("ghs_reviewer_token");
      expect(mockGetInstallationToken).toHaveBeenCalledWith(
        "222",
        expect.any(String),
        "acme",
        "widgets",
        "review",
      );
      await app.close();
    });

    it("returns null (never the PAT) when the reviewer App isn't installed on this owner", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      setGitHubApp(app, "222", FAKE_APP_PRIVATE_KEY, GITHUB_REVIEWER_PROVIDER);
      mockGetInstallationToken.mockResolvedValue({ token: null, installationsChecked: 3 });

      const token = await resolveReviewerToken(app, { owner: "acme", repo: "widgets" });

      expect(token).toBeNull();
      await app.close();
    });

    it("returns null (never the PAT) when the mint throws", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      setGitHubApp(app, "222", FAKE_APP_PRIVATE_KEY, GITHUB_REVIEWER_PROVIDER);
      mockGetInstallationToken.mockRejectedValue(new GitHubAppError("GitHub is down"));

      const token = await resolveReviewerToken(app, { owner: "acme", repo: "widgets" });

      expect(token).toBeNull();
      await app.close();
    });

    it("returns null (never the PAT) when the stored reviewer key can't be decrypted", async () => {
      process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_shared");
      setGitHubApp(app, "222", FAKE_APP_PRIVATE_KEY, GITHUB_REVIEWER_PROVIDER);
      app.db
        .update(integrations)
        .set({ githubAppPrivateKeyEnc: "enc:not-valid-ciphertext" }) // pragma: allowlist secret
        .where(eq(integrations.provider, GITHUB_REVIEWER_PROVIDER))
        .run();

      const token = await resolveReviewerToken(app, { owner: "acme", repo: "widgets" });

      expect(token).toBeNull();
      expect(mockGetInstallationToken).not.toHaveBeenCalled();
      await app.close();
      delete process.env.DB_ENCRYPTION_KEY;
    });

    it("rethrows an unexpected error rather than silently returning null", async () => {
      const app = await buildApp();
      setGitHubApp(app, "222", FAKE_APP_PRIVATE_KEY, GITHUB_REVIEWER_PROVIDER);
      mockGetInstallationToken.mockRejectedValue(
        new TypeError("Cannot read properties of undefined"),
      );

      await expect(resolveReviewerToken(app, { owner: "acme", repo: "widgets" })).rejects.toThrow(
        TypeError,
      );
      await app.close();
    });

    it("configuring/clearing the reviewer App does not disturb the primary App's row", async () => {
      const app = await buildApp();
      setGitHubApp(app, "111", FAKE_APP_PRIVATE_KEY);
      setGitHubApp(app, "222", FAKE_APP_PRIVATE_KEY, GITHUB_REVIEWER_PROVIDER);

      const primaryStatus = await getGitHubAppStatus(app);
      expect(primaryStatus.appId).toBe("111");

      clearGitHubApp(app, GITHUB_REVIEWER_PROVIDER);

      const primaryAfter = await getGitHubAppStatus(app);
      expect(primaryAfter.appId).toBe("111");
      expect(primaryAfter.configured).toBe(true);
      const reviewerAfter = await getGitHubAppStatus(app, GITHUB_REVIEWER_PROVIDER);
      expect(reviewerAfter.configured).toBe(false);
      await app.close();
    });
  });

  // Fresh review, PR #737 follow-up (D0) — a gating review round posts from
  // the reviewer App, a distinct identity from whichever token a caller
  // used to fetch the PR (github-write.ts's `viewerLogin`). This is the
  // helper that closes that gap: the set of logins a caller should treat
  // as "Mullion's own" spans both identities, not just the caller's own.
  describe("resolveMullionReviewLogins (D0)", () => {
    it("returns just the primary login when no reviewer App is configured", async () => {
      const app = await buildApp();
      const logins = await resolveMullionReviewLogins(
        app,
        { owner: "acme", repo: "widgets" },
        "mullion-bot[bot]",
      );
      expect(logins).toEqual(new Set(["mullion-bot[bot]"]));
      await app.close();
    });

    it("includes the reviewer App's own login, stripped of its [bot] suffix to match author.login, when one is configured and installed", async () => {
      const app = await buildApp();
      setGitHubApp(app, "222", FAKE_APP_PRIVATE_KEY, GITHUB_REVIEWER_PROVIDER);
      mockGetInstallationToken.mockResolvedValue({
        token: "ghs_reviewer_token",
        installationsChecked: null,
      });
      // GitHub's raw `viewer.login` carries the `[bot]` suffix; the same
      // App's authored comments/reviews report `author.login` without it
      // (confirmed live, 2026-08-27) — fetchViewerLogin strips it so this
      // set is comparable against `c.author` elsewhere.
      fetchMock.mockResolvedValue(
        jsonResponse(200, { data: { viewer: { login: "mullion-reviewer[bot]" } } }),
      );

      const logins = await resolveMullionReviewLogins(
        app,
        { owner: "acme", repo: "widgets" },
        "mullion-bot[bot]",
      );

      expect(logins).toEqual(new Set(["mullion-bot[bot]", "mullion-reviewer"]));
      await app.close();
    });

    it("degrades to just the primary login when the reviewer identity lookup fails", async () => {
      const app = await buildApp();
      setGitHubApp(app, "222", FAKE_APP_PRIVATE_KEY, GITHUB_REVIEWER_PROVIDER);
      mockGetInstallationToken.mockResolvedValue({
        token: "ghs_reviewer_token",
        installationsChecked: null,
      });
      fetchMock.mockResolvedValue(jsonResponse(500, { message: "GitHub is down" }));

      const logins = await resolveMullionReviewLogins(
        app,
        { owner: "acme", repo: "widgets" },
        "mullion-bot[bot]",
      );

      expect(logins).toEqual(new Set(["mullion-bot[bot]"]));
      await app.close();
    });

    it("returns an empty set when there is no primary login and no reviewer App", async () => {
      const app = await buildApp();
      const logins = await resolveMullionReviewLogins(
        app,
        { owner: "acme", repo: "widgets" },
        null,
      );
      expect(logins).toEqual(new Set());
      await app.close();
    });
  });

  // #514 — verifies a (appId, privateKey) pair against GitHub's own GET
  // /app before the PUT route ever persists it. Exercises the real
  // getAuthenticatedApp (github-app.js's mock above only swaps out
  // getInstallationToken/clearInstallationTokenCacheForApp, everything
  // else — including this — passes through via `...actual`), so it needs
  // the real REAL_APP_PRIVATE_KEY keypair, same reason getGitHubAppStatus's
  // own tests below do.
  describe("verifyAppCredentials (#514)", () => {
    it("reports verified with the App's slug when GET /app returns a matching id", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { id: 555, slug: "acme-bot", name: "Acme Bot" }),
      );
      const result = await verifyAppCredentials("555", REAL_APP_PRIVATE_KEY);
      expect(result).toEqual({ status: "verified", appSlug: "acme-bot" });
    });

    it("reports rejected on a 401 — the key/App-id pair doesn't work", async () => {
      fetchMock.mockResolvedValue(jsonResponse(401, {}));
      const result = await verifyAppCredentials("555", REAL_APP_PRIVATE_KEY);
      expect(result.status).toBe("rejected");
    });

    it("reports mismatch when GET /app succeeds but returns a DIFFERENT App id", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 999, slug: "someone-elses-app" }));
      const result = await verifyAppCredentials("555", REAL_APP_PRIVATE_KEY);
      expect(result.status).toBe("mismatch");
      if (result.status === "mismatch") {
        expect(result.actualAppId).toBe("999");
      }
    });

    // Hermes review, PR #519: a signAppJwt failure never reaches GitHub at
    // all — no HTTP round trip happened, so it must not be lumped in with
    // "unreachable" (a network/GitHub-side issue that's fine to persist
    // through). The route already validated the key parses as RSA before
    // calling this, so a signing failure past that point means the key is
    // locally unusable in a way that check couldn't catch — "rejected",
    // not "GitHub had a bad moment."
    it("reports rejected (not unreachable) when the key fails to sign locally, without ever calling GitHub", async () => {
      const result = await verifyAppCredentials("555", FAKE_APP_PRIVATE_KEY);
      expect(result.status).toBe("rejected");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports unreachable (not rejected) on a 5xx — must not block a rotation during a GitHub outage", async () => {
      fetchMock.mockResolvedValue(jsonResponse(503, { message: "GitHub is down" }));
      const result = await verifyAppCredentials("555", REAL_APP_PRIVATE_KEY);
      expect(result.status).toBe("unreachable");
    });

    it("reports unreachable (not rejected) on a 403 — e.g. a secondary rate limit", async () => {
      fetchMock.mockResolvedValue(jsonResponse(403, { message: "rate limited" }));
      const result = await verifyAppCredentials("555", REAL_APP_PRIVATE_KEY);
      expect(result.status).toBe("unreachable");
    });

    it("reports unreachable on a raw network failure", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      const result = await verifyAppCredentials("555", REAL_APP_PRIVATE_KEY);
      expect(result.status).toBe("unreachable");
    });
  });

  // #489 remaining scope — non-secret visibility into whether an App is
  // configured and how many accounts it's installed on.
  describe("getGitHubAppStatus (#489)", () => {
    it("reports not configured when no App is set", async () => {
      const app = await buildApp();
      const status = await getGitHubAppStatus(app);
      expect(status).toEqual({
        configured: false,
        appId: null,
        installationCount: null,
        keyFingerprint: null,
        keyRotatedAt: null,
      });
      await app.close();
    });

    it("reports the appId and a live installation count when configured", async () => {
      const app = await buildApp();
      setGitHubApp(app, "555", REAL_APP_PRIVATE_KEY);
      fetchMock.mockResolvedValue(
        jsonResponse(200, [
          { id: 1, account: { login: "acme" } },
          { id: 2, account: { login: "widgets-inc" } },
        ]),
      );

      const status = await getGitHubAppStatus(app);

      expect(status.configured).toBe(true);
      expect(status.appId).toBe("555");
      expect(status.installationCount).toBe(2);
      await app.close();
    });

    // #514 — the key fingerprint/rotation-timestamp fields, which let an
    // operator confirm a rotation actually landed.
    it("reports the current key's fingerprint and rotation timestamp when configured", async () => {
      const app = await buildApp();
      setGitHubApp(app, "555", REAL_APP_PRIVATE_KEY);
      fetchMock.mockResolvedValue(jsonResponse(200, [{ id: 1, account: { login: "acme" } }]));

      const status = await getGitHubAppStatus(app);

      expect(status.keyFingerprint).toBe(computeKeyFingerprint(REAL_APP_PRIVATE_KEY));
      expect(status.keyRotatedAt).toBeInstanceOf(Date);
      expect((status.keyRotatedAt as Date).getTime()).toBeCloseTo(Date.now(), -4);
      await app.close();
    });

    it("degrades keyFingerprint to null (rather than throwing) when the stored key can't be decrypted", async () => {
      process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
      const app = await buildApp();
      setGitHubApp(app, "555", REAL_APP_PRIVATE_KEY);
      app.db
        .update(integrations)
        .set({ githubAppPrivateKeyEnc: "enc:not-valid-ciphertext" }) // pragma: allowlist secret
        .where(eq(integrations.provider, GITHUB_PROVIDER))
        .run();

      const status = await getGitHubAppStatus(app);

      expect(status.configured).toBe(true);
      expect(status.keyFingerprint).toBeNull();
      await app.close();
      delete process.env.DB_ENCRYPTION_KEY;
    });

    it("never returns the private key, only the public appId", async () => {
      const app = await buildApp();
      setGitHubApp(app, "555", REAL_APP_PRIVATE_KEY);
      fetchMock.mockResolvedValue(jsonResponse(200, []));

      const status = await getGitHubAppStatus(app);

      expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
      await app.close();
    });

    it("reports configured with a null installation count when the live list call fails", async () => {
      const app = await buildApp();
      setGitHubApp(app, "555", REAL_APP_PRIVATE_KEY);
      fetchMock.mockResolvedValue(jsonResponse(500, { message: "boom" }));

      const status = await getGitHubAppStatus(app);

      expect(status.configured).toBe(true);
      expect(status.appId).toBe("555");
      expect(status.installationCount).toBeNull();
      // #514 — the fingerprint is a pure function of the stored PEM, unlike
      // installationCount; a network failure fetching installations must
      // not also blank it out.
      expect(status.keyFingerprint).toBe(computeKeyFingerprint(REAL_APP_PRIVATE_KEY));
      await app.close();
    });

    it("reports configured with a null installation count when the stored key can't be used to sign", async () => {
      const app = await buildApp();
      setGitHubApp(app, "555", FAKE_APP_PRIVATE_KEY);

      const status = await getGitHubAppStatus(app);

      expect(status.configured).toBe(true);
      expect(status.appId).toBe("555");
      expect(status.installationCount).toBeNull();
      expect(status.keyFingerprint).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      await app.close();
    });

    // Hermes review, PR #512 — GET /api/integrations/github calls this on
    // every load, with no rate limit; a bare live call per request risked
    // stalling the Settings page on a slow GitHub and flickering the count
    // on a transient blip. A short cache fixes both.
    it("serves a repeat call within the cache TTL without a second live fetch", async () => {
      const app = await buildApp();
      setGitHubApp(app, "555", REAL_APP_PRIVATE_KEY);
      fetchMock.mockResolvedValue(jsonResponse(200, [{ id: 1, account: { login: "acme" } }]));

      const first = await getGitHubAppStatus(app);
      const second = await getGitHubAppStatus(app);

      expect(first.configured).toBe(true);
      expect(first.appId).toBe("555");
      expect(first.installationCount).toBe(1);
      // #514 — the fingerprint must not flicker between a cache-miss and
      // cache-hit call: it's derived from the stored PEM directly, ahead of
      // (and independent of) the installation-count cache lookup.
      expect(first.keyFingerprint).toBe(computeKeyFingerprint(REAL_APP_PRIVATE_KEY));
      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("does not cache a failed live call — the next call retries", async () => {
      const app = await buildApp();
      setGitHubApp(app, "555", REAL_APP_PRIVATE_KEY);
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: "boom" }));
      fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: 1, account: { login: "acme" } }]));

      const first = await getGitHubAppStatus(app);
      const second = await getGitHubAppStatus(app);

      expect(first.installationCount).toBeNull();
      expect(second.installationCount).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await app.close();
    });

    it("re-fetches after re-configuring the App instead of serving the old App's cached count", async () => {
      const app = await buildApp();
      setGitHubApp(app, "555", REAL_APP_PRIVATE_KEY);
      fetchMock.mockResolvedValue(jsonResponse(200, [{ id: 1, account: { login: "acme" } }]));
      await getGitHubAppStatus(app);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Re-PUT the SAME appId (e.g. a rotated key) — must not serve the
      // stale cached count from before the reconfigure.
      setGitHubApp(app, "555", REAL_APP_PRIVATE_KEY);
      fetchMock.mockResolvedValue(
        jsonResponse(200, [
          { id: 1, account: { login: "acme" } },
          { id: 2, account: { login: "widgets-inc" } },
        ]),
      );
      const status = await getGitHubAppStatus(app);

      expect(status.installationCount).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await app.close();
    });

    afterEach(() => {
      clearGitHubAppStatusCacheForTests();
    });
  });
});
