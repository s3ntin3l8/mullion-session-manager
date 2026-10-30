import type { FastifyInstance } from "fastify";
import {
  LOCAL_HOST_ID,
  PLACEMENT_CAPABILITIES,
  PLACEMENT_PLATFORMS,
  type HostRole,
  type PlacementMode,
} from "../shared/constants.js";
import { listHosts } from "./host-registry.js";
import { measureHostCapacity, type HostCapacity } from "./host-capacity.js";
import { isOlderVersion, refreshLocalAgents } from "./host-agents.js";
import { appVersion } from "../routes/server-info.js";

/**
 * The PLACEMENT policy — which host should a new session run on (issue
 * #1723, roadmap 8.9).
 *
 * The fleet has a health signal (host-heartbeat.ts) and a capacity signal
 * (host-capacity.ts, issue #1721) and a per-session host (sessions.hostId,
 * issue #1722). This module turns the first two into a DECISION, for the
 * projects whose owner has opted into automatic placement.
 *
 * Two shapes, on purpose:
 *
 *   - `chooseHost()` is PURE — no DB, no network, no clock beyond what it
 *     is handed. That is what makes its whole decision table unit-testable,
 *     and what makes "placement never fails a spawn" a structural property
 *     rather than a promise: the function cannot throw and cannot return
 *     nothing.
 *   - `resolvePlacement()` is the seam that assembles the candidate set
 *     from the live trackers and logs the decision. It is what #1724 calls
 *     when a session is created or a task is claimed.
 */

/** One host the policy may choose, with everything the policy needs to judge it. */
export interface PlacementCandidate {
  hostId: string;
  /** Whether this is the primary's own host (the "local" one). */
  isLocal: boolean;
  /**
   * Online per the heartbeat. Only "online" is eligible: a degraded host
   * has already missed a ping, and an offline or pending one has never
   * answered.
   */
  online: boolean;
  /**
   * Drained/parked: the host takes no new work.
   *
   * Issue #1725 / roadmap 8.11 owns the flag — the column, the toggle, and
   * what "parked" means. It is an INTENT, not a teardown: draining a host
   * kills no session, removes no worktree and contacts no agent, and the
   * host stays usable for MANUAL placement. It only makes the host
   * ineligible for AUTOMATIC placement.
   */
  drained: boolean;
  /**
   * The host's capacity (issue #1721) — null when the host never reported
   * any. A host with no reading is NOT a failure: it is simply not a
   * candidate.
   */
  capacity: HostCapacity | null;
  /**
   * Where this project lives ON THIS HOST — null when it does not.
   *
   * Issue #1724 / roadmap 8.10. A session runs in a directory, so a host
   * that does not have the project cannot host a session for it: the
   * checkout would have to be materialized there first, which is a different
   * feature. The project's own host always has it (`projects.cwd`); every
   * other host needs the operator's map (`projects.hostCwds`).
   *
   * So a null here is NOT a failure — it is simply not a candidate, exactly
   * like a missing capacity reading.
   */
  projectCwd: string | null;
  /**
   * The host's platform ("darwin" | "linux" | "win32" | …) — null when it
   * never reported one. Issue #1951: only a TARGETED placement reads it
   * (`resolveTargetHost`); the policy's own scoring ignores it. Optional so
   * a candidate built without it keeps working.
   */
  platform?: string | null;
  /**
   * What the host is for (issue #2239). Only "burst" changes the decision: a
   * burst host is skipped unless the context allows it. Optional so a
   * candidate built without it reads as a plain worker.
   */
  role?: HostRole;
  /**
   * The agent CLIs (`claude`, `codex`, …) this host has (issue #2240). Null or
   * absent = UNKNOWN (an old agent without the route, or not fetched yet),
   * which is not "has none": placement only excludes a host it knows lacks the
   * CLI a session needs.
   */
  agents?: string[] | null;
  /**
   * The `PLACEMENT_CAPABILITIES` this host has (issue #2306). Null or absent =
   * UNKNOWN, like `agents`: only a host KNOWN to lack one is excluded.
   */
  capabilities?: string[] | null;
  /** The host's Mullion version, for flagging an agent older than the primary. */
  mullionVersion?: string | null;
}

/** What the caller knows about the session being placed. */
export interface PlacementContext {
  /**
   * The project's own host — the fallback that never fails. Used when no
   * host is eligible.
   */
  pinnedHostId: string;
  /**
   * True for an unattended session (a Task Master worker or reviewer).
   * Unattended sessions get NO local bonus: the goal is to drain the
   * primary onto the least-loaded eligible host.
   */
  unattended: boolean;
  /**
   * The local host's live capacity. The local host is measured on demand
   * rather than polled (issue #1721), so its reading arrives here rather
   * than on the candidate.
   */
  localCapacity: HostCapacity | null;
  /**
   * Whether a "burst" host may be chosen (issue #2239). False by default:
   * automatic placement and unattended Task Master leave burst hosts alone.
   * `resolveTargetHost` sets it, because a caller who NAMED a host or
   * platform asked for exactly that machine.
   */
  allowBurst?: boolean;
  /**
   * The project's `platform` allow-list (issue #2241): a host that does not
   * report one of these platforms is excluded. Empty/absent = any. Only the
   * policy path sets it — a task `Platform:`/`Host:` directive overrides the
   * project's flags, so `resolveTargetHost` never passes it for Task Master.
   */
  platforms?: readonly string[];
  /**
   * The agent CLI(s) the session needs on its host (issue #2240), as
   * `KNOWN_AGENTS` binaries. A host KNOWN to lack one is excluded; a host
   * whose list is unknown stays eligible (fail open). Absent = no CLI filter
   * (a shell, or an unrecognised command).
   */
  requiredAgent?: string | readonly string[];
  /**
   * The project's `capabilities` flag (issue #2306): a REQUIREMENT, applied
   * like `requiredAgent` — a host KNOWN to lack one is excluded, an unknown
   * list fails open. Unlike `platforms`, a Task Master `Platform:`/`Host:`
   * directive does not override it.
   */
  requiredCapabilities?: readonly string[];
  /** The primary's own version, to flag a chosen agent that runs an older one. */
  primaryVersion?: string;
}

