import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { previews, sessions } from "../db/schema.js";
import { parseDevServerPort } from "./dev-server-detect.js";
import { resolveDevServerHostId } from "./dev-server-host.js";
import { getComposeServices, mapServicesToProject } from "./docker-service-detect.js";
import { LOCAL_HOST_ID, getHostRow } from "./host-registry.js";
import { getProjectById } from "./project-store.js";
import { listLocalProjectCwds } from "./project-records.js";
import {
  CHECKOUT_BRANCH,
  getOrCreateProjectPreview,
  getOrCreatePortPreview,
  isPortPreviewBranch,
  readProjectPreviewTargets,
} from "./preview-registry.js";
import { resolvePreviewTarget } from "./preview-upstream.js";
import { resolveSessionHostId } from "./session-host.js";
import { getStoredSettings } from "./settings.js";
import { DOCKER_STACK_SESSION_NAME_PREFIX } from "../shared/constants.js";

// #3003 — "where this project can be opened right now": the Browser pane's
// quick pick (its address bar's "▾", both modes). One list built from the
// sources that each know a part of it, in the order the owner decided:
//
// 1. Running now: Dock commands whose output printed a dev server banner
//    (dev-server-detect.ts), and Compose services that publish a port
//    (docker-service-detect.ts), each labelled with its stack. Both are
//    detected on this server only, so a project on another host gets none,
//    and `runningNote` says why.
// 2. Saved for the project: its dev server (`devServerUrl`), its named
//    preview targets, and its branch previews.
//
// Recent addresses (the third group) are the browser's own, kept client-side.
//
// Read-only: listing never creates a preview row. Opening a running entry in
// the preview goes through `openRunningDestinationPreview`, which re-derives
// the port from live discovery, so a client names an entry, never a port.

export type BrowserDestinationKind = "dev-server" | "dock" | "compose" | "target" | "branch";

export interface BrowserDestination {
  /** Stable id of the entry: `dev-server`, `dock:<sessionId>`,
   * `compose:<stack>:<service>:<port>`, `target:<id>`, `branch:<slug>`. */
  key: string;
  group: "running" | "saved";
  kind: BrowserDestinationKind;
  label: string;
  /** Secondary text: the port, the stack, the destination. */
  detail: string | null;
  /** The address as seen from `hostId` (a bare port is that host's
   * `localhost`), or null when there is none to show. */
  address: string | null;
  /** The host the address is on: where `localhost` in it points. */
  hostId: string;
  /** A branch preview's slug. */
  previewSlug: string | null;
  /** A named target's id. */
  targetId: string | null;
}

export interface BrowserDestinations {
  destinations: BrowserDestination[];
  /** Why the running group is empty or incomplete, or null. */
  runningNote: string | null;
}

function localAddress(port: number): string {
  return `http://localhost:${port}/`;
}

/** A dev server URL or target destination as an address: a bare port is
 * the host's own `localhost`, `host:port` shorthand is http. */
function addressOf(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{1,5}$/.test(trimmed)) return localAddress(Number(trimmed));
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function hostName(app: FastifyInstance, hostId: string): string {
  return getHostRow(app, hostId)?.name ?? hostId;
}

interface RunningDock {
  sessionId: number;
  label: string;
  port: number;
}

/** The project's live Dock commands on this server with a detected port. A
 * session bound to a branch preview is left out: the saved group lists it. */
