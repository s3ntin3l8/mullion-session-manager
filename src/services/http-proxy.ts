import type { FastifyRequest, FastifyReply } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

// Shared by both hops of a preview proxy request (issue #28): the primary's
// own preview-proxy.ts (browser -> dev server, or browser -> owning agent)
// and the agent's own internal.ts (agent -> its own loopback dev server,
// issue #28 phase 6). Header/body plumbing is identical at both hops — only
// where the fetch() actually goes differs.

// Hop-by-hop headers per RFC 7230 §6.1, plus "host" (which must become the
// *upstream's* host — see buildUpstreamRequestHeaders — or dev servers with
// a Host allowlist, e.g. Vite's `server.allowedHosts`, 403 every request
// since the browser sent "preview-<slug>.<baseHost>") and "content-length"
// (recomputed per hop by whichever framing buildUpstreamRequestBody chooses
// — forwarding the browser's own value alongside a streamed/re-framed body
// would describe bytes we're not sending).
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "expect",
]);

// Headers a reverse proxy in front of us (Traefik) sets to tell an upstream
// what the original request looked like — e.g. "x-forwarded-host:
// preview-<slug>.<baseHost>". Forwarding these defeats the "host" rewrite
// above: frameworks that build absolute URLs or validate the request's
// origin (Next.js/Auth.js's `trustHost`, next-intl's own redirect() naming
// just two) prefer x-forwarded-host over host, so a surviving one steers
// them right back at the public preview hostname the dev server doesn't
// recognize — this was the actual cause of a "Misdirected Request" 421 from
// an app whose own Host guard explicitly depends on us not doing this. A
// prefix test rather than a fixed list, so it also covers Traefik
// ForwardAuth's x-forwarded-uri/-method/-prefix. Also covers x-real-ip,
// nginx's older equivalent of x-forwarded-for. Stripping (not rewriting to
// the upstream's own address) is deliberate: it lets the framework fall
// back to the already-correct "host" header instead of us having to predict
// every header a given dev server might prefer, and it's the strictly safer
// choice for a bare loopback dev server that never expected to sit behind
// any proxy at all — X-Forwarded-* reaching its code unfiltered otherwise.
function isForwardedRequestHeader(name: string): boolean {
  return name.startsWith("x-forwarded-") || name === "forwarded" || name === "x-real-ip";
}

/**
 * Builds the outgoing request headers for one proxy hop: copies everything
 * except the hop-by-hop set above, any forwarded-address header (x-real-ip,
 * "forwarded", or anything prefixed "x-forwarded-"), and `extraExcluded`
 * (case-insensitive) — then forces "host" to
 * `upstreamHost`. `extraExcluded` exists for a hop whose target this process
 * doesn't control and mustn't see a credential the caller attached to reach
 * *this* hop: the agent's own onward hop to its loopback dev server strips
 * the `authorization` bearer token it was just authenticated with (see
 * internal.ts), and the primary's own preview-proxy hop (finding AS4) does
 * the same for a `kind: "external"`/local-project preview target, which can
 * be attacker-chosen — see preview-proxy.ts's own
 * PREVIEW_UPSTREAM_EXCLUDED_HEADERS and stripPreviewAuthCookie (the latter
 * handles the `mullion_preview` cookie, which isn't a whole header this
 * function's own exclusion mechanism can strip).
 */
export function buildUpstreamRequestHeaders(
  request: FastifyRequest,
  upstreamHost: string,
  extraExcluded: string[] = [],
): Headers {
  const extraExcludedLower = new Set(extraExcluded.map((h) => h.toLowerCase()));
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_REQUEST_HEADERS.has(lower) ||
      isForwardedRequestHeader(lower) ||
      extraExcludedLower.has(lower)
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  headers.set("host", upstreamHost);
  return headers;
}

/**
 * Builds the { body, duplex } to spread into a fetch() init for one proxy
 * hop, from the raw (not-yet-parsed) request stream. GET/HEAD never carry a
 * body onward — fetch() throws if given one — and a request with neither
 * "content-length" nor "transfer-encoding" is itself declaring it has no
 * body, so turning it into a chunked request would be inventing framing the
 * client never sent (a bodyless DELETE/OPTIONS is the realistic case).
 * `duplex: "half"` is Node's own requirement for a streamed fetch() body —
 * see https://github.com/nodejs/node/issues/46221. Callers must pass the
 * *raw*, unparsed request stream: both proxy hops read it before Fastify's
 * own body parsing ever runs (the primary's onRequest hook fires before
 * preParsing; the agent's own route registers a pass-through content-type
 * parser — see preview-proxy.ts / internal.ts for why each is safe).
 */
export function buildUpstreamRequestBody(
  method: string,
  headers: IncomingHttpHeaders,
  raw: Readable,
): { body?: ReadableStream<Uint8Array>; duplex?: "half" } {
  if (method === "GET" || method === "HEAD") return {};
  if (headers["content-length"] === undefined && headers["transfer-encoding"] === undefined) {
    return {};
  }
  return { body: Readable.toWeb(raw) as ReadableStream<Uint8Array>, duplex: "half" };
}

