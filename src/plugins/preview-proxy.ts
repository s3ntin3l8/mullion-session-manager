import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { projects } from "../db/schema.js";
import { getPreviewBySlug } from "../services/preview-registry.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { buildPreviewHostPattern, extractPreviewSlug } from "../services/preview-host.js";

// The two things a resolved preview can point at (see resolvePreviewTarget
// below) — either a local project's dev server or an arbitrary external
// URL (issue #28 phase 5, SSRF-guarded at creation time in
// src/routes/previews.ts, not re-validated here — see url-guard.ts's own
// comment on the DNS-rebind gap this doesn't close). Both resolve to a
// base URL via resolveUpstreamBase and proxy identically from that point
// on — subdomain-based previews don't rewrite paths, so "a project's dev
// server" and "an external site" are just two ways to obtain that base.
type PreviewTarget =
  { kind: "project"; devServerUrl: string; projectId: number } | { kind: "external"; url: string };

function resolveUpstreamBase(target: PreviewTarget): URL {
  if (target.kind === "external") return new URL(target.url);
  // A bare port ("5173") means "this same machine" — see projects.ts's
  // isValidDevServerUrl. A full URL's host (and path — see
  // buildUpstreamUrl below) is honored as-is for a *local* project (this
  // process trusts itself, same admin-trust level as hosts.ts's own
  // baseUrl); the loopback-only boundary this column's own schema.ts
  // comment describes only applies once a *remote*-hosted project's
  // preview is proxied through its owning agent (issue #28 phase 6) —
  // that branch never reaches this function.
  if (/^\d{1,5}$/.test(target.devServerUrl)) {
    return new URL(`http://127.0.0.1:${target.devServerUrl}/`);
  }
  return new URL(target.devServerUrl);
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
function buildUpstreamUrl(base: URL, requestUrl: string): URL {
  const incoming = new URL(requestUrl, "http://placeholder");
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const suffix = incoming.pathname.startsWith("/") ? incoming.pathname.slice(1) : incoming.pathname;
  return new URL(prefix + suffix + incoming.search, base.origin);
}

// Hop-by-hop or request-scoped headers that must never pass through
// unchanged: "host" specifically has to become the *upstream's* host (see
// buildUpstreamRequestHeaders) or dev servers with a Host allowlist (e.g.
// Vite's `server.allowedHosts`) 403 every request, since the browser sent
// "preview-<slug>.<baseHost>", not what the dev server expects to be
// reached as.
const HOP_BY_HOP_REQUEST_HEADERS = new Set(["host", "connection", "content-length"]);

function buildUpstreamRequestHeaders(request: FastifyRequest, upstreamHost: string): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  headers.set("host", upstreamHost);
  return headers;
}

