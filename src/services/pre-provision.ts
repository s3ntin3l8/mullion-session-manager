import type { FastifyInstance } from "fastify";
import { projects } from "../db/schema.js";
import { startMaterialize } from "./checkout-materialize.js";
import { listHosts } from "./host-registry.js";
import { parseHostCwds, parsePlacementConstraints, platformFlagState } from "./placement.js";
import { cachedProjectOrigin, hostProjectsRoots, warmProjectOriginUrl } from "./project-origin.js";

// Per-project `preProvision`: clone a project's checkout onto hosts AHEAD of
// the first placement. `"none"` (the default) / `"all"` / a list of host ids,
// stored as JSON in a nullable column.

export type PreProvision = "none" | "all" | string[];

const MAX_PRE_PROVISION_HOSTS = 32;

export function parsePreProvision(raw: string | null | undefined): PreProvision {
  if (!raw) return "none";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === "all") return "all";
    if (Array.isArray(parsed)) {
      const ids = [
        ...new Set(parsed.filter((v): v is string => typeof v === "string" && v !== "")),
      ];
      return ids.length === 0 ? "none" : ids.slice(0, MAX_PRE_PROVISION_HOSTS);
    }
  } catch {
    // fall through
  }
  return "none";
}

/** The column value: null for "none" (and an empty list). */
export function serializePreProvision(value: PreProvision | null | undefined): string | null {
  if (value === undefined || value === null || value === "none") return null;
  if (value === "all") return JSON.stringify("all");
  return value.length === 0 ? null : JSON.stringify(value.slice(0, MAX_PRE_PROVISION_HOSTS));
}

type ProjectRow = typeof projects.$inferSelect;

/**
 * The hosts `project` should have a managed checkout on right now but does
 * not: online, not parked, not a burst host unless allowed, not the project's
 * own host, no path yet, platform flag and capabilities not ruling it out, and
 * not known to lack projects roots.
 */
export function preProvisionTargets(
  app: FastifyInstance,
  project: ProjectRow,
  onlyHostId?: string,
): string[] {
  const mode = parsePreProvision(project.preProvision);
  if (mode === "none") return [];
  if (cachedProjectOrigin(app, project) === null) return [];
  const mapped = parseHostCwds(project.hostCwds);
  const constraints = parsePlacementConstraints(project.placementConstraints);
  const out: string[] = [];
  for (const host of listHosts(app)) {
    if (onlyHostId !== undefined && host.id !== onlyHostId) continue;
    if (mode !== "all" && !mode.includes(host.id)) continue;
    if (host.id === project.hostId || Object.hasOwn(mapped, host.id)) continue;
    if (host.drained) continue;
    if (!host.isLocal && app.hostHeartbeatTracker?.getHealth(host.id)?.status !== "online")
      continue;
    if (host.role === "burst" && !constraints.allowBurst) continue;
    // The same source placement reads: the host's own report, else its capacity reading.
    const platform = host.isLocal
      ? process.platform
      : (host.platform ?? app.hostCapacityTracker?.get(host.id)?.capacity.platform ?? null);
    if (platformFlagState(platform, constraints.platform) !== "ok") continue;
    const capabilities = app.hostAgentTracker?.get(host.id)?.capabilities;
    if (capabilities && constraints.capabilities.some((c) => !capabilities.includes(c))) continue;
    const roots = hostProjectsRoots(app, host.id);
    if (roots !== null && roots.length === 0) continue;
    out.push(host.id);
  }
  return out;
}

/** Starts a materialize job for every host pre-provisioning selects. Returns how many. */
export async function runPreProvisionSweep(
  app: FastifyInstance,
  opts: { onlyHostId?: string } = {},
): Promise<number> {
  let started = 0;
  for (const project of app.db.select().from(projects).all()) {
    if (parsePreProvision(project.preProvision) === "none") continue;
    // Warm the origin first: a remote project's is read in the background, so
    // the targets below would otherwise see "unknown" on the very first run.
    await warmProjectOriginUrl(app, project);
    for (const hostId of preProvisionTargets(app, project, opts.onlyHostId)) {
      startMaterialize(app, project.id, hostId);
      started++;
    }
  }
  return started;
}
