import { readFileSync } from "node:fs";

// The service this process runs as: a systemd --user unit on Linux, a
// launchd agent on macOS (issue #1718, roadmap 8.4). Renamed from
// systemd-unit.ts because it is no longer systemd-only — the resolution
// below branches on the platform, and the update path's restart step does
// the same.

// Fallback when neither an explicit override nor cgroup autodetection
// resolves a real unit — matches the systemd --user unit this repo's own
// deploy/mullion.service installs. A dev checkout (`make dev`, no systemd
// unit at all) never actually restarts anything with this name: MULLION_HOME
// is empty there, so POST /api/updates/apply refuses before self-update.sh
// is ever invoked (see src/routes/updates.ts).
export const DEFAULT_SERVICE_UNIT = "mullion.service";

// The macOS counterpart (issue #1718, roadmap 8.4): on darwin the "service"
// this process runs as is a launchd agent, and what the self-update has to
// restart is its LABEL, not a systemd unit name. The installer writes the
// label into the job's MULLION_SERVICE_UNIT, so the override below normally
// carries it — this default is the fallback for a manual invocation.
export const DEFAULT_LAUNCHD_LABEL = "com.mullion.primary";

/**
 * The launchd label for a role — the counterpart of the systemd unit names
 * (mullion.service / mullion-agent.service). Baked into the installed plist
 * and into MULLION_SERVICE_UNIT, so it is effectively permanent for a given
 * install.
 */
export function launchdLabelForRole(role: string): string {
  return role === "agent" ? "com.mullion.agent" : DEFAULT_LAUNCHD_LABEL;
}

// A systemd --user cgroup v2 path looks like:
//   0::/user.slice/user-1000.slice/user@1000.service/app.slice/mullion.service
// `user@<uid>.service` is always an ANCESTOR segment, not the app's own
// unit — matching the first/any ".service" substring would resolve that
// ancestor and `systemctl --user restart` it instead of the app, a real
// foot-gun. Only the rightmost (leaf) segment is the process's own unit.
const SERVICE_LEAF_PATTERN = /([^/\n]+\.service)\s*$/;

/**
 * Parses `/proc/self/cgroup`-style contents and returns the leaf systemd
 * unit name, or null if the leaf segment isn't a `.service` (e.g. running
 * under a `.scope` — self-update.sh's own `mullion-update-<version>` wrapper
 * scope, or a plain dev process with no unit at all).
 */
export function resolveServiceUnitFromCgroup(cgroupContents: string): string | null {
  const trimmed = cgroupContents.trim();
  if (!trimmed) return null;
  const match = SERVICE_LEAF_PATTERN.exec(trimmed);
  return match ? match[1] : null;
}

export interface ResolveServiceUnitOptions {
  // Explicit escape hatch (MULLION_SERVICE_UNIT) — wins over autodetection
  // outright, e.g. for a host whose cgroup layout this parser doesn't
  // anticipate. Empty/undefined is treated as "not set." On darwin this
  // carries the launchd LABEL instead of a unit name.
  override?: string;
  // The host's platform — darwin resolves a launchd label, anything else a
  // systemd unit. Defaults to the platform this process runs on.
  platform?: NodeJS.Platform;
  // This instance's role (primary|agent) — the launchd label is
  // role-derived. Defaults to "primary".
  role?: string;
  // Test-only injection points; production always reads the real
  // /proc/self/cgroup.
  cgroupPath?: string;
  readCgroup?: (path: string) => string;
}

/**
 * Resolves the service that self-update.sh should restart: on Linux the
 * systemd --user unit, on macOS the launchd agent's label (issue #1718).
 *
 * Order: an explicit MULLION_SERVICE_UNIT override, then — on Linux only —
 * autodetection from this process's own /proc/self/cgroup (only the app's
 * long-lived Node process is actually IN the app's unit cgroup — the
 * updater itself runs inside a separate systemd-run --scope on Linux and its
 * own one-shot launchd job on macOS, so detection can't happen there), then
 * the platform's default.
 *
 * Never throws: a missing/unreadable cgroup file (no cgroups, sandboxed)
 * just falls through to the default.
 */
export function resolveServiceUnit(options: ResolveServiceUnitOptions = {}): string {
  if (options.override && options.override.trim() !== "") {
    return options.override.trim();
  }

  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    // No cgroups on darwin: the label comes from the install's own
    // MULLION_SERVICE_UNIT (the installer writes it into the plist), or
    // from the role.
    return launchdLabelForRole(options.role ?? "primary");
  }

  const cgroupPath = options.cgroupPath ?? "/proc/self/cgroup";
  const readCgroup = options.readCgroup ?? ((path: string) => readFileSync(path, "utf8"));
  try {
    const detected = resolveServiceUnitFromCgroup(readCgroup(cgroupPath));
    if (detected) return detected;
  } catch {
    // Best-effort — fall through to the default.
  }

  return DEFAULT_SERVICE_UNIT;
}