// Headers that would either defeat this whole feature (the target's own
// X-Frame-Options/CSP would block the dashboard from framing it — the exact
// mixed-content/embedding problem this proxy exists to solve) or are simply
// wrong once re-served through fetch()/Fastify rather than passed through a
// raw socket: fetch() already transparently decompressed the body, so
// forwarding the upstream's own content-encoding/content-length would
// describe bytes we're no longer sending; Fastify recomputes
// framing/length headers itself once the response is actually sent. Since
// this handler runs as a global onRequest hook ahead of helmet's own (see
// the plugin registration below), these reply.header() calls simply
// overwrite whatever helmet already staged — headers are just mutable
// state on the reply object until the response is actually flushed, so
// hook *registration* order relative to helmet doesn't matter here.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

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
  if (project.hostId !== LOCAL_HOST_ID) {
    // Remote-hosted project previews are the two-hop proxy in issue #28
    // phase 6 — not reachable from the primary directly.
    return {
      ok: false,
      status: 503,
      message: "preview proxying for a remote-hosted project isn't supported yet",
    };
  }
  return {
    ok: true,
    target: { kind: "project", devServerUrl: project.devServerUrl, projectId: project.id },
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

  let upstreamUrl: URL;
  try {
    upstreamUrl = buildUpstreamUrl(resolveUpstreamBase(resolution.target), request.raw.url ?? "/");
  } catch {
    return reply.serviceUnavailable(`preview ${slug} has an invalid target URL`);
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: buildUpstreamRequestHeaders(request, upstreamUrl.host),
      // Never auto-follow: forward the redirect to the browser as-is
      // rather than silently resolving it server-side (same
      // don't-trust-a-redirect posture as remote-host-client.ts, and it
      // lets the browser re-request through this same proxy rather than
      // this process fetching content on the browser's behalf).
      redirect: "manual",
    });
  } catch (err) {
    app.log.warn(
      { err, slug, upstreamOrigin: upstreamUrl.origin },
      "preview proxy: upstream unreachable",
    );
    return reply.badGateway(`dev server at ${upstreamUrl.origin} is unreachable`);
  }

  reply.code(upstreamResponse.status);

  // Explicit removal, not just "don't copy the upstream's own value": this
  // hook runs *after* helmet's own onRequest hook (registration order —
  // securityPlugin registers before this plugin), so helmet has already
  // staged its own x-frame-options/CSP on this reply. Skipping the copy
  // step for a stripped header only means "don't overwrite helmet's
  // value" — it does nothing to *remove* it. Critically, `reply.raw`
  // (Node's own ServerResponse), not just `reply`, needs clearing too:
  // @fastify/helmet sets its headers by calling the `helmet` npm package's
  // middleware directly against `reply.raw` (see its own index.js), which
  // bypasses Fastify's `reply.header()` API — and `reply.removeHeader()`
  // only clears Fastify's *own* internal header map, never `reply.raw`'s,
  // so it's a silent no-op for anything helmet set this way. Without both
  // calls, helmet's SAMEORIGIN/default-src 'self' survives untouched and
  // blocks the dashboard from framing this exact response — the one thing
  // this whole feature exists to make possible.
  for (const name of STRIPPED_RESPONSE_HEADERS) {
    reply.removeHeader(name);
    if (reply.raw.hasHeader(name)) reply.raw.removeHeader(name);
  }

  // Grouped by header name (not just iterated + reply.header() per entry)
  // so a multi-value header — Set-Cookie is the realistic case — round-trips
  // as every value rather than only the last one Fastify's reply.header()
  // would otherwise overwrite with.
  const headersToSend = new Map<string, string[]>();
  for (const [key, value] of upstreamResponse.headers) {
    const lower = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    const existing = headersToSend.get(lower);
    if (existing) existing.push(value);
    else headersToSend.set(lower, [value]);
  }
  for (const [key, values] of headersToSend) {
    reply.header(key, values.length === 1 ? values[0] : values);
  }

  if (request.method === "HEAD" || upstreamResponse.body === null) {
    return reply.send();
  }
  return reply.send(Readable.fromWeb(upstreamResponse.body));
}

