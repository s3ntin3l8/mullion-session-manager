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

// Finding AS11: `Date.now() - issuedAt > maxAgeMs` alone always passes when
// the difference is negative — i.e. `issuedAt` is in the future. A server
// clock jump forward (NTP correction, VM pause/resume, manual misconfig)
// mints payloads whose `issuedAt` looks "future" relative to a reader on an
// unaffected clock, and such a payload would then never expire under the
// staleness check alone. request-signature.ts's isTimestampFresh closes the
// equivalent gap with a symmetric `Math.abs(now - ts) <= DRIFT_WINDOW_MS` —
// but that check's window (30s) is the whole tolerance for a request meant
// to be used within seconds. The payloads here range from a 60s bootstrap
// token up to a 30-day session cookie, so a single symmetric window is
// wrong: `Math.abs(age) > maxAgeMs` would let a 30-day cookie be minted with
// `issuedAt` up to 29 days in the future and still pass. Instead, the two
// directions get independent bounds: the existing `maxAgeMs` (per-caller,
// already correct) for staleness, and a small, fixed
// `CLOCK_SKEW_TOLERANCE_MS` for how far into the future `issuedAt` may
// legitimately be — enough to absorb real clock drift between processes,
// not enough to matter as a usable "extend my expiry" lever.
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

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
 * `issuedAt` is older than `maxAgeMs`, or `issuedAt` is more than
 * `CLOCK_SKEW_TOLERANCE_MS` in the future (finding AS11).
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
  const age = Date.now() - parsed.issuedAt;
  if (age > maxAgeMs) return null;
  if (age < -CLOCK_SKEW_TOLERANCE_MS) return null;
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
