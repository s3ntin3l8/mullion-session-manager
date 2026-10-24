import type { FastifyInstance } from "fastify";
import { LOCAL_HOST_ID, type PlacementMode } from "../shared/constants.js";
import { listHosts } from "./host-registry.js";
import { measureHostCapacity, type HostCapacity } from "./host-capacity.js";

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
   * Drained/parked.
   *
   * Issue #1725 owns the flag itself — the column, the toggle, and what
   * "parked" means. This issue only CONSULTS it, so the eligibility rule
   * is in place from the start and #1725 only has to add the storage and
   * the switch, not the policy. Until then, every candidate is
   * `drained: false`.
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

/** The decision, and why. */
export interface PlacementDecision {
  /** The host the session should run on. Always a host id. */
  hostId: string;
  /** Why — human-readable, for the server log and the UI (#1726). */
  reason: string;
  /** The eligible hosts and their numbers, so a UI can show the table. */
  considered: ConsideredHost[];
  /** True when the fallback was used (no eligible host at all). */
  fellBack: boolean;
}

/**
 * Load per core — the number the policy compares.
 *
 * A raw load average is not comparable across machines: load 4 on a 16-core
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
 * The project's working directory ON a given host, falling back to the
 * project's own root when the map has nothing for it.
 *
 * For a host the project is not on, the fallback is the PROJECT's own root —
 * which is wrong for that host, and is why this is only for callers that
 * already know the host has the project (a session joining its worker's
 * host, say). `projectCwdOnHost` is the honest version: it returns null.
 */
export function projectCwdForHost(
  project: { hostId: string; cwd: string; hostCwds?: string | null },
  hostId: string,
): string {
  return projectCwdOnHost(project, hostId, parseHostCwds(project.hostCwds)) ?? project.cwd;
}

/**
 * The project's working directory ON a given host — null when the project is
 * not there.
 *
 * The project's own host has it at `projects.cwd`; every other host needs
 * the operator's map (`projects.hostCwds`). A host the project is not on is
 * not a placement candidate: a session cannot run where its code is not.
 */
