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
  assertAllowedUrl,
  findSsrfBlock,
  getPinnedDispatcher,
  getPinnedWsAgent,
} from "../services/pinned-connect.js";
import type { UrlGuardPolicy } from "../services/url-guard.js";
import {
  PREVIEW_COOKIE_MAX_AGE_SECONDS,
  PREVIEW_COOKIE_NAME,
  PREVIEW_TOKEN_QUERY_PARAM,
  checkPreviewCookie,
  mintPreviewCookie,
  verifyPreviewCookie,
  verifyPreviewToken,
} from "../services/preview-auth.js";

// The two things a resolved preview can point at (see resolvePreviewTarget
// below) — either a project's dev server (local, or remote via its owning
// agent — issue #28 phase 6) or an arbitrary external URL (issue #28 phase
// 5, SSRF-guarded at creation time in src/routes/previews.ts, and since
// issue #250 re-validated *and* IP-pinned at connect time here too — see
// previewUrlPolicy below). All resolve to a base URL via resolveUpstreamBase
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

// Connection-time SSRF pinning policy for the two things this proxy dials
// directly (issue #250). The split matches where each target's URL came from,
// which is the whole reason url-guard takes a policy at all:
//   - external: a URL a user typed into a browser pane. Same strict policy
//     routes/previews.ts applied when it was created — but that check ran once
//     against a *literal*, so a hostname resolving to loopback/RFC1918/IMDS,
//     or rebinding after creation, only gets caught here.
//   - project: an admin-configured dev server, which is normally on loopback
//     or a private LAN. Blocking those would break the feature's main use.
// A remote project's dev server isn't dialed here at all — it goes through the
// owning agent's client, pinned there.
function previewUrlPolicy(target: PreviewTarget): UrlGuardPolicy {
  return target.kind === "external"
    ? { allowLoopback: false, allowPrivate: false }
    : { allowLoopback: true, allowPrivate: true };
}

// A URL's `.port` is "" when the URL has no explicit port (protocol
// default) — Number("") is 0, not a usable port, so this can't just be
// `Number(url.port)`. Exported for routes/projects.ts's dev-server-status
// route (issue #522), which needs the same port-only-forwarding rule this
// file already follows for remote previews — see this module's own
// PreviewTarget handling and schema.ts's devServerUrl comment ("only the
// port is forwarded, never the host").
export function portFromUrl(url: URL): number {
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

// Finding AS4 — this hop's fetch() target (buildUpstreamUrl's own
// resolution: a `kind: "external"` preview is a URL the operator typed into
// a browser pane, i.e. attacker-chosen the moment that preview points
// somewhere hostile) must never see either credential a client attaches to
// reach the preview proxy itself. Mirrors http-proxy.ts's own
// extraExcluded stripping of "authorization" for the agent's own onward hop
// to its loopback dev server ("that secret must never reach arbitrary
// project dev-server code" — see buildUpstreamRequestHeaders' doc comment)
// — the primary's direct-fetch hop used to pass no exclusions at all, on
// the assumption no client ever sends that header to a preview host, which
// doesn't hold once the target is attacker-controlled. "proxy-authorization"
// is already covered by HOP_BY_HOP_REQUEST_HEADERS below; passed here too
// so this call site is explicit about both credentials it must never leak,
// without relying on a reader to cross-reference the other module.
//
// The `mullion_preview` auth cookie needs the same treatment but isn't a
// header http-proxy.ts's own extraExcluded mechanism can strip (it strips
// whole headers, not individual cookies within "cookie") — stripCookieValue
// below removes just that one cookie, leaving any other cookie the browser
// happens to send untouched.
const PREVIEW_UPSTREAM_EXCLUDED_HEADERS = ["authorization", "proxy-authorization"];

// Removes a single named cookie from a raw Cookie header value, leaving
// every other cookie in place — used to strip the `mullion_preview`
// auth cookie (see PREVIEW_UPSTREAM_EXCLUDED_HEADERS' own comment) before
// forwarding to an upstream this proxy doesn't control.
function stripCookieValue(cookieHeader: string, name: string): string | undefined {
  const kept = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => {
      const eq = part.indexOf("=");
      const cookieName = eq === -1 ? part : part.slice(0, eq);
      return cookieName !== name;
    });
  return kept.length > 0 ? kept.join("; ") : undefined;
}

