import type { FastifyInstance } from "fastify";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { appVersion } from "../routes/server-info.js";
import { getCachedAgents, type DetectedAgent } from "./agent-detect.js";
import { getCachedCapabilities } from "./host-capabilities.js";
import {
  LEGACY_BASELINE,
  isProtocolCompatible,
  localProtocolInfo,
  type AgentProtocolInfo,
  type HostProtocolStatus,
} from "../shared/agent-protocol.js";
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
  /** `PLACEMENT_CAPABILITIES` the host has (issue #2306); null when unknown. */
  capabilities: string[] | null;
  /** The host's Mullion version; null when it could not be read. */
  mullionVersion: string | null;
  /** The host's `PROJECTS_ROOTS` (where a managed clone goes); absent/null when unknown. */
  projectsRoots?: string[] | null;
  /** The negotiated protocol (issue #2248); absent/null when not read yet. */
  protocol?: HostProtocol | null;
  checkedAt: number;
}

/**
 * What a host's agent advertised on `GET /internal/protocol`, or — when the
 * agent predates the route (404) — `LEGACY_BASELINE` with `legacy: true`.
 */
export interface HostProtocol extends AgentProtocolInfo {
  legacy: boolean;
}

const LEGACY_PROTOCOL: HostProtocol = { ...LEGACY_BASELINE, legacy: true };

/** The agent binaries (`claude`, `codex`, …) a probe found, shells excluded. */
export function availableAgentBins(detected: readonly DetectedAgent[]): string[] {
  return detected.filter((a) => a.kind === "agent" && a.available).map((a) => a.command);
}

export class HostAgentTracker {
  private entries = new Map<string, HostAgentEntry>();
  /** Hosts with a refresh in flight, so a slow host is never stacked on. */
  readonly refreshing = new Set<string>();
  /** Bumped by `invalidateHost`, so a read started before it cannot record. */
  private epochs = new Map<string, number>();

  epoch(hostId: string): number {
    return this.epochs.get(hostId) ?? 0;
  }

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

  /**
   * The host re-registered or was updated, so its negotiated protocol may
   * describe a previous build: forget it and make the entry stale, so the next
   * heartbeat re-reads. The agent list and capabilities are kept (stale, real).
   */
  markProtocolStale(hostId: string): void {
    const entry = this.entries.get(hostId);
    if (entry) this.entries.set(hostId, { ...entry, protocol: null, checkedAt: 0 });
  }

  /** Call when the host's baseUrl/token changes: the list described another agent. */
  invalidateHost(hostId: string): void {
    this.epochs.set(hostId, this.epoch(hostId) + 1);
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
  const epoch = tracker.epoch(hostId);
  const client = getRemoteHostClient(app, hostId);
  let agents: string[] | null;
  try {
    agents = availableAgentBins(await client.detectAgents());
  } catch (err) {
    if (!(err instanceof HostRequestError && err.statusCode === 404)) throw err;
    agents = null;
  }
  // A capabilities failure must not discard the agent list. An older agent's
  // 404 is "unknown" (null); any other failure keeps the previous reading
  // (stale, but real), like the agent list does.
  let capabilities: string[] | null = tracker.get(hostId)?.capabilities ?? null;
  try {
    capabilities = (await client.detectCapabilities()).capabilities;
  } catch (err) {
    if (err instanceof HostRequestError && err.statusCode === 404) capabilities = null;
  }
  let mullionVersion: string | null = null;
  let projectsRoots: string[] | null = tracker.get(hostId)?.projectsRoots ?? null;
  try {
    const config = await client.resolveConfig();
    mullionVersion = config.version ?? null;
    if (Array.isArray(config.projectsRoots)) projectsRoots = config.projectsRoots;
  } catch {
    // The version is advisory; the agent list above is what gates placement.
  }
  // The handshake: a 404 is an agent that predates it, which is the explicit
  // legacy baseline; any other failure keeps the previous reading.
  let protocol: HostProtocol | null = tracker.get(hostId)?.protocol ?? null;
  try {
    protocol = { ...(await client.detectProtocol()), legacy: false };
  } catch (err) {
    if (err instanceof HostRequestError && err.statusCode === 404) protocol = LEGACY_PROTOCOL;
  }
  // The host's address or token changed while we were reading: this list
  // describes the OLD agent, so it must not be recorded as fresh.
  if (tracker.epoch(hostId) !== epoch) return;
  tracker.record(hostId, { agents, capabilities, mullionVersion, projectsRoots, protocol });
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
    .then(async (detected) => {
      // A capabilities failure must not discard the agent list.
      const capabilities = await getCachedCapabilities(app).catch((err: unknown) => {
        app.log.debug({ err }, "[host-agents] local capability detection failed");
        return null;
      });
      tracker.record(LOCAL_HOST_ID, {
        agents: availableAgentBins(detected),
        capabilities,
        mullionVersion: appVersion,
        protocol: { ...localProtocolInfo(), legacy: false },
      });
    })
    .catch((err: unknown) => {
      app.log.debug({ err }, "[host-agents] local agent detection failed");
    })
    .finally(() => {
      localRefreshing.delete(app);
    });
}

/**
 * Re-reads a host's protocol soon after it re-registered or was updated: drops
 * the old reading, then refreshes best-effort (the agent may still be coming
 * back, in which case the stale entry makes the next heartbeat retry).
 */
export function refreshHostProtocolSoon(app: FastifyInstance, hostId: string): void {
  app.hostAgentTracker?.markProtocolStale(hostId);
  void refreshRemoteHostAgents(app, hostId).catch((err: unknown) => {
    app.log.debug({ err, hostId }, "[host-agents] protocol refresh failed");
  });
}

/**
 * Whether the host's agent supports `op`. Unknown (not negotiated yet) reads
 * as unsupported: callers that must fail open on unknown ask `hostProtocol`.
 * The local host is this build, so it supports everything it registers.
 */
export function hostSupports(app: FastifyInstance, hostId: string, op: string): boolean {
  if (hostId === LOCAL_HOST_ID) return localProtocolInfo().operations.includes(op);
  return hostProtocol(app, hostId)?.operations.includes(op) ?? false;
}

/** The launch options (spawn-body fields) the host's agent accepts; `[]` when unknown. */
export function hostLaunchOptions(app: FastifyInstance, hostId: string): string[] {
  if (hostId === LOCAL_HOST_ID) return localProtocolInfo().launchOptions;
  return hostProtocol(app, hostId)?.launchOptions ?? [];
}

/** The negotiated protocol for a remote host; null until first read. */
export function hostProtocol(app: FastifyInstance, hostId: string): HostProtocol | null {
  return app.hostAgentTracker?.get(hostId)?.protocol ?? null;
}

/** The Hosts API's view of a protocol; null while it is not known. */
export function protocolStatus(
  protocol: HostProtocol | null | undefined,
  registryOperations: readonly string[] = localProtocolInfo().operations,
): HostProtocolStatus | null {
  if (!protocol) return null;
  return {
    protocolVersion: protocol.legacy ? null : protocol.protocolVersion,
    incompatible: !protocol.legacy && !isProtocolCompatible(protocol.protocolVersion),
    missingOperations: registryOperations.filter((op) => !protocol.operations.includes(op)),
    legacy: protocol.legacy,
  };
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
