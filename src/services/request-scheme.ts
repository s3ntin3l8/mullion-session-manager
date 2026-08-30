import type { FastifyRequest } from "fastify";

// Traefik terminates TLS and talks plain HTTP to this process internally,
// and this app doesn't enable Fastify's trustProxy option, so
// request.protocol never consults X-Forwarded-Proto on its own and would
// read "http" even in production. Reading the header directly (falling back
// to request.protocol for a deployment with no reverse proxy in front at
// all) is what actually reflects the scheme the *browser* saw.
//
// Only the first hop's value is read — with two proxies in front (e.g. a
// CDN in front of Traefik), Node joins duplicate X-Forwarded-Proto headers
// into a single comma-joined string ("https, http"), and Fastify itself
// passes an array through unchanged if the header appeared as multiple
// wire-level lines — either shape would fail an exact-match, fall back to
// request.protocol's "http", and then break downstream logic that needs the
// real browser-facing scheme.
export function requestScheme(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-proto"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first?.toLowerCase() === "https" ? "https" : request.protocol;
}
