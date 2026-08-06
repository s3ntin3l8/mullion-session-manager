import crypto from "node:crypto";

// Issue #249 / roadmap 7.5 — HMAC-signed primary->agent requests. Pure
// functions, no Fastify dependency — same reasoning as signed-payload.ts's
// own top-of-file comment: the WS-upgrade signing path (remote-host-client.ts's
// openAttach/openBrowserWs/openEventsStream/openPreviewWs) has no
// FastifyRequest at all, only a raw `ws` package client-options object, and
// the agent-side verification needs to run from routes/internal.ts's own
// hooks without this module knowing anything about Fastify's request type.
//
// Only ever used for a *session*-credentialed (self-registered, #245) host.
// A manually-registered static-Bearer host never signs and never verifies a
// signature — that path is untouched, byte-for-byte, by anything here.

export const SIGNATURE_HEADER = "x-request-signature";
export const TIMESTAMP_HEADER = "x-request-timestamp";
export const NONCE_HEADER = "x-request-nonce";

// ±30s (issue #249's own stated window) — generous enough for real clock
// drift between primary and agent hosts (neither is assumed NTP-synced)
// without weakening replay protection much past what the nonce store below
// already provides on its own.
export const DRIFT_WINDOW_MS = 30_000;

// A nonce must be remembered for at least as long as a request bearing it
// could still be considered "fresh" by the drift check above — a request
// timestamped up to DRIFT_WINDOW_MS in the past is still accepted, so its
// nonce must still be checked against nonces recorded up to that long ago
// too. Doubled, not just matched 1:1, as a margin against sweep-interval
// jitter (nonce-store.ts's periodic sweep, not this check itself, is what
// actually evicts entries).
export const NONCE_TTL_MS = DRIFT_WINDOW_MS * 2;

// Issue #249 — the only request paths whose body is NOT covered by the
// signature (bodyHashed: false in the canonical string below): bodies too
// large or too streaming-oriented to synchronously buffer and hash before
// auth is decided — a dev-server preview response/request body (up to
// MAX_PREVIEW_BODY_BYTES) and an image upload (MAX_UPLOAD_BYTES). Exported
// so both sides derive the SAME bodyHashed verdict from the SAME request
// path independently: remote-host-client.ts (deciding what to hash before
// sending) and routes/internal.ts (deciding what to expect on receipt).
// Neither side ever transmits bodyHashed itself over the wire — it's
// recomputed from the path on each end — so there is nothing in the request
// a forged/tampered request could set to downgrade it; the two sides either
// agree (because they're looking at the same path) or the signature simply
// fails to verify.
const UNSIGNED_BODY_PATH_PREFIXES = ["/internal/preview/", "/internal/uploads"];

// A plain .startsWith(prefix) would also match "/internal/uploads-extra" —
// harmless today (no such route exists), but wrong in principle for a
// security-relevant allowlist. Requires the match to land on an actual path
// boundary: either the prefix itself already ends in "/" (true for
// "/internal/preview/", which only ever matches its own subpaths), or the
// very next character in requestTarget is absent (an exact match, "/internal
// /uploads" with no trailing anything) or "?" (a query string starts here).
function matchesPathPrefix(requestTarget: string, prefix: string): boolean {
  if (!requestTarget.startsWith(prefix)) return false;
  if (prefix.endsWith("/")) return true;
  const nextChar = requestTarget[prefix.length];
  return nextChar === undefined || nextChar === "?";
}

export function isUnsignedBodyPath(requestTarget: string): boolean {
  return UNSIGNED_BODY_PATH_PREFIXES.some((prefix) => matchesPathPrefix(requestTarget, prefix));
}

export function hashBody(body: string | Buffer): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

export interface CanonicalStringInput {
  method: string;
  // Path + query, verbatim, byte-for-byte as sent — never normalized or
  // query-sorted (see the phase plan's D3 design notes: the primary
  // controls both sides of this wire, so verbatim is both safer and less
  // code than agreeing on a canonicalization scheme).
  requestTarget: string;
  timestamp: string;
  nonce: string;
  bodyHashed: boolean;
  // "" whenever bodyHashed is false — the actual body content is then not
  // part of what's signed at all, not "signed as empty".
  bodyHash: string;
}

// Versioned so the format can evolve without an ambiguous mid-migration
// window — see the phase plan's D3 design notes.
export function buildCanonicalString(input: CanonicalStringInput): string {
  const bodyMode = input.bodyHashed ? "h" : "n";
  return [
    "v1",
    input.method.toUpperCase(),
    input.requestTarget,
    input.timestamp,
    input.nonce,
    `${bodyMode}:${input.bodyHash}`,
  ].join("\n");
}

export function sign(secret: string, canonicalString: string): string {
  return crypto.createHmac("sha256", secret).update(canonicalString).digest("hex");
}

/** Constant-time compare, same reasoning/shape as crypto-utils.ts's
 * timingSafeTokenMatch — recomputes the expected signature and compares,
 * rather than trusting a caller-provided one. Returns false (not a throw)
 * for a garbage/wrong-length provided signature, same fail-closed shape as
 * every other credential check in this phase. */
export function verify(secret: string, canonicalString: string, provided: string): boolean {
  const expected = sign(secret, canonicalString);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

/** ±DRIFT_WINDOW_MS around `now` — a timestamp too old OR too far in the
 * future is rejected identically (a request "from the future" is exactly as
 * suspicious as a stale replay). Non-numeric/missing input fails closed. */
export function isTimestampFresh(timestamp: string, now: number = Date.now()): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(now - ts) <= DRIFT_WINDOW_MS;
}
