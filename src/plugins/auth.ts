import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { buildPreviewHostPattern, isPreviewHost } from "../services/preview-host.js";
import { hasValidBearerToken, hasValidSessionCookie, isAuthEnabled } from "../services/auth.js";

// request.url includes the query string, and onRequest fires before
// Fastify's own routing/query parsing runs — this is the cheapest correct
// way to get just the pathname for the prefix check below. The
// "http://placeholder" base is discarded immediately, the same throwaway-base
// trick routes/internal.ts's resolveLoopbackPreviewUrl uses.
function requestPathname(url: string): string {
  return new URL(url, "http://placeholder").pathname;
}

// Same scheme-detection reasoning as preview-proxy.ts's isHttpsRequest:
// Traefik terminates TLS and talks plain HTTP to this process internally,
// and this app doesn't enable Fastify's trustProxy option, so
// request.protocol never consults X-Forwarded-Proto on its own and would
// read "http" even in production. Reading the header directly (falling back
// to request.protocol for a deployment with no reverse proxy in front at
// all) is what actually reflects the scheme the *browser* saw — exactly
// what a same-origin comparison against the browser-supplied Origin header
// needs.
//
// Unlike isHttpsRequest's own `=== "https"` exact-match (safe there — a
// misread there only downgrades a cookie to a weaker but still-working
// sameSite), an exact-match here is unsafe: with two proxies in front
// (e.g. a CDN in front of Traefik), Node joins duplicate X-Forwarded-Proto
// headers into a single comma-joined string ("https, http"), and Fastify
// itself passes an array through unchanged if the header appeared as
// multiple wire-level lines — either shape would fail `=== "https"`,
// fall back to request.protocol's "http", and then reject every
// cookie-authenticated write with a 403 (a full write outage, not just a
// weaker check) — so only the first hop's value is read here, same as how
// a trustProxy-enabled Fastify itself would only trust the outermost.
function requestScheme(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-proto"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first === "https" ? "https" : request.protocol;
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
// to use as the comparison target specifically *because* it's paired with
// hasValidSessionCookie: an attacker can send any Host header they like, but
// that only changes what origin *this* request is compared against, not
// what cookie the browser attaches — a forged Host couldn't make a foreign
// Origin match unless the attacker already controls the session cookie too.
function requestOrigin(request: FastifyRequest): string {
  const scheme = requestScheme(request);
  const host = stripDefaultPort(scheme, request.headers.host ?? "");
  return `${scheme}://${host}`;
}

// True for exactly the surface issue #19 asks to gate: every /api/* route
// (except /api/auth/* itself — the login/me/logout endpoints obviously
// can't require a session to reach them) and the /ws/terminal upgrade.
// Static assets, "/", and "/health"/"/ready" stay reachable unauthenticated:
// the SPA shell (including its own login view) has to load before it can
// even call GET /api/auth/me, and health checks are infrastructure, not
// product surface.
//
// /api/internal/register (issue #245 / roadmap 7.1) is exempted the same
// way: an agent registering itself has no session cookie and can't get
// one — it authenticates via its own bootstrap/session credential, checked
// by routes/enrollment.ts itself, not this hook. Same class of exemption
// as /api/auth/* — a route that's its own auth boundary, not a hole in
// this one. /api/internal/deregister (issue #248 / roadmap 7.3) is the same
// shape: an agent calling it as it shuts down has no session cookie either,
// and it's gated by its own session-credential check in
// routes/enrollment.ts.
//
// /api/webhooks/github (issue #523) is the same class again: GitHub signs
// each delivery with HMAC-SHA256 over the raw body (webhooks.ts's own
// verifySignature) and cannot send a session cookie or a bearer header, so
// gating it here 401'd every delivery before that signature check ever ran.
// Exempting it opens nothing new — the handler's own ladder already 401s on
// a missing secret, a missing signature, and a bad signature
// (webhooks.ts:62-76) — and it never uses session auth as a trust mechanism
// in the first place. Exact-match, not a startsWith prefix: webhook
// *management* lives under the separate /api/integrations/github/webhooks*
// namespace (routes/integrations.ts) and stays session-gated; a prefix here
// would silently exempt any future route dropped into /api/webhooks/*.
//
// The /api/auth/* exemption below (AS8) is the same exact-match set for the
// same reason — the neighboring webhook check above already draws the
// contrast. This used to be a `pathname.startsWith("/api/auth/")` prefix
// match, the identical shape that comment warns against: every route
// registered under routes/auth.ts today is listed explicitly, so a future
// route dropped into /api/auth/* (e.g. a hypothetical /api/auth/sessions)
// is PROTECTED by default and requires a deliberate addition here to open
// it up, rather than being silently unauthenticated the day it's added with
// no reviewer signal. Keep this set in sync with routes/auth.ts.
const UNPROTECTED_AUTH_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/auth/oidc/login",
  "/api/auth/oidc/callback",
]);

