import { SESSION_MAX_AGE_SECONDS } from "./auth.js";
import { parseCookieHeader, signPayload, verifySignedPayload } from "./signed-payload.js";

// Preview-host auth token (issue #383) — closes the gap documented in
// src/plugins/auth.ts's own doc comment: a same-origin session cookie can't
// reach a cross-subdomain preview iframe, and a bare <iframe> can't attach a
// Bearer header. The literal issue design ("append the token as a query
// parameter to the iframe URL, validated by preview-proxy.ts on each preview
// host request") doesn't work as written — the query param only rides the
// single top-level document request the iframe makes; every subresource
// request the previewed app itself makes (JS/CSS/images/fetch/XHR) and the
// HMR WebSocket upgrade originate *inside* the iframe with no query string at
// all. So this is a two-lifetime scheme instead, mirroring the OIDC
// login-transaction/session-cookie split already in services/auth.ts:
//
//  1. A 60-second bootstrap token (mintPreviewToken/verifyPreviewToken),
//     minted by an authenticated dashboard session via
//     POST /api/previews/:slug/token and appended to the iframe URL's query
//     string as a one-time bootstrap.
//  2. A long-lived, host-only preview cookie (mintPreviewCookie/
//     verifyPreviewCookie) that preview-proxy.ts exchanges the bootstrap
//     token for (302 redirect + Set-Cookie, stripping the token from the
//     URL) — the cookie then rides every subsequent same-subdomain request
//     automatically, including the HMR WS upgrade, which never carries a
//     query string of its own.
//
// Both payloads carry the preview `slug` they were minted for (checked by
// the caller against the slug the request's Host header resolved to) as
// defense in depth on top of the cookie already being host-only per preview
// subdomain — a token/cookie minted for one preview can't unlock another.
//
// Pure functions over (secret, rawString), not Fastify decorators/request
// objects — same reasoning as services/auth.ts's own top-of-file comment:
// preview-proxy.ts's WS upgrade path has no FastifyRequest/FastifyReply at
// all, only a raw node:http IncomingMessage/socket.

export const PREVIEW_TOKEN_QUERY_PARAM = "__mullion_preview";
export const PREVIEW_COOKIE_NAME = "mullion_preview";

// One-time bootstrap only — just long enough for the iframe's initial
// top-level navigation to complete. Deliberately far shorter than the
// preview cookie's own TTL below.
const PREVIEW_TOKEN_MAX_AGE_MS = 60 * 1000;

// Same TTL as the dashboard session cookie (services/auth.ts's
// SESSION_MAX_AGE_MS) — reused rather than a new constant, per design. Long
// on purpose: the frontend has no keepalive/401-retry for an open iframe
// (AuthGate.tsx checks GET /api/auth/me once on mount only), so a short-lived
// cookie would silently 401 a long-open preview with no recovery path short
// of a full iframe reload (losing the previewed app's in-page state).
// Trade-off: revocation is weak — killing the dashboard session does not
// kill preview access until this cookie itself expires. Documented in
// docs/auth.md's Current limitations.
export const PREVIEW_COOKIE_MAX_AGE_SECONDS = SESSION_MAX_AGE_SECONDS;

interface PreviewSlugPayload {
  slug: string;
  issuedAt: number;
}

function isValidPreviewSlugPayload(value: unknown): value is PreviewSlugPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PreviewSlugPayload>;
  return typeof candidate.slug === "string" && typeof candidate.issuedAt === "number";
}

/** Mint a 60-second bootstrap token for `slug` — appended to the iframe URL's query string (see PREVIEW_TOKEN_QUERY_PARAM). */
export function mintPreviewToken(secret: string, slug: string): string {
  return signPayload(secret, { slug, issuedAt: Date.now() });
}

/**
 * Verify a raw bootstrap token value against `secret` and `slug` — `raw` is
 * already the decoded token string (e.g. from `URL.searchParams.get`, which
 * decodes automatically; see preview-proxy.ts's own note on why the token
 * must be encodeURIComponent'd on mint but never hand-split off the query
 * string on read, since @fastify/cookie's sign() output is standard base64,
 * not base64url, and can contain `+`/`/`).
 */
export function verifyPreviewToken(secret: string, raw: string | undefined, slug: string): boolean {
  if (!raw) return false;
  const payload = verifySignedPayload(
    secret,
    raw,
    PREVIEW_TOKEN_MAX_AGE_MS,
    isValidPreviewSlugPayload,
  );
  return payload !== null && payload.slug === slug;
}

/** Mint the long-lived preview-access cookie value for `slug`, exchanged for a valid bootstrap token. */
export function mintPreviewCookie(secret: string, slug: string): string {
  return signPayload(secret, { slug, issuedAt: Date.now() });
}

/** Verify a request's preview cookie (from a raw `Cookie` header) against `secret` and `slug`. */
export function verifyPreviewCookie(
  secret: string,
  cookieHeader: string | undefined,
  slug: string,
): boolean {
  const raw = parseCookieHeader(cookieHeader, PREVIEW_COOKIE_NAME);
  if (!raw) return false;
  const payload = verifySignedPayload(
    secret,
    raw,
    PREVIEW_COOKIE_MAX_AGE_SECONDS * 1000,
    isValidPreviewSlugPayload,
  );
  return payload !== null && payload.slug === slug;
}