// In-place: strips PREVIEW_COOKIE_NAME out of `headers`' own "cookie" value
// (or removes the header entirely once it's the only cookie present) — see
// PREVIEW_UPSTREAM_EXCLUDED_HEADERS' doc comment for why this can't just be
// another entry in that list.
function stripPreviewAuthCookie(headers: Headers): void {
  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) return;
  const stripped = stripCookieValue(cookieHeader, PREVIEW_COOKIE_NAME);
  if (stripped === undefined) headers.delete("cookie");
  else headers.set("cookie", stripped);
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
//
// Finding AS15: this used to carry a `message` field with internal detail
// (the slug, the numeric project id) that both call sites below sent
// straight back to an unauthenticated client (the WS path already never
// used it — rejectUpgrade only ever takes a bare status line). That
// undermines the whole point of the auth-before-slug-resolution ordering
// this file otherwise deliberately maintains (see evaluatePreviewAuth's own
// comment): if the response body itself leaks "no such preview" vs. "preview
// exists but its project has no devServerUrl" vs. "preview exists and is
// reachable," the 404-vs-503-vs-200 status split alone was never the only
// existence oracle. The detail is still worth having — just server-side
// only, via the app.log.warn calls below — so this now returns nothing more
// than a status code to the caller; the client-facing body is always the
// same fixed PREVIEW_UNAVAILABLE_MESSAGE (see handlePreviewRequest).
type PreviewResolution = { ok: true; target: PreviewTarget } | { ok: false; status: 404 | 503 };

