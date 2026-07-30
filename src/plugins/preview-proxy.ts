import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { CookieSerializeOptions } from "@fastify/cookie";
import { eq } from "drizzle-orm";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { projects } from "../db/schema.js";
import { getPreviewBySlug } from "../services/preview-registry.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { buildPreviewHostPattern, extractPreviewSlug } from "../services/preview-host.js";
import {
  buildUpstreamRequestBody,
  buildUpstreamRequestHeaders,
  relayFetchResponse,
} from "../services/http-proxy.js";
import { pipeWsFrames, toWsUrl } from "../services/ws-pipe.js";
import {
  PREVIEW_COOKIE_MAX_AGE_SECONDS,
  PREVIEW_COOKIE_NAME,
  PREVIEW_TOKEN_QUERY_PARAM,
  mintPreviewCookie,
  verifyPreviewCookie,
  verifyPreviewToken,
} from "../services/preview-auth.js";

// The two things a resolved preview can point at (see resolvePreviewTarget
// below) — either a project's dev server (local, or remote via its owning
// agent — issue #28 phase 6) or an arbitrary external URL (issue #28 phase
// 5, SSRF-guarded at creation time in src/routes/previews.ts, not
// re-validated here — see url-guard.ts's own comment on the DNS-rebind gap
// this doesn't close). All resolve to a base URL via resolveUpstreamBase
// and proxy identically from that point on — subdomain-based previews
// don't rewrite paths, so "a project's dev server" and "an external site"
// are just two ways to obtain that base.
type PreviewTarget =
  | { kind: "project"; devServerUrl: string; projectId: number; hostId: string }
  | { kind: "external"; url: string };

function resolveUpstreamBase(target: PreviewTarget): URL {
  if (target.kind === "external") return new URL(target.url);
  // A bare port ("5173") means "this same machine" — see projects.ts's
  // isValidDevServerUrl. A full URL's host (and path — see
  // buildUpstreamUrl below) is honored as-is for a *local* project (this
  // process trusts itself, same admin-trust level as hosts.ts's own
  // baseUrl). For a *remote*-hosted project (hostId !== LOCAL_HOST_ID),
  // only this URL's port and path are ever used (see
  // isRemoteProjectTarget's callers below) — its host, if any, is
  // discarded, since the owning agent forces the actual connection to its
  // own loopback (issue #28 phase 6, and projects.ts's own
  // isValidDevServerUrl comment). This function itself stays host-agnostic
  // either way — it just parses whatever devServerUrl names.
  if (/^\d{1,5}$/.test(target.devServerUrl)) {
    return new URL(`http://127.0.0.1:${target.devServerUrl}/`);
  }
  return new URL(target.devServerUrl);
}

function isRemoteProjectTarget(
  target: PreviewTarget,
): target is Extract<PreviewTarget, { kind: "project" }> {
  return target.kind === "project" && target.hostId !== LOCAL_HOST_ID;
}

