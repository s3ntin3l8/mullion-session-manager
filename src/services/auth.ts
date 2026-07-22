import type { IncomingHttpHeaders } from "node:http";
import fastifyCookie from "@fastify/cookie";
import { timingSafeTokenMatch } from "./crypto-utils.js";
import { isOidcEnabled, type OidcConfig, type OidcIdentity } from "./oidc.js";

// Deliberately not a Fastify plugin — pure logic, importable from both
// src/plugins/auth.ts's onRequest hook (a real FastifyRequest) and, if a
// future caller needs it, any raw node:http request/response pair (a
// FastifyRequest's .headers is structurally the same IncomingHttpHeaders a
// raw request has). See src/plugins/preview-proxy.ts's own comment on why
// its WS upgrade path bypasses Fastify's request lifecycle entirely — this
// module's functions don't assume that lifecycle exists.

export const SESSION_COOKIE_NAME = "mullion_session";

// A signed, but NOT encrypted, cookie (see createSessionCookieValue) — HMAC
// via @fastify/cookie's sign/unsign gives integrity (the browser can't forge
// or tamper with it) but not confidentiality (the payload is base64, not
// encrypted, so treat it as client-readable). This is why OIDC login (issue
// #30) only ever stores *derived* identity claims here (sub/email/name/
// groups) and never the raw id_token/access_token from the provider — see
// services/oidc.ts's completeOidcLogin, which discards those tokens the
// moment it extracts claims from them.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000;

interface SessionPayload {
  authenticated: true;
  issuedAt: number;
  identity?: OidcIdentity;
}

// The subset of app.config this module needs — kept as its own interface
// (rather than importing Fastify's `config` augmentation) so this stays
// framework-agnostic. Includes OIDC's config shape so isAuthEnabled and the
// auth-methods reporting below can see both credentials at once.
export interface AuthConfig extends OidcConfig {
  MULLION_AUTH_TOKEN: string;
  MULLION_SESSION_SECRET: string;
}

/**
 * Whether in-process auth is switched on at all — either credential is
 * enough. Both unset (the default) means "rely on the gateway/network, same
 * as before this feature existed" — see MULLION_AUTH_TOKEN's doc in
 * src/plugins/env.ts.
 */
export function isAuthEnabled(config: AuthConfig): boolean {
  return config.MULLION_AUTH_TOKEN.trim() !== "" || isOidcEnabled(config);
}

export interface AuthMethods {
  token: boolean;
  oidc: boolean;
}

/**
 * Which credential(s) GET /api/auth/me should tell the frontend to offer —
 * not a single mode string, since token and OIDC can both be configured at
 * once (the frontend then shows both the token field and the SSO button).
 */
export function getAuthMethods(config: AuthConfig): AuthMethods {
  return { token: config.MULLION_AUTH_TOKEN.trim() !== "", oidc: isOidcEnabled(config) };
}

/** Mint a signed session cookie value for a Set-Cookie header after login. */
export function createSessionCookieValue(secret: string, identity?: OidcIdentity): string {
  const payload: SessionPayload = { authenticated: true, issuedAt: Date.now() };
  if (identity) payload.identity = identity;
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return fastifyCookie.sign(encoded, secret);
}

