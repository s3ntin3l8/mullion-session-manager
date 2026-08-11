import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { buildPreviewHostPattern, isPreviewHost } from "../services/preview-host.js";
import { CONTROL_SOCKET_ADDR } from "../services/control-socket-addr.js";

export const securityPlugin = fp(async (app: FastifyInstance) => {
  const previewBaseHost = app.config.PREVIEW_BASE_HOST.trim();
  const previewHostPattern =
    previewBaseHost !== "" ? buildPreviewHostPattern(previewBaseHost) : null;

  // Security headers (CSP, HSTS, etc.).
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        // Helmet's default directives include upgrade-insecure-requests,
        // which tells the browser to silently rewrite every same-origin
        // http:// subresource request to https:// — including behind a
        // reverse proxy (Traefik) that terminates TLS and talks plain HTTP
        // to this app internally, which is exactly this app's deployment
        // model (see the plan). With it on, every asset request 404s/503s
        // against a port that never speaks TLS; this cost real time to
        // diagnose (looked identical to a blank/broken terminal). Disabled
        // by setting the directive to null, helmet's documented way to
        // drop a default directive.
        upgradeInsecureRequests: null,
        // Helmet's defaults set no frame-src at all, so it falls back to
        // default-src 'self' — which blocks the dashboard's own pages from
        // embedding a preview pane's <iframe> at all. Two modes, matching
        // BrowserPanel.tsx's own previewsEnabled branch:
        //  - PREVIEW_BASE_HOST set: only that subdomain may be framed —
        //    "preview-<slug>.PREVIEW_BASE_HOST", a *different* origin (issue
        //    #28's whole reason for existing: a same-origin subdomain proxy,
        //    not a same-origin path, is what lets the target see "/" as its
        //    own root — see the plan). Both schemes are listed since local
        //    dev runs plain http while production terminates TLS at Traefik.
        //  - PREVIEW_BASE_HOST unset: the preview feature has no working
        //    subdomain to proxy through (see routes/previews.ts's own opt-in
        //    gate), so the browser pane embeds the target URL directly
        //    instead — any origin may be framed. This governs only what the
        //    dashboard's own pages may *embed*, not who may embed the
        //    dashboard (that's frame-ancestors, untouched here), so it isn't
        //    a same-origin exposure — just the minimal allowance any
        //    direct-embed browser pane needs.
        frameSrc:
          previewBaseHost !== ""
            ? ["'self'", `http://*.${previewBaseHost}`, `https://*.${previewBaseHost}`]
            : ["'self'", "http:", "https:"],
      },
    },
  });

  // Basic abuse protection. Tune via RATE_LIMIT_MAX / RATE_LIMIT_WINDOW.
  //
  // B5 (audit remediation plan) — no keyGenerator override, so this (and
  // every per-route limiter built on top of it, e.g. routes/auth.ts's
  // LOGIN_RATE_LIMIT) keys on Fastify's default `request.ip`, which —
  // because `trustProxy` is off app-wide (see docs/auth.md, and
  // control-socket-addr.ts/raw-remote-address.ts's own comments on why) —
  // is always the raw TCP peer address, never an XFF-derived one. Behind a
  // reverse proxy (Traefik, per deploy/README.md) that peer is the proxy
  // itself, so every request from every real client shares one bucket —
  // the login limiter throttles the whole deployment rather than one
  // attacker. Decided NOT to fix this with a trusted-header keyGenerator
  // (e.g. reading X-Real-Ip): Traefik does not overwrite a client-supplied
  // X-Real-Ip/X-Forwarded-For by default — that requires the entrypoint's
  // own `forwardedHeaders.trustedIPs`, which this repo's
  // deploy/traefik-dynamic.yml template does not set up — and docs/auth.md
  // explicitly supports a bare, gateway-less deployment too. Trusting an
  // unverified header in either of those cases would let any direct client
  // forge a fresh bucket per request, which is strictly worse than today's
  // global bucketing (an attacker could evade the login limiter entirely
  // instead of merely sharing its ceiling with everyone else). Accepted as
  // a real, documented trade-off (docs/auth.md's "Current limitations")
  // rather than a silent gap — revisit if this app ever requires a
  // mandatory, pre-verified gateway hop (at which point a narrowly-scoped,
  // rate-limit-only keyGenerator reading that gateway's header would be
  // safe to add, distinct from flipping `trustProxy` app-wide, which the
  // CSRF Origin check, the control-socket allowlist above, and
  // raw-remote-address.ts's other call sites all depend on staying off).
  // test/plugins/security.test.ts pins the current behavior so a future
  // trustProxy flip (or an unreviewed keyGenerator addition) can't change
  // it silently.
  await app.register(rateLimit, {
    max: app.config.RATE_LIMIT_MAX,
    timeWindow: app.config.RATE_LIMIT_WINDOW,
    // A single preview page load fans out into dozens of subresource
    // requests (issue #28) — the app-wide default (100/min) would 429
    // partway through the very first paint. This plugin's own onRequest
    // hook (registered before preview-proxy.ts's, since securityPlugin
    // registers first) would otherwise count and gate every one of them,
    // regardless of what preview-proxy.ts does downstream — allowList is
    // rate-limit's own supported way to exempt requests by predicate,
    // checked from inside its hook, so registration order doesn't matter.
    //
    // Also exempts control-socket.ts's own app.inject() re-entry (Phase 4,
    // #185) — every socket op dispatches through this same rate-limited
    // pipeline, tagged with CONTROL_SOCKET_ADDR as its remoteAddress, so a
    // `mullion ps` polling loop doesn't 429 the same way a hostile HTTP
    // client would. Unconditional (not gated behind previewHostPattern like
    // the preview check above): this predicate must always run, since
    // control-socket.ts registers after this plugin and so has no way to
    // extend an `undefined` allowList itself.
    //
    // Checked against request.raw.socket.remoteAddress, deliberately NOT
    // request.ip: `.ip` is XFF-derived the moment a future PR enables
    // Fastify's trustProxy (plausible — this app deploys behind Traefik,
    // per CLAUDE.md), at which point any external client could send
    // `X-Forwarded-For: mullion-control-socket` and forge this exemption.
    // The raw socket's remoteAddress is what light-my-request's own
    // `remoteAddress` inject option sets (see control-socket.ts's
    // injectRoute) and is never influenced by trustProxy/XFF parsing either
    // way, so this check stays correct regardless of that future config.
    allowList: (request) =>
      request.raw.socket.remoteAddress === CONTROL_SOCKET_ADDR ||
      (previewHostPattern !== null && isPreviewHost(request.headers.host, previewHostPattern)),
  });

  // CORS is disabled by default. Set CORS_ORIGIN to a comma-separated allowlist
  // (e.g. "https://app.example.com,https://admin.example.com") to enable it.
  const allowlist = app.config.CORS_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  await app.register(cors, {
    origin: allowlist.length > 0 ? allowlist : false,
  });
});