// A URL's `.port` is "" when the URL has no explicit port (protocol
// default) — Number("") is 0, not a usable port, so this can't just be
// `Number(url.port)`.
function portFromUrl(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

// `new URL(requestPath, base)` alone is NOT enough to honor a `devServerUrl`
// with its own base path (e.g. "http://host:5173/app/"): requestPath is
// always an *absolute* path (leading "/", straight from the browser), and
// per the URL/RFC 3986 resolution algorithm an absolute-path reference
// replaces the base's entire path rather than appending to it — so
// resolving "/asset.js" against "http://host:5173/app/" yields
// "http://host:5173/asset.js", silently dropping "/app" (caught in review
// on PR #44). Prepending the base's own pathname manually — a no-op for
// the common case where devServerUrl has no path at all — fixes this.
//
// `stripPreviewToken`, when true (only when PREVIEW_AUTH_REQUIRED is on —
// see the plugin registration below), removes PREVIEW_TOKEN_QUERY_PARAM from
// the query string before it's forwarded upstream, so the bootstrap token
// never leaks to the dev server itself, its access logs, or any outbound
// Referer header it sends. Guarded by a substring check first — most
// requests never carry the param at all, and re-serializing the whole query
// string via URLSearchParams unconditionally would risk subtly re-encoding
// unrelated params (e.g. "+" vs "%20"), which would break the "gate off ->
// byte-identical to today" invariant this plugin otherwise preserves.
function stripPreviewTokenParam(search: string): string {
  if (!search || !search.includes(PREVIEW_TOKEN_QUERY_PARAM)) return search;
  const params = new URLSearchParams(search);
  if (!params.has(PREVIEW_TOKEN_QUERY_PARAM)) return search;
  params.delete(PREVIEW_TOKEN_QUERY_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

function buildUpstreamUrl(base: URL, requestUrl: string, stripPreviewToken = false): URL {
  const incoming = new URL(requestUrl, "http://placeholder");
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const suffix = incoming.pathname.startsWith("/") ? incoming.pathname.slice(1) : incoming.pathname;
  const search = stripPreviewToken ? stripPreviewTokenParam(incoming.search) : incoming.search;
  return new URL(prefix + suffix + search, base.origin);
}

// Shared by both the HTTP handler (handlePreviewRequest) and the WS upgrade
// handler (handlePreviewWsUpgrade) below — slug -> preview -> target
// resolution and its error cases are identical for both transports, only
// what happens with a *resolved* target differs (fetch() vs. opening a
// `ws` connection).
type PreviewResolution =
  { ok: true; target: PreviewTarget } | { ok: false; status: 404 | 503; message?: string };

function resolvePreviewTarget(app: FastifyInstance, slug: string): PreviewResolution {
  const preview = getPreviewBySlug(app, slug);
  if (!preview) return { ok: false, status: 404, message: `Unknown preview ${slug}` };

  if (preview.kind === "external") {
    if (!preview.externalUrl) return { ok: false, status: 404 };
    return { ok: true, target: { kind: "external", url: preview.externalUrl } };
  }

  if (preview.projectId === null) return { ok: false, status: 404 };
  const [project] = app.db.select().from(projects).where(eq(projects.id, preview.projectId)).all();
  if (!project) return { ok: false, status: 404 };
  if (!project.devServerUrl) {
    return {
      ok: false,
      status: 503,
      message: `project ${project.id} has no devServerUrl configured`,
    };
  }
  return {
    ok: true,
    target: {
      kind: "project",
      devServerUrl: project.devServerUrl,
      projectId: project.id,
      hostId: project.hostId,
    },
  };
}

async function handlePreviewRequest(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string,
) {
  const resolution = resolvePreviewTarget(app, slug);
  if (!resolution.ok) {
    return resolution.status === 404
      ? reply.notFound(resolution.message)
      : reply.serviceUnavailable(resolution.message);
  }

  let upstreamBase: URL;
  let upstreamUrl: URL;
  try {
    upstreamBase = resolveUpstreamBase(resolution.target);
    upstreamUrl = buildUpstreamUrl(
      upstreamBase,
      request.raw.url ?? "/",
      app.config.PREVIEW_AUTH_REQUIRED,
    );
  } catch {
    return reply.serviceUnavailable(`preview ${slug} has an invalid target URL`);
  }

  const target = resolution.target;
  const body = buildUpstreamRequestBody(request.method, request.headers, request.raw);

  // For a remote-hosted project, only the port and path/query resolved
  // above are ever used — the owning agent forces the actual connection to
  // its own loopback (see resolveUpstreamBase's comment and internal.ts's
  // loopback assertion), so the Host header sent onward must reflect that
  // loopback address too, not whatever host a full-URL devServerUrl named,
  // and the fetch itself goes through the agent's own /internal/preview*
  // API rather than directly.
  if (isRemoteProjectTarget(target)) {
    const headers = buildUpstreamRequestHeaders(request, `127.0.0.1:${portFromUrl(upstreamUrl)}`);
    let upstreamResponse: Response;
    try {
      upstreamResponse = await getRemoteHostClient(app, target.hostId).openPreviewHttp(
        portFromUrl(upstreamUrl),
        upstreamUrl.pathname + upstreamUrl.search,
        { method: request.method, headers, ...body },
      );
    } catch (err) {
      request.raw.resume();
      app.log.warn({ err, slug, hostId: target.hostId }, "preview proxy: upstream unreachable");
      return reply.badGateway(`dev server on host ${target.hostId} is unreachable`);
    }
    // The loopback base this hop actually forced the connection to (see the
    // comment above), literally constructed the same way
    // resolveLoopbackPreviewUrl does on the agent side — not upstreamBase's
    // own origin, which may name a host the agent never dials. Location
    // rewriting still only ever happens here, at the primary: see
    // internal.ts's own comment on why the agent's hop always passes null.
    const loopbackBase = new URL(
      upstreamBase.pathname,
      `http://127.0.0.1:${portFromUrl(upstreamUrl)}`,
    );
    return relayFetchResponse(reply, request.method, upstreamResponse, loopbackBase);
  }

  const headers = buildUpstreamRequestHeaders(request, upstreamUrl.host);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      ...body,
      // Never auto-follow: forward the redirect to the browser as-is
      // rather than silently resolving it server-side (same
      // don't-trust-a-redirect posture as remote-host-client.ts, and it
      // lets the browser re-request through this same proxy rather than
      // this process fetching content on the browser's behalf).
      redirect: "manual",
    } as RequestInit & { duplex?: "half" });
  } catch (err) {
    request.raw.resume();
    app.log.warn(
      { err, slug, upstreamOrigin: upstreamUrl.origin },
      "preview proxy: upstream unreachable",
    );
    return reply.badGateway(`dev server at ${upstreamUrl.origin} is unreachable`);
  }

  return relayFetchResponse(reply, request.method, upstreamResponse, upstreamBase);
}

