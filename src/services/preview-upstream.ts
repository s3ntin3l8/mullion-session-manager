// How the preview proxy resolves a preview slug to the upstream it serves
// (moved out of plugins/preview-proxy.ts for #3373, unchanged, so the Browser
// pane's "open in the other browser" (services/browser-handoff.ts) answers
// from the same resolution the proxy dials).
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, projectPreviewTargets } from "../db/schema.js";
import { resolveExecutionContext } from "./execution-context.js";
import { getPreviewBySlug } from "./preview-registry.js";
import { resolveDevServerHostId } from "./dev-server-host.js";
import { LOCAL_HOST_ID } from "./host-registry.js";

// The two things a resolved preview can point at (see resolvePreviewTarget
// below) — either a project's dev server (local, or remote via its owning
// agent — issue #28 phase 6) or an arbitrary external URL (issue #28 phase
// 5, SSRF-guarded at creation time in src/routes/previews.ts, and since
// issue #250 re-validated *and* IP-pinned at connect time here too — see
// previewUrlPolicy in plugins/preview-proxy.ts). All resolve to a base URL via resolveUpstreamBase
// and proxy identically from that point on — subdomain-based previews
// don't rewrite paths, so "a project's dev server" and "an external site"
// are just two ways to obtain that base.
export type PreviewTarget =
  | { kind: "project"; devServerUrl: string; projectId: number; hostId: string }
  | { kind: "external"; url: string }
  | { kind: "target"; url: string; hostId: string };

export function resolveUpstreamBase(target: PreviewTarget): URL {
  if (target.kind === "external" || target.kind === "target") return new URL(target.url);
  // A bare port ("5173") means "this same machine" — see projects.ts's
  // isValidDevServerUrl. A full URL's host (and path — see
  // plugins/preview-proxy.ts's buildUpstreamUrl) is honored as-is for a *local* project (this
  // process trusts itself, same admin-trust level as hosts.ts's own
  // baseUrl). For a *remote*-hosted project (hostId !== LOCAL_HOST_ID),
  // only this URL's port and path are ever used (see
  // isRemoteProjectTarget's callers in plugins/preview-proxy.ts) — its host, if any, is
  // discarded, since the owning agent forces the actual connection to its
  // own loopback (issue #28 phase 6, and projects.ts's own
  // isValidDevServerUrl comment). This function itself stays host-agnostic
  // either way — it just parses whatever devServerUrl names.
  if (/^\d{1,5}$/.test(target.devServerUrl)) {
    return new URL(`http://127.0.0.1:${target.devServerUrl}/`);
  }
  return new URL(target.devServerUrl);
}

