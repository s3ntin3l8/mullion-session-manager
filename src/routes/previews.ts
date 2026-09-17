import type { FastifyInstance } from "fastify";
import {
  UnknownProjectError,
  createExternalPreview,
  deletePreviewBySlug,
  getOrCreateProjectPreview,
  getPreviewBySlug,
  listPreviews,
} from "../services/preview-registry.js";
import { isAllowedHttpUrl } from "../services/url-guard.js";
import { PREVIEW_TOKEN_QUERY_PARAM, mintPreviewToken } from "../services/preview-auth.js";
import { requestScheme } from "../services/request-scheme.js";
import { isAuthEnabled, isRequestAuthenticated } from "../services/auth.js";

interface CreatePreviewBody {
  kind: "project" | "external";
  projectId?: number;
  url?: string;
}

const createPreviewSchema = {
  body: {
    type: "object",
    required: ["kind"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["project", "external"] },
      projectId: { type: "number" },
      url: { type: "string", minLength: 1 },
    },
  },
};

// Full SSRF-range validation (issue #28 phase 5) — the opposite policy from
// hosts.ts's own use of the same underlying check (services/url-guard.ts):
// this path is driven by whatever URL a user types into a browser pane's
// address bar, a real privilege boundary this server crosses on the
// caller's behalf (it fetches the target and serves the response back),
// not an admin-trust config action. Loopback and RFC1918/ULA private
// ranges are rejected on top of the link-local/shared-NAT/cloud-IMDS
// ranges hosts.ts already blocks unconditionally.
function isAllowedExternalUrl(value: string): boolean {
  return isAllowedHttpUrl(value, { allowLoopback: false, allowPrivate: false });
}