/** One eligible host, with the numbers the policy compared. */
export interface ConsideredHost {
  hostId: string;
  /** The host's 1-minute load average, as reported. */
  loadAverage1m: number;
  /** The host's core count (os.availableParallelism). */
  logicalCores: number;
  /** The load per core — what the policy actually compares. */
  loadPerCore: number;
  /** Whether this host was chosen. */
  chosen: boolean;
}

/** One host the policy filtered out, and the first rule that did it. */
export interface ExcludedHost {
  hostId: string;
  reason: string;
}

/** The decision, and why. */
export interface PlacementDecision {
  /** The host the session should run on. Always a host id. */
  hostId: string;
  /** Why — human-readable, for the server log and the UI (#1726). */
  reason: string;
  /** The eligible hosts and their numbers, so a UI can show the table. */
  considered: ConsideredHost[];
  /**
   * The hosts that were NOT eligible, each with the reason. For the preview
   * routes and the decision log only: it names other hosts, so it never goes
   * into a refusal a session-scoped caller can read.
   */
  excluded: ExcludedHost[];
  /** True when the fallback was used (no eligible host at all). */
  fellBack: boolean;
  /**
   * Issue #2241 — set INSTEAD of the fallback when the project's `platform`
   * flag is active and no host satisfies it: the caller must not run the work
   * on `hostId` (the pinned host, kept only so the shape stays total). `detail`
   * names only the flags and the state of hosts that passed them, never other
   * hosts; `transient` = a host that satisfies the flags exists or could (it
   * is offline/parked/unreported), so waiting can help.
   */
  refusal?: { detail: string; transient: boolean; unreadable?: boolean };
}

/**
 * Load per core — the number the policy compares.
 *
 * A raw load average is not comparable between machines: load 4 on a 16-core
 * box is a quarter of its capacity, load 4 on a 4-core box is all of it. So
 * the comparison is per core, and the reason string shows BOTH numbers, so
 * a user can see the comparison that was made.
 */
function loadPerCore(capacity: HostCapacity): number {
  if (capacity.logicalCores <= 0) return capacity.loadAverage1m;
  return capacity.loadAverage1m / capacity.logicalCores;
}

/**
 * The per-host cwd map, parsed.
 *
 * `projects.hostCwds` is a JSON object `{ "<hostId>": "<absolute path>" }`.
 *
 * Parsed into a NULL-PROTOTYPE object and written with
 * `Object.defineProperty`, so a key of `__proto__` stays an ordinary own
 * property: the map's KEYS are operator-supplied and become property names,
 * and `__proto__`'s setter must never see one. A malformed or non-object
 * value yields an EMPTY map — no host is a candidate, which is the same
 * answer as "the project lives on its own host and nowhere else".
 */