function parseCookieHeader(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const rawValue = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Decode + verify a request's session cookie against `secret` — a pure
 * function of (secret, raw Cookie header) rather than @fastify/cookie's
 * request decorators, which only exist on a real FastifyRequest. Returns
 * null (not just "invalid") whenever secret is empty, matching
 * MULLION_SESSION_SECRET's "auth enabled but no secret configured" boot-time
 * refusal in src/app.ts — this never trusts an unsigned/unsignable cookie.
 */
function getValidSessionPayload(
  secret: string,
  cookieHeader: string | undefined,
): SessionPayload | null {
  if (secret === "") return null;
  const raw = parseCookieHeader(cookieHeader, SESSION_COOKIE_NAME);
  if (!raw) return null;

  const result = fastifyCookie.unsign(raw, secret);
  if (!result.valid || result.value === null) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(result.value, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (payload.authenticated !== true || typeof payload.issuedAt !== "number") return null;
  if (Date.now() - payload.issuedAt > SESSION_MAX_AGE_MS) return null;
  return payload;
}

export function hasValidSessionCookie(secret: string, cookieHeader: string | undefined): boolean {
  return getValidSessionPayload(secret, cookieHeader) !== null;
}

/** The OIDC identity carried by a valid session cookie, if any (token-only sessions have none). */
export function getSessionIdentity(
  secret: string,
  cookieHeader: string | undefined,
): OidcIdentity | undefined {
  return getValidSessionPayload(secret, cookieHeader)?.identity;
}

/** Bearer-token check, reusing the same constant-time compare the agent-role internal API uses. */
export function hasValidBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (expectedToken === "") return false;
  const provided = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : "";
  return timingSafeTokenMatch(provided, expectedToken);
}

/** POST /api/auth/login's own check — same constant-time compare, body-token shaped. */
export function isValidLoginToken(provided: string, config: AuthConfig): boolean {
  if (config.MULLION_AUTH_TOKEN === "") return false;
  return timingSafeTokenMatch(provided, config.MULLION_AUTH_TOKEN);
}

/**
 * The single "is this request allowed through the gate" decision, shared by
 * src/plugins/auth.ts's global onRequest hook. Accepts either credential: a
 * valid session cookie (how the browser SPA authenticates after POST
 * /api/auth/login) or a valid Bearer header (keeps curl/scripts working, and
 * is the only option available to a caller that can't hold cookies).
 */
export function isRequestAuthenticated(
  headers: Pick<IncomingHttpHeaders, "cookie" | "authorization">,
  config: AuthConfig,
): boolean {
  if (hasValidSessionCookie(config.MULLION_SESSION_SECRET, headers.cookie)) return true;
  return hasValidBearerToken(headers.authorization, config.MULLION_AUTH_TOKEN);
}

// --- OIDC transaction cookie (issue #30) ------------------------------
//
// Phase 1 deliberately kept this app stateless (no server-side session
// store) — the OIDC authorization-code flow needs to carry a PKCE verifier
// and CSRF `state`/`nonce` from GET /api/auth/oidc/login to GET
// /api/auth/oidc/callback, so rather than add a store just for this, it
// rides in its own short-lived signed cookie, separate from the long-lived
// session cookie above. Signed with the same MULLION_SESSION_SECRET (no new
// config key needed — HMAC signing keys are routinely reused across
// distinct cookies, unlike encryption keys) via the same sign/unsign
// mechanism.

export const OIDC_TXN_COOKIE_NAME = "mullion_oidc_txn";
const OIDC_TXN_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — just long enough for a login redirect round trip
export const OIDC_TXN_MAX_AGE_SECONDS = OIDC_TXN_MAX_AGE_MS / 1000;

export interface OidcTxnPayload {
  codeVerifier: string;
  state: string;
  nonce: string;
  issuedAt: number;
}

export function createOidcTxnCookieValue(
  secret: string,
  txn: Pick<OidcTxnPayload, "codeVerifier" | "state" | "nonce">,
): string {
  const payload: OidcTxnPayload = { ...txn, issuedAt: Date.now() };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return fastifyCookie.sign(encoded, secret);
}

/** Reads and verifies the OIDC txn cookie — null if missing, tampered, malformed, or expired. */
export function readOidcTxnCookieValue(
  secret: string,
  cookieHeader: string | undefined,
): OidcTxnPayload | null {
  if (secret === "") return null;
  const raw = parseCookieHeader(cookieHeader, OIDC_TXN_COOKIE_NAME);
  if (!raw) return null;

  const result = fastifyCookie.unsign(raw, secret);
  if (!result.valid || result.value === null) return null;

  let payload: OidcTxnPayload;
  try {
    payload = JSON.parse(Buffer.from(result.value, "base64url").toString("utf8")) as OidcTxnPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.codeVerifier !== "string" ||
    typeof payload.state !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.issuedAt !== "number"
  ) {
    return null;
  }
  if (Date.now() - payload.issuedAt > OIDC_TXN_MAX_AGE_MS) return null;
  return payload;
}
