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

// Finding AS12 — this used to reuse SESSION_MAX_AGE_SECONDS outright (30
// days, same as the dashboard session cookie), with no revocation path at
// all short of rotating MULLION_SESSION_SECRET itself (which invalidates
// every signed cookie/token in the app, dashboard sessions included — the
// "big hammer," documented as the only kill switch). Killing a single
// dashboard session or rotating MULLION_AUTH_TOKEN did nothing to an
// already-issued preview cookie.
//
// The frontend constraint that originally justified the 30-day reuse is
// still real and unchanged: there's no keepalive/401-retry for an open
// iframe (AuthGate.tsx checks GET /api/auth/me once on mount only, and a
// cross-origin iframe's parent frame can't even observe a 401 happening
// inside it), so a short *absolute* TTL would silently kill a long-open
// preview with no recovery path short of a full iframe reload (losing the
// previewed app's in-page state) — exactly what evaluatePreviewAuth's own
// cookie-checked-first comment already goes out of its way to avoid one
// extra round trip for.
//
// The fix is a sliding idle timeout instead of a flat absolute one:
// PREVIEW_COOKIE_MAX_AGE_SECONDS itself is now short (24h, not 30 days) —
// bounding how long revocation lag can possibly be — but
// checkPreviewCookie (below) tells its caller (preview-proxy.ts's
// evaluatePreviewAuth) to silently re-mint the cookie, with a fresh
// issuedAt and thus a fresh full 24h window, once a still-valid cookie is
// more than PREVIEW_COOKIE_REFRESH_AGE_MS old. A preview that's genuinely
// still being used (any request within the WS-transport-adjacent HTTP
// traffic a live HMR session always generates — see checkPreviewCookie's
// own comment on why the WS path itself doesn't need to do this) never
// actually reaches the 24h cap; only one that's gone idle (tab left open
// but untouched, or genuinely abandoned) does — at which point re-auth
// requires a fresh bootstrap token from the still-live dashboard session
// (POST /api/previews/:slug/token), which fails if that session was killed
// or the token was rotated in the meantime. That's the actual revocation
// win: idle exposure now caps at ~24h instead of 30 days.
export const PREVIEW_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60; // 24h

// Half the max age — see the block comment above. A cookie younger than
// this is left untouched (no extra Set-Cookie on every single request); one
// older gets silently refreshed. Halfway is arbitrary but reasonable: it
// guarantees a still-active preview refreshes well before its cookie could
// ever actually expire, without refreshing on literally every request.
export const PREVIEW_COOKIE_REFRESH_AGE_MS = (PREVIEW_COOKIE_MAX_AGE_SECONDS * 1000) / 2;

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

export interface PreviewCookieCheck {
  valid: boolean;
  // Only meaningful when valid is true — whether the caller should re-mint
  // (mintPreviewCookie) and Set-Cookie a fresh value on this same response,
  // per PREVIEW_COOKIE_REFRESH_AGE_MS's own comment above.
  shouldRefresh: boolean;
}

/**
 * Verify a request's preview cookie (from a raw `Cookie` header) against
 * `secret` and `slug`, and report whether it's old enough to warrant a
 * silent sliding refresh (finding AS12). The HTTP path (preview-proxy.ts's
 * onRequest hook) uses this directly so it can Set-Cookie a refreshed value
 * on the same response. The WS upgrade path (handlePreviewWsUpgrade)
 * doesn't — there's no way to Set-Cookie mid-handshake — so it uses the
 * boolean-only verifyPreviewCookie below instead; that's not a gap in
 * practice, since a live HMR/WS connection always rides alongside ordinary
 * HTTP asset traffic on the same preview host, which does refresh it.
 */
export function checkPreviewCookie(
  secret: string,
  cookieHeader: string | undefined,
  slug: string,
): PreviewCookieCheck {
  const raw = parseCookieHeader(cookieHeader, PREVIEW_COOKIE_NAME);
  if (!raw) return { valid: false, shouldRefresh: false };
  const payload = verifySignedPayload(
    secret,
    raw,
    PREVIEW_COOKIE_MAX_AGE_SECONDS * 1000,
    isValidPreviewSlugPayload,
  );
  if (payload === null || payload.slug !== slug) return { valid: false, shouldRefresh: false };
  const age = Date.now() - payload.issuedAt;
  return { valid: true, shouldRefresh: age > PREVIEW_COOKIE_REFRESH_AGE_MS };
}

/** Boolean-only convenience wrapper over checkPreviewCookie — used by the WS
 * upgrade path, which has no use for the refresh signal (see
 * checkPreviewCookie's own comment). */
export function verifyPreviewCookie(
  secret: string,
  cookieHeader: string | undefined,
  slug: string,
): boolean {
  return checkPreviewCookie(secret, cookieHeader, slug).valid;
}
