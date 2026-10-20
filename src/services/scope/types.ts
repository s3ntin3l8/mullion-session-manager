import type { CgroupProcess } from "../cgroup-inventory.js";

/**
 * Liveness of a scope, as the owning backend can establish it.
 *
 * "alive"   — the backend can confirm a scope owning this id is running.
 * "dead"    — a confident negative: nothing anywhere plausibly names this id.
 * "unknown" — liveness could NOT be established: an id whose ownership can't
 *              be confirmed, or a backend listing that failed/timed out.
 *
 * The trust rule this type exists to make un-ignorable: a caller that takes a
 * DESTRUCTIVE action on "not alive" (mark-exited, kill, recreate) must treat
 * "unknown" as "don't know", never silently fold it into "dead". Collapsing
 * the two mass-flips live sessions to exited on a single ambiguous row or a
 * transient error — see session-process.ts's isMasterAliveStateBatch() doc
 * comment for the full reasoning behind that landmine, and session-backend.ts's
 * livenessFromWire() for the same rule applied to a remote host's reply.
 */
export type ScopeLiveness = "alive" | "dead" | "unknown";

/**
 * Optional resource constraints for a scope.
 *
 * Expressed in platform-neutral terms; each backend maps them onto whatever
 * its platform actually offers and IGNORES the ones it cannot honor. The
 * systemd backend maps them onto cgroup v2 properties (CPUWeight=, IOWeight=,
 * CPUQuota=); a backend with no cgroup equivalent simply drops them. That is
 * why these are optional NUMBERS here rather than pre-rendered property
 * strings — a pre-rendered "CPUQuota=300%" would be systemd syntax leaking
 * into a platform-neutral type.
 */
export interface ScopeConstraints {
  /** Relative CPU weight — systemd's `CPUWeight=`. */
  cpuWeight?: number;
  /** Relative IO weight — systemd's `IOWeight=`. */
  ioWeight?: number;
  /** CPU quota as a percentage of ONE core — systemd's `CPUQuota=N%`. */
  cpuQuotaPercent?: number;
}

/**
 * Everything a backend needs to launch one detached program under a scope.
 *
 * Deliberately free of any supervisor-specific concept: the caller describes
 * the PROGRAM, and the backend decides how to keep it alive (a systemd scope,
 * a bare detached process, ...). That inversion is what makes the seam
 * portable — the program itself is identical on every platform, only the
 * supervisor around it differs.
 */
export interface ScopeLaunchSpec {
  /**
   * The id this scope belongs to, within its host — a session id, a device
   * id. The backend maps it to a scope NAME via its own naming rule; the
   * caller never composes a name itself (see SystemdScopeBackend's
   * unitNameFor() and the "crs-session-<instanceId>-<id>" scheme it wraps).
   */
  id: string;
  /**
   * The program to run, fully composed — the argv AFTER the supervisor.
   * e.g. `["dtach", "-n", "<socket>", "<shell>", "-lc", "<command>"]`.
   *
   * The supervisor is the backend's business: the systemd backend wraps this
   * in `systemd-run --user --scope ... --`, a backend with no supervisor runs
   * it directly.
   */
  argv: string[];
  /** The program's working directory. */
  cwd: string;
  /** The program's environment. */
  env: NodeJS.ProcessEnv;
  /** How long the supervisor may take before it is killed and the launch fails. */
  timeoutMs: number;
  /**
   * A short human-readable phrase for this launch, used in the backend's own
   * diagnostics — e.g. "master bootstrap" for a session's dtach master,
   * "device bootstrap" for an emulator scope.
   */
  label: string;
  /** Optional resource constraints; backends that cannot honor them ignore them. */
  constraints?: ScopeConstraints;
}

/**
 * The platform-neutral seam over "run a detached long-lived process and track
 * it" — issue #1715 (Phase 8).
 *
 * **Why this exists.** Every session this app runs is owned by a
 * `systemd --user` scope today: spawned via `systemd-run --user --scope`, with
 * liveness read from `systemctl --user list-units` and teardown via
 * `systemctl --user stop`. That made the backend Linux-only by construction,
 * which is what blocked a non-Linux host from running an agent at all (Phase 8's
 * macOS work). The seam below is the extraction that makes a second backend
 * possible without touching the session spawn path again.
 *
 * **What it is NOT.** It is not a session abstraction. It is deliberately
 * expressed in terms of a detached process and an id, because a SECOND
 * consumer already has the same shape and should be able to adopt it:
 * `src/services/device-process.ts` runs Android emulator scopes with the same
 * "crs-<kind>-<instanceId>-<id>" naming and ownership discipline
 * (see device-process.ts's own header comment, which calls itself "a
 * deliberately separate module rather than a generalization of this high-risk
 * one"). It has NOT been migrated here — that is a separate change, once a
 * second backend implementation exists to migrate it TO.
 *
 * **Where the backend is chosen.** On the host that OWNS the scope, from that
 * host's own platform — never negotiated between hosts. A primary and its
 * remote agents each run their own process and each pick their own backend, so
 * the two never have to agree on anything, and no wire format carries the
 * question. See scope/index.ts's getScopeBackend().
 */
export interface ScopeBackend {
  /** Identifies the implementation — "systemd", "detached", ... */
  readonly kind: string;

  /**
   * Launch `spec.argv` as a detached program under this backend's scope for
   * `spec.id`, resolving once the launch is confirmed.
   *
   * Rejects on a genuine launch failure (the supervisor missing, the cwd
   * gone, a non-zero exit). The rejection's message is the backend's own
   * diagnostic; callers should treat it as opaque text.
   */
  start(spec: ScopeLaunchSpec): Promise<void>;

  /**
   * Liveness for every requested id — a TOTAL map: every id in `ids` is
   * always present in the result, so no caller can mistake "this backend's
   * reply omitted the id" for a confident "dead".
   */
  isAliveBatch(ids: string[]): Promise<Record<string, ScopeLiveness>>;

  /**
   * Stop the scope owning `id`, terminating whatever it holds. Safe to call
   * for an id this host doesn't own, or one that is already gone.
   */
  stop(id: string): Promise<void>;

  /**
   * Inventory of the genuine OS processes running inside `id`'s scope — the
   * supervisor's own process, the program, and anything the program itself
   * spawned (MCP servers, background jobs, nested CLIs).
   *
   * Returns `[]` for a scope that isn't owned or active, and for any backend
   * that cannot enumerate processes on its platform — an empty list is a
   * legitimate "not supported / nothing there" answer, never an error.
   */
  listProcesses(id: string): Promise<CgroupProcess[]>;
}
