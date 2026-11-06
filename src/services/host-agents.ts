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
import { hosts } from "../db/schema.js";

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
  /**
   * The protocol is the last known reading, kept across a re-registration or
   * renewal while a refresh is pending (issue #2596); false/absent once read.
   */
  protocolStale?: boolean;
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
  /** The refresh in flight per host, so a gate can wait on the read already running. */
  readonly inflight = new Map<string, Promise<void>>();
  /** The bounded read a gate started per host, shared by concurrent gates (issue #2596). */
  readonly ensuring = new Map<string, Promise<HostProtocol>>();
  /** When a bounded protocol read timed out or failed (other than 404), per host (issue #2625). */
  private protocolReadFailures = new Map<string, number>();

  epoch(hostId: string): number {
    return this.epochs.get(hostId) ?? 0;
  }

  get(hostId: string): HostAgentEntry | undefined {
    return this.entries.get(hostId);
  }

  record(hostId: string, entry: Omit<HostAgentEntry, "checkedAt">, now = Date.now()): void {
    if (entry.protocol) this.protocolReadFailures.delete(hostId);
    this.entries.set(hostId, { ...entry, checkedAt: now });
  }

  recordProtocolReadFailure(hostId: string, now = Date.now()): void {
    this.protocolReadFailures.set(hostId, now);
  }

  clearProtocolReadFailure(hostId: string): void {
    this.protocolReadFailures.delete(hostId);
  }

  hasRecentProtocolReadFailure(
    hostId: string,
    ttlMs = PROTOCOL_READ_FAILURE_TTL_MS,
    now = Date.now(),
  ): boolean {
    const failedAt = this.protocolReadFailures.get(hostId);
    return failedAt !== undefined && now - failedAt < ttlMs;
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
    for (const id of this.protocolReadFailures.keys()) {
      if (id !== LOCAL_HOST_ID && !currentIds.has(id)) this.protocolReadFailures.delete(id);
    }
  }

  /**
   * The host re-registered or was updated, so its negotiated protocol may
   * describe a previous build: keep serving the last known reading (dropping it
   * would let a gate pass ungated, issue #2596), flag it stale and make the
   * entry stale, so the next heartbeat re-reads. The agent list and
   * capabilities are kept too (stale, real).
   */
  markProtocolStale(hostId: string): void {
    this.protocolReadFailures.delete(hostId);
    const entry = this.entries.get(hostId);
    if (entry) this.entries.set(hostId, { ...entry, protocolStale: true, checkedAt: 0 });
  }

  /** Call when the host's baseUrl/token changes: the list described another agent. */
  invalidateHost(hostId: string): void {
    this.epochs.set(hostId, this.epoch(hostId) + 1);
    this.entries.delete(hostId);
    this.protocolReadFailures.delete(hostId);
  }

  clearForTests(): void {
    this.entries.clear();
    this.protocolReadFailures.clear();
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
export function refreshRemoteHostAgents(app: FastifyInstance, hostId: string): Promise<void> {
  const tracker = app.hostAgentTracker;
  if (!tracker || tracker.refreshing.has(hostId)) return Promise.resolve();
  tracker.refreshing.add(hostId);
  const run = readRemoteHostAgents(app, tracker, hostId).finally(() => {
    tracker.refreshing.delete(hostId);
    tracker.inflight.delete(hostId);
  });
  tracker.inflight.set(hostId, run);
  return run;
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
  let protocolStale = tracker.get(hostId)?.protocolStale ?? false;
  try {
    protocol = { ...(await client.detectProtocol()), legacy: false };
    protocolStale = false;
  } catch (err) {
    if (err instanceof HostRequestError && err.statusCode === 404) {
      protocol = LEGACY_PROTOCOL;
      protocolStale = false;
    }
  }
  // The host's address or token changed while we were reading: this list
  // describes the OLD agent, so it must not be recorded as fresh.
  if (tracker.epoch(hostId) !== epoch) return;
  tracker.record(hostId, {
    agents,
    capabilities,
    mullionVersion,
    projectsRoots,
    protocol,
    protocolStale,
  });
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
 * Re-reads a host's protocol soon after it re-registered or was updated: marks
 * the old reading stale (still served meanwhile), then refreshes best-effort (the agent may still be coming
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
 * as the legacy baseline (issue #2596), like every gate.
 * The local host is this build, so it supports everything it registers.
 */
export function hostSupports(app: FastifyInstance, hostId: string, op: string): boolean {
  if (hostId === LOCAL_HOST_ID) return localProtocolInfo().operations.includes(op);
  return effectiveProtocol(app, hostId).operations.includes(op);
}

/** The launch options (spawn-body fields) the host's agent accepts; the legacy baseline's when unknown. */
export function hostLaunchOptions(app: FastifyInstance, hostId: string): string[] {
  if (hostId === LOCAL_HOST_ID) return localProtocolInfo().launchOptions;
  return effectiveProtocol(app, hostId).launchOptions;
}

/** Where the remedy for a gated operation lives: the per-host Update action. */
export const UPDATE_HINT =
  "update this host's Mullion from Settings → Hosts (the host's Update action)";

/** A gated operation or launch option: the host's agent cannot do it (issue #2569). */
export interface UnsupportedGate {
  ok: false;
  code: "unsupported";
  /** What the host lacks: an operation name, or the launch options it would ignore. */
  missing: string[];
  /** Points at the existing per-host Update action. */
  updateHint: string;
  /** Human-readable, names the host and what it lacks; ends with the hint. */
  message: string;
}
export type OperationGate = { ok: true } | UnsupportedGate;

/** The refusal for `op` on `hostId`: also what a 404 from an agent without the route maps to. */
export function unsupportedOperation(hostId: string, op: string): UnsupportedGate {
  return {
    ok: false,
    code: "unsupported",
    missing: [op],
    updateHint: UPDATE_HINT,
    message: `host ${hostId} does not support ${op} — ${UPDATE_HINT}`,
  };
}

/**
 * Gates an operation on the host's negotiated support. A host whose protocol
 * has not been read yet is read as the legacy baseline (issue #2596); callers
 * that can wait use `gateOperation`, which makes one bounded read first. The
 * local host always passes (as does an app with no tracker, i.e. no negotiation
 * machinery at all); a host outside the primary's protocol range fails
 * every operation.
 */
export function requireOperation(app: FastifyInstance, hostId: string, op: string): OperationGate {
  if (hostId === LOCAL_HOST_ID || !app.hostAgentTracker) return { ok: true };
  const protocol = effectiveProtocol(app, hostId);
  // "updates" is the remedy for an incompatible protocol, so it is never
  // blocked by one (only by the agent not having the route at all).
  if (op !== "updates" && !protocol.legacy && !isProtocolCompatible(protocol.protocolVersion)) {
    return {
      ...unsupportedOperation(hostId, op),
      message: `host ${hostId} speaks an incompatible agent protocol (v${protocol.protocolVersion}) — ${UPDATE_HINT}`,
    };
  }
  return protocol.operations.includes(op) ? { ok: true } : unsupportedOperation(hostId, op);
}

/**
 * Gates a launch on the options it needs. A field an agent's spawn schema does
 * not list is silently stripped, so a launch needing one is refused rather than
 * started without it. A host whose protocol has not been read yet is read as
 * the legacy baseline (issue #2596), the same as a legacy agent; callers that
 * can wait use `gateLaunchOptions`, which makes one bounded read first.
 */
export function requireLaunchOptions(
  app: FastifyInstance,
  hostId: string,
  required: readonly string[],
): OperationGate {
  if (required.length === 0 || hostId === LOCAL_HOST_ID || !app.hostAgentTracker) {
    return { ok: true };
  }
  const protocol = effectiveProtocol(app, hostId);
  const missing = required.filter((opt) => !protocol.launchOptions.includes(opt));
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    code: "unsupported",
    missing,
    updateHint: UPDATE_HINT,
    message: `host ${hostId} does not support the launch option${missing.length > 1 ? "s" : ""} ${missing.join(", ")} — ${UPDATE_HINT}`,
  };
}

/** The negotiated protocol for a remote host; null until first read. */
export function hostProtocol(app: FastifyInstance, hostId: string): HostProtocol | null {
  return app.hostAgentTracker?.get(hostId)?.protocol ?? null;
}

/** The protocol a decision should use: the last known reading, else the legacy baseline. Never cached. */
export function effectiveProtocol(app: FastifyInstance, hostId: string): HostProtocol {
  return hostProtocol(app, hostId) ?? LEGACY_PROTOCOL;
}

/** How long a gate waits for the one read it makes of an unread protocol. */
export const PROTOCOL_READ_TIMEOUT_MS = 3000;

/**
 * How long a failed or timed-out bounded protocol read is remembered per host
 * before another Auto placement attempts to read it again (issue #2625).
 */
export const PROTOCOL_READ_FAILURE_TTL_MS = 60_000;

/**
 * Makes sure a remote host's protocol is known before a gate decides on it
 * (issue #2596). A known protocol (even a stale one) returns at once. An
 * unknown one costs one bounded read through `refreshRemoteHostAgents`, shared
 * by concurrent callers and by a background refresh already running; if it
 * times out or fails (other than the 404 that records the legacy baseline),
 * this decision uses the legacy baseline and no protocol is cached. The failure
 * is remembered for `PROTOCOL_READ_FAILURE_TTL_MS` so `ensureRemoteHostProtocols`
 * stops retrying, but this function (and so every explicit gate) keeps reading.
 */
export function ensureHostProtocol(app: FastifyInstance, hostId: string): Promise<HostProtocol> {
  if (hostId === LOCAL_HOST_ID) return Promise.resolve({ ...localProtocolInfo(), legacy: false });
  const known = hostProtocol(app, hostId);
  if (known) return Promise.resolve(known);
  const tracker = app.hostAgentTracker;
  if (!tracker) return Promise.resolve(LEGACY_PROTOCOL);
  const shared = tracker.ensuring.get(hostId);
  if (shared) return shared;
  const read = (async (): Promise<HostProtocol> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const pending = tracker.inflight.get(hostId) ?? refreshRemoteHostAgents(app, hostId);
      pending.catch(() => {});
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PROTOCOL_READ_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      app.log.debug({ err, hostId }, "[host-agents] bounded protocol read failed");
    } finally {
      clearTimeout(timer);
    }
    const result = hostProtocol(app, hostId);
    if (!result) {
      tracker.recordProtocolReadFailure(hostId);
    }
    return result ?? LEGACY_PROTOCOL;
  })().finally(() => {
    tracker.ensuring.delete(hostId);
  });
  tracker.ensuring.set(hostId, read);
  return read;
}

function couldSatisfyTarget(
  h: { id: string; platform: string | null },
  target: { hostId?: string; platform?: string } | null | undefined,
): boolean {
  if (!target) return false;
  if (target.hostId !== undefined && h.id !== target.hostId) return false;
  if (target.platform === undefined) return target.hostId !== undefined;
  // A host that has not reported its platform may turn out to match.
  return (h.platform ?? "") === "" || h.platform?.toLowerCase() === target.platform.toLowerCase();
}

/**
 * `ensureHostProtocol` for registered remote hosts before a placement reads them
 * (issue #2596, #2625). `target` is the placement target the caller resolves:
 * every host that could satisfy it (the named host, or a host of the named
 * platform, or one that has not reported a platform yet) is read despite a
 * remembered failure, so a launch is never judged on a guess for its own target.
 */
export async function ensureRemoteHostProtocols(
  app: FastifyInstance,
  opts: { target?: { hostId?: string; platform?: string } | null } = {},
): Promise<void> {
  if (!app.db || !app.hostAgentTracker) return;
  const tracker = app.hostAgentTracker;
  const rows = app.db
    .select({ id: hosts.id, drained: hosts.drained, platform: hosts.platform })
    .from(hosts)
    .all();
  const toRead = rows
    .filter((h) => {
      if (h.id === LOCAL_HOST_ID) return false;
      if (h.drained) return false;
      if (app.hostHeartbeatTracker?.getHealth(h.id)?.status === "offline") return false;
      if (!couldSatisfyTarget(h, opts.target) && tracker.hasRecentProtocolReadFailure(h.id)) {
        return false;
      }
      return true;
    })
    .map((h) => h.id);
  await Promise.all(toRead.map((id) => ensureHostProtocol(app, id)));
}

/** `requireOperation` after one bounded read of an unread protocol. */
export async function gateOperation(
  app: FastifyInstance,
  hostId: string,
  op: string,
): Promise<OperationGate> {
  await ensureHostProtocol(app, hostId);
  return requireOperation(app, hostId, op);
}

/** `requireLaunchOptions` after one bounded read of an unread protocol. */
export async function gateLaunchOptions(
  app: FastifyInstance,
  hostId: string,
  required: readonly string[],
): Promise<OperationGate> {
  if (required.length > 0) await ensureHostProtocol(app, hostId);
  return requireLaunchOptions(app, hostId, required);
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
    missingLaunchOptions: localProtocolInfo().launchOptions.filter(
      (option) => !protocol.launchOptions.includes(option),
    ),
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
