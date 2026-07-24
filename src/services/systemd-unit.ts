import { readFileSync } from "node:fs";

// Fallback when neither an explicit override nor cgroup autodetection
// resolves a real unit — matches the systemd --user unit this repo's own
// deploy/mullion.service installs. A dev checkout (`make dev`, no systemd
// unit at all) never actually restarts anything with this name: MULLION_HOME
// is empty there, so POST /api/updates/apply refuses before self-update.sh
// is ever invoked (see src/routes/updates.ts).
export const DEFAULT_SERVICE_UNIT = "mullion.service";

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
  // anticipate. Empty/undefined is treated as "not set."
  override?: string;
  // Test-only injection points; production always reads the real
  // /proc/self/cgroup.
  cgroupPath?: string;
  readCgroup?: (path: string) => string;
}

/**
 * Resolves the systemd --user unit that self-update.sh should restart, in
 * order: an explicit MULLION_SERVICE_UNIT override, then autodetection from
 * this process's own /proc/self/cgroup (only the app's long-lived Node
 * process is actually IN the app's unit cgroup — self-update.sh itself runs
 * inside a separate systemd-run --scope, so detection can't happen there),
 * then DEFAULT_SERVICE_UNIT. Never throws: a missing/unreadable cgroup file
 * (non-Linux, no cgroups, sandboxed) just falls through to the default.
 */
export function resolveServiceUnit(options: ResolveServiceUnitOptions = {}): string {
  if (options.override && options.override.trim() !== "") {
    return options.override.trim();
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
