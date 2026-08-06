import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { buildPreviewHostPattern, isPreviewHost } from "../services/preview-host.js";
import { isAuthEnabled, isRequestAuthenticated } from "../services/auth.js";

// request.url includes the query string, and onRequest fires before
// Fastify's own routing/query parsing runs — this is the cheapest correct
// way to get just the pathname for the prefix check below. The
// "http://placeholder" base is discarded immediately, the same throwaway-base
// trick routes/internal.ts's resolveLoopbackPreviewUrl uses.
function requestPathname(url: string): string {
  return new URL(url, "http://placeholder").pathname;
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
// this one.
function isProtectedPath(pathname: string): boolean {
  if (pathname.startsWith("/api/auth/")) return false;
  if (pathname === "/api/internal/register") return false;
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
    if (!isProtectedPath(requestPathname(request.url))) return;
    if (isRequestAuthenticated(request.headers, app.config)) return;
    return reply.unauthorized("authentication required");
  });
});
