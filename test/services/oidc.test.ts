import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as OpenidClient from "openid-client";
import {
  isOidcEnabled,
  isOidcConfigPartial,
  buildOidcAuthorizationUrl,
  completeOidcLogin,
  resetOidcDiscoveryCacheForTests,
  type OidcConfig,
} from "../../src/services/oidc.js";

// oidc.ts wraps openid-client's real v6 functional API (discovery(),
// buildAuthorizationUrl(), authorizationCodeGrant(), ...) — mocked here so
// these tests assert *our* wiring (the exact parameters we pass, and how we
// turn a token response into an OidcIdentity) rather than re-testing
// openid-client's own certified OIDC-conformance behavior. vi.mock's
// factory is hoisted above every import/const in this file, so the mock
// functions themselves must be created via vi.hoisted().
const {
  discoveryMock,
  randomPKCECodeVerifierMock,
  calculatePKCECodeChallengeMock,
  randomStateMock,
  randomNonceMock,
  buildAuthorizationUrlMock,
  authorizationCodeGrantMock,
} = vi.hoisted(() => ({
  discoveryMock: vi.fn(),
  randomPKCECodeVerifierMock: vi.fn(),
  calculatePKCECodeChallengeMock: vi.fn(),
  randomStateMock: vi.fn(),
  randomNonceMock: vi.fn(),
  buildAuthorizationUrlMock: vi.fn(),
  authorizationCodeGrantMock: vi.fn(),
}));

vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenidClient>();
  return {
    ...actual,
    discovery: discoveryMock,
    randomPKCECodeVerifier: randomPKCECodeVerifierMock,
    calculatePKCECodeChallenge: calculatePKCECodeChallengeMock,
    randomState: randomStateMock,
    randomNonce: randomNonceMock,
    buildAuthorizationUrl: buildAuthorizationUrlMock,
    authorizationCodeGrant: authorizationCodeGrantMock,
  };
});

const CONFIG: OidcConfig = {
  TESSERA_OIDC_ISSUER: "https://idp.example.com",
  TESSERA_OIDC_CLIENT_ID: "client-id",
  TESSERA_OIDC_CLIENT_SECRET: "client-secret",
  TESSERA_OIDC_REDIRECT_URI: "https://tessera.example.com/api/auth/oidc/callback",
};

const FAKE_CLIENT_CONFIG = { marker: "fake-config" } as unknown as OpenidClient.Configuration;

describe("isOidcEnabled", () => {
  it("false when every key is empty (the default)", () => {
    expect(
      isOidcEnabled({
        TESSERA_OIDC_ISSUER: "",
        TESSERA_OIDC_CLIENT_ID: "",
        TESSERA_OIDC_CLIENT_SECRET: "",
        TESSERA_OIDC_REDIRECT_URI: "",
      }),
    ).toBe(false);
  });

  it("true once all four are set", () => {
    expect(isOidcEnabled(CONFIG)).toBe(true);
  });

  it("false when any single key is missing", () => {
    expect(isOidcEnabled({ ...CONFIG, TESSERA_OIDC_CLIENT_SECRET: "" })).toBe(false);
  });
});

describe("isOidcConfigPartial", () => {
  it("false when all four are empty", () => {
    expect(
      isOidcConfigPartial({
        TESSERA_OIDC_ISSUER: "",
        TESSERA_OIDC_CLIENT_ID: "",
        TESSERA_OIDC_CLIENT_SECRET: "",
        TESSERA_OIDC_REDIRECT_URI: "",
      }),
    ).toBe(false);
  });

  it("false when all four are set", () => {
    expect(isOidcConfigPartial(CONFIG)).toBe(false);
  });

  it("true when only some are set — never a valid half-on state", () => {
    expect(isOidcConfigPartial({ ...CONFIG, TESSERA_OIDC_REDIRECT_URI: "" })).toBe(true);
  });
});

