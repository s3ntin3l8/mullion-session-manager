import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
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
function buildUpstreamUrl(base: URL, requestUrl: string): URL {
  const incoming = new URL(requestUrl, "http://placeholder");
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const suffix = incoming.pathname.startsWith("/") ? incoming.pathname.slice(1) : incoming.pathname;
  return new URL(prefix + suffix + incoming.search, base.origin);
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
    upstreamUrl = buildUpstreamUrl(upstreamBase, request.raw.url ?? "/");
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

// Opt-in and inert with no PREVIEW_BASE_HOST configured (see plugins/env.ts)
// — installs no hook at all rather than a proxy with nothing to resolve
// against. Local (hostId === "local") project previews, external-URL
// previews (issue #28 phase 5, SSRF-guarded at creation time — see
// url-guard.ts), and remote-hosted project previews (issue #28 phase 6,
// two-hop via the owning agent's own /internal/preview* API) are all
// served today.
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
