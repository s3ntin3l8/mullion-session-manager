import { spawn as spawnChild } from "node:child_process";
import {
  buildDeviceScopeArgv,
  deriveInstanceId,
  isDeviceAliveStateBatch,
  stopDeviceScope,
} from "../device-process.js";
import type { ScopeBackend, ScopeLaunchSpec, ScopeLiveness } from "./types.js";

export interface DeviceScopeBackendOptions {
  /** This instance's absolute, resolved sessions dir (the device markers live in it). */
  sessionsDir: string;
  /** Every dir this instance may own device scopes in (issue #1770). Defaults to the sessions dir. */
  ownedDirs?: ReadonlySet<string>;
}

/**
 * The Linux device-scope backend (issue #1854): an Android emulator in a
 * `systemd-run --user --scope` unit whose Description carries the marker-file
 * path that identifies it as this instance's own.
 *
 * This is the behavior `Device.spawn` had inline before the migration, moved
 * behind `ScopeBackend` unchanged — `systemd-run --scope` stays in the
 * foreground for the emulator's whole life, so its `exit` event is the "scope
 * died" signal (`onExit`), and `start()` resolves one macrotask after the
 * spawn unless the supervisor failed first.
 *
 * Ownership, liveness and teardown are device-process.ts's, including its
 * trust rule: a scope whose ownership can't be confirmed is "unknown", never
 * "dead" and never "not ours".
 */
export class SystemdDeviceScopeBackend implements ScopeBackend {
  readonly kind = "systemd-device";
  private readonly instanceId: string;
  private readonly ownedDirs: ReadonlySet<string>;

  constructor(private readonly opts: DeviceScopeBackendOptions) {
    this.instanceId = deriveInstanceId(opts.sessionsDir);
    this.ownedDirs = opts.ownedDirs ?? new Set([opts.sessionsDir]);
  }

  start(spec: ScopeLaunchSpec): Promise<void> {
    const plan = buildDeviceScopeArgv({
      id: spec.id,
      sessionsDir: this.opts.sessionsDir,
      program: spec.argv,
    });
    return new Promise<void>((resolve, reject) => {
      const child = spawnChild("systemd-run", plan.argv, {
        stdio: "ignore",
        cwd: spec.cwd,
        env: spec.env,
      });
      let settled = false;

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          spec.onExit?.({ code: null, error: err, scopeName: plan.unitName });
        }
      });

      child.on("exit", (code) => {
        if (!settled) {
          settled = true;
          if (code !== 0) {
            reject(new Error(`${spec.label} exited with code ${code} (unit ${plan.unitName})`));
          } else {
            // Exit 0 inside the bootstrap window (a mock, or a supervisor that
            // finished at once) counts as a successful launch.
            resolve();
          }
        } else {
          spec.onExit?.({ code, scopeName: plan.unitName });
        }
      });

      // systemd-run --scope runs the emulator in the foreground for its whole
      // life: once it has spawned without an immediate error or non-zero exit,
      // the launch is confirmed and the exit listener stays attached.
      setImmediate(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  async isAliveBatch(ids: string[]): Promise<Record<string, ScopeLiveness>> {
    return isDeviceAliveStateBatch(this.ownedDirs, this.instanceId, ids);
  }

  async stop(id: string): Promise<void> {
    await stopDeviceScope(this.ownedDirs, this.instanceId, id);
  }

  async listProcesses(): Promise<[]> {
    return [];
  }
}
