// "Open this address in the other browser" (#3373, docs/design/one-browser-pane/
// note.md). The Browser pane's two engines see addresses differently: the
// preview is an iframe in the user's tab, loaded through the preview proxy
// (`preview-<slug>.<host>`), and the agent's browser is a Chromium on the host
// the session's browser target names. This service translates between them,
// read-only: it never binds a browser, never fixes an endpoint, never launches
// anything, so asking is free.
//
// - Preview -> agent: the address the agent's browser loads for a project
//   preview. The preview's upstream comes from the proxy's own resolution
//   (resolvePreviewTarget/resolveUpstreamBase), and the host it is read from
//   comes from the session's browser target. A loopback upstream (a bare dev
//   server port, `localhost`) belongs to one machine, so it only travels when
//   the agent's browser runs on that same machine; there it is `localhost`.
// - Agent -> preview: which of the project's previews serves a page the agent's
//   browser shows, so the preview opens that target through the proxy. A
//   loopback page that is none of them is refused: `localhost` means a
//   different machine to each engine.
//
// The preview proxy's bootstrap token never enters here: the frontend names a
// preview by its slug, never by the iframe's address.
import type { FastifyInstance } from "fastify";
import { and, eq, ne } from "drizzle-orm";
import { previews, projectPreviewTargets, projects, sessions } from "../db/schema.js";
import {
  portFromUrl,
  resolvePreviewTarget,
  resolveUpstreamBase,
  type PreviewTarget,
} from "./preview-upstream.js";
import { bindingBrowserTarget } from "./browser-binding-target.js";
import { resolveExecutionContext } from "./execution-context.js";
import { LOCAL_HOST_ID, getHostRow } from "./host-registry.js";
import { CHECKOUT_BRANCH, getPreviewBySlug } from "./preview-registry.js";
import { listSessionBrowserBindings } from "./session-browsers.js";

type SessionRow = typeof sessions.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/** Where an upstream lives, as one engine or the other can reach it. */
interface Upstream {
  url: URL;
  /** The host whose loopback `url` names, or null when `url` names a host
   * any machine can reach by name. */
  loopbackHostId: string | null;
}

export type AddressForAgentResult = { ok: true; url: string } | { ok: false; reason: string };

export type PreviewForAddressResult =
  | {
      kind: "project";
      /** A branch preview's slug; absent for the project's checkout preview. */
      previewSlug?: string;
      /** A named preview target; the client opens it (POST /api/previews). */
      targetId?: string;
      /** What the pane's title names: the branch or target, or "" for the checkout. */
      label: string;
      /** Path, query and hash below the upstream's own base path. */
      path: string;
    }
  | { kind: "external"; url: string }
  | { kind: "disabled"; reason: string };

/** `localhost`, `*.localhost`, 127.0.0.0/8, `[::1]`, and the unspecified
 * addresses (`0.0.0.0`, `[::]`), which a browser dials as its own loopback:
 * each names one machine's own, whichever machine dials it. */
export function isLoopbackHostname(hostname: string): boolean {
  // A trailing dot is the root-qualified form (`localhost.`), which a browser
  // resolves the same way; URL keeps it on a name.
  const h = hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h === "0.0.0.0") return true;
  // IPv4-mapped loopback, as URL normalizes it ([::ffff:7f00:1]).
  if (/^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(h)) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

function hostLabel(app: FastifyInstance, hostId: string): string {
  if (hostId === LOCAL_HOST_ID) return "the Mullion server";
  return getHostRow(app, hostId)?.name ?? hostId;
}

/** The host the session's browser runs on, as its browser target names it: the
 * recorded binding when there is one (an open browser never moves), otherwise
 * the host its first bind would pick. Never binds. */