const BACKPRESSURE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function toWsUrl(url: URL): URL {
  const wsUrl = new URL(url.href);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return wsUrl;
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

/**
 * Pipes frames between the browser's already-upgraded preview WS connection
 * and an upstream dev-server WS connection — the WS analog of
 * handlePreviewRequest above. Mirrors terminal.ts's own
 * proxyToRemoteAttach() backpressure/lifecycle handling frame-for-frame
 * (same BACKPRESSURE_MAX_BUFFERED_BYTES drop threshold, unconditional
 * message-handler registration so frames sent before the upstream opens
 * aren't silently dropped, close/error propagation both ways) rather than
 * reusing it directly — that function is PtyManager-attach-specific
 * (AttachSessionParams, hostId-keyed RemoteHostClient lookup), not a
 * generic two-socket pipe.
 */
function pipePreviewWsFrames(
  app: FastifyInstance,
  browserSocket: NodeWebSocket,
  upstream: NodeWebSocket,
  slug: string,
) {
  const closeBrowser = () => {
    if (browserSocket.readyState === NodeWebSocket.OPEN) browserSocket.close();
  };
  const closeUpstream = () => {
    // A CLOSING upstream (already mid-close-handshake from some other
    // trigger) is left alone rather than closed again — same as
    // proxyToRemoteAttach's own closeUpstream, which this mirrors. In the
    // rare case the browser side closes at that exact moment, the upstream
    // simply finishes its own close on its own timeline rather than
    // erroring on a double-close.
    if (
      upstream.readyState === NodeWebSocket.OPEN ||
      upstream.readyState === NodeWebSocket.CONNECTING
    ) {
      upstream.close();
    }
  };

  // Unconditional, not nested in upstream's "open" handler — same reasoning
  // as proxyToRemoteAttach: the upstream connect isn't instant, and gating
  // this on "open" would silently drop any frame the browser sends during
  // that window.
  browserSocket.on("message", (data, isBinary) => {
    if (upstream.readyState !== NodeWebSocket.OPEN) return;
    if (upstream.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) return;
    upstream.send(data, { binary: isBinary });
  });
  browserSocket.on("close", closeUpstream);

  upstream.on("close", closeBrowser);
  upstream.on("error", (err) => {
    app.log.warn({ err, slug }, "preview proxy: ws upstream error");
    closeBrowser();
  });

  upstream.once("open", () => {
    upstream.on("message", (data, isBinary) => {
      if (browserSocket.readyState !== NodeWebSocket.OPEN) return;
      if (browserSocket.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) return;
      browserSocket.send(data, { binary: isBinary });
    });
  });
  upstream.once("unexpected-response", (_req, res) => {
    app.log.warn(
      { slug, statusCode: res.statusCode },
      "preview proxy: dev server rejected ws upgrade",
    );
    closeBrowser();
  });
}

async function handlePreviewWsUpgrade(
  app: FastifyInstance,
  previewWss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  slug: string,
) {
  const resolution = resolvePreviewTarget(app, slug);
  if (!resolution.ok) {
    return rejectUpgrade(
      socket,
      resolution.status === 404 ? "404 Not Found" : "503 Service Unavailable",
    );
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = buildUpstreamUrl(resolveUpstreamBase(resolution.target), req.url ?? "/");
  } catch {
    return rejectUpgrade(socket, "503 Service Unavailable");
  }

  // Accept the browser's handshake first, then attempt the upstream
  // connection — mirrors proxyToRemoteAttach's own posture (a browser
  // socket that already exists gets closed, not left hanging, if the
  // upstream turns out to be unreachable) rather than delaying the
  // browser's handshake on an async upstream round-trip.
  previewWss.handleUpgrade(req, socket, head, (browserSocket) => {
    const upstream = new NodeWebSocket(toWsUrl(upstreamUrl), {
      headers: { host: upstreamUrl.host },
    });
    pipePreviewWsFrames(app, browserSocket, upstream, slug);
  });
}

// Opt-in and inert with no PREVIEW_BASE_HOST configured (see plugins/env.ts)
// — installs no hook at all rather than a proxy with nothing to resolve
// against. Local (hostId === "local") project previews and external-URL
// previews (issue #28 phase 5, SSRF-guarded at creation time — see
// url-guard.ts) are both served today; a remote-hosted project preview
// (phase 6) resolves but responds "not supported yet" rather than a hard
// error, so a client can distinguish "this slug will never work" from
// "this slug isn't wired up in this phase."
export const previewProxyPlugin = fp(async (app: FastifyInstance) => {
  const baseHost = app.config.PREVIEW_BASE_HOST.trim();
  if (baseHost === "") return;

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
  app.addHook("onRequest", async (request, reply) => {
    const slug = extractPreviewSlug(request.headers.host, hostPattern);
    if (!slug) return; // not a preview host — fall through to normal routing
    if (request.method !== "GET" && request.method !== "HEAD") return;
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
