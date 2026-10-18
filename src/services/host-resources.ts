import os from "node:os";

/**
 * Returns the number of online, available CPU cores on this host.
 * Uses `os.availableParallelism()` when available (Node 19.4+), falling back
 * to `os.cpus()?.length`, and defaulting to 4 if neither reports valid cores.
 */
export function getAvailableHostCores(osModule: typeof os = os): number {
  try {
    if (typeof osModule.availableParallelism === "function") {
      const cores = osModule.availableParallelism();
      if (typeof cores === "number" && cores > 0) return cores;
    }
    const cpus = osModule.cpus();
    if (Array.isArray(cpus) && cpus.length > 0) return cpus.length;
  } catch {
    // Non-standard runtime or procfs unreadable — fall through to default.
  }
  return 4;
}

/**
 * Computes the cgroup v2 CPUQuota percentage for unattended Task Master sessions.
 * Allocates ~45% of total host capacity so background tasks can never saturate
 * the machine while a user is actively interacting with manual sessions.
 *
 * Examples:
 *  - 14 cores -> 6 cores (600%)
 *  - 8 cores  -> 3 cores (300%)
 *  - 4 cores  -> 2 cores (200%)
 *  - 2 cores  -> 2 cores (200%, minimum floor)
 */
export function computeTaskMasterCpuQuota(totalCores: number): number {
  const quotaCores = Math.max(2, Math.floor(totalCores * 0.45));
  return quotaCores * 100;
}

/**
 * Computes the recommended worker concurrency for greedy test/build tools
 * based on the host's core count and instantaneous 1-minute load average.
 *
 * Rules:
 *  - Low load (< 35% capacity): Full burst capacity (all cores).
 *  - Moderate load (< 75% capacity): Half capacity.
 *  - High contention (>= 75% capacity): Conservative floor (25% capacity, min 2).
 */
export function computeAdaptiveWorkers(totalCores: number, load1m: number): number {
  const safeCores = Math.max(1, totalCores);
  if (load1m < safeCores * 0.35) {
    return safeCores;
  }
  if (load1m < safeCores * 0.75) {
    return Math.max(2, Math.ceil(safeCores / 2));
  }
  return Math.max(2, Math.floor(safeCores / 4));
}
