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

const DEFAULT_PORT: Record<string, string> = { https: "443", http: "80" };

// Browsers never include a scheme's default port in the Origin header they
// send (e.g. https://host, never https://host:443) — but a Host header
// reaching this process can carry one explicitly (a proxy config that
// forwards Host verbatim including a literal :443/:80, or a client that set
// it that way directly), which would otherwise false-403 an otherwise-valid
// same-origin write (found in Hermes review on this same PR). Stripping the
// default port for the request's own scheme before comparing makes "host"
// and "host:443" (under https) equivalent, matching what a real browser's
// Origin header actually looks like.
function stripDefaultPort(scheme: string, host: string): string {
  const suffix = `:${DEFAULT_PORT[scheme]}`;
  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : host;
}

// The dashboard's own origin, derived from the request that reached it —
// never a hardcoded domain, since this app is deployed under whatever
// hostname the operator points at it (see deploy/README.md). This is safe
// to use as the comparison target because a browser (the CSRF / cross-site
// WebSocket threat) cannot forge its own Host header, so a foreign page's
// Origin can never equal the Host the browser sends to the dashboard. Shared
// by plugins/auth.ts's cookie-authenticated check and its gateway-mode
// (auth-disabled) check.
export function requestOrigin(request: FastifyRequest): string {
  const scheme = requestScheme(request);
  const host = stripDefaultPort(scheme, request.headers.host ?? "");
  return `${scheme}://${host}`;
}