function runningDockCommands(app: FastifyInstance, projectId: number): RunningDock[] {
  const rows = app.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, projectId),
        eq(sessions.kind, "dock"),
        eq(sessions.status, "active"),
      ),
    )
    .all();
  if (rows.length === 0) return [];
  const branchBound = new Set(
    app.db
      .select({ sessionId: previews.sessionId, branch: previews.branch })
      .from(previews)
      .where(
        and(
          eq(previews.projectId, projectId),
          inArray(
            previews.sessionId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .all()
      .filter((p) => p.branch !== CHECKOUT_BRANCH && !isPortPreviewBranch(p.branch))
      .map((p) => p.sessionId),
  );
  const out: RunningDock[] = [];
  for (const row of rows.sort((a, b) => a.id - b.id)) {
    if (branchBound.has(row.id)) continue;
    // A Compose service's log stream is listed as the service itself.
    if (row.dockControlId?.startsWith("docker:")) continue;
    if (row.name?.startsWith(DOCKER_STACK_SESSION_NAME_PREFIX)) continue;
    if (resolveSessionHostId(app, row) !== LOCAL_HOST_ID) continue;
    // Only this process's own PTYs have a scrollback to read.
    const pty = app.pty.get(String(row.id));
    if (!pty) continue;
    const port = parseDevServerPort(pty.getScrollback().toString("utf8"));
    if (!port) continue;
    out.push({
      sessionId: row.id,
      label: row.name || row.dockControlId || `Dock session ${row.id}`,
      port: Number(port),
    });
  }
  return out;
}

interface RunningCompose {
  stack: string;
  service: string;
  port: number;
}

async function runningComposeServices(
  app: FastifyInstance,
  project: { cwd: string },
): Promise<RunningCompose[]> {
  if (!getStoredSettings(app.db).dock.dockerServices) return [];
  const all = await getComposeServices();
  const owned = mapServicesToProject(all, project.cwd, listLocalProjectCwds(app.db));
  const out: RunningCompose[] = [];
  for (const svc of owned) {
    if (svc.state !== "running") continue;
    for (const port of svc.publishedPorts ?? []) {
      out.push({ stack: svc.composeProject, service: svc.service, port });
    }
  }
  return out;
}

/** The project's destinations, or undefined for an unknown project. */
export async function listBrowserDestinations(
  app: FastifyInstance,
  projectId: number,
): Promise<BrowserDestinations | undefined> {
  const project = getProjectById(app, projectId);
  if (!project) return undefined;
  const destinations: BrowserDestination[] = [];

  let runningNote: string | null = null;
  if (project.hostId === LOCAL_HOST_ID) {
    for (const dock of runningDockCommands(app, project.id)) {
      destinations.push({
        key: `dock:${dock.sessionId}`,
        group: "running",
        kind: "dock",
        label: dock.label,
        detail: `Dock · port ${dock.port}`,
        address: localAddress(dock.port),
        hostId: LOCAL_HOST_ID,
        previewSlug: null,
        targetId: null,
      });
    }
    for (const svc of await runningComposeServices(app, project)) {
      destinations.push({
        key: `compose:${svc.stack}:${svc.service}:${svc.port}`,
        group: "running",
        kind: "compose",
        label: svc.service,
        detail: `${svc.stack} · port ${svc.port}`,
        address: localAddress(svc.port),
        hostId: LOCAL_HOST_ID,
        previewSlug: null,
        targetId: null,
      });
    }
  } else {
    runningNote = `Running services are detected only for projects on this server, not on ${hostName(app, project.hostId)}.`;
  }

  const saved = readProjectPreviewTargets(app, project.id);
  if (saved?.devServerUrl) {
    destinations.push({
      key: "dev-server",
      group: "saved",
      kind: "dev-server",
      label: "Dev server",
      detail: saved.devServerUrl,
      address: addressOf(saved.devServerUrl),
      hostId: await resolveDevServerHostId(app, project),
      previewSlug: null,
      targetId: null,
    });
  }
  for (const target of saved?.targets ?? []) {
    destinations.push({
      key: `target:${target.id}`,
      group: "saved",
      kind: "target",
      label: target.name,
      detail: target.destination,
      address: addressOf(target.destination),
      hostId: target.connectionOrigin === "primary" ? LOCAL_HOST_ID : project.hostId,
      previewSlug: null,
      targetId: target.id,
    });
  }
  const branches = app.db
    .select()
    .from(previews)
    .where(and(eq(previews.kind, "project"), eq(previews.projectId, project.id)))
    .all()
    .filter((row) => row.branch !== CHECKOUT_BRANCH && !isPortPreviewBranch(row.branch))
    .sort((a, b) => a.branch.localeCompare(b.branch));
  for (const row of branches) {
    const owner = row.sessionId
      ? app.db.select().from(sessions).where(eq(sessions.id, row.sessionId)).get()
      : undefined;
    destinations.push({
      key: `branch:${row.slug}`,
      group: "saved",
      kind: "branch",
      label: row.branch,
      detail: "Branch preview",
      address: row.upstreamPort !== null ? localAddress(row.upstreamPort) : null,
      hostId: owner ? resolveSessionHostId(app, owner) : project.hostId,
      previewSlug: row.slug,
      targetId: null,
    });
  }

  return { destinations, runningNote };
}

export type RunningPreviewResult =
  { ok: true; slug: string; label: string } | { ok: false; status: 404; message: string };

/**
 * Opens a running entry in the preview: the slug of the preview that serves
 * its port. A port the project's dev server already names opens the
 * project's own preview; any other port gets a port preview
 * (`getOrCreatePortPreview`). The port comes from this server's live
 * discovery, looked up by the entry's key, so a key that no longer names a
 * running entry is refused rather than trusted.
 */
export async function openRunningDestinationPreview(
  app: FastifyInstance,
  projectId: number,
  key: string,
): Promise<RunningPreviewResult | undefined> {
  const project = getProjectById(app, projectId);
  if (!project) return undefined;
  const gone: RunningPreviewResult = {
    ok: false,
    status: 404,
    message: "That service is no longer running",
  };
  if (project.hostId !== LOCAL_HOST_ID) return gone;

  let port: number | null = null;
  let sessionId: number | null = null;
  let label = "";
  const dock = /^dock:(\d+)$/.exec(key);
  if (dock) {
    const found = runningDockCommands(app, project.id).find((d) => d.sessionId === Number(dock[1]));
    if (found) ({ port, sessionId, label } = found);
  } else if (key.startsWith("compose:")) {
    const found = (await runningComposeServices(app, project)).find(
      (svc) => `compose:${svc.stack}:${svc.service}:${svc.port}` === key,
    );
    if (found) {
      port = found.port;
      label = found.service;
    }
  }
  if (port === null) return gone;

  // The port the dev server names opens the project's own preview, but only
  // while that preview is served from this host: a checkout preview bound to
  // a session elsewhere (#3425) would show another machine's port.
  const devServer = project.devServerUrl ? addressOf(project.devServerUrl) : null;
  if (devServer) {
    const url = new URL(devServer);
    const local = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname);
    if (local && Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port) {
      const checkout = getOrCreateProjectPreview(app, project.id);
      const resolved = await resolvePreviewTarget(app, checkout.slug);
      if (
        resolved.ok &&
        resolved.target.kind === "project" &&
        resolved.target.hostId === LOCAL_HOST_ID
      ) {
        return { ok: true, slug: checkout.slug, label };
      }
    }
  }
  return { ok: true, slug: getOrCreatePortPreview(app, project.id, port, sessionId).slug, label };
}