function resolvePreviewTarget(app: FastifyInstance, slug: string): PreviewResolution {
  const preview = getPreviewBySlug(app, slug);
  if (!preview) {
    app.log.warn({ slug }, "preview proxy: unknown preview slug");
    return { ok: false, status: 404 };
  }

  if (preview.kind === "external") {
    if (!preview.externalUrl) return { ok: false, status: 404 };
    return { ok: true, target: { kind: "external", url: preview.externalUrl } };
  }

  if (preview.projectId === null) return { ok: false, status: 404 };
  const [project] = app.db.select().from(projects).where(eq(projects.id, preview.projectId)).all();
  if (!project) return { ok: false, status: 404 };
  if (!project.devServerUrl) {
    app.log.warn(
      { slug, projectId: project.id },
      "preview proxy: project has no devServerUrl configured",
    );
    return { ok: false, status: 503 };
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

// Finding AS15 — the one fixed, detail-free body every preview-proxy error
// response sends to the client, regardless of which internal condition
// triggered it (unknown slug, no devServerUrl, blocked/unreachable upstream,
// an unparsable target URL). Same "don't reflect attacker/internal state
// into the response" posture as PREVIEW_AUTH_UNAUTHORIZED_HTML above — the
// actual reason is always still available server-side, in the app.log.warn/
// error call alongside each call site below.
const PREVIEW_UNAVAILABLE_MESSAGE = "preview unavailable";

async function handlePreviewRequest(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string,
) {
  const resolution = resolvePreviewTarget(app, slug);
  if (!resolution.ok) {
    // Hermes review, PR #579: reply.notFound() with no argument falls back
    // to @fastify/sensible's own default message, not the fixed
    // PREVIEW_UNAVAILABLE_MESSAGE the design comment above promises for
    // every preview-proxy error response — pass it explicitly so the body
    // is uniform across every failure branch on this path (same
    // {statusCode, error, message} shape as the serviceUnavailable/
    // badGateway calls below, just with message pinned to the one constant
    // regardless of status code).
    return resolution.status === 404
      ? reply.notFound(PREVIEW_UNAVAILABLE_MESSAGE)
      : reply.serviceUnavailable(PREVIEW_UNAVAILABLE_MESSAGE);
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
  } catch (err) {
    app.log.warn({ err, slug }, "preview proxy: preview has an invalid target URL");
    return reply.serviceUnavailable(PREVIEW_UNAVAILABLE_MESSAGE);
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
    // AS4's "authorization" leak is already closed for this hop by a
    // different, pre-existing mechanism: remote-host-client.ts's own
    // openPreviewHttp deletes whatever "authorization" this browser-derived
    // header set carries and replaces it with the primary's own
    // agent-session bearer token before it ever reaches the wire (issue
    // #249 — see that file's own comment on why a delete-then-set, not a
    // conditional one, is required). The `mullion_preview` auth cookie has
    // no equivalent scrubbing anywhere on this hop, though — the agent's own
    // onward fetch to its loopback dev server (internal.ts) only strips
    // "authorization", not "cookie" — so it must be stripped here, same as
    // the direct-fetch hop below.
    stripPreviewAuthCookie(headers);
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
      return reply.badGateway(PREVIEW_UNAVAILABLE_MESSAGE);
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

  const headers = buildUpstreamRequestHeaders(
    request,
    upstreamUrl.host,
    PREVIEW_UPSTREAM_EXCLUDED_HEADERS,
  );
  stripPreviewAuthCookie(headers);
  const policy = previewUrlPolicy(target);
  let upstreamResponse: Response;
  try {
    assertAllowedUrl(upstreamUrl, policy);
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
      // Pins the connection to a validated address so the guard
      // routes/previews.ts ran at creation time can't be sidestepped by a
      // name that resolves somewhere else now (issue #250).
      dispatcher: getPinnedDispatcher(policy),
    } as RequestInit & { duplex?: "half" });
  } catch (err) {
    request.raw.resume();
    // A blocked connection and a dead dev server both land here; without
    // separating them the operator just sees a 502 and no reason for it.
    const blocked = findSsrfBlock(err);
    if (blocked) {
      app.log.warn(
        {
          slug,
          kind: target.kind,
          hostname: blocked.hostname,
          address: blocked.address,
          policy,
        },
        "preview proxy: upstream blocked by SSRF guard",
      );
    } else {
      app.log.warn(
        { err, slug, upstreamOrigin: upstreamUrl.origin },
        "preview proxy: upstream unreachable",
      );
    }
    return reply.badGateway(PREVIEW_UNAVAILABLE_MESSAGE);
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
  // Finding AS5 — same unconditional per-IP volume meter as the HTTP path's
  // onRequest hook, applied before the PREVIEW_AUTH_REQUIRED branch below so
  // it covers HMR upgrade traffic even when that flag is off.
  if (
    isPreviewRequestRateLimited(app, req.socket.remoteAddress, app.config.PREVIEW_RATE_LIMIT_MAX)
  ) {
    return rejectUpgrade(socket, "429 Too Many Requests");
  }

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
      if (isPreviewAuthRateLimited(app, req.socket.remoteAddress)) {
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
      // The weakest spot before issue #250: this hop had no guard at all —
      // `redirect: "manual"` isn't even available on the WS transport, and no
      // Dispatcher can reach it, so the pinned `http(s).Agent` is what closes
      // it. assertAllowedUrl covers the IP-literal case the lookup never sees.
      const policy = previewUrlPolicy(target);
      const wsUrl = toWsUrl(upstreamUrl);
      try {
        assertAllowedUrl(upstreamUrl, policy);
        upstream = new NodeWebSocket(wsUrl, {
          headers: { host: upstreamUrl.host },
          agent: getPinnedWsAgent(policy, wsUrl),
        });
      } catch (err) {
        const blocked = findSsrfBlock(err);
        app.log.warn(
          { err: blocked ? undefined : err, slug, kind: target.kind, blocked },
          blocked
            ? "preview proxy: upstream ws blocked by SSRF guard"
            : "preview proxy: failed to open upstream ws",
        );
        if (browserSocket.readyState === NodeWebSocket.OPEN) browserSocket.close();
        return;
      }
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
  // Finding AS12 — a valid cookie old enough to warrant a silent sliding
  // refresh (see preview-auth.ts's PREVIEW_COOKIE_REFRESH_AGE_MS comment).
  // Distinct from "redirect": the request still proxies normally on this
  // same response, it just also carries a fresh Set-Cookie.
  | { kind: "refresh"; cookieValue: string }
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
//
// Shared implementation for this counter and previewRequestCounts below
// (AS5) — same shape, different key/window/max/cap per instance.
//
// Finding AS10: this used to be a single module-level Map per counter, and
// only ever swept opportunistically — on a fresh window starting, and only
// once the map had already grown past 1000 entries — so a sustained burst
// (e.g. rotating IPv6 source addresses) could grow it without any ceiling
// for the whole duration of the burst; the "size > 1000" check only ever
// ran on the *next* insert after crossing the threshold, it didn't cap
// anything proactively. Now: a hard `maxEntries` cap with unconditional
// oldest-first eviction on every insert past capacity (Map iterates in
// insertion order, same eviction shape as nonce-store.ts's
// NonceStore.checkAndRecord — see that file's own comment for the full
// rationale), plus a periodic sweep of genuinely expired entries (mirrors
// plugins/request-nonce.ts's SWEEP_INTERVAL_MS timer) so a bursty-then-quiet
// attacker's entries don't just sit at the cap forever between bursts.
//
// Per-app-instance (decorated onto `app` below, not a module-level Map) —
// same per-instance-not-module-level reasoning nonce-store.ts documents for
// its own store: state must not leak across the many buildApp() instances a
// single test run creates. Every test in this file/preview-ws-proxy.test.ts
// already builds a fresh app per case, so this also removes the previous
// module-level resetPreviewAuthFailuresForTests()/
// resetPreviewRequestCountsForTests() reset dance entirely — a
// clearForTests() method is kept on the class itself (mirroring
// NonceStore's own) for the rare case a single test wants to exhaust and
// then reset a counter within one still-open app instance.
interface FixedWindowEntry {
  count: number;
  windowStart: number;
}

// ~40 bytes/entry (nonce-store.ts's own estimate for a similarly-shaped
// entry) — 10,000 entries is a few hundred KB, comfortably above any
// realistic distinct-IP count for a single preview host in one window, while
// still bounding a burst from an attacker cycling through addresses.
// Exported for test/plugins/preview-proxy.test.ts's direct unit test of
// FixedWindowCounter's eviction — driving 10,001 real HTTP requests through
// app.inject() just to exercise the cap would make that test impractically
// slow, same reasoning nonce-store.test.ts's own MAX_NONCES tests apply.
export const PREVIEW_TRACKER_MAX_ENTRIES = 10_000;

export class FixedWindowCounter {
  private counts = new Map<string, FixedWindowEntry>();

  constructor(private readonly windowMs: number) {}

  /** Records a hit for `remoteAddress` and returns whether it's now over
   * `max` for the current window. */
  hit(remoteAddress: string | undefined, max: number, now: number = Date.now()): boolean {
    const key = remoteAddress ?? "unknown";
    const entry = this.counts.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      // Hermes review, PR #579: eviction must only run when this hit is
      // adding a genuinely NEW key. Re-hitting an EXISTING key whose window
      // has merely expired resets it in place via the `counts.set` below —
      // that doesn't grow the map at all, so evicting here too would
      // needlessly (and harmfully) drop some *other*, possibly still-active
      // IP's counter, silently resetting its count and weakening the very
      // limiter this cap exists to harden. `!entry` is the only branch
      // that actually adds a new Map key.
      if (!entry && this.counts.size >= PREVIEW_TRACKER_MAX_ENTRIES) {
        const oldest = this.counts.keys().next().value;
        if (oldest !== undefined) this.counts.delete(oldest);
      }
      this.counts.set(key, { count: 1, windowStart: now });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  }

  /** Drops entries whose window has fully expired — called on a periodic
   * timer (see previewProxyPlugin below), not on every hit, so this stays
   * bounded without a per-hit sweep cost (mirrors NonceStore.sweep). */
  sweep(now: number = Date.now()): void {
    for (const [key, entry] of this.counts) {
      if (now - entry.windowStart > this.windowMs) this.counts.delete(key);
    }
  }

  /** Test-only introspection. */
  size(): number {
    return this.counts.size;
  }

  /** Test-only: reset within a single still-open app instance. */
  clearForTests(): void {
    this.counts.clear();
  }
}

const PREVIEW_AUTH_FAILURE_WINDOW_MS = 60_000;
const PREVIEW_AUTH_FAILURE_MAX = 30;

function isPreviewAuthRateLimited(
  app: FastifyInstance,
  remoteAddress: string | undefined,
): boolean {
  return app.previewAuthFailures!.hit(remoteAddress, PREVIEW_AUTH_FAILURE_MAX);
}

// Finding AS5 — with PREVIEW_AUTH_REQUIRED off (the default), preview-host
// traffic is exempt from securityPlugin's app-wide rate limiter (see that
// comment) with NO compensating meter at all: isPreviewAuthRateLimited
// above only ever runs inside the `if (app.config.PREVIEW_AUTH_REQUIRED)`
// branch below, so an unauthenticated deployment metered nothing on a
// surface that can trigger a 30s-lived outbound fetch per request. This is
// a separate, much more generous per-IP counter than the app-wide default
// (RATE_LIMIT_MAX, 100/min) — previews legitimately fan out into dozens of
// subresource requests per page load — but still bounded, applied
// unconditionally (both HTTP, in the onRequest hook below, and the WS
// upgrade path in handlePreviewWsUpgrade), and keyed the same
// forgery-resistant way as every other counter on this path. The ceiling
// itself is `app.config.PREVIEW_RATE_LIMIT_MAX` (env.ts), not a hardcoded
// constant — an operator whose dev server's cold load legitimately needs
// more headroom than the default has a lever, rather than being stuck.
const PREVIEW_REQUEST_WINDOW_MS = 60_000;

function isPreviewRequestRateLimited(
  app: FastifyInstance,
  remoteAddress: string | undefined,
  max: number,
): boolean {
  return app.previewRequestCounts!.hit(remoteAddress, max);
}

// Finding AS10 — same periodic-sweep reasoning as
// plugins/request-nonce.ts's SWEEP_INTERVAL_MS.
const PREVIEW_TRACKER_SWEEP_INTERVAL_MS = 60_000;

declare module "fastify" {
  interface FastifyInstance {
    // Finding AS10 — per-instance failed-preview-auth-attempt /
    // preview-request-volume counters (see FixedWindowCounter's own
    // comment above). Both are set in previewProxyPlugin below before its
    // onRequest hook (the only code that reads them) is installed, and only
    // when that hook is installed at all (PREVIEW_BASE_HOST configured) —
    // isPreviewAuthRateLimited/isPreviewRequestRateLimited are never called
    // on a path where these could still be undefined, hence the `!` at
    // their call sites rather than a redundant runtime guard.
    previewAuthFailures?: FixedWindowCounter;
    previewRequestCounts?: FixedWindowCounter;
  }
}

// Called before resolvePreviewTarget runs at all (see this plugin's onRequest
// hook below) — checking auth only *after* resolving the slug would turn the
// 404-vs-401 status difference into a slug-existence oracle for an
// unauthenticated caller.
//
// CodeQL (js/missing-rate-limiting) flags this function itself (its only
// call site being an "authorization check with no rate-limit decorator of
// its own"). Same *resolution* as the onRequest hook's own CodeQL alert
// above (search this file for "js/missing-rate-limiting" for the full
// writeup) — NOT the same false positive: that alert wasn't dismissed, it
// was addressed by building FixedWindowCounter (AS10) in the first place.
// This function's alert is a fresh re-anchoring of that same, now-real
// protection onto a different piece of code, unrecognized by CodeQL's
// heuristic for the same underlying reason: the heuristic looks for a
// recognized `@fastify/rate-limit`-style decorator directly on the flagged
// code, and doesn't credit a plain function call to a custom counter as
// satisfying it. The actual protection is real, just structured
// differently — this function's one call site (the onRequest hook below) is
// only ever reached *after* `isPreviewRequestRateLimited` has already
// gated the request unconditionally, and this function's own "unauthorized"
// outcome is itself gated by `isPreviewAuthRateLimited` before any response
// is sent — see both call sites just below. Nothing about AS10's changes
// (moving these counters to per-instance state, adding the eviction cap)
// altered that ordering or removed any check; CodeQL simply re-anchored the
// same alert onto this helper once AS12 added a new branch inside it.
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
  const cookieCheck = checkPreviewCookie(secret, request.headers.cookie, slug);
  if (cookieCheck.valid) {
    // Finding AS12 — a still-valid cookie old enough to warrant a silent
    // sliding refresh (see preview-auth.ts's PREVIEW_COOKIE_REFRESH_AGE_MS
    // comment) re-mints here rather than falling through to "authenticated"
    // unchanged; the onRequest hook below Set-Cookies the fresh value on
    // this same response and still proxies it normally.
    if (cookieCheck.shouldRefresh) {
      return { kind: "refresh", cookieValue: mintPreviewCookie(secret, slug) };
    }
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

  // Finding AS10 — one tracker instance per app instance (see
  // FixedWindowCounter's own comment above), created only once this plugin
  // is actually going to install its hook (PREVIEW_BASE_HOST configured —
  // the empty-baseHost branch above already returned). A single shared
  // timer sweeps both, unref'd (mirrors plugins/request-nonce.ts's own
  // NonceStore sweep timer exactly) so it never keeps the process alive on
  // its own, and cleared on close so repeated buildApp()/close() cycles in
  // a single test run don't accumulate timers.
  app.previewAuthFailures = new FixedWindowCounter(PREVIEW_AUTH_FAILURE_WINDOW_MS);
  app.previewRequestCounts = new FixedWindowCounter(PREVIEW_REQUEST_WINDOW_MS);
  const sweepTimer = setInterval(() => {
    app.previewAuthFailures?.sweep();
    app.previewRequestCounts?.sweep();
  }, PREVIEW_TRACKER_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  app.addHook("onClose", () => {
    clearInterval(sweepTimer);
    app.previewAuthFailures = undefined;
    app.previewRequestCounts = undefined;
  });

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

    // Finding AS5 — applies unconditionally, before the PREVIEW_AUTH_REQUIRED
    // branch below: with that flag off (the default), preview-host traffic
    // is otherwise metered by nothing at all (see isPreviewRequestRateLimited's
    // own doc comment).
    if (
      isPreviewRequestRateLimited(
        app,
        request.raw.socket.remoteAddress,
        app.config.PREVIEW_RATE_LIMIT_MAX,
      )
    ) {
      return reply.tooManyRequests("too many preview requests — try again later");
    }

    // Preview-host auth token (issue #383) — opt-in, default off (see
    // plugins/env.ts). Checked here, before handlePreviewRequest (and
    // therefore before resolvePreviewTarget) ever runs, for the same
    // slug-existence-oracle reason evaluatePreviewAuth's own comment
    // explains. When the flag is off, this whole block is skipped and
    // behavior is byte-identical to before this feature existed.
    if (app.config.PREVIEW_AUTH_REQUIRED) {
      const decision = evaluatePreviewAuth(app, request, slug);
      if (decision.kind === "unauthorized") {
        if (isPreviewAuthRateLimited(app, request.raw.socket.remoteAddress)) {
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
      if (decision.kind === "refresh") {
        // Finding AS12 — unlike "redirect" above, this isn't a bootstrap
        // exchange: the request already carried a valid cookie and proxies
        // normally on this same response, it just also gets Set-Cookie'd a
        // fresh value (sliding refresh — see preview-auth.ts's
        // PREVIEW_COOKIE_REFRESH_AGE_MS comment). No redirect, no early
        // return — falls through to handlePreviewRequest below same as
        // "authenticated."
        reply.setCookie(
          PREVIEW_COOKIE_NAME,
          decision.cookieValue,
          buildPreviewCookieOptions(request),
        );
      }
      // decision.kind === "authenticated" (or "refresh", handled above) —
      // fall through to the proxy below.
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