describe("buildOidcAuthorizationUrl", () => {
  beforeEach(() => {
    resetOidcDiscoveryCacheForTests();
    vi.clearAllMocks();
    discoveryMock.mockResolvedValue(FAKE_CLIENT_CONFIG);
    randomPKCECodeVerifierMock.mockReturnValue("verifier-123");
    calculatePKCECodeChallengeMock.mockResolvedValue("challenge-abc");
    randomStateMock.mockReturnValue("state-xyz");
    randomNonceMock.mockReturnValue("nonce-789");
    buildAuthorizationUrlMock.mockReturnValue(new URL("https://idp.example.com/authorize?foo=bar"));
  });

  it("discovers against the configured issuer/client", async () => {
    await buildOidcAuthorizationUrl(CONFIG);
    expect(discoveryMock).toHaveBeenCalledTimes(1);
    const [server, clientId, clientSecret] = discoveryMock.mock.calls[0];
    expect(server.href).toBe(new URL(CONFIG.TESSERA_OIDC_ISSUER).href);
    expect(clientId).toBe(CONFIG.TESSERA_OIDC_CLIENT_ID);
    expect(clientSecret).toBe(CONFIG.TESSERA_OIDC_CLIENT_SECRET);
  });

  it("derives the PKCE challenge from the generated verifier", async () => {
    await buildOidcAuthorizationUrl(CONFIG);
    expect(calculatePKCECodeChallengeMock).toHaveBeenCalledWith("verifier-123");
  });

  it("builds the authorization URL with S256 PKCE, state, and nonce", async () => {
    await buildOidcAuthorizationUrl(CONFIG);
    expect(buildAuthorizationUrlMock).toHaveBeenCalledWith(FAKE_CLIENT_CONFIG, {
      redirect_uri: CONFIG.TESSERA_OIDC_REDIRECT_URI,
      scope: "openid email profile",
      code_challenge: "challenge-abc",
      code_challenge_method: "S256",
      state: "state-xyz",
      nonce: "nonce-789",
    });
  });

  it("returns the url alongside the verifier/state/nonce the caller must persist", async () => {
    const txn = await buildOidcAuthorizationUrl(CONFIG);
    expect(txn.url.href).toBe("https://idp.example.com/authorize?foo=bar");
    expect(txn).toMatchObject({
      codeVerifier: "verifier-123",
      state: "state-xyz",
      nonce: "nonce-789",
    });
  });

  it("caches discovery across calls for the same issuer instead of re-fetching", async () => {
    await buildOidcAuthorizationUrl(CONFIG);
    await buildOidcAuthorizationUrl(CONFIG);
    expect(discoveryMock).toHaveBeenCalledTimes(1);
  });

  it("evicts a failed discovery so a later call retries rather than staying wedged", async () => {
    discoveryMock.mockReset();
    discoveryMock.mockRejectedValueOnce(new Error("idp unreachable"));
    await expect(buildOidcAuthorizationUrl(CONFIG)).rejects.toThrow("idp unreachable");

    discoveryMock.mockResolvedValueOnce(FAKE_CLIENT_CONFIG);
    await expect(buildOidcAuthorizationUrl(CONFIG)).resolves.toBeDefined();
    expect(discoveryMock).toHaveBeenCalledTimes(2);
  });
});

describe("completeOidcLogin", () => {
  const txn = { codeVerifier: "verifier-123", state: "state-xyz", nonce: "nonce-789" };
  const currentUrl = new URL(
    "https://tessera.example.com/api/auth/oidc/callback?code=abc&state=state-xyz",
  );

  beforeEach(() => {
    resetOidcDiscoveryCacheForTests();
    vi.clearAllMocks();
    discoveryMock.mockResolvedValue(FAKE_CLIENT_CONFIG);
  });

  it("exchanges the code with the persisted PKCE verifier/state/nonce", async () => {
    authorizationCodeGrantMock.mockResolvedValue({ claims: () => ({ sub: "user-1" }) });
    await completeOidcLogin(CONFIG, currentUrl, txn);
    expect(authorizationCodeGrantMock).toHaveBeenCalledWith(FAKE_CLIENT_CONFIG, currentUrl, {
      pkceCodeVerifier: txn.codeVerifier,
      expectedState: txn.state,
      expectedNonce: txn.nonce,
    });
  });

  it("returns only the derived identity claims worth keeping", async () => {
    authorizationCodeGrantMock.mockResolvedValue({
      claims: () => ({
        sub: "user-1",
        email: "user@example.com",
        name: "User One",
        groups: ["admins", "devs"],
      }),
    });
    const identity = await completeOidcLogin(CONFIG, currentUrl, txn);
    expect(identity).toEqual({
      sub: "user-1",
      email: "user@example.com",
      name: "User One",
      groups: ["admins", "devs"],
    });
  });

  it("never carries the raw token response through — only claims() output", async () => {
    const tokens = {
      access_token: "raw-access-token",
      id_token: "raw-id-token",
      claims: () => ({ sub: "user-1" }),
    };
    authorizationCodeGrantMock.mockResolvedValue(tokens);
    const identity = await completeOidcLogin(CONFIG, currentUrl, txn);
    expect(identity).not.toHaveProperty("access_token");
    expect(identity).not.toHaveProperty("id_token");
    expect(JSON.stringify(identity)).not.toContain("raw-access-token");
    expect(JSON.stringify(identity)).not.toContain("raw-id-token");
  });

  it("omits optional claims that are missing or the wrong type", async () => {
    authorizationCodeGrantMock.mockResolvedValue({
      claims: () => ({ sub: "user-1", email: 12345, groups: "not-an-array" }),
    });
    const identity = await completeOidcLogin(CONFIG, currentUrl, txn);
    expect(identity).toEqual({ sub: "user-1" });
  });

  it("throws when the token response has no id_token (claims() undefined)", async () => {
    authorizationCodeGrantMock.mockResolvedValue({ claims: () => undefined });
    await expect(completeOidcLogin(CONFIG, currentUrl, txn)).rejects.toThrow(/sub claim/);
  });

  it("throws when claims() has no sub", async () => {
    authorizationCodeGrantMock.mockResolvedValue({ claims: () => ({ email: "user@example.com" }) });
    await expect(completeOidcLogin(CONFIG, currentUrl, txn)).rejects.toThrow(/sub claim/);
  });

  it("propagates a state/nonce/PKCE mismatch rejection from the grant call", async () => {
    authorizationCodeGrantMock.mockRejectedValue(new Error("state mismatch"));
    await expect(completeOidcLogin(CONFIG, currentUrl, txn)).rejects.toThrow("state mismatch");
  });
});
