import type { CgroupProcess } from "../cgroup-inventory.js";
import {
  describeScope,
  invalidateOwnedScopesCache,
  isMasterAliveStateBatch,
  listSessionProcesses,
  scopeUnitName,
  stopScope,
} from "../session-process.js";
import { spawnScopeProcess } from "./spawn.js";
import type { ScopeBackend, ScopeConstraints, ScopeLaunchSpec, ScopeLiveness } from "./types.js";

/**
 * The default scope-name prefix — "crs-session-<instanceId>-<id>".
 *
 * A prefix is a parameter rather than a hardcoded literal because the seam
 * this backend implements is deliberately NOT session-specific: the Android
 * device scopes in `src/services/device-process.ts` have the same
 * "crs-<kind>-<instanceId>-<id>" shape and are expected to adopt this
 * backend later (they have NOT been migrated here — that is a separate
 * change, once a second backend implementation exists to migrate them TO).
 */
const DEFAULT_SCOPE_PREFIX = "crs-session";

export interface SystemdScopeBackendOptions {
  /** This instance's absolute, resolved sessions dir. */
  sessionsDir: string;
  /** This instance's id — `deriveInstanceId(sessionsDir)`. */
  instanceId: string;
  /** Scope-name prefix; defaults to "crs-session". */
  prefix?: string;
}

/**
 * The `systemd --user` implementation of the scope seam — issue #1715.
 *
 * This is the backend every Linux host uses today, and it is a WRAPPER: the
 * systemd-specific behavior lives in `src/services/session-process.ts`,
 * unchanged, and this class only adapts it to the interface. That is
 * deliberate — session-process.ts is one of the highest-risk files in this
 * repo (see its own header comment and docs/architecture.md's "non-obvious
 * session model" note), and a refactor that MOVED its logic would be far
 * harder to review as behavior-preserving than one that leaves it in place
 * and calls it.
 *
 * What the systemd scope actually buys a session, and why a second backend
 * is needed at all:
 *
 *   1. **Survival.** The scope lives in systemd's own (Unix-user-global)
 *      namespace, not in this Node process's cgroup, so a `systemctl --user
 *      restart` of the Mullion service — whose default KillMode=control-group
 *      SIGTERMs everything in the *service's* cgroup — leaves the session's
 *      dtach master and program running. A master spawned as a plain child
 *      would die right along with it, silently defeating the whole
 *      "sessions survive redeploys" premise.
 *   2. **Liveness and teardown.** `systemctl --user list-units` answers "is it
 *      still running?", and `systemctl --user stop` ends it.
 *
 * (1) is the part a host without systemd has to re-implement by other means;
 * (2) is the part that has to be re-implemented differently. Both live behind
 * this class.
 */
export class SystemdScopeBackend implements ScopeBackend {
  readonly kind = "systemd";

  private readonly prefix: string;

  constructor(private readonly opts: SystemdScopeBackendOptions) {
    this.prefix = opts.prefix ?? DEFAULT_SCOPE_PREFIX;
  }

  /**
   * The transient unit's name for `id` — `crs-session-<instanceId>-<id>` by
   * default. Namespaced per Mullion instance because a scope's unit name
   * lives in a Unix-user-global systemd namespace while `sessions.id` is
   * per-database, so two Mullion backends on one host would otherwise
   * collide on a low id (issue #1140). See session-process.ts's scopeUnitName()
   * for the full reasoning.
   */
  private unitNameFor(id: string): string {
    return scopeUnitName(this.opts.instanceId, id, this.prefix);
  }

  /**
   * Launches `spec.argv` inside a fresh transient systemd scope.
   *
   * The scope is created with `--scope` (the program runs as a child of
   * systemd-run, inside the scope's own cgroup) and `--collect` (the unit is
   * garbage-collected once it finishes, so a crashed run can't leave a unit
   * squatting on the name — see the collision diagnostic below).
   */
  async start(spec: ScopeLaunchSpec): Promise<void> {
    const unitName = this.unitNameFor(spec.id);
    await spawnScopeProcess({
      command: "systemd-run",
      argv: [
        "--user",
        "--scope",
        "--collect",
        "-u",
        unitName,
        ...constraintArgs(spec.constraints),
        "--",
        ...spec.argv,
      ],
      cwd: spec.cwd,
      env: spec.env,
      timeoutMs: spec.timeoutMs,
      label: spec.label,
      scopeName: unitName,
      // Issue #1541 — a scope may have been created; never let a cached
      // pre-spawn listing mask it. Same reason the original code dropped the
      // cache on both the error and the exit path.
      onSettled: invalidateOwnedScopesCache,
      // Issue #1137's investigation: `systemd-run --collect` refuses to
      // create a transient scope whose unit name already exists — the far
      // more likely cause of a non-zero exit here than a genuine
      // `systemd-run`/`dtach` problem, since a fresh master's OWN scope name
      // has never existed before. describeScope() checks whether that name is
      // currently squatted and, if so, names the squatter instead of leaving
      // the next investigation to rediscover this by hand. Best-effort: on
      // any probe failure/timeout it resolves `null`, and the message falls
      // back to the plain text, unchanged from before this diagnostic
      // existed.
      //
      // Issue #1140 (PR 2) — the unit name is namespaced by this instance's
      // own instanceId (derived from sessionsDir), so a squatter here can
      // only be a scope THIS SAME instance already created (a stale process
      // from before a restart, still running under a session id this fresh
      // boot happens to reuse) — never a different Mullion instance. NOT "a
      // leaked test run" — a test run's own throwaway sessionsDir derives a
      // DIFFERENT instanceId, so it could never squat on this instance's
      // namespaced name in the first place.
      describeFailure: async () => {
        const squatter = await describeScope(this.opts.instanceId, spec.id, this.prefix);
        if (!squatter) return null;
        return (
          `a scope named ${unitName}.scope already exists and is running "${squatter}". ` +
          `Scope names are namespaced per Mullion instance but not per session restart, so a ` +
          `leftover scope from this same instance (a stale process from before a restart) ` +
          `with this same id blocks this one. Run ` +
          `\`systemctl --user stop ${unitName}.scope\` if it's not a session you still need.`
        );
      },
    });
  }

  isAliveBatch(ids: string[]): Promise<Record<string, ScopeLiveness>> {
    return isMasterAliveStateBatch(this.opts.sessionsDir, this.opts.instanceId, ids, this.prefix);
  }

  stop(id: string): Promise<void> {
    return stopScope(this.opts.sessionsDir, this.opts.instanceId, id, this.prefix);
  }

  listProcesses(id: string): Promise<CgroupProcess[]> {
    return listSessionProcesses(this.opts.sessionsDir, this.opts.instanceId, id, this.prefix);
  }
}

/**
 * Renders platform-neutral constraints into systemd's cgroup v2 property
 * syntax — `-p CPUWeight=100 -p IOWeight=100 [-p CPUQuota=300%]`.
 *
 * Only the constraints that were actually specified are emitted, so a
 * constraint a platform cannot honor is simply absent rather than rendered
 * as a property systemd would reject.
 */
function constraintArgs(constraints: ScopeConstraints | undefined): string[] {
  if (!constraints) return [];
  const args: string[] = [];
  if (constraints.cpuWeight !== undefined) {
    args.push("-p", `CPUWeight=${constraints.cpuWeight}`);
  }
  if (constraints.ioWeight !== undefined) {
    args.push("-p", `IOWeight=${constraints.ioWeight}`);
  }
  if (constraints.cpuQuotaPercent !== undefined) {
    args.push("-p", `CPUQuota=${constraints.cpuQuotaPercent}%`);
  }
  return args;
}
