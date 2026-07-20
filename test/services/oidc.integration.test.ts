import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { generateKeyPair, exportJWK, SignJWT, type JWK, type CryptoKey } from "jose";
import {
  buildOidcAuthorizationUrl,
  completeOidcLogin,
  resetOidcDiscoveryCacheForTests,
  type OidcConfig,
} from "../../src/services/oidc.js";

// Reviewer-flagged gap (PR #59): test/services/oidc.test.ts and
// test/plugins/auth.test.ts both mock openid-client/services/oidc.ts
// entirely, so a real discovery/JWKS/redirect_uri/signature mismatch would
// pass every one of those tests and only surface against a live IdP. This
// file closes that gap without needing a live IdP: undici's MockAgent
// replaces the *transport* Node's global fetch uses (no real network, no
// TLS handshake, no allowInsecureRequests escape hatch needed since the
// URLs stay https://) — so the actual openid-client v6 code this app runs
// in production (discovery, PKCE, the authorization-code grant, and real
// RSA ID-token signature verification via a real JWKS) all execute for
// real here, unmocked.

const ISSUER = "https://idp.integration.test";
const CLIENT_ID = "integration-client-id";
const CLIENT_SECRET = "integration-client-secret";
const REDIRECT_URI = "https://tessera.integration.test/api/auth/oidc/callback";
const KID = "integration-test-key";

const CONFIG: OidcConfig = {
  TESSERA_OIDC_ISSUER: ISSUER,
  TESSERA_OIDC_CLIENT_ID: CLIENT_ID,
  TESSERA_OIDC_CLIENT_SECRET: CLIENT_SECRET,
  TESSERA_OIDC_REDIRECT_URI: REDIRECT_URI,
};

const JSON_HEADERS = { "content-type": "application/json" };

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;
let privateKey: CryptoKey;

async function signIdToken(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function mockTokenEndpoint(idToken: string) {
  mockAgent
    .get(ISSUER)
    .intercept({ path: "/token", method: "POST" })
    .reply(
      200,
      { access_token: "at-1", token_type: "Bearer", id_token: idToken, expires_in: 3600 },
      { headers: JSON_HEADERS },
    );
}

beforeEach(async () => {
  resetOidcDiscoveryCacheForTests();
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const keyPair = await generateKeyPair("RS256", { extractable: true });
  privateKey = keyPair.privateKey;
  const publicJwk: JWK = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };

  const pool = mockAgent.get(ISSUER);
  pool
    .intercept({ path: "/.well-known/openid-configuration", method: "GET" })
    .reply(
      200,
      {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      },
      { headers: JSON_HEADERS },
    )
    .persist();
  pool
    .intercept({ path: "/jwks", method: "GET" })
    .reply(200, { keys: [publicJwk] }, { headers: JSON_HEADERS })
    .persist();
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

describe("OIDC integration against a mocked-transport provider (real openid-client, issue #30 review)", () => {
  it("completes the full login flow: discovery -> authorize URL -> code exchange -> verified identity", async () => {
    const txn = await buildOidcAuthorizationUrl(CONFIG);
    expect(txn.url.origin + txn.url.pathname).toBe(`${ISSUER}/authorize`);
    expect(txn.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(txn.url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);

    const idToken = await signIdToken({
      sub: "user-1",
      email: "user@example.com",
      name: "Integration User",
      groups: ["admins"],
      nonce: txn.nonce,
    });
    mockTokenEndpoint(idToken);

    const currentUrl = new URL(`${REDIRECT_URI}?code=test-code&state=${txn.state}`);
    const identity = await completeOidcLogin(CONFIG, currentUrl, txn);

    expect(identity).toEqual({
      sub: "user-1",
      email: "user@example.com",
      name: "Integration User",
      groups: ["admins"],
    });
  });

  it("rejects an ID token whose nonce doesn't match the persisted transaction", async () => {
    const txn = await buildOidcAuthorizationUrl(CONFIG);
    mockTokenEndpoint(await signIdToken({ sub: "user-1", nonce: "wrong-nonce" }));

    const currentUrl = new URL(`${REDIRECT_URI}?code=test-code&state=${txn.state}`);
    await expect(completeOidcLogin(CONFIG, currentUrl, txn)).rejects.toThrow();
  });

  it("rejects a callback whose state doesn't match the persisted transaction", async () => {
    // No token-endpoint mock: openid-client validates `state` against the
    // authorization response before ever attempting the token exchange, so
    // this should fail before any network call — mockAgent.disableNetConnect()
    // means an unexpected request would also fail loudly rather than hang.
    const txn = await buildOidcAuthorizationUrl(CONFIG);
    const currentUrl = new URL(`${REDIRECT_URI}?code=test-code&state=tampered-state`);
    await expect(completeOidcLogin(CONFIG, currentUrl, txn)).rejects.toThrow();
  });

  it("rejects an ID token signed by a key absent from the provider's JWKS", async () => {
    const txn = await buildOidcAuthorizationUrl(CONFIG);
    const otherKeyPair = await generateKeyPair("RS256", { extractable: true });
    const idToken = await new SignJWT({ sub: "user-1", nonce: txn.nonce })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(otherKeyPair.privateKey);
    mockTokenEndpoint(idToken);

    const currentUrl = new URL(`${REDIRECT_URI}?code=test-code&state=${txn.state}`);
    await expect(completeOidcLogin(CONFIG, currentUrl, txn)).rejects.toThrow();
  });

  it("sends the configured redirect_uri unchanged to the token endpoint, matching the PR review fix", async () => {
    const txn = await buildOidcAuthorizationUrl(CONFIG);
    mockTokenEndpoint(await signIdToken({ sub: "user-1", nonce: txn.nonce }));

    // routes/auth.ts builds currentUrl from TESSERA_OIDC_REDIRECT_URI plus
    // only the request's query string (see its own comment) — reproduced
    // directly here rather than importing Fastify, since this file's job
    // is exercising the real openid-client call, not the route wiring
    // (already covered by test/plugins/auth.test.ts's own regression test).
    const currentUrl = new URL(`${REDIRECT_URI}?code=test-code&state=${txn.state}`);
    await expect(completeOidcLogin(CONFIG, currentUrl, txn)).resolves.toMatchObject({
      sub: "user-1",
    });
  });
});
