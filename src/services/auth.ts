import type { IncomingHttpHeaders } from "node:http";
import { timingSafeTokenMatch } from "./crypto-utils.js";
import { isOidcEnabled, type OidcConfig, type OidcIdentity } from "./oidc.js";
import { parseCookieHeader, signPayload, verifySignedPayload } from "./signed-payload.js";

// Deliberately not a Fastify plugin — pure logic, importable from both
// src/plugins/auth.ts's onRequest hook (a real FastifyRequest) and, if a
// future caller needs it, any raw node:http request/response pair (a
// FastifyRequest's .headers is structurally the same IncomingHttpHeaders a
// raw request has). See src/plugins/preview-proxy.ts's own comment on why
// its WS upgrade path bypasses Fastify's request lifecycle entirely — this
// module's functions don't assume that lifecycle exists.

export const SESSION_COOKIE_NAME = "mullion_session";

// A signed, but NOT encrypted, cookie (see createSessionCookieValue) — HMAC
// via @fastify/cookie's sign/unsign (through signed-payload.ts's shared
// signPayload/verifySignedPayload helper) gives integrity (the browser can't
// forge or tamper with it) but not confidentiality (the payload is base64,
// not encrypted, so treat it as client-readable). This is why OIDC login
// (issue #30) only ever stores *derived* identity claims here (sub/email/
// name/groups) and never the raw id_token/access_token from the provider —
// see services/oidc.ts's completeOidcLogin, which discards those tokens the
// moment it extracts claims from them.
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
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
 * The single normalized reading of MULLION_AUTH_TOKEN — every function in
 * this file that has an opinion on whether a token credential is
 * "configured" or "valid" must go through this, never `config
 * .MULLION_AUTH_TOKEN` directly (security audit finding AS2). Before this
 * existed, isAuthEnabled/getAuthMethods trimmed and isValidLoginToken/
 * hasValidBearerToken (via isRequestAuthenticated) didn't, so a
 * whitespace-only token (e.g. a `.env` line with a trailing space) was
 * reported as "auth disabled" by the first pair while the second pair
 * happily accepted `"   "` as a live credential — worse, with no OIDC
 * configured, isAuthEnabled() returning false made authPlugin
 * (src/plugins/auth.ts) install no onRequest hook at all, leaving the
 * entire dashboard open behind only a log.warn. src/app.ts's boot-invariant
 * block refuses to boot on exactly this shape (non-empty but blank after
 * trim) so this case shouldn't reach runtime at all — this accessor is the
 * defense-in-depth backstop for that invariant, and the single place that
 * definition lives.
 *
 * Exported (not module-private) because AS2's inconsistency wasn't limited
 * to this file: src/plugins/control-socket.ts's resolveHandshake — the
 * `mullion ps`/CLI control-socket handshake, a third credential path
 * alongside the HTTP login and Bearer-token checks below — independently
 * compared a presented token against the raw, untrimmed config value (found
 * in Hermes review on this same PR). A token with incidental surrounding
 * whitespace (e.g. "secret ") would then authenticate over HTTP (trimmed)
 * but be rejected on the control socket (untrimmed) — same root cause, a
 * second call site. Exporting this instead of duplicating the trim logic
 * there keeps exactly one definition of "the configured token" for every
 * credential path this app has.
 */
export function configuredToken(config: AuthConfig): string {
  return config.MULLION_AUTH_TOKEN.trim();
}

/**
 * Whether in-process auth is switched on at all — either credential is
 * enough. Both unset (the default) means "rely on the gateway/network, same
 * as before this feature existed" — see MULLION_AUTH_TOKEN's doc in
 * src/plugins/env.ts.
 */
export function isAuthEnabled(config: AuthConfig): boolean {
  return configuredToken(config) !== "" || isOidcEnabled(config);
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
  return { token: configuredToken(config) !== "", oidc: isOidcEnabled(config) };
}

function isValidSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SessionPayload>;
  return candidate.authenticated === true && typeof candidate.issuedAt === "number";
}

/** Mint a signed session cookie value for a Set-Cookie header after login. */
export function createSessionCookieValue(secret: string, identity?: OidcIdentity): string {
  const payload: SessionPayload = { authenticated: true, issuedAt: Date.now() };
  if (identity) payload.identity = identity;
  return signPayload(secret, payload);
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
  const raw = parseCookieHeader(cookieHeader, SESSION_COOKIE_NAME);
  if (!raw) return null;
  return verifySignedPayload(secret, raw, SESSION_MAX_AGE_MS, isValidSessionPayload);
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

/**
 * Bearer-token check, reusing the same constant-time compare the agent-role
 * internal API uses. `expectedToken` is trimmed here too (not just by
 * configuredToken's callers) so this stays correct even for a caller that
 * passes a raw, untrimmed config value directly — see configuredToken's own
 * doc comment (finding AS2) for why a whitespace-only token must never be
 * treated as a live credential.
 */
export function hasValidBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  const trimmedExpected = expectedToken.trim();
  if (trimmedExpected === "") return false;
  const provided = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : "";
  return timingSafeTokenMatch(provided, trimmedExpected);
}

/** POST /api/auth/login's own check — same constant-time compare, body-token shaped. */
export function isValidLoginToken(provided: string, config: AuthConfig): boolean {
  const expected = configuredToken(config);
  if (expected === "") return false;
  return timingSafeTokenMatch(provided, expected);
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
  return hasValidBearerToken(headers.authorization, configuredToken(config));
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

function isValidOidcTxnPayload(value: unknown): value is OidcTxnPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OidcTxnPayload>;
  return (
    typeof candidate.codeVerifier === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.nonce === "string" &&
    typeof candidate.issuedAt === "number"
  );
}

export function createOidcTxnCookieValue(
  secret: string,
  txn: Pick<OidcTxnPayload, "codeVerifier" | "state" | "nonce">,
): string {
  const payload: OidcTxnPayload = { ...txn, issuedAt: Date.now() };
  return signPayload(secret, payload);
}

/** Reads and verifies the OIDC txn cookie — null if missing, tampered, malformed, or expired. */
export function readOidcTxnCookieValue(
  secret: string,
  cookieHeader: string | undefined,
): OidcTxnPayload | null {
  const raw = parseCookieHeader(cookieHeader, OIDC_TXN_COOKIE_NAME);
  if (!raw) return null;
  return verifySignedPayload(secret, raw, OIDC_TXN_MAX_AGE_MS, isValidOidcTxnPayload);
}