// Headers that would either defeat this whole feature (the target's own
// X-Frame-Options/CSP would block the dashboard from framing it) or are
// simply wrong once re-served through fetch()/Fastify rather than passed
// through a raw socket: fetch() already transparently decompressed the
// body, so forwarding the upstream's own content-encoding/content-length
// would describe bytes we're no longer sending; Fastify recomputes
// framing/length headers itself once the response is actually sent. Applies
// at both hops — an agent's own reply to the primary needs the same
// stripping for the same reasons (its own fetch() to the loopback dev
// server already decompressed the body too), and stripping x-frame-options/
// CSP twice is harmless.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * Rewrites an upstream "Location" header into a browser-usable form when it
 * names the dev server's own loopback address — e.g.
 * "http://127.0.0.1:5173/en" — which a browser inside an HTTPS preview
 * iframe can neither follow (mixed content) nor should (it's the viewer's
 * own machine, not the dev server's). `upstreamBase` must be the upstream
 * *base* exactly as resolveUpstreamBase returned it (origin + optional
 * base-path prefix for a devServerUrl like "http://host:5173/sub") — never
 * a per-request URL, since the base path has to be stripped the same way
 * buildUpstreamUrl added it.
 *
 * Left untouched: anything unparseable or already relative (a same-origin
 * navigation needs no rewriting), anything on a different origin (a
 * genuinely external redirect), and anything same-origin but outside
 * upstreamBase's own path prefix (no correct browser-space mapping exists
 * for that case — leaving it absolute is safer than guessing).
 */
export function relativizeUpstreamLocation(location: string, upstreamBase: URL): string {
  const parsed = URL.parse(location);
  if (parsed === null) return location;
  if (parsed.origin !== upstreamBase.origin) return location;

  const prefix = upstreamBase.pathname.endsWith("/")
    ? upstreamBase.pathname
    : `${upstreamBase.pathname}/`;
  let pathname = parsed.pathname;
  if (prefix !== "/") {
    if (pathname === prefix.slice(0, -1)) {
      pathname = "/";
    } else if (pathname.startsWith(prefix)) {
      pathname = pathname.slice(prefix.length - 1);
    } else {
      return location;
    }
  }
  return pathname + parsed.search + parsed.hash;
}

/**
 * Relays a fetch() Response onto a Fastify reply: status, headers (minus
 * the stripped set above, grouped by name so a multi-value header —
 * Set-Cookie is the realistic case — round-trips as every value rather than
 * only the last one reply.header() would otherwise overwrite with), and
 * body (streamed, not buffered). `upstreamBase` drives whether a same-origin
 * "location" header gets relativized — see relativizeUpstreamLocation.
 * Required rather than optional so every call site (present and future)
 * makes the decision explicitly; pass `null` when this hop cannot correctly
 * make that call (see internal.ts's own comment on why the agent's hop
 * never does).
 */
export function relayFetchResponse(
  reply: FastifyReply,
  method: string,
  upstreamResponse: Response,
  upstreamBase: URL | null,
) {
  reply.code(upstreamResponse.status);

  // Explicit removal, not just "don't copy the upstream's own value": if
  // this hop runs behind helmet's own onRequest hook (the primary's own
  // registration order), helmet has already staged its own
  // x-frame-options/CSP on this reply by the time this runs. `reply.raw`
  // (Node's own ServerResponse), not just `reply`, needs clearing too:
  // @fastify/helmet sets its headers by calling the `helmet` npm package's
  // middleware directly against `reply.raw`, bypassing Fastify's
  // `reply.header()` API — and `reply.removeHeader()` only clears
  // Fastify's own internal header map, never `reply.raw`'s.
  for (const name of STRIPPED_RESPONSE_HEADERS) {
    reply.removeHeader(name);
    if (reply.raw.hasHeader(name)) reply.raw.removeHeader(name);
  }

  const headersToSend = new Map<string, string[]>();
  for (const [key, value] of upstreamResponse.headers) {
    const lower = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    const existing = headersToSend.get(lower);
    if (existing) existing.push(value);
    else headersToSend.set(lower, [value]);
  }

  // Only rewritten when a single "location" value round-tripped above — a
  // duplicate/comma-joined Location (Headers already merges multi-value
  // headers on iteration) isn't a valid redirect target either way, so
  // leaving it as-is degrades to a no-op rather than mangling it further.
  if (upstreamBase !== null) {
    const location = headersToSend.get("location");
    if (location?.length === 1) {
      location[0] = relativizeUpstreamLocation(location[0], upstreamBase);
    }
  }

  for (const [key, values] of headersToSend) {
    reply.header(key, values.length === 1 ? values[0] : values);
  }

  if (method === "HEAD" || upstreamResponse.body === null) {
    return reply.send();
  }
  return reply.send(Readable.fromWeb(upstreamResponse.body));
}
