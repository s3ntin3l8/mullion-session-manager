import fastifyCookie from "@fastify/cookie";

// Extracted from three hand-rolled, structurally identical copies of the
// same pattern that used to live in services/auth.ts: createSessionCookieValue/
// getValidSessionPayload (the long-lived dashboard session) and
// createOidcTxnCookieValue/readOidcTxnCookieValue (the short-lived OIDC PKCE/
// state/nonce transaction cookie). services/preview-auth.ts (issue #383) is
// the third and fourth caller (a 60s bootstrap token and a preview-access
// cookie). All four share the same wire format — JSON.stringify -> base64url
// -> @fastify/cookie's sign()/unsign() — and the same "reject if stale"
// staleness check; only the payload shape and max age differ per caller,
// which is why `isValidShape` is a caller-supplied type guard rather than
// this module trying to validate a shape it has no way to know.
//
// Deliberately NOT Fastify decorators/request objects — a pure function of
// (secret, raw string) — for the same reason services/auth.ts's own functions
// are written that way (see that file's top-of-file comment): a future caller
// may have no FastifyRequest/FastifyReply at all, only a raw node:http
// request/socket (preview-proxy.ts's WS upgrade path is exactly that today).

/** Mint a signed value for a Set-Cookie/query-param payload — `payload` must already carry whatever staleness field (e.g. `issuedAt`) the matching `verifySignedPayload` call will check. */
export function signPayload<T extends object>(secret: string, payload: T): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return fastifyCookie.sign(encoded, secret);
}

/**
 * Decode + verify a signed value against `secret`, rejecting it outright
 * (returning null, not throwing) whenever: `secret` is empty (never trust an
 * unsigned/unsignable value — matches every boot-time "auth enabled but no
 * secret configured" refusal in src/app.ts), `raw` is missing, the signature
 * doesn't match, the decoded JSON doesn't parse, `isValidShape` rejects it,
 * or `issuedAt` is older than `maxAgeMs`.
 */
export function verifySignedPayload<T extends { issuedAt: number }>(
  secret: string,
  raw: string | undefined,
  maxAgeMs: number,
  isValidShape: (value: unknown) => value is T,
): T | null {
  if (secret === "" || !raw) return null;

  const result = fastifyCookie.unsign(raw, secret);
  if (!result.valid || result.value === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(result.value, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!isValidShape(parsed)) return null;
  if (Date.now() - parsed.issuedAt > maxAgeMs) return null;
  return parsed;
}

/**
 * Parse a single named cookie out of a raw `Cookie` request header — shared
 * by every consumer of verifySignedPayload above that reads its raw value
 * from a cookie rather than a query param (services/auth.ts's session/OIDC-txn
 * cookies, services/preview-auth.ts's preview-access cookie). A pure function
 * of the header string, same "no FastifyRequest assumed" reasoning as this
 * module's other exports — preview-proxy.ts's WS upgrade path only ever has a
 * raw node:http IncomingMessage's `.headers.cookie`, never a FastifyRequest.
 */
export function parseCookieHeader(cookieHeader: string | undefined, name: string): string | null {
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