// A URL's `.port` is "" when the URL has no explicit port (protocol
// default) — Number("") is 0, not a usable port, so this can't just be
// `Number(url.port)`. Exported for routes/projects.ts's dev-server-status
// route (issue #522), which needs the same port-only-forwarding rule the
// preview proxy already follows for remote previews — see this module's own
// PreviewTarget handling and schema.ts's devServerUrl comment ("only the
// port is forwarded, never the host").
export function portFromUrl(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

// Shared by both the HTTP handler (handlePreviewRequest) and the WS upgrade
// handler (handlePreviewWsUpgrade) in plugins/preview-proxy.ts — slug -> preview -> target
// resolution and its error cases are identical for both transports, only
// what happens with a *resolved* target differs (fetch() vs. opening a
// `ws` connection).
//
// Finding AS15: this used to carry a `message` field with internal detail
// (the slug, the numeric project id) that both call sites in plugins/preview-proxy.ts sent
// straight back to an unauthenticated client (the WS path already never
// used it — rejectUpgrade only ever takes a bare status line). That
// undermines the whole point of the auth-before-slug-resolution ordering
// the preview proxy otherwise deliberately maintains (see evaluatePreviewAuth's own
// comment): if the response body itself leaks "no such preview" vs. "preview
// exists but its project has no devServerUrl" vs. "preview exists and is
// reachable," the 404-vs-503-vs-200 status split alone was never the only
// existence oracle. The detail is still worth having — just server-side
// only, via the app.log.warn calls below — so this now returns nothing more
// than a status code to the caller; the client-facing body is always the
// same fixed PREVIEW_UNAVAILABLE_MESSAGE (see handlePreviewRequest).
export type PreviewResolution =
  { ok: true; target: PreviewTarget } | { ok: false; status: 404 | 503 };

export async function resolvePreviewTarget(
  app: FastifyInstance,
  slug: string,
): Promise<PreviewResolution> {
  const preview = getPreviewBySlug(app, slug);
  if (!preview) {
    app.log.warn({ slug }, "preview proxy: unknown preview slug");
    return { ok: false, status: 404 };
  }

  if (preview.kind === "target") {
    const [named] = app.db
      .select()
      .from(projectPreviewTargets)
      .where(eq(projectPreviewTargets.id, preview.targetId ?? ""))
      .all();
    if (!named || named.projectId !== preview.projectId) return { ok: false, status: 404 };
    const [owner] = app.db.select().from(projects).where(eq(projects.id, named.projectId)).all();
    if (!owner) return { ok: false, status: 404 };
    return {
      ok: true,
      target: {
        kind: "target",
        url: named.destination,
        hostId: named.connectionOrigin === "primary" ? LOCAL_HOST_ID : owner.hostId,
      },
    };
  }
  if (preview.kind === "external") {
    if (!preview.externalUrl) return { ok: false, status: 404 };
    return { ok: true, target: { kind: "external", url: preview.externalUrl } };
  }

  if (preview.projectId === null) return { ok: false, status: 404 };
  const [project] = app.db.select().from(projects).where(eq(projects.id, preview.projectId)).all();
  if (!project) return { ok: false, status: 404 };
  // The bound session owns the target: its host (never the project's) is
  // where the dev server runs, and "localhost" in the project's devServerUrl
  // means that host. A bound session that can't be resolved is unavailable,
  // not a reason to fall back to the project's host (issue #2247); only a
  // preview with no session at all is project-default, i.e. explicitly
  // project-scoped, and then the dev server runs where its preview control does
  // (a dock control can be started on another host, #3425).
  let hostId: string;
  if (preview.sessionId !== null) {
    const ctx = await resolveExecutionContext(
      app,
      { projectId: project.id, sessionId: preview.sessionId },
      { trustSessionCwd: true },
    );
    if (!ctx.ok) {
      app.log.warn(
        { slug, sessionId: preview.sessionId, error: ctx.error },
        "preview proxy: the bound session's host is unavailable",
      );
      return { ok: false, status: 503 };
    }
    hostId = ctx.context.hostId;
  } else if (preview.upstreamPort !== null && !preview.portPreview) {
    // A branch preview's port only means something on its session's host.
    return { ok: false, status: 503 };
  } else if (preview.portPreview) {
    // #3003 — a port preview with no session: a running Compose service's
    // published port, which is only discovered on the project's own host
    // (docker-service-detect.ts), or a Dock command's port whose session row
    // was since deleted (SET NULL). Both were picked from this host's own
    // discovery, which only covers local projects. Like the checkout preview,
    // the row keeps serving the port after the service stops; nothing prunes
    // it yet (follow-up issue linked from the PR).
    hostId = project.hostId;
  } else {
    hostId = await resolveDevServerHostId(app, project);
  }
  // Issues #2016/#2018 — a branch preview targets the port its own dock
  // session was told to bind, never the project's devServerUrl (which serves
  // the checkout).
  if (preview.upstreamPort !== null) {
    return {
      ok: true,
      target: {
        kind: "project",
        devServerUrl: String(preview.upstreamPort),
        projectId: project.id,
        hostId,
      },
    };
  }
  if (!project.devServerUrl) {
    app.log.warn(
      { slug, projectId: project.id },
      "preview proxy: project has no devServerUrl configured",
    );
    return { ok: false, status: 503 };
  }
  return {
    ok: true,
    target: { kind: "project", devServerUrl: project.devServerUrl, projectId: project.id, hostId },
  };
}