export async function previewsRoute(app: FastifyInstance) {
  // Opt-in feature (see plugins/env.ts): with no base host configured, a
  // created preview row could never resolve to a working "preview-<slug>"
  // subdomain, so don't register these routes — creation must 404 rather
  // than silently succeed into a dead end.
  if (app.config.PREVIEW_BASE_HOST.trim() === "") return;

  app.get("/api/previews", async () => listPreviews(app));

  app.post<{ Body: CreatePreviewBody }>(
    "/api/previews",
    { schema: createPreviewSchema },
    async (request, reply) => {
      const { kind } = request.body;

      if (kind === "project") {
        const { projectId } = request.body;
        if (typeof projectId !== "number" || !Number.isInteger(projectId)) {
          return reply.badRequest('projectId is required for kind "project"');
        }
        try {
          const preview = getOrCreateProjectPreview(app, projectId);
          reply.code(201);
          return preview;
        } catch (err) {
          if (err instanceof UnknownProjectError) return reply.notFound(err.message);
          throw err;
        }
      }

      const { url } = request.body;
      if (typeof url !== "string" || !isAllowedExternalUrl(url)) {
        return reply.badRequest('url must be a valid, non-private http(s) URL for kind "external"');
      }
      const preview = createExternalPreview(app, url);
      reply.code(201);
      return preview;
    },
  );

  app.get<{ Params: { slug: string } }>("/api/previews/:slug", async (request, reply) => {
    const preview = getPreviewBySlug(app, request.params.slug);
    if (!preview) return reply.notFound();
    return preview;
  });

  app.delete<{ Params: { slug: string } }>("/api/previews/:slug", async (request, reply) => {
    const deleted = deletePreviewBySlug(app, request.params.slug);
    if (!deleted) return reply.notFound();
    reply.code(204);
  });

  // Preview-host auth token (issue #383) — mints the 60-second bootstrap
  // token BrowserPanel.tsx appends to a preview iframe's URL when
  // PREVIEW_AUTH_REQUIRED is on (see src/services/preview-auth.ts and
  // src/plugins/preview-proxy.ts, which exchanges it for a long-lived
  // preview cookie). No special-casing needed here beyond the ordinary
  // 404-on-unknown-slug check: this route sits behind the normal /api/*
  // auth gate (src/plugins/auth.ts) exactly like every other route in this
  // file — that gate installs no hook at all when in-process auth isn't
  // configured, so this route is only ever reachable with no credential in
  // that same configuration. That's why src/app.ts's own boot-time
  // invariant refuses to start with PREVIEW_AUTH_REQUIRED=true unless
  // in-process auth (MULLION_AUTH_TOKEN or MULLION_OIDC_*) is also
  // configured — without that, PREVIEW_AUTH_REQUIRED would be reachable
  // by anyone who can reach the dashboard origin, defeating the gate it
  // exists to add.
  app.post<{ Params: { slug: string } }>("/api/previews/:slug/token", async (request, reply) => {
    const preview = getPreviewBySlug(app, request.params.slug);
    if (!preview) return reply.notFound();
    return { token: mintPreviewToken(app.config.MULLION_SESSION_SECRET, preview.slug) };
  });

  // Issue #1316 — lets an already-authenticated dashboard session satisfy a
  // direct/bookmarked top-level navigation to a preview URL, reached via a
  // link on the preview-auth 401 page (preview-proxy.ts's
  // buildPreviewAuthUnauthorizedHtml, rewritten client-side to point here)
  // rather than through BrowserPanel.tsx's iframe flow. A GET, because this
  // route's whole job is to BE a top-level browser navigation target (a
  // plain `<a href>` a visitor clicks, or a middle-click/bookmark of one) —
  // that only ever sends a GET, and it's what makes the dashboard's own
  // session cookie available here in the first place: a cross-origin
  // fetch() from the preview subdomain's own 401 page couldn't carry it at
  // all (httpOnly, not SameSite=None for this host — see
  // docs/auth.md's Preview-host auth token section), but a same-site
  // top-level navigation to this, the dashboard's own origin, can.
  //
  // Exempted from the ordinary /api/* auth gate (src/plugins/auth.ts's
  // isProtectedPath — see PREVIEW_OPEN_PATH_PATTERN there for why), so this
  // handler is the one place that decides what an unauthenticated visitor
  // sees. That gate's usual plain-JSON 401 is a dead end for a visitor who
  // just clicked a plain `<a href>` on the preview-auth 401 page — there's
  // no script running on that page anymore by the time this request lands
  // to interpret a JSON body, only the browser's own top-level navigation.
  // So a caller that fails the equivalent of that gate's own check
  // (isRequestAuthenticated, reused here for byte-identical semantics) is
  // redirected to PREVIEW_AUTH_DASHBOARD_URL instead — the same operator-set,
  // boot-time-validated absolute URL buildPreviewAuthUnauthorizedHtml already
  // links to, so this never sends a caller anywhere the 401 page wasn't
  // already prepared to send them. If that's unset too, there is truly
  // nowhere to send this caller, so it falls back to the same plain-JSON 401
  // the auth gate would have sent — a visitor can only ever reach this
  // route's link at all when PREVIEW_AUTH_DASHBOARD_URL is set (see that
  // function's own dashboardUrl-empty branch, which omits the link
  // entirely), so this branch is unreachable via the documented UI path; it
  // only guards a direct/guessed request to this URL.
  //
  // The target host is always "preview-<preview.slug>.<PREVIEW_BASE_HOST>"
  // — PREVIEW_BASE_HOST is fixed server config, and preview.slug comes from
  // the resolved DB row, not echoed back from request.params.slug — so this
  // can't be steered to an arbitrary redirect target by an unauthenticated
  // caller. An authenticated caller could always reach the same preview via
  // the pre-existing POST /token route instead (BrowserPanel.tsx's own
  // flow), so this adds no new capability beyond a friendlier top-level
  // entry point into it.
  app.get<{ Params: { slug: string } }>("/api/previews/:slug/open", async (request, reply) => {
    // Mirrors src/plugins/auth.ts's own onRequest hook: with in-process auth
    // disabled entirely (the default — no MULLION_AUTH_TOKEN/OIDC), that
    // hook installs no gate at all and every /api/* route is reachable
    // unauthenticated, so isRequestAuthenticated (which only ever sees "no
    // cookie, no bearer token") must not be treated as a rejection here
    // either.
    if (isAuthEnabled(app.config) && !isRequestAuthenticated(request.headers, app.config)) {
      const dashboardUrl = app.config.PREVIEW_AUTH_DASHBOARD_URL.trim();
      if (dashboardUrl) return reply.redirect(dashboardUrl);
      return reply.unauthorized("authentication required");
    }

    const preview = getPreviewBySlug(app, request.params.slug);
    if (!preview) return reply.notFound();

    const previewOrigin = `${requestScheme(request)}://preview-${preview.slug}.${app.config.PREVIEW_BASE_HOST.trim()}`;
    if (!app.config.PREVIEW_AUTH_REQUIRED) {
      // Nothing to bootstrap with the gate off — same "gate off -> no
      // token/cookie machinery involved at all" invariant preview-proxy.ts
      // itself maintains.
      return reply.redirect(`${previewOrigin}/`);
    }

    const token = mintPreviewToken(app.config.MULLION_SESSION_SECRET, preview.slug);
    return reply.redirect(
      `${previewOrigin}/?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`,
    );
  });
}