export function projectCwdOnHost(
  project: { hostId: string; cwd: string },
  hostId: string,
  hostCwds: Record<string, string>,
): string | null {
  if (hostId === project.hostId) return project.cwd;
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
 *      failure, it is just not eligible.
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
 *      the idle machine.
 *
 * Ties break deterministically (the local host first, then the host id), so
 * the same inputs always give the same answer and the tests are exact.
 */
export function chooseHost(
  candidates: readonly PlacementCandidate[],
  context: PlacementContext,
): PlacementDecision {
  // The local host's capacity is measured live rather than polled, so it
  // arrives in the context; every other host carries its own reading.
  const eligible = candidates.filter((candidate) => {
    const capacity = candidate.isLocal ? context.localCapacity : candidate.capacity;
    return (
      candidate.online &&
      !candidate.drained &&
      capacity !== null &&
      // Issue #1724 — the host must have the project: a session runs in a
      // directory, and this host's directory does not have it.
      candidate.projectCwd !== null
    );
  });

  if (eligible.length === 0) {
    return {
      hostId: context.pinnedHostId,
      reason: `no eligible host — fell back to the project's host ${context.pinnedHostId}`,
      considered: [],
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
    fellBack: false,
  };
}

/** The capacity a candidate is judged by — the local host's live reading wins. */
function capacityOf(candidate: PlacementCandidate, context: PlacementContext): HostCapacity {
  return (candidate.isLocal ? context.localCapacity : candidate.capacity)!;
}

/**
 * Whether `candidate` beats `best`: less load per core wins; a tie goes to
 * the local host, and a further tie to the lexicographically smaller id — so
 * the answer never depends on the order the candidates arrived in.
 */
function isBetter(
  candidate: PlacementCandidate,
  candidateLoad: number,
  best: PlacementCandidate,
  bestLoad: number,
): boolean {
  if (candidateLoad !== bestLoad) return candidateLoad < bestLoad;
  if (candidate.isLocal !== best.isLocal) return candidate.isLocal;
  return candidate.hostId < best.hostId;
}

function markChosen(considered: ConsideredHost[], hostId: string): void {
  for (const entry of considered) {
    if (entry.hostId === hostId) entry.chosen = true;
  }
}

/**
 * Assembles the candidate set from the live trackers and decides — the seam
 * #1724 calls when a session is created or a task is claimed.
 *
 * The candidate set is built HERE, not inside the policy, so that "what is
 * eligible" is a property of the moment of the call (the trackers' current
 * readings) while the policy itself stays pure.
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
 * The local host is always eligible (it is this process: online per the
 * heartbeat's own rule, and measured live), so the "no eligible host"
 * fallback is reached from here only once #1725's drain flag can park it.
 * The fallback itself is the pure function's, and its table is pinned by
 * test/services/placement.test.ts.
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
    project: {
      hostId: string;
      placement: PlacementMode;
      /** The project's path on this host (issue #1724). */
      cwd: string;
      /**
       * The project's path on OTHER hosts, as a JSON object
       * `{hostId: cwd}` (issue #1724). Null/empty means "this project lives
       * on its own host and nowhere else", which is every project as of that
       * migration — so an "auto" project with no map places exactly as it
       * did before: on its own host.
       */
      hostCwds?: string | null;
    };
    /** True for an unattended session (a Task Master worker or reviewer). */
    unattended: boolean;
  },
): PlacementDecision {
  const { project, unattended } = opts;

  if (project.placement !== "auto") {
    const decision: PlacementDecision = {
      hostId: project.hostId,
      reason: `pinned to the project's host ${project.hostId}`,
      considered: [],
      fellBack: false,
    };
    app.log.info(
      { hostId: decision.hostId, placement: project.placement, unattended },
      "placement: pinned to the project's host",
    );
    return decision;
  }

  // The local host is measured on demand (issue #1721) — it is this
  // process, so its reading is always fresh.
  let localCapacity: HostCapacity | null;
  let candidates: PlacementCandidate[];
  // Issue #1724 — the per-host cwd map, parsed ONCE (the keys are
  // operator-supplied and become property names, so it is parsed into a
  // null-prototype object; see parseHostCwds).
  const hostCwds = parseHostCwds(project.hostCwds);
  try {
    localCapacity = measureHostCapacity(app);
    candidates = listHosts(app).map((host) => {
      const isLocal = host.id === LOCAL_HOST_ID;
      const health = app.hostHeartbeatTracker?.getHealth(host.id);
      return {
        hostId: host.id,
        isLocal,
        // Only "online" is eligible. The local host reads as online by
        // construction (host-heartbeat.ts says so explicitly); a remote host
        // that has never been reached reads as "pending".
        online: health?.status === "online",
        // Issue #1725 owns the drain flag; until it lands, nothing is drained.
        drained: false,
        // The local host's reading is in the context, not here (it is
        // measured live rather than polled).
        capacity: isLocal ? null : (app.hostCapacityTracker?.get(host.id)?.capacity ?? null),
        // Issue #1724 — where the project lives on THIS host. Null for a
        // host the project is not on, which makes it not a candidate.
        projectCwd: projectCwdOnHost(project, host.id, hostCwds),
      };
    });
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
      fellBack: true,
    };
    app.log.warn(
      { err, hostId: decision.hostId, placement: project.placement },
      "placement: could not evaluate the candidates, using the project's host",
    );
    return decision;
  }

  const decision = chooseHost(candidates, {
    pinnedHostId: project.hostId,
    unattended,
    localCapacity,
  });

  app.log.info(
    {
      hostId: decision.hostId,
      pinnedHostId: project.hostId,
      unattended,
      fellBack: decision.fellBack,
      considered: decision.considered,
      reason: decision.reason,
    },
    "placement: chose a host",
  );
  return decision;
}