export function parseHostCwds(raw: string | null | undefined): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (raw === null || raw === undefined || raw.trim() === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [hostId, cwd] of Object.entries(parsed)) {
    if (typeof cwd !== "string" || cwd.trim() === "") continue;
    Object.defineProperty(out, hostId, {
      value: cwd,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * The per-host cwd map, serialized for the column.
 *
 * The map's KEYS are operator-supplied and become property names when the
 * map is parsed back, so it is written as JSON and read back into a
 * null-prototype object (see parseHostCwds). Empty paths are dropped, and
 * an empty map serializes to null — "this project lives on its own host and
 * nowhere else", which is what an absent map means.
 */
export function serializeHostCwds(map: Record<string, string> | null | undefined): string | null {
  if (map === null || map === undefined) return null;
  const entries = Object.entries(map).filter(
    ([, cwd]) => typeof cwd === "string" && cwd.trim() !== "",
  );
  if (entries.length === 0) return null;
  // Object.fromEntries defines own properties, so a key of "__proto__" stays
  // an ordinary property — it is never handed to a prototype setter.
  return JSON.stringify(Object.fromEntries(entries));
}

/**
 * A project's placement steering flags (issue #2241), parsed.
 *
 * `platform` is an allow-list (empty = any platform); `allowBurst` lets
 * "burst" hosts take Auto work (false = they stay out, the default).
 */
export interface PlacementConstraints {
  platform: string[];
  allowBurst: boolean;
  /** Host capabilities (`PLACEMENT_CAPABILITIES`) the project needs (issue #2306). */
  capabilities: string[];
}

/**
 * `projects.placementConstraints`, parsed. Malformed, absent or unknown-valued
 * input reads as "no flags" — a bad column can only ever LOOSEN placement back
 * to its default, never wedge a project. Unknown platforms are dropped, so a
 * value the route schema would have rejected cannot narrow the set.
 */
export function parsePlacementConstraints(raw: string | null | undefined): PlacementConstraints {
  const out: PlacementConstraints = { platform: [], allowBurst: false, capabilities: [] };
  if (raw === null || raw === undefined || raw.trim() === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  const { platform, allowBurst, capabilities } = parsed as Record<string, unknown>;
  if (Array.isArray(platform)) {
    out.platform = PLACEMENT_PLATFORMS.filter((p) => platform.includes(p));
  }
  out.allowBurst = allowBurst === true;
  if (Array.isArray(capabilities)) {
    out.capabilities = PLACEMENT_CAPABILITIES.filter((c) => capabilities.includes(c));
  }
  return out;
}

/**
 * The flags, serialized for the column. Default flags (no platform list,
 * burst off, no capabilities) serialize to null — "no flags", which is what an absent column
 * means — so a cleared form never leaves a stray `{}` behind.
 */
export function serializePlacementConstraints(
  input:
    | {
        platform?: readonly string[] | null;
        allowBurst?: boolean | null;
        capabilities?: readonly string[] | null;
      }
    | null
    | undefined,
): string | null {
  if (input === null || input === undefined) return null;
  const platform = PLACEMENT_PLATFORMS.filter((p) => input.platform?.includes(p));
  const allowBurst = input.allowBurst === true;
  const capabilities = PLACEMENT_CAPABILITIES.filter((c) => input.capabilities?.includes(c));
  if (platform.length === 0 && !allowBurst && capabilities.length === 0) return null;
  return JSON.stringify({ platform, allowBurst, capabilities });
}

/** `project allows only darwin hosts` / `darwin or linux hosts` — the reason a host is excluded. */
export function describePlatformFlag(platforms: readonly string[]): string {
  return `project allows only ${platforms.join(" or ")} hosts`;
}

/** `project requires xcode` / `xcode and android-emulator` — the flag, for refusals. */
export function describeCapabilityFlag(capabilities: readonly string[]): string {
  return `project requires ${capabilities.join(" and ")}`;
}

/**
 * How a host's platform sits against a project's `platform` allow-list:
 * "ok" (listed, or no list), "unknown" (the host has not reported one — it may
 * turn out to match, so a refusal for it is transient), "forbidden" (reports
 * another platform).
 */
function platformFlagState(
  platform: string | null | undefined,
  allowed: readonly string[] | undefined,
): "ok" | "unknown" | "forbidden" {
  if (allowed === undefined || allowed.length === 0) return "ok";
  const reported = (platform ?? "").toLowerCase();
  if (reported === "") return "unknown";
  return allowed.includes(reported) ? "ok" : "forbidden";
}

/**
 * The sentinel for "the project IS on this host, but its path is not known".
 *
 * It exists for the create-project preview: a project that does not exist yet
 * lives on the host it is being created on, and its path is not chosen until
 * it is saved.
 *
 * NOT null, and that is load-bearing: null means "the project is NOT here",
 * which makes the host ineligible (the policy's rule is
 * `candidate.projectCwd !== null`). Returning null here would silently empty
 * every preview — the create-modal one would answer "nowhere" for a project
 * that is about to exist. The path is only ever READ where the project row
 * exists, so the empty string never becomes a directory.
 */
const PROJECT_PATH_UNKNOWN = "";

/**
 * The project's working directory ON a given host — null when the project is
 * not there.
 *
 * The project's own host always HAS the project — that is where its checkout
 * lives — but the path itself may be unknown (a project that does not exist
 * yet, in the create-project preview). The sentinel above says "here, but I do
 * not know where": the CALLER only needs to know the project is PRESENT
 * there, and the real path comes from the project row.
 *
 * Every other host needs the operator's map (`projects.hostCwds`). A host
 * the project is not on is not a placement candidate: a session cannot run
 * where its code is not.
 */
export function projectCwdOnHost(
  project: { hostId: string; cwd?: string },
  hostId: string,
  hostCwds: Record<string, string>,
): string | null {
  if (hostId === project.hostId) return project.cwd ?? PROJECT_PATH_UNKNOWN;
  return hostCwds[hostId] ?? null;
}

/**
 * Chooses the host for a session.
 *
 * The rules, in order:
 *
 *   1. ELIGIBLE = online per the heartbeat, not drained, has reported a
 *      capacity reading, AND HAS THE PROJECT (issue #1724: a session runs in
 *      a directory, so a host the project is not on cannot host it). A host
 *      with no reading — or no checkout — is not a candidate: that is not a
 *      failure, it is just not eligible. A "burst" host (issue #2239) is also
 *      not eligible unless `context.allowBurst` — only an explicit target
 *      reaches one. Every host that fails a rule is reported in `excluded`
 *      with the first rule it failed.
 *   2. NO ELIGIBLE HOST → the project's own host. The fallback is the whole
 *      point: a placement decision is an optimization, never a gate, and the
 *      spawn that follows must succeed either way.
 *   3. INTERACTIVE + the local host is eligible + the PROJECT's own host is
 *      the local one → the local host. Terminal latency matters to a human
 *      at a keyboard — but only when the repo is already here; for a
 *      remote-hosted project "local" is not the warm place, and the
 *      checkout would have to be materialized there anyway.
 *   4. OTHERWISE → the least loaded eligible host, per core. An unattended
 *      session lands here directly: the local host gets NO bonus, it
 *      competes on its own load — which is what drains the primary onto
 *      the fleet.
 *
 * The score is LOAD PER CORE, not the raw load average: a raw average is
 * not comparable across machines.
 */
export function chooseHost(
  candidates: PlacementCandidate[],
  context: PlacementContext,
): PlacementDecision {
  const decision = decideHost(candidates, context);
  const notes: string[] = [];
  const chosen = candidates.find((candidate) => candidate.hostId === decision.hostId);
  if (chosen !== undefined && !decision.fellBack) {
    // Issue #2240 — the session needs a CLI and this host never told us
    // whether it has it: say so rather than imply it was checked.
    if (requiredAgents(context).length > 0 && !chosen.agents) notes.push("agent list unknown");
    // Issue #2306 — likewise for a required capability the host never reported.
    if ((context.requiredCapabilities?.length ?? 0) > 0 && !chosen.capabilities) {
      notes.push("capabilities unknown");
    }
  }
  if (
    chosen?.mullionVersion &&
    context.primaryVersion &&
    isOlderVersion(chosen.mullionVersion, context.primaryVersion)
  ) {
    notes.push(`agent v${chosen.mullionVersion}, older than the primary`);
  }
  return notes.length === 0
    ? decision
    : { ...decision, reason: `${decision.reason} (${notes.join("; ")})` };
}

function requiredAgents(context: Pick<PlacementContext, "requiredAgent">): readonly string[] {
  const { requiredAgent } = context;
  if (requiredAgent === undefined) return [];
  return typeof requiredAgent === "string" ? [requiredAgent] : requiredAgent;
}

function decideHost(
  candidates: PlacementCandidate[],
  context: PlacementContext,
): PlacementDecision {
  // The local host's capacity is not on its candidate — it is measured on
  // demand (issue #1721) and arrives in the context; every other host
  // carries its own reading.
  const excluded: ExcludedHost[] = [];
  const eligible = candidates.filter((candidate) => {
    const reason = exclusionReason(candidate, context);
    if (reason !== null) excluded.push({ hostId: candidate.hostId, reason });
    return reason === null;
  });

  if (eligible.length === 0) {
    return {
      hostId: context.pinnedHostId,
      reason: `no eligible host — fell back to the project's host ${context.pinnedHostId}`,
      considered: [],
      excluded,
      fellBack: true,
    };
  }

  const considered: ConsideredHost[] = eligible.map((candidate) => {
    const capacity = (candidate.isLocal ? context.localCapacity : candidate.capacity)!;
    return {
      hostId: candidate.hostId,
      loadAverage1m: capacity.loadAverage1m,
      logicalCores: capacity.logicalCores,
      loadPerCore: loadPerCore(capacity),
      chosen: false,
    };
  });

  // The local bonus is for INTERACTIVE sessions, and only when the project's
  // own host IS the local one — i.e. when the repo is already here. For a
  // project that lives on a REMOTE host, "local" is not the warm place to
  // run it: the checkout is not on this machine, so the session would need
  // its own copy materialized there anyway (the caller's job, #1724), and
  // the latency argument does not apply. Such a project follows the same
  // least-loaded rule as an unattended one.
  const local = eligible.find((candidate) => candidate.isLocal);
  const projectIsLocal = context.pinnedHostId === LOCAL_HOST_ID;
  if (!context.unattended && local !== undefined && projectIsLocal) {
    markChosen(considered, local.hostId);
    return {
      hostId: local.hostId,
      reason: `local host preferred for an interactive session (terminal latency): ${local.hostId}`,
      considered,
      excluded,
      fellBack: false,
    };
  }

  // The least loaded eligible host, per core. `considered` is already in
  // candidate order, so the comparison is explicit about the tie-break.
  let best = eligible[0];
  let bestLoad = loadPerCore(capacityOf(best, context));
  for (const candidate of eligible.slice(1)) {
    const load = loadPerCore(capacityOf(candidate, context));
    if (isBetter(candidate, load, best, bestLoad)) {
      best = candidate;
      bestLoad = load;
    }
  }

  const bestCapacity = capacityOf(best, context);
  markChosen(considered, best.hostId);
  return {
    hostId: best.hostId,
    reason:
      `least loaded: ${best.hostId} at ${bestCapacity.loadAverage1m} load on ` +
      `${bestCapacity.logicalCores} cores (${bestLoad.toFixed(2)} per core)`,
    considered,
    excluded,
    fellBack: false,
  };
}

/**
 * Why a candidate is not eligible — the FIRST rule it fails, or null when it
 * is eligible. One function, so the filter and the reported reason cannot
 * disagree.
 */
function exclusionReason(candidate: PlacementCandidate, context: PlacementContext): string | null {
  const capacity = candidate.isLocal ? context.localCapacity : candidate.capacity;
  // Issue #2239 — checked FIRST: the role is static, while a sleeping laptop
  // is usually also offline, and "burst host" is the reason worth showing.
  if (candidate.role === "burst" && context.allowBurst !== true) {
    return "burst host (only an explicit target uses it)";
  }
  // Issue #2241 — the project's platform allow-list; static like the role, so
  // it too is reported ahead of "offline".
  const platformState = platformFlagState(candidate.platform, context.platforms);
  if (platformState === "forbidden") return describePlatformFlag(context.platforms!);
  if (platformState === "unknown") {
    return `${describePlatformFlag(context.platforms!)} (this host has not reported its platform)`;
  }
  if (!candidate.online) return "offline";
  if (candidate.drained) return "parked";
  if (capacity === null) return "no capacity reported";
  // Issue #1724 — the host must have the project: a session runs in a
  // directory, and this host's directory does not have it.
  if (candidate.projectCwd === null) return "the project has no path on this host";
  // Issue #2240 — a host KNOWN to lack the CLI cannot run the session. An
  // unknown list does not exclude (fail open); `chooseHost` notes it instead.
  const missing = missingAgent(candidate, context);
  if (missing !== null) return `no ${missing} CLI on this host`;
  // Issue #2306 — same for a required capability: known-lacking excludes,
  // unknown fails open (`chooseHost` notes it).
  const lacking = missingCapability(candidate, context);
  if (lacking !== null) return `host lacks capability: ${lacking}`;
  return null;
}

function missingCapability(
  candidate: PlacementCandidate,
  context: Pick<PlacementContext, "requiredCapabilities">,
): string | null {
  if (!candidate.capabilities) return null;
  return (
    (context.requiredCapabilities ?? []).find((c) => !candidate.capabilities!.includes(c)) ?? null
  );
}

function missingAgent(
  candidate: PlacementCandidate,
  context: Pick<PlacementContext, "requiredAgent">,
): string | null {
  if (!candidate.agents) return null;
  return requiredAgents(context).find((bin) => !candidate.agents!.includes(bin)) ?? null;
}

function capacityOf(candidate: PlacementCandidate, context: PlacementContext): HostCapacity {
  return (candidate.isLocal ? context.localCapacity : candidate.capacity)!;
}

/**
 * Is `candidate` a better choice than `best`?
 *
 * Lower load per core wins. The tie-break is deterministic and
 * deliberate: among equally-loaded hosts, the one whose id sorts first
 * wins, so two hosts reporting the same load never make the decision
 * depend on the order the trackers happened to answer in.
 */
function isBetter(
  candidate: PlacementCandidate,
  load: number,
  best: PlacementCandidate,
  bestLoad: number,
): boolean {
  if (load < bestLoad) return true;
  if (load > bestLoad) return false;
  return candidate.hostId < best.hostId;
}

function markChosen(considered: ConsideredHost[], hostId: string): void {
  for (const entry of considered) if (entry.hostId === hostId) entry.chosen = true;
}

/**
 * The candidate set as the trackers see it RIGHT NOW.
 *
 * The candidate set is built HERE, not inside the policy, so that "what is
 * eligible" is a property of the moment of the call (the trackers' current
 * readings) while the policy itself stays pure.
 */
interface CollectedCandidates {
  /** The local host's live reading (it is measured on demand, issue #1721). */
  localCapacity: HostCapacity | null;
  candidates: PlacementCandidate[];
}

/**
 * What the caller knows about the PROJECT being placed.
 *
 * Issue #1724 — the project is not everywhere: it has a path on its own
 * host (`projects.cwd`) and on every host the operator mapped it to
 * (`projects.hostCwds`). A host without the project cannot host a session
 * for it, so the map is part of what "eligible" means.
 */
interface PlacementProject {
  /** The project's own host. */
  hostId: string;
  /** The placement mode. */
  placement: PlacementMode;
  /**
   * The project's path on its own host. Optional only for a project that
   * does not exist yet (the create-project modal's preview) — where the
   * path is not known but the project WILL be on the asked-about host.
   */
  cwd?: string;
  /**
   * The project's path on OTHER hosts, as a JSON object
   * `{hostId: cwd}`. Null/empty means "this project lives on its own host
   * and nowhere else", which is every project as of that migration — so an
   * "auto" project with no map places exactly as it did before: on its own
   * host.
   */
  hostCwds?: string | null;
  /**
   * The project's steering flags (issue #2241), the raw column: a JSON object,
   * read with `parsePlacementConstraints`. Null/absent = no flags.
   */
  placementConstraints?: string | null;
}

/**
 * Reads the live trackers into a candidate set.
 *
 * THROWS when the DB read or the measurement fails — the caller decides what
 * a failure means (fall back to the project's host), because only the caller
 * knows whether this was a real placement or a preview.
 */
function collectCandidates(
  app: FastifyInstance,
  project: PlacementProject,
  needsAgents = false,
): CollectedCandidates {
  const localCapacity = measureHostCapacity(app);
  // Issue #2240 — warm the primary's own CLI list in the background; until it
  // lands the local host reads as unknown and placement fails open.
  if (needsAgents) refreshLocalAgents(app);
  // Issue #1724 — the per-host cwd map, parsed ONCE (the keys are
  // operator-supplied and become property names, so it is parsed into a
  // null-prototype object; see parseHostCwds).
  const hostCwds = parseHostCwds(project.hostCwds);
  const candidates = listHosts(app).map((host) => {
    const isLocal = host.id === LOCAL_HOST_ID;
    const health = app.hostHeartbeatTracker?.getHealth(host.id);
    return {
      hostId: host.id,
      isLocal,
      // Only "online" is eligible. The local host reads as online by
      // construction (host-heartbeat.ts says so explicitly); a remote host
      // that has never been reached reads as "pending".
      online: health?.status === "online",
      // Issue #1725 / roadmap 8.11 — the host's own drain flag: a parked
      // host takes no new work, so it is not a candidate. The flag is an
      // intent, not a teardown: nothing about the host is stopped, and it
      // stays usable for manual placement.
      drained: host.drained,
      // The local host's reading is in the context, not here (it is
      // measured live rather than polled).
      capacity: isLocal ? null : (app.hostCapacityTracker?.get(host.id)?.capacity ?? null),
      // Issue #1724 — where the project lives on THIS host. Null for a
      // host the project is not on, which makes it not a candidate.
      projectCwd: projectCwdOnHost(project, host.id, hostCwds),
      // Issue #2239 — what the host is for (burst hosts stay out of Auto).
      role: host.role,
      // Issue #2240 — the CLIs this host has (null while unknown) and its version.
      agents: app.hostAgentTracker?.get(host.id)?.agents ?? null,
      // Issue #2306 — likewise the host's capabilities (null while unknown).
      capabilities: app.hostAgentTracker?.get(host.id)?.capabilities ?? null,
      mullionVersion: isLocal
        ? appVersion
        : (app.hostAgentTracker?.get(host.id)?.mullionVersion ?? null),
      // Issue #1951 — what a targeted spawn matches `platform` against: the
      // host's self-reported platform, else its cached capacity reading's,
      // else (the local host) this process's own.
      platform: isLocal
        ? (localCapacity?.platform ?? process.platform)
        : (host.platform ?? app.hostCapacityTracker?.get(host.id)?.capacity.platform ?? null),
    };
  });
  return { localCapacity, candidates };
}

/**
 * THE decision — one implementation, two entry points.
 *
 * `announce` is the ONLY difference between a real placement and a preview:
 * a preview must not write "placement: chose a host", because no placement
 * happened. The decision itself is identical either way, which is the whole
 * point — a preview that could disagree with the spawn path would be worse
 * than no preview at all.
 *
 * A "pinned" project short-circuits: the project's own host, with the
 * reason saying so, and no scoring at all. That is what makes "pinned
 * behaves exactly as today" structural rather than accidental.
 *
 * The caller owns the EFFECT: the chosen host is where the session will
 * RUN, so the caller (#1724) has to give the session a cwd that exists
 * THERE (its own worktree on that host) — the project's cwd lives on the
 * pinned host, and a remote-placed session's cwd cannot be that path.
 * This module decides the host; it does not move files.
 *
 * The local host is eligible by default (it is this process: online per
 * the heartbeat's own rule, and measured live) — so the "no eligible host"
 * fallback is reached from here once the host is PARKED (#1725's drain
 * flag), which is exactly what parking the primary is for.
 * The fallback itself is the pure function's, and its table is pinned by
 * test/services/placement.test.ts.
 */
function decide(
  app: FastifyInstance,
  project: PlacementProject,
  unattended: boolean,
  announce: boolean,
  requiredAgent?: string | readonly string[],
): PlacementDecision {
  // Issue #2241 — the project's steering flags only bite on the "auto" path:
  // a pinned project goes to its own host whatever they say.
  const constraints = parsePlacementConstraints(project.placementConstraints);
  const platformFlag = constraints.platform.length > 0;
  const capabilityFlag = constraints.capabilities.length > 0;
  if (project.placement !== "auto") {
    const decision: PlacementDecision = {
      hostId: project.hostId,
      reason: `pinned to the project's host ${project.hostId}`,
      considered: [],
      excluded: [],
      fellBack: false,
    };
    if (announce) {
      app.log.info(
        { hostId: decision.hostId, placement: project.placement, unattended },
        "placement: pinned to the project's host",
      );
    }
    return decision;
  }

  let collected: CollectedCandidates;
  try {
    collected = collectCandidates(app, project, requiredAgent !== undefined || capabilityFlag);
  } catch (err) {
    // The seam must never fail a spawn, not just the policy: the DB read
    // or the measurement threw BEFORE chooseHost() was reached, and a
    // placement decision that cannot be made is not a reason to refuse the
    // work. Fall back to the project's own host — which is where the
    // session would have gone anyway.
    const decision: PlacementDecision = {
      hostId: project.hostId,
      reason: `placement could not be evaluated — fell back to the project's host ${project.hostId}`,
      considered: [],
      excluded: [],
      fellBack: true,
      // A platform flag forbids the silent fallback: the project's host may not
      // satisfy it, and nothing says a retry would fail too.
      ...(platformFlag || capabilityFlag
        ? {
            refusal: {
              detail: `${describeFlags(constraints.platform, constraints.capabilities)}, but the hosts could not be checked just now`,
              transient: true,
              unreadable: true,
            },
          }
        : {}),
    };
    // A FAILURE, not an announcement — so it is logged either way. The
    // `preview` flag only says which caller was asking.
    app.log.warn(
      { err, hostId: decision.hostId, placement: project.placement, preview: !announce },
      "placement: could not evaluate the candidates, using the project's host",
    );
    return decision;
  }

  const context: PlacementContext = {
    pinnedHostId: project.hostId,
    unattended,
    localCapacity: collected.localCapacity,
    allowBurst: constraints.allowBurst,
    platforms: constraints.platform,
    requiredAgent,
    requiredCapabilities: constraints.capabilities,
    primaryVersion: appVersion,
  };
  let decision = chooseHost(collected.candidates, context);
  if (decision.fellBack && (platformFlag || capabilityFlag)) {
    decision = refuseForFlags(decision, collected, context);
  }

  if (announce) {
    app.log.info(
      {
        hostId: decision.hostId,
        pinnedHostId: project.hostId,
        unattended,
        fellBack: decision.fellBack,
        considered: decision.considered,
        excluded: decision.excluded,
        reason: decision.reason,
      },
      "placement: chose a host",
    );
  }
  return decision;
}

/** The active flags in words: `project allows only darwin hosts; project requires xcode`. */
function describeFlags(platforms: readonly string[], capabilities: readonly string[]): string {
  return [
    ...(platforms.length > 0 ? [describePlatformFlag(platforms)] : []),
    ...(capabilities.length > 0 ? [describeCapabilityFlag(capabilities)] : []),
  ].join("; ");
}

/**
 * Issue #2241 / #2306 — a platform or capability flag is active and no host is eligible: turn the
 * silent fallback into a refusal.
 *
 * The reasons are built ONLY from hosts that satisfy the flags (plus a note
 * when none does), so a refusal that reaches a session-scoped caller says no
 * more about the fleet than a `Platform:` directive refusal does.
 */
function refuseForFlags(
  decision: PlacementDecision,
  collected: CollectedCandidates,
  context: PlacementContext,
): PlacementDecision {
  const flag = describeFlags(context.platforms ?? [], context.requiredCapabilities ?? []);
  // Hosts the flags let through, whatever else is wrong with them right now.
  const byPlatform = collected.candidates.filter(
    (candidate) => platformFlagState(candidate.platform, context.platforms) !== "forbidden",
  );
  const passing = byPlatform.filter(
    (candidate) => candidate.role !== "burst" || context.allowBurst === true,
  );
  const why = new Set<string>();
  for (const candidate of passing) {
    const capacity = candidate.isLocal ? collected.localCapacity : candidate.capacity;
    if (platformFlagState(candidate.platform, context.platforms) === "unknown") {
      why.add("a host that has not reported its platform yet may match once it is online");
    }
    if (!candidate.online) why.add("a matching host is offline");
    else if (candidate.drained) why.add("a matching host is parked/drained");
    else if (capacity === null) why.add("a matching host has no capacity reading yet");
    if (candidate.projectCwd === null) why.add("the project has no checkout on a matching host");
    const bin = missingAgent(candidate, context);
    if (bin !== null) why.add(`a matching host has no ${bin} CLI`);
    const lacking = missingCapability(candidate, context);
    if (lacking !== null) why.add(`a matching host lacks ${lacking}`);
  }
  if (passing.length < byPlatform.length) {
    why.add("a matching host is a burst host (this project does not allow burst hosts)");
  }
  if (byPlatform.length === 0) why.add("no host reports a matching platform");
  // Waiting helps when a passing host has the project and the CLI, and is only
  // temporarily unavailable (or has not reported its platform yet).
  const transient = passing.some(
    (candidate) =>
      candidate.projectCwd !== null &&
      missingAgent(candidate, context) === null &&
      // A host known to lack a capability never gains it by waiting.
      missingCapability(candidate, context) === null,
  );
  const detail = `no eligible host satisfies this project's placement flags (${flag}; ${[...why].join("; ")})`;
  return {
    ...decision,
    reason: `${detail} — not placed`,
    refusal: { detail, transient },
  };
}

/**
 * Assembles the candidate set from the live trackers and decides — the seam
 * #1724 calls when a session is created or a task is claimed.
 *
 * The caller owns the EFFECT: the chosen host is where the session will
 * RUN, so the caller (#1724) has to give the session a cwd that exists
 * THERE (its own worktree on that host) — the project's cwd lives on the
 * pinned host, and a remote-placed session's cwd cannot be that path.
 * This module decides the host; it does not move files.
 */
export function resolvePlacement(
  app: FastifyInstance,
  opts: {
    // The mode is TYPED, not `string`: the column's value and the shared
    // mode vocabulary are one thing (PlacementMode is derived from
    // PLACEMENT_MODES), so a mode that is not in the vocabulary cannot reach
    // this seam without the compiler saying so. A mode outside the list
    // would otherwise be silently treated as "pinned" — the safe default,
    // which makes a typo invisible rather than loud.
    project: PlacementProject;
    /** True for an unattended session (a Task Master worker or reviewer). */
    unattended: boolean;
    /** The agent CLI(s) the session needs on its host (issue #2240). */
    requiredAgent?: string | readonly string[];
  },
): PlacementDecision {
  return decide(app, opts.project, opts.unattended, true, opts.requiredAgent);
}

/**
 * Issue #1951 — WHERE a caller insists a session run: one host by id, or any
 * host of one platform. A target is a hard requirement, not a preference.
 */
export type PlacementTarget =
  // `platform` on a host target is an additional requirement ("this host, and
  // it must be a Mac") — a Task Master issue can carry both directives (#1954).
  { hostId: string; platform?: string } | { platform: string };

export type TargetPlacementResult =
  | { ok: true; decision: PlacementDecision }
  | {
      ok: false;
      detail: string;
      /**
       * Issue #2006 — whether waiting could change the answer. TRUE when a
       * host matching the target, with this project's path, EXISTS but is not
       * eligible right now (offline, parked, no capacity reading yet) — or the
       * fleet could not be read at all. FALSE when nothing could ever match
       * (no such host or platform, or none has this project's path): only
       * config can fix that. Deliberately not part of `detail`, which names
       * only the target so a session-scoped caller cannot enumerate the fleet.
       */
      transient: boolean;
      /** Only with `transient`: the fleet could not be read at all, so nothing
       * is known about any host — the caller words its hold accordingly. */
      unreadable?: boolean;
    };

/** `host <id>`, `platform <p>`, or `host <id> (platform <p>)` for a target that
 * names both. Used in refusals and the recorded placement reason. */
export function describeTarget(target: PlacementTarget): string {
  if (!("hostId" in target)) return `platform ${target.platform}`;
  return target.platform === undefined
    ? `host ${target.hostId}`
    : `host ${target.hostId} (platform ${target.platform})`;
}

/**
 * Places a session on a host the CALLER named (issue #1951) — the one place
 * "placement never fails a spawn" does not hold, on purpose: a session that
 * needs a Mac (Xcode, the iOS Simulator) running on the Linux fallback would
 * just fail later, so an unsatisfiable target is REFUSED instead.
 *
 * The candidates are narrowed to the target, then the usual `chooseHost`
 * scoring picks among them — so "eligible" means exactly what it means for
 * automatic placement (online, not drained, has a capacity reading, and the
 * project lives there — `projects.hostCwds`). It runs for a `pinned` project
 * too: an explicit target does not depend on the project's placement mode.
 *
 * The refusal names only the TARGET the caller asked for, never other hosts:
 * a session-scoped caller must not be able to enumerate the fleet through it.
 */
/**
 * Why nothing matching a target is eligible, in words a coordinator can act
 * on. Built ONLY from the hosts that already match the requested target (plus
 * whether any host has yet to report a platform), so a session-scoped caller
 * learns nothing about hosts it did not ask for.
 */
function refusalReasons(
  matching: PlacementCandidate[],
  localCapacity: HostCapacity | null,
  all: PlacementCandidate[],
  wantedPlatform: string | undefined,
  wantedHost: string | null,
): string[] {
  const why = new Set<string>();
  for (const candidate of matching) {
    if (!candidate.online) why.add("a matching host is offline");
    else if (candidate.drained) why.add("a matching host is parked/drained");
    else if ((candidate.isLocal ? localCapacity : candidate.capacity) === null) {
      why.add("a matching host has no capacity reading yet");
    }
    if (candidate.projectCwd === null) why.add("the project has no checkout on a matching host");
  }
  if (matching.length === 0) {
    const named = wantedHost === null ? undefined : all.find((c) => c.hostId === wantedHost);
    if (wantedHost !== null && named === undefined) {
      why.add("no such host");
    } else if (wantedHost !== null && wantedPlatform !== undefined) {
      // The caller named this host, so saying what it reports leaks nothing — and
      // the fleet-wide claim below would be untrue when another host has `p`.
      why.add(
        (named?.platform ?? "") === ""
          ? `the named host has not reported its platform yet, so it cannot be confirmed as ${wantedPlatform}`
          : `the named host reports platform ${named?.platform}, not ${wantedPlatform}`,
      );
    } else if (wantedPlatform !== undefined) {
      why.add(`no host has reported platform ${wantedPlatform}`);
      if (all.some((c) => (c.platform ?? "") === "")) {
        why.add("a host that has not reported its platform yet may match once it is online");
      }
    }
    // A host-only target with an existing host always lands in `matching`, so
    // nothing above applies to it today; never leave a refusal without a reason
    // if `matching` ever narrows further.
    if (why.size === 0) why.add("no matching host is available");
  }
  return [...why];
}

export function resolveTargetHost(
  app: FastifyInstance,
  opts: {
    project: PlacementProject;
    target: PlacementTarget;
    /** True for an unattended session (a Task Master worker or reviewer). */
    unattended: boolean;
    /** Who asked, for the recorded reason: "the caller's request" by default
     * (an explicit child spawn); Task Master passes "the task's requirement"
     * so a past placement reads right (#1954/#1852). */
    requestedBy?: string;
    /** The agent CLI(s) the session needs on its host (issue #2240). */
    requiredAgent?: string | readonly string[];
    /**
     * Issue #2241 — check the target against the PROJECT's `platform` flag. Set
     * by an explicit launcher/caller target; left off for a Task Master
     * directive, which overrides the project's flags. (`allowBurst` never
     * applies here: naming a host or platform is the opt-in to burst hosts.)
     * The `capabilities` flag is NOT governed by this: it is a requirement and
     * is always applied (issue #2306).
     */
    checkProjectFlags?: boolean;
  },
): TargetPlacementResult {
  const refusal = (
    transient: boolean,
    unreadable = false,
    why: string[] = [],
  ): TargetPlacementResult => ({
    ok: false,
    detail: `no eligible host matches ${describeTarget(opts.target)}${why.length > 0 ? ` (${why.join("; ")})` : ""}`,
    transient,
    ...(unreadable ? { unreadable } : {}),
  });

  // Issue #2306 — a capability is a requirement: always applied, even to a
  // Task Master directive (which overrides only the platform flag).
  const constraints = parsePlacementConstraints(opts.project.placementConstraints);
  const requiredCapabilities = constraints.capabilities;

  let collected: CollectedCandidates;
  try {
    collected = collectCandidates(
      app,
      opts.project,
      opts.requiredAgent !== undefined || requiredCapabilities.length > 0,
    );
  } catch (err) {
    app.log.warn({ err, target: opts.target }, "placement: could not evaluate a targeted spawn");
    // Could not read the fleet: nothing says a retry would fail too.
    return refusal(true, true, ["the host list could not be read"]);
  }

  const wantedPlatform = opts.target.platform?.toLowerCase();
  const wantedHost = "hostId" in opts.target ? opts.target.hostId : null;
  const flagPlatforms = opts.checkProjectFlags ? constraints.platform : [];
  const targeted = collected.candidates.filter(
    (candidate) =>
      (wantedHost === null || candidate.hostId === wantedHost) &&
      (wantedPlatform === undefined || (candidate.platform ?? "").toLowerCase() === wantedPlatform),
  );
  // Issue #2241 — a target the project's platform flag forbids is not matched.
  const matching = targeted.filter(
    (candidate) => platformFlagState(candidate.platform, flagPlatforms) === "ok",
  );

  const agentContext = { requiredAgent: opts.requiredAgent, requiredCapabilities };
  const decision = chooseHost(matching, {
    pinnedHostId: opts.project.hostId,
    unattended: opts.unattended,
    localCapacity: collected.localCapacity,
    // The caller NAMED this host or platform, so a burst host is in scope.
    allowBurst: true,
    requiredAgent: opts.requiredAgent,
    requiredCapabilities,
    primaryVersion: appVersion,
  });
  // chooseHost falls back to the pinned host when nothing is eligible; for a
  // target that is exactly the case to refuse.
  if (decision.fellBack) {
    // Issue #2006 — a host that matches the target AND has this project's
    // path exists; it is just not eligible yet (offline, parked, no capacity
    // reading), so waiting can help. With none, only a config change can.
    //
    // A host that has not reported a platform yet (a Mac still offline after a
    // backend restart) cannot be told apart from a match, so for a platform
    // target it counts too — it may turn out to be one.
    const mightMatch = collected.candidates.some(
      (candidate) =>
        candidate.projectCwd !== null &&
        platformFlagState(candidate.platform, flagPlatforms) !== "forbidden" &&
        // A host known to lack the CLI never gains it by waiting.
        missingAgent(candidate, agentContext) === null &&
        missingCapability(candidate, agentContext) === null &&
        (wantedHost === null || candidate.hostId === wantedHost) &&
        (wantedPlatform === undefined ||
          (candidate.platform ?? "").toLowerCase() === wantedPlatform ||
          (candidate.platform ?? "") === ""),
    );
    const why = refusalReasons(
      matching,
      collected.localCapacity,
      collected.candidates,
      wantedPlatform,
      wantedHost,
    );
    for (const candidate of matching) {
      const bin = missingAgent(candidate, agentContext);
      if (bin !== null) why.push(`a matching host has no ${bin} CLI`);
      const lacking = missingCapability(candidate, agentContext);
      if (lacking !== null) why.push(`a matching host lacks ${lacking}`);
    }
    // The target exists but the project's flag rules it out; the caller named
    // it, so saying what the project allows leaks nothing.
    if (targeted.length > matching.length) why.push(describePlatformFlag(flagPlatforms));
    return refusal(mightMatch, false, [...new Set(why)]);
  }

  const decorated: PlacementDecision = {
    ...decision,
    reason: `placed on ${describeTarget(opts.target)} at ${opts.requestedBy ?? "the caller's request"} — ${decision.reason}`,
  };
  app.log.info(
    { hostId: decorated.hostId, target: opts.target, reason: decorated.reason },
    "placement: chose a host for a targeted spawn",
  );
  return { ok: true, decision: decorated };
}

/**
 * The SAME decision, without announcing it — the live preview #1726's UI
 * asks for ("where would a new session land right now, and why?").
 *
 * It reads the same trackers and runs the same policy as the spawn path, so
 * it cannot drift from what would actually happen; it only differs in that
 * it writes no "placement: chose a host" line, because no placement
 * happened. The project's own host and mode are passed in rather than read
 * from the DB, so this also works for a project that does not exist yet
 * (the create-project modal's preview).
 *
 * The answer is a NOW reading: load moves between the preview and the
 * spawn. The UI says so.
 */
export function previewPlacement(
  app: FastifyInstance,
  opts: {
    project: PlacementProject;
    /**
     * True for an unattended session (a Task Master worker or reviewer).
     * Defaults to false — a preview answers the question a human is asking,
     * and a human creates an interactive session.
     */
    unattended?: boolean;
    /** The agent CLI the launch would need on its host (issue #2240). */
    requiredAgent?: string | readonly string[];
  },
): PlacementDecision {
  return decide(app, opts.project, opts.unattended ?? false, false, opts.requiredAgent);
}
