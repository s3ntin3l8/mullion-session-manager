import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { Readable } from "node:stream";
import { projects } from "../db/schema.js";
import { getPreviewBySlug } from "../services/preview-registry.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { buildPreviewHostPattern, extractPreviewSlug } from "../services/preview-host.js";

function resolveUpstreamBase(devServerUrl: string): URL {
  // A bare port ("5173") means "this same machine" — see projects.ts's
  // isValidDevServerUrl. A full URL's host (and path — see
  // buildUpstreamUrl below) is honored as-is for a *local* project (this
  // process trusts itself, same admin-trust level as hosts.ts's own
  // baseUrl); the loopback-only boundary this column's own schema.ts
  // comment describes only applies once a *remote*-hosted project's
  // preview is proxied through its owning agent (issue #28 phase 6) —
  // that branch never reaches this function.
  if (/^\d{1,5}$/.test(devServerUrl)) return new URL(`http://127.0.0.1:${devServerUrl}/`);
  return new URL(devServerUrl);
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

async function handlePreviewRequest(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string,
) {
  const preview = getPreviewBySlug(app, slug);
  if (!preview) return reply.notFound(`Unknown preview ${slug}`);
  if (preview.kind !== "project" || preview.projectId === null) {
    // External-URL previews are proxied starting issue #28 phase 5, once
    // the SSRF guard exists — nothing here yet, so treat the slug as
    // unresolvable rather than half-serving it.
    return reply.notFound();
  }

  const [project] = app.db.select().from(projects).where(eq(projects.id, preview.projectId)).all();
  if (!project) return reply.notFound();
  if (!project.devServerUrl) {
    return reply.serviceUnavailable(`project ${project.id} has no devServerUrl configured`);
  }
  if (project.hostId !== LOCAL_HOST_ID) {
    // Remote-hosted project previews are the two-hop proxy in issue #28
    // phase 6 — not reachable from the primary directly.
    return reply.serviceUnavailable(
      "preview proxying for a remote-hosted project isn't supported yet",
    );
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = buildUpstreamUrl(
      resolveUpstreamBase(project.devServerUrl),
      request.raw.url ?? "/",
    );
  } catch {
    return reply.serviceUnavailable(`project ${project.id} has an invalid devServerUrl`);
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

// Opt-in and inert with no PREVIEW_BASE_HOST configured (see plugins/env.ts)
// — installs no hook at all rather than a proxy with nothing to resolve
// against. Only local (hostId === "local") *project* previews are served
// today; external-URL previews (phase 5) and remote-hosted project previews
// (phase 6) both resolve but respond with a "not supported yet" status
// rather than a hard error, so a client can distinguish "this slug will
// never work" from "this slug isn't wired up in this phase."
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
});