function rejectUpgrade(socket: Duplex, statusLine: string) {
  // The socket hasn't been upgraded yet, so this is a plain pre-upgrade
  // HTTP error response — the WS analog of terminal.ts's `/ws/terminal`
  // `preValidation` hook rejecting before the handshake completes. Written
  // by hand, not via Fastify's reply API, since this whole path
  // deliberately bypasses Fastify's routing (see the plugin registration's
  // own comment on why).
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

async function handlePreviewWsUpgrade(
  app: FastifyInstance,
  previewWss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  slug: string,
) {
  // Checked before resolvePreviewTarget, same ordering (and for the same
  // reason) as the HTTP path's onRequest hook below: checking auth only
  // *after* resolving the slug would turn the 404-vs-401 status difference
  // into a slug-existence oracle for an unauthenticated caller. Cookie-only
  // — there's no query string on an HMR/WS upgrade to carry a bootstrap
  // token, but the browser sends cookies automatically on the upgrade
  // handshake, so that's both correct and sufficient here.
  if (app.config.PREVIEW_AUTH_REQUIRED) {
    if (!verifyPreviewCookie(app.config.MULLION_SESSION_SECRET, req.headers.cookie, slug)) {
      // Same failure counter as the HTTP path's onRequest hook (defined
      // above) — one shared bound across both transports, since both are
      // the same class of unauthenticated-guessing surface.
      if (isPreviewAuthRateLimited(req.socket.remoteAddress)) {
        return rejectUpgrade(socket, "429 Too Many Requests");
      }
      return rejectUpgrade(socket, "401 Unauthorized");
    }
  }

  const resolution = resolvePreviewTarget(app, slug);
  if (!resolution.ok) {
    return rejectUpgrade(
      socket,
      resolution.status === 404 ? "404 Not Found" : "503 Service Unavailable",
    );
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = buildUpstreamUrl(
      resolveUpstreamBase(resolution.target),
      req.url ?? "/",
      app.config.PREVIEW_AUTH_REQUIRED,
    );
  } catch {
    return rejectUpgrade(socket, "503 Service Unavailable");
  }

  const target = resolution.target;

  // Accept the browser's handshake first, then attempt the upstream
  // connection — mirrors proxyToRemoteAttach's own posture (a browser
  // socket that already exists gets closed, not left hanging, if the
  // upstream turns out to be unreachable) rather than delaying the
  // browser's handshake on an async upstream round-trip.
  previewWss.handleUpgrade(req, socket, head, (browserSocket) => {
    let upstream: NodeWebSocket;
    if (isRemoteProjectTarget(target)) {
      try {
        upstream = getRemoteHostClient(app, target.hostId).openPreviewWs(
          portFromUrl(upstreamUrl),
          upstreamUrl.pathname + upstreamUrl.search,
        );
      } catch (err) {
        app.log.error({ err, slug }, "preview proxy: failed to open remote preview ws");
        if (browserSocket.readyState === NodeWebSocket.OPEN) browserSocket.close();
        return;
      }
    } else {
      upstream = new NodeWebSocket(toWsUrl(upstreamUrl), { headers: { host: upstreamUrl.host } });
    }
    pipeWsFrames(app, browserSocket, upstream, { slug });
  });
}

// Never any request-derived value interpolated in — the slug comes from an
// attacker-controllable Host header, so this stays a fixed, static body no
// matter what Host the caller sent (same "don't reflect attacker input"
// posture routes/settings.ts's own reply.type("application/json") call
// documents for a different content-type-confusion concern).
const PREVIEW_AUTH_UNAUTHORIZED_HTML =
  "<!doctype html><html><head><title>401 Unauthorized</title></head>" +
  "<body><h1>401 Unauthorized</h1><p>This preview requires authentication.</p></body></html>";

// Traefik terminates TLS and talks plain HTTP to this process internally
// (this app's standard deployment model — see routes/auth.ts's own comment
// on the session cookie's `secure` flag), and this app doesn't enable
// Fastify's trustProxy option, so `request.protocol` never consults
// X-Forwarded-Proto on its own and would read "http" even in production.
// Reading the header directly (falling back to request.protocol for a
// deployment that terminates TLS in this process itself, with no reverse
// proxy in front at all) is what actually reflects what scheme the *browser*
// saw, which is what the Secure/SameSite=None cookie attributes below need
// to track.
function isHttpsRequest(request: FastifyRequest): boolean {
  return request.headers["x-forwarded-proto"] === "https" || request.protocol === "https";
}

// No `domain` attribute, ever — host-only by design, so each
// "preview-<slug>.<PREVIEW_BASE_HOST>" subdomain gets its own independent
// cookie jar (defense in depth on top of the cookie payload's own slug
// check). Secure/SameSite=None/Partitioned when the request arrived over
// https (needed for a cookie to survive being set from what the browser
// treats as a cross-site context at all); SameSite=Lax as a plain-http
// fallback, since `None` without `Secure` is rejected by every modern
// browser outright — this only actually works when the dashboard and
// PREVIEW_BASE_HOST share a registrable domain (see docs/auth.md's Current
// limitations); a plain-http deployment with a cross-registrable-domain
// dashboard isn't supported by this feature.
function buildPreviewCookieOptions(request: FastifyRequest): CookieSerializeOptions {
  const base: CookieSerializeOptions = {
    httpOnly: true,
    path: "/",
    maxAge: PREVIEW_COOKIE_MAX_AGE_SECONDS,
  };
  if (isHttpsRequest(request)) {
    return { ...base, secure: true, sameSite: "none", partitioned: true };
  }
  return { ...base, sameSite: "lax" };
}

type PreviewAuthDecision =
  | { kind: "authenticated" }
  | { kind: "redirect"; location: string; cookieValue: string }
  | { kind: "unauthorized" };

// Preview hosts are exempt from securityPlugin's app-wide rate limiter
// (security.ts's own comment explains why: a single preview page load fans
// out into dozens of subresource requests that would 429 partway through the
// very first paint). That exemption is fine for proxied preview traffic
// itself, but it means this feature's own credential check — the only place
// on this path that performs an authorization decision — inherits no
// rate-limit protection at all (flagged by CodeQL's js/missing-rate-limiting
// on the onRequest hook below). This differs from auth.ts's own onRequest
// hook, which IS covered by the app-wide limiter, since /api/* isn't
// exempted there — so this can't be dismissed as the same reviewed
// false-positive that hook's CodeQL alerts were.
//
// A plain fixed-window counter, not a second @fastify/rate-limit
// registration: this hook runs as a bare app-level onRequest listener, not
// inside a route or child encapsulation context, so there's no scope to
// attach a second plugin instance's decorator to. Counts only *failed*
// (unauthorized) attempts, keyed by the raw socket's remoteAddress — not
// request.ip, for the same forgeability reason security.ts's own allowList
// comment gives (this app doesn't enable trustProxy today, but `.ip` becomes
// XFF-derived and spoofable the moment it does) — so a legitimately
// cookie-authenticated preview session's own traffic volume never throttles
// itself; only repeated failed guesses count against the bound.
const PREVIEW_AUTH_FAILURE_WINDOW_MS = 60_000;
const PREVIEW_AUTH_FAILURE_MAX = 30;
const previewAuthFailures = new Map<string, { count: number; windowStart: number }>();

function isPreviewAuthRateLimited(remoteAddress: string | undefined): boolean {
  const key = remoteAddress ?? "unknown";
  const now = Date.now();
  const entry = previewAuthFailures.get(key);
  if (!entry || now - entry.windowStart > PREVIEW_AUTH_FAILURE_WINDOW_MS) {
    previewAuthFailures.set(key, { count: 1, windowStart: now });
    // Opportunistic eviction of stale entries on a fresh window starting,
    // rather than a dedicated timer — bounded the same way ManagedBrowser's
    // consoleLogs/pageErrors buffers are, just time- rather than
    // count-keyed. In practice this map holds one entry per distinct
    // offending IP, so a size-gated sweep is cheap and rare.
    if (previewAuthFailures.size > 1000) {
      for (const [staleKey, staleEntry] of previewAuthFailures) {
        if (now - staleEntry.windowStart > PREVIEW_AUTH_FAILURE_WINDOW_MS) {
          previewAuthFailures.delete(staleKey);
        }
      }
    }
    return false;
  }
  entry.count += 1;
  return entry.count > PREVIEW_AUTH_FAILURE_MAX;
}

/** Test-only: this counter is module-level (not per-app-instance) so a test
 * exercising the 429 threshold doesn't leak state into whichever other test
 * happens to run next against the same default injected remoteAddress. */
export function resetPreviewAuthFailuresForTests(): void {
  previewAuthFailures.clear();
}

// Called before resolvePreviewTarget runs at all (see this plugin's onRequest
// hook below) — checking auth only *after* resolving the slug would turn the
// 404-vs-401 status difference into a slug-existence oracle for an
// unauthenticated caller.
function evaluatePreviewAuth(
  app: FastifyInstance,
  request: FastifyRequest,
  slug: string,
): PreviewAuthDecision {
  const secret = app.config.MULLION_SESSION_SECRET;

  // Cookie checked first — the common case once an iframe's already open.
  // Checking it before the token avoids an unnecessary redirect + re-mint
  // round trip when a bookmarked/stale URL still carries an
  // old-but-still-valid bootstrap token param alongside an already-valid
  // cookie (Hermes review, PR #427) — harmless either way (the token's TTL
  // is short and this only costs one extra hop on that one bookmark-open,
  // not per request), but checking the cookie first means it's simply never
  // reached instead.
  if (verifyPreviewCookie(secret, request.headers.cookie, slug)) {
    return { kind: "authenticated" };
  }

  // The bootstrap token only ever rides a top-level GET/HEAD navigation (the
  // iframe's initial document load, per BrowserPanel.tsx). Honoring it on
  // any other method would mean a 302 response here — which forces the
  // browser to replay the request as a GET, per HTTP semantics — could
  // silently turn e.g. a previewed app's own POST into a GET and drop its
  // body. Every other method is cookie-only.
  if (request.method === "GET" || request.method === "HEAD") {
    const incoming = new URL(request.raw.url ?? "/", "http://placeholder");
    const token = incoming.searchParams.get(PREVIEW_TOKEN_QUERY_PARAM);
    if (token && verifyPreviewToken(secret, token, slug)) {
      const cookieValue = mintPreviewCookie(secret, slug);
      const location = incoming.pathname + stripPreviewTokenParam(incoming.search);
      return { kind: "redirect", location, cookieValue };
    }
  }

  return { kind: "unauthorized" };
}

// Opt-in and inert with no PREVIEW_BASE_HOST configured (see plugins/env.ts)
// — installs no hook at all rather than a proxy with nothing to resolve
// against. Local (hostId === "local") project previews, external-URL
// previews (issue #28 phase 5, SSRF-guarded at creation time — see
// url-guard.ts), and remote-hosted project previews (issue #28 phase 6,
// two-hop via the owning agent's own /internal/preview* API) are all
// served today.
export const previewProxyPlugin = fp(async (app: FastifyInstance) => {
  const baseHost = app.config.PREVIEW_BASE_HOST.trim();
  if (baseHost === "") {
    // PREVIEW_AUTH_REQUIRED is inert with no preview proxy installed at all
    // — warn (not throw; this is a misconfiguration, not an invariant
    // violation) so an operator who sets the flag without also setting
    // PREVIEW_BASE_HOST notices it's a no-op rather than silently assuming
    // previews are gated.
    if (app.config.PREVIEW_AUTH_REQUIRED) {
      app.log.warn(
        "PREVIEW_AUTH_REQUIRED is set but PREVIEW_BASE_HOST is empty — this flag has " +
          "no preview proxy to gate and is currently inert (see issue #383).",
      );
    }
    return;
  }

  const hostPattern = buildPreviewHostPattern(baseHost);

  // A global onRequest hook, deliberately NOT a route with
  // `constraints: { host }`. Fastify/find-my-way's "host" route constraint
  // only disambiguates between *multiple handlers registered at the same
  // matched path* — it does not stop the router from preferring a more
  // specific, unconstrained route registered elsewhere in the app (e.g.
  // rootRoute's exact "/") over a constrained wildcard "*" route, no
  // matter what the actual Host header is. See preview-host.ts's own
  // comment for the full trace through find-my-way's source; this was
  // caught by this phase's own test suite (a request with a matching
  // preview Host header to "/" was served by rootRoute's placeholder
  // instead of this proxy) before it ever reached review. Deciding purely
  // from the Host header, before Fastify's own path-based routing runs,
  // is what actually isolates preview traffic from the dashboard's own
  // routes — including "/", which is exactly the path a preview's own
  // root document needs most.
  // Originally GET/HEAD only (PR #44 scoped the feature to "docs + assets");
  // every method is proxied now so Server Actions, form posts, and API
  // writes made by a previewed app work the same as they would unproxied.
  // This is also an isolation *improvement*, not just a capability add: a
  // preview-host request of any method now always terminates here (proxied,
  // or a 404/502/503 from handlePreviewRequest) and never falls through to
  // Fastify's own routing — previously a non-GET/HEAD request to a preview
  // Host reached Mullion's own `/api/*` handlers on that origin. authPlugin's
  // own preview bypass (auth.ts's isPreviewBypass) depends on that: it used
  // to mirror this method gate exactly, for the opposite reason (a Host-only
  // bypass would have let a spoofed preview Host on a write reach a real
  // handler uncredentialed back when non-GET/HEAD wasn't handled here) — now
  // that this hook consumes every method, the bypass is host-only too.
  app.addHook("onRequest", async (request, reply) => {
    const slug = extractPreviewSlug(request.headers.host, hostPattern);
    if (!slug) return; // not a preview host — fall through to normal routing

    // Preview-host auth token (issue #383) — opt-in, default off (see
    // plugins/env.ts). Checked here, before handlePreviewRequest (and
    // therefore before resolvePreviewTarget) ever runs, for the same
    // slug-existence-oracle reason evaluatePreviewAuth's own comment
    // explains. When the flag is off, this whole block is skipped and
    // behavior is byte-identical to before this feature existed.
    if (app.config.PREVIEW_AUTH_REQUIRED) {
      const decision = evaluatePreviewAuth(app, request, slug);
      if (decision.kind === "unauthorized") {
        if (isPreviewAuthRateLimited(request.raw.socket.remoteAddress)) {
          return reply.tooManyRequests("too many failed preview-auth attempts — try again later");
        }
        return reply.code(401).type("text/html").send(PREVIEW_AUTH_UNAUTHORIZED_HTML);
      }
      if (decision.kind === "redirect") {
        reply.setCookie(
          PREVIEW_COOKIE_NAME,
          decision.cookieValue,
          buildPreviewCookieOptions(request),
        );
        return reply.redirect(decision.location);
      }
      // decision.kind === "authenticated" — fall through to the proxy below.
    }

    await handlePreviewRequest(app, request, reply, slug);
  });

  // A dedicated `noServer` WebSocketServer, entirely separate from
  // @fastify/websocket's own `app.websocketServer` — this plugin completes
  // preview HMR handshakes itself rather than going through
  // @fastify/websocket/Fastify routing at all, for the same root-cause
  // reason the HTTP path above uses a global hook instead of a route:
  // @fastify/websocket's own 'upgrade' listener unconditionally calls
  // `fastify.routing(...)` and writes a real — wrong, for an upgrade — HTTP
  // response through whatever route matches, consuming the socket even
  // when no `{websocket: true}` route matches at all.
  //
  // Simply *adding a second* 'upgrade' listener isn't enough to stop that:
  // Node's EventEmitter calls every registered 'upgrade' listener
  // unconditionally, one after another, with no way for an earlier listener
  // to stop a later one from also touching the same socket — there's no
  // stopPropagation for a plain EventEmitter. An earlier version of this
  // registered a sibling listener ahead of websocketPlugin's; this phase's
  // own test suite caught the result — corrupted WebSocket framing
  // (`WS_ERR_UNEXPECTED_RSV_1`) from *both* handlers writing to the same
  // socket for a preview-host upgrade. The fix: websocketPlugin registers
  // *first* (normal app.ts order), then this plugin captures whatever
  // listener(s) it just attached, removes them, and installs a single
  // dispatcher that either fully owns the socket (preview host) or calls
  // through to the captured original (everything else, including
  // /ws/terminal) — never both.
  const existingUpgradeListeners = app.server.listeners("upgrade") as Array<
    (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  >;
  app.server.removeAllListeners("upgrade");

  const previewWss = new WebSocketServer({ noServer: true });
  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const slug = extractPreviewSlug(req.headers.host, hostPattern);
    if (!slug) {
      // Not a preview host — dispatch to whatever would have handled this
      // otherwise (@fastify/websocket's own listener, in practice).
      for (const listener of existingUpgradeListeners) listener(req, socket, head);
      return;
    }
    handlePreviewWsUpgrade(app, previewWss, req, socket, head, slug).catch((err: unknown) => {
      app.log.error({ err, slug }, "preview proxy: ws upgrade failed");
      socket.destroy();
    });
  });
});