function isProtectedPath(pathname: string): boolean {
  if (UNPROTECTED_AUTH_PATHS.has(pathname)) return false;
  if (pathname === "/api/internal/register") return false;
  if (pathname === "/api/internal/deregister") return false;
  if (pathname === "/api/webhooks/github") return false;
  if (pathname.startsWith("/api/")) return true;
  return pathname.startsWith("/ws/");
}

/**
 * Optional in-process auth for the primary role (issue #19) — a single
 * shared token, checked via a global onRequest hook that also covers the
 * /ws/terminal upgrade (onRequest fires before that upgrade completes, the
 * same guarantee routes/internal.ts's own token gate and terminal.ts's own
 * preValidation hook rely on). Registered after dbPlugin, before
 * previewProxyPlugin (see src/app.ts's comment at that call site) — that
 * ordering is what lets this hook run, and potentially reject, before
 * previewProxyPlugin's own onRequest hook gets a chance to proxy a
 * preview-host HTTP request.
 *
 * Deliberately does NOT gate the preview-host surface itself (a Host header
 * matching PREVIEW_BASE_HOST): a Lax, host-only session cookie cannot reach
 * a cross-subdomain preview iframe (SameSite=Lax excludes cross-site
 * subresource loads, and a host-only cookie is never sent to a different
 * subdomain regardless of SameSite), and a browser <iframe> can't attach a
 * Bearer header either — gating that surface with this mechanism would
 * silently 401 every browser preview the moment auth is enabled, a
 * regression hiding behind a config flag. Preview hosts stay exactly as
 * protected as they are today: by whatever gateway forwardAuth the operator
 * has in front (deploy/README.md already calls out that the preview router
 * needs the same middleware as the main one — this isn't a new gap, just an
 * unclosed one). A real fix — a short-lived, dashboard-minted preview-access
 * token appended to the iframe URL, validated by preview-proxy.ts itself —
 * is a follow-up, not this PR.
 *
 * The bypass below is host-only — see isPreviewBypass. That is only safe
 * because previewProxyPlugin's own onRequest hook now consumes *every*
 * method for a matching Host, and always terminates the request itself
 * (proxied, or an explicit 404/502/503) rather than ever falling through to
 * Fastify's own routing. `request.headers.host` is attacker-controlled (any
 * client can send an arbitrary Host header), so the invariant this bypass
 * depends on is: isPreviewBypass's own Host predicate must never recognize a
 * request that previewProxyPlugin wouldn't also fully consume — see
 * preview-host.ts's isPreviewHost, which is the exact same predicate both
 * plugins use, so that holds by construction. (Before previewProxyPlugin
 * proxied non-GET/HEAD too, this bypass had to mirror that method gate
 * exactly, or a spoofed `Host: preview-x.<PREVIEW_BASE_HOST>` on a write
 * would have fallen through this hook straight into the real /api/* handler
 * with no credential check at all. See test/plugins/auth.test.ts's non-GET
 * preview-host case for the regression test.)
 *
 * CSRF (security audit finding AS1): the session cookie is `sameSite: "lax"`
 * (routes/auth.ts), and a previewed page shares a registrable domain with
 * the dashboard (preview-proxy.ts), making it a same-site context — Lax
 * still attaches the cookie to a same-site, no-body, credentialed
 * `fetch(..., {method:"POST"})`. That's enough for a previewed untrusted
 * page to drive any cookie-gated write with no header a browser lets
 * script forge. The mitigation below rejects a cookie-authenticated
 * non-GET/HEAD request whenever it carries an Origin header that doesn't
 * match the dashboard's own origin (derived per-request — see
 * requestOrigin above — never hardcoded, since this app deploys under
 * whatever hostname the operator points at it). GET/HEAD are exempt (they
 * shouldn't mutate state, and this keeps navigations/links working);
 * Bearer-token requests are exempt entirely (that credential can never be
 * attached by a page the browser didn't run same-origin script in — a
 * cross-origin script can't read or set an Authorization header without a
 * preflight, which a hostile page can't get past for these routes). A
 * request with no Origin header at all (most non-browser clients: curl,
 * server-to-server, and some legitimate same-origin navigations) is left
 * alone — the absence of the header is not itself evidence of an attack,
 * and browsers reliably send Origin on the fetch/XHR/form-POST shapes this
 * finding is actually about.
 *
 * The GET/HEAD exemption does NOT extend to a `/ws/*` upgrade, even though
 * the upgrade request's HTTP method is GET (found in review on this same
 * PR): a WebSocket handshake isn't subject to the Same-Origin Policy or a
 * CORS preflight the way fetch/XHR/navigation are, so a same-site previewed
 * page can open `new WebSocket("wss://<dashboard>/ws/terminal?...")`
 * directly — no forgeable header required — and the Lax session cookie
 * still attaches (same-site, not cross-site). For `/ws/terminal`
 * specifically that hands the page a live, interactive PTY: strictly worse
 * than the POST routes this check already closes. Browsers reliably send
 * Origin on a WS handshake (unlike a bare top-level GET navigation, where
 * it's frequently absent), so gating every `/ws/*` upgrade the same way as
 * a non-GET write — regardless of method — closes this without risking a
 * legitimate same-origin terminal connection.
 *
 * Scope note: this check runs only for isProtectedPath's gated surface, so
 * the same /api/auth/* exemption documented above (login/me/logout, plus
 * /api/internal/* and /api/webhooks/github) applies here too — including
 * POST /api/auth/logout, which AS1's own writeup calls out by name as a
 * CSRF-able no-body POST. That's intentional, not an oversight: this route
 * has no session state to protect yet by the time this hook would need to
 * decide whether to reject it (it's reachable specifically so a request can
 * log itself out even with a stale/foreign session), and AS9 (routes/auth.ts)
 * caps the resulting nuisance — a same-site page repeatedly forcing a
 * logout — with a dedicated rate limit instead. A forced logout has no
 * capability an attacker can extract from it, unlike the state-changing
 * writes (task claim/approve, host actions, ...) this check exists to stop.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  // Registered purely for reply.setCookie()/clearCookie() serialization
  // convenience in routes/auth.ts — signing itself is done by hand via
  // services/auth.ts's createSessionCookieValue (@fastify/cookie's own
  // `secret` option / signed:true path is unused, to keep exactly one
  // signing mechanism in play).
  await app.register(fastifyCookie);

  if (!isAuthEnabled(app.config)) {
    app.log.warn(
      "no in-app auth configured (MULLION_AUTH_TOKEN unset) — relying entirely on " +
        "the network/reverse-proxy gateway for access control; see issue #19 and " +
        "deploy/README.md",
    );
    return;
  }

  const previewBaseHost = app.config.PREVIEW_BASE_HOST.trim();
  const previewHostPattern =
    previewBaseHost !== "" ? buildPreviewHostPattern(previewBaseHost) : null;

  // Host-only, deliberately: previewProxyPlugin's own onRequest hook now
  // consumes every method for a matching Host, so nothing this bypass lets
  // through can reach a real /api/* handler uncredentialed — see this
  // plugin's own doc comment above for the full invariant.
  function isPreviewBypass(request: { headers: { host?: string } }): boolean {
    if (!previewHostPattern) return false;
    return isPreviewHost(request.headers.host, previewHostPattern);
  }

  // CodeQL (js/missing-rate-limiting) flags this hook: it performs an
  // authorization check with no rate-limit decorator of its own. Reviewed —
  // not applicable here, and not fixable the way routes/auth.ts's login/me
  // routes were (a literal per-route `config: { rateLimit }`, which CodeQL
  // does recognize): this hook runs for *every* protected request, not one
  // specific "check a shared secret" endpoint, and it's already behind the
  // app-wide limiter securityPlugin registers earlier in src/app.ts (that
  // plugin's own onRequest hook counts and gates every request, including
  // the ones that reach this one, before this hook ever runs). Adding a
  // second, stricter limiter *here* wouldn't add brute-force protection —
  // the actual credential check is POST /api/auth/login, already rate-
  // limited directly — it would just throttle every authenticated user's
  // normal API traffic a second time.
  app.addHook("onRequest", async (request, reply) => {
    if (isPreviewBypass(request)) return;
    const pathname = requestPathname(request.url);
    if (!isProtectedPath(pathname)) return;

    // Checked separately, not via isRequestAuthenticated's single boolean,
    // because the CSRF gate below applies only when the cookie is what
    // authenticated this request — see this plugin's own doc comment
    // (finding AS1) for why a Bearer-token caller is exempt.
    const cookieAuthenticated = hasValidSessionCookie(
      app.config.MULLION_SESSION_SECRET,
      request.headers.cookie,
    );
    const authenticated =
      cookieAuthenticated ||
      hasValidBearerToken(request.headers.authorization, app.config.MULLION_AUTH_TOKEN);
    if (!authenticated) return reply.unauthorized("authentication required");

    // A WS upgrade is a GET on the wire but isn't subject to the GET/HEAD
    // "can't mutate state" reasoning below — see this plugin's own doc
    // comment (finding AS1) for why every /ws/* upgrade is gated here
    // regardless of method, using the same isProtectedPath prefix rather
    // than a one-off route check so any future /ws/* route inherits it too.
    const isWebSocketUpgrade = pathname.startsWith("/ws/");
    const requiresOriginCheck =
      isWebSocketUpgrade || (request.method !== "GET" && request.method !== "HEAD");
    if (cookieAuthenticated && requiresOriginCheck) {
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== requestOrigin(request)) {
        return reply.forbidden("cross-origin request rejected");
      }
    }
  });
});