async function sessionBrowserHostId(
  app: FastifyInstance,
  session: SessionRow,
  project: ProjectRow,
): Promise<{ ok: true; hostId: string } | { ok: false; reason: string }> {
  const [binding] = listSessionBrowserBindings(app, session.id);
  if (binding) {
    const target = bindingBrowserTarget(project, binding);
    if (target) return { ok: true, hostId: target.hostId };
  }
  const ctx = await resolveExecutionContext(app, { projectId: project.id, sessionId: session.id });
  if (!ctx.ok) return { ok: false, reason: ctx.error.message };
  return { ok: true, hostId: ctx.context.hostId };
}

/** A resolved preview target as an address, and whose loopback it is. Mirrors
 * how the proxy dials it: a remote project's dev server is always its host's
 * loopback (only the port and path are used), a local one is dialled as
 * written, and a named target is dialled from its connection origin. */
function upstreamOf(target: PreviewTarget): Upstream | null {
  let base: URL;
  try {
    base = resolveUpstreamBase(target);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  if (target.kind === "external") return { url: base, loopbackHostId: null };
  if (target.kind === "project" && target.hostId !== LOCAL_HOST_ID) {
    const url = new URL(base.href);
    url.hostname = "localhost";
    url.port = String(portFromUrl(base));
    return { url, loopbackHostId: target.hostId };
  }
  return isLoopbackHostname(base.hostname)
    ? { url: base, loopbackHostId: target.hostId }
    : { url: base, loopbackHostId: null };
}

/** `url` as the agent's browser on `browserHostId` must load it. */
function addressFrom(
  app: FastifyInstance,
  upstream: Upstream,
  browserHostId: string,
): AddressForAgentResult {
  if (upstream.loopbackHostId === null) return { ok: true, url: upstream.url.href };
  if (upstream.loopbackHostId !== browserHostId) {
    return {
      ok: false,
      reason: `The dev server runs on ${hostLabel(app, upstream.loopbackHostId)}, and this session's browser on ${hostLabel(app, browserHostId)}`,
    };
  }
  const url = new URL(upstream.url.href);
  url.hostname = "localhost";
  return { ok: true, url: url.href };
}

function loadSessionAndProject(
  app: FastifyInstance,
  sessionId: number,
): { session: SessionRow; project: ProjectRow } | null {
  const [session] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  if (!session) return null;
  const [project] = app.db.select().from(projects).where(eq(projects.id, session.projectId)).all();
  return project ? { session, project } : null;
}

/** The project's checkout preview (no branch) as a resolvable target, even
 * before its preview row exists: the proxy would resolve it the same way. */
async function checkoutTarget(
  app: FastifyInstance,
  project: ProjectRow,
): Promise<PreviewTarget | null> {
  const [row] = app.db
    .select({ slug: previews.slug })
    .from(previews)
    .where(
      and(
        eq(previews.kind, "project"),
        eq(previews.projectId, project.id),
        eq(previews.branch, CHECKOUT_BRANCH),
      ),
    )
    .all();
  if (row) {
    const resolved = await resolvePreviewTarget(app, row.slug);
    return resolved.ok ? resolved.target : null;
  }
  if (!project.devServerUrl) return null;
  return {
    kind: "project",
    devServerUrl: project.devServerUrl,
    projectId: project.id,
    hostId: project.hostId,
  };
}

/**
 * Preview -> agent's browser: the address the session's browser loads for the
 * project preview the pane shows. `slug` names a branch or target preview; no
 * slug means the project's checkout preview (its dev server).
 */
export async function addressForAgent(
  app: FastifyInstance,
  sessionId: number,
  slug: string | undefined,
): Promise<AddressForAgentResult | null> {
  const loaded = loadSessionAndProject(app, sessionId);
  if (!loaded) return null;
  const { session, project } = loaded;

  let target: PreviewTarget | null;
  if (slug) {
    const preview = getPreviewBySlug(app, slug);
    // Only this project's own previews: an external preview's address is the
    // one the user typed, which the client sends as is.
    if (!preview || preview.kind === "external" || preview.projectId !== project.id) {
      return { ok: false, reason: "This preview is not one of this session's project" };
    }
    const resolved = await resolvePreviewTarget(app, slug);
    target = resolved.ok ? resolved.target : null;
  } else {
    target = await checkoutTarget(app, project);
  }
  const upstream = target ? upstreamOf(target) : null;
  if (!upstream) return { ok: false, reason: "This preview has no address to open" };

  const host = await sessionBrowserHostId(app, session, project);
  if (!host.ok) return { ok: false, reason: host.reason };
  return addressFrom(app, upstream, host.hostId);
}

function pathBelow(base: URL, page: URL): string {
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const rest = page.pathname.startsWith(prefix)
    ? page.pathname.slice(prefix.length - 1)
    : page.pathname === base.pathname
      ? "/"
      : null;
  return `${rest ?? "/"}${page.search}${page.hash}`;
}

function sameServer(page: URL, upstream: Upstream, browserHostId: string): boolean {
  const pageLoopback = isLoopbackHostname(page.hostname);
  if (page.protocol !== upstream.url.protocol) return false;
  if (pageLoopback) {
    return (
      upstream.loopbackHostId === browserHostId && portFromUrl(page) === portFromUrl(upstream.url)
    );
  }
  return (
    upstream.loopbackHostId === null &&
    page.hostname.toLowerCase() === upstream.url.hostname.toLowerCase() &&
    portFromUrl(page) === portFromUrl(upstream.url)
  );
}

/**
 * Agent's browser -> preview: which preview shows the page `address` the
 * session's browser is on. One of the project's dev servers or preview targets
 * opens that target through the proxy; any other http(s) page opens as an
 * external address, except a loopback one, which would be a different machine
 * in the preview.
 */
export async function previewForAddress(
  app: FastifyInstance,
  sessionId: number,
  address: string,
): Promise<PreviewForAddressResult | null> {
  const loaded = loadSessionAndProject(app, sessionId);
  if (!loaded) return null;
  const { session, project } = loaded;

  let page: URL;
  try {
    page = new URL(address);
  } catch {
    return { kind: "disabled", reason: "The agent's browser has no page open" };
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") {
    return { kind: "disabled", reason: "Only http and https pages can open in the preview" };
  }

  const host = await sessionBrowserHostId(app, session, project);
  if (!host.ok) return { kind: "disabled", reason: host.reason };

  const checkout = await checkoutTarget(app, project);
  const checkoutUp = checkout ? upstreamOf(checkout) : null;
  if (checkoutUp && sameServer(page, checkoutUp, host.hostId)) {
    return { kind: "project", label: "", path: pathBelow(checkoutUp.url, page) };
  }

  const branches = app.db
    .select({ slug: previews.slug, branch: previews.branch })
    .from(previews)
    .where(
      and(
        eq(previews.kind, "project"),
        eq(previews.projectId, project.id),
        ne(previews.branch, CHECKOUT_BRANCH),
      ),
    )
    .all();
  for (const row of branches) {
    const resolved = await resolvePreviewTarget(app, row.slug);
    const up = resolved.ok ? upstreamOf(resolved.target) : null;
    if (up && sameServer(page, up, host.hostId)) {
      return {
        kind: "project",
        previewSlug: row.slug,
        label: row.branch,
        path: pathBelow(up.url, page),
      };
    }
  }

  const named = app.db
    .select()
    .from(projectPreviewTargets)
    .where(eq(projectPreviewTargets.projectId, project.id))
    .all();
  for (const t of named) {
    const up = upstreamOf({
      kind: "target",
      url: t.destination,
      hostId: t.connectionOrigin === "primary" ? LOCAL_HOST_ID : project.hostId,
    });
    if (up && sameServer(page, up, host.hostId)) {
      return { kind: "project", targetId: t.id, label: t.name, path: pathBelow(up.url, page) };
    }
  }

  if (isLoopbackHostname(page.hostname)) {
    return {
      kind: "disabled",
      reason: `${page.host} is not one of this project's dev servers, and localhost in the preview is your own machine, not ${hostLabel(app, host.hostId)}`,
    };
  }
  return { kind: "external", url: page.href };
}
