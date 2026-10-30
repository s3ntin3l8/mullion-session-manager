import type { FastifyInstance } from "fastify";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { appVersion } from "../routes/server-info.js";
import { getCachedAgents, type DetectedAgent } from "./agent-detect.js";
import { getRemoteHostClient, HostRequestError } from "./remote-host-client.js";

/**
 * The AGENT-CLI signal — which agent CLIs a host has installed, and which
 * Mullion version it runs (issue #2240).
 *
 * Placement must not send a `codex` session to a host with no `codex`. The
 * list is volatile (someone installs or removes a CLI; the agent is updated by
 * hand), so it lives in memory beside the capacity cache, never in the hosts
 * table.
 *
 * `agents: null` means UNKNOWN, which is different from `[]` ("has none"):
 * placement fails open on unknown, and only excludes a host it KNOWS lacks the
 * CLI. An agent build that predates `/internal/agents` answers 404 and is
 * recorded as unknown, not as broken.
 */
export interface HostAgentEntry {
  /** `KNOWN_AGENTS` binaries the host has on its PATH; null when unknown. */
  agents: string[] | null;
  /** The host's Mullion version; null when it could not be read. */
  mullionVersion: string | null;
  checkedAt: number;
}

/** The agent binaries (`claude`, `codex`, …) a probe found, shells excluded. */
export function availableAgentBins(detected: readonly DetectedAgent[]): string[] {
  return detected.filter((a) => a.kind === "agent" && a.available).map((a) => a.command);
}

export class HostAgentTracker {
  private entries = new Map<string, HostAgentEntry>();
  /** Hosts with a refresh in flight, so a slow host is never stacked on. */
  readonly refreshing = new Set<string>();

  get(hostId: string): HostAgentEntry | undefined {
    return this.entries.get(hostId);
  }

  record(hostId: string, entry: Omit<HostAgentEntry, "checkedAt">, now = Date.now()): void {
    this.entries.set(hostId, { ...entry, checkedAt: now });
  }

  /** True when nothing is cached for the host or the entry is older than the TTL. */
  isStale(hostId: string, ttlMs: number, now = Date.now()): boolean {
    const entry = this.entries.get(hostId);
    return entry === undefined || now - entry.checkedAt >= ttlMs;
  }

  pruneMissing(currentIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (id !== LOCAL_HOST_ID && !currentIds.has(id)) this.entries.delete(id);
    }
  }

  /** Call when the host's baseUrl/token changes: the list described another agent. */
  invalidateHost(hostId: string): void {
    this.entries.delete(hostId);
  }

  clearForTests(): void {
    this.entries.clear();
  }
}

export function agentsTtlMs(app: FastifyInstance): number {
  return app.config.HOST_AGENTS_TTL_SECONDS * 1000;
}

/**
 * Re-reads a remote host's agent list and version into the tracker. A 404 on
 * the list (an agent build without the route) records "unknown"; any other
 * failure throws and leaves the previous entry alone (stale, but real).
 */
export async function refreshRemoteHostAgents(app: FastifyInstance, hostId: string): Promise<void> {
  const tracker = app.hostAgentTracker;
  if (!tracker || tracker.refreshing.has(hostId)) return;
  tracker.refreshing.add(hostId);
  try {
    await readRemoteHostAgents(app, tracker, hostId);
  } finally {
    tracker.refreshing.delete(hostId);
  }
}

async function readRemoteHostAgents(
  app: FastifyInstance,
  tracker: HostAgentTracker,
  hostId: string,
): Promise<void> {
  const client = getRemoteHostClient(app, hostId);
  let agents: string[] | null;
  try {
    agents = availableAgentBins(await client.detectAgents());
  } catch (err) {
    if (!(err instanceof HostRequestError && err.statusCode === 404)) throw err;
    agents = null;
  }
  let mullionVersion: string | null = null;
  try {
    mullionVersion = (await client.resolveConfig()).version ?? null;
  } catch {
    // The version is advisory; the agent list above is what gates placement.
  }
  tracker.record(hostId, { agents, mullionVersion });
}

// Per app: tests (and nothing else) build many Fastify instances in one process.
const localRefreshing = new WeakSet<FastifyInstance>();

/**
 * Fire-and-forget refresh of the primary's own list from `getCachedAgents()`
 * (which is itself stale-while-revalidate). Never throws or blocks the caller:
 * until it lands, the local host reads as unknown and placement fails open.
 */
export function refreshLocalAgents(app: FastifyInstance): void {
  const tracker = app.hostAgentTracker;
  if (!tracker || localRefreshing.has(app)) return;
  if (!tracker.isStale(LOCAL_HOST_ID, agentsTtlMs(app))) return;
  localRefreshing.add(app);
  getCachedAgents()
    .then((detected) => {
      tracker.record(LOCAL_HOST_ID, {
        agents: availableAgentBins(detected),
        mullionVersion: appVersion,
      });
    })
    .catch((err: unknown) => {
      app.log.debug({ err }, "[host-agents] local agent detection failed");
    })
    .finally(() => {
      localRefreshing.delete(app);
    });
}

/** `a` is an older version than `b` (dotted numeric compare; unparseable → false). */
export function isOlderVersion(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number);
  const pa = parse(a);
  const pb = parse(b);
  if ([...pa, ...pb].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

declare module "fastify" {
  interface FastifyInstance {
    hostAgentTracker?: HostAgentTracker;
  }
}
