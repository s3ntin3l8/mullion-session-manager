import * as client from "openid-client";

// Deliberately not a Fastify plugin — pure OAuth/OIDC protocol logic, kept
// framework-agnostic and free of cookie/HTTP-header concerns (those live in
// src/services/auth.ts, which owns the session/txn cookie mechanics and
// calls into this module). Mirrors crypto-utils.ts's split: one small module
// per concern rather than one growing auth.ts.

// The subset of app.config OIDC needs, kept as its own interface for the
// same reason AuthConfig in auth.ts is — framework-agnostic, easy to
// construct in tests without a real FastifyInstance.
export interface OidcConfig {
  TESSERA_OIDC_ISSUER: string;
  TESSERA_OIDC_CLIENT_ID: string;
  TESSERA_OIDC_CLIENT_SECRET: string;
  TESSERA_OIDC_REDIRECT_URI: string;
}

const OIDC_KEYS = [
  "TESSERA_OIDC_ISSUER",
  "TESSERA_OIDC_CLIENT_ID",
  "TESSERA_OIDC_CLIENT_SECRET",
  "TESSERA_OIDC_REDIRECT_URI",
] as const;

/** All four OIDC settings configured — the only state OIDC login is offered in. */
export function isOidcEnabled(config: OidcConfig): boolean {
  return OIDC_KEYS.every((key) => config[key].trim() !== "");
}

/**
 * Some but not all four OIDC settings are set — always a misconfiguration,
 * never a valid "half on" state (mirrors src/app.ts's TESSERA_AUTH_TOKEN /
 * TESSERA_SESSION_SECRET fail-closed check for the same reason: a partially
 * configured OIDC client can't complete discovery or the code exchange, so
 * refusing to boot beats failing confusingly on the first login attempt).
 */
export function isOidcConfigPartial(config: OidcConfig): boolean {
  const setCount = OIDC_KEYS.filter((key) => config[key].trim() !== "").length;
  return setCount > 0 && setCount < OIDC_KEYS.length;
}

// Discovery hits the IdP's well-known endpoint — cached per issuer after the
// first successful call rather than at boot (so buildApp()/tests never need
// network access or a live IdP just to start) or per-request (so login
// doesn't hammer the IdP on every click). A failed discovery is evicted
// immediately so a transient IdP outage doesn't wedge every future login
// behind one cached rejection.
const discoveryCache = new Map<string, Promise<client.Configuration>>();

async function getClientConfig(config: OidcConfig): Promise<client.Configuration> {
  const cached = discoveryCache.get(config.TESSERA_OIDC_ISSUER);
  if (cached) return cached;

  const discovered = client.discovery(
    new URL(config.TESSERA_OIDC_ISSUER),
    config.TESSERA_OIDC_CLIENT_ID,
    config.TESSERA_OIDC_CLIENT_SECRET,
  );
  discoveryCache.set(config.TESSERA_OIDC_ISSUER, discovered);
  discovered.catch(() => discoveryCache.delete(config.TESSERA_OIDC_ISSUER));
  return discovered;
}

/** Test-only: forget cached discovery results so a mocked issuer can be re-resolved between tests. */
export function resetOidcDiscoveryCacheForTests(): void {
  discoveryCache.clear();
}

export interface OidcTransaction {
  url: URL;
  codeVerifier: string;
  state: string;
  nonce: string;
}

/**
 * Builds the provider redirect URL plus the PKCE verifier/state/nonce the
 * caller must persist (in a short-lived signed cookie — see
 * src/services/auth.ts's OIDC txn cookie helpers) until the callback.
 */
export async function buildOidcAuthorizationUrl(config: OidcConfig): Promise<OidcTransaction> {
  const clientConfig = await getClientConfig(config);
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();

  const url = client.buildAuthorizationUrl(clientConfig, {
    redirect_uri: config.TESSERA_OIDC_REDIRECT_URI,
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });

  return { url, codeVerifier, state, nonce };
}

export interface OidcIdentity {
  sub: string;
  email?: string;
  name?: string;
  groups?: string[];
}

/**
 * Completes the authorization code grant against `currentUrl` (the full
 * callback URL, including its query string) and returns only the identity
 * claims worth keeping — never the raw id_token/access_token. The session
 * cookie those claims end up in is signed-but-not-encrypted (client-
 * readable, see auth.ts), so a raw token must never reach it; the tokens
 * themselves are discarded the moment this function returns.
 */
export async function completeOidcLogin(
  config: OidcConfig,
  currentUrl: URL,
  txn: Pick<OidcTransaction, "codeVerifier" | "state" | "nonce">,
): Promise<OidcIdentity> {
  const clientConfig = await getClientConfig(config);
  const tokens = await client.authorizationCodeGrant(clientConfig, currentUrl, {
    pkceCodeVerifier: txn.codeVerifier,
    expectedState: txn.state,
    expectedNonce: txn.nonce,
  });

  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== "string") {
    throw new Error("OIDC provider did not return a valid ID token with a sub claim");
  }

  const identity: OidcIdentity = { sub: claims.sub };
  if (typeof claims.email === "string") identity.email = claims.email;
  if (typeof claims.name === "string") identity.name = claims.name;
  if (Array.isArray(claims.groups) && claims.groups.every((g) => typeof g === "string")) {
    identity.groups = claims.groups;
  }
  return identity;
}
