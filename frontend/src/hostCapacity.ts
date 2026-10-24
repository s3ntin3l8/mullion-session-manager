// The host CAPACITY display — issue #1726 / roadmap 8.12.
//
// How busy each host in the fleet is, in numbers comparable across machines:
// the platform it runs on, how many things it can do at once, how loaded it
// is, and how much memory is free.
//
// Two rules this module exists to enforce, because both are easy to get
// wrong in a template and both would mislead:
//
//   - **UNKNOWN IS NOT ZERO.** A host that never reported a capacity (an
//     older agent build without the route, or one that has not been polled
//     yet) is `known: false`. A zero load would not just be a wrong number
//     — it would read as "this machine is idle", which is the one thing a
//     missing reading must never say. `HostCapacity.loadAverage1m`'s own
//     doc comment (src/services/host-capacity.ts) makes the same point
//     about a zero load on a platform that does not report one.
//   - **A READING IS NOT A FACT.** Capacity is cached in memory on the
//     heartbeat sweep, so it is always a little old. A host that stopped
//     reporting keeps its last known numbers, so the numbers stay visible
//     but are marked stale, with their age.
//
// Pure and React-free on purpose: the formatting is the part worth testing,
// and it must be testable without a component tree.

import type { Host, HostCapacity } from "./api/index.js";

/**
 * How old a capacity reading may be before it is shown as stale.
 *
 * The heartbeat sweep's interval is configurable server-side
 * (`HOST_HEARTBEAT_INTERVAL_SECONDS`), and the frontend does not know it —
 * so this is a fixed, generous threshold rather than a promise. Two minutes
 * is long enough that a normally-swept host never looks stale, and short
 * enough that a host that went quiet is marked promptly.
 */
export const CAPACITY_STALE_AFTER_MS = 120_000;

export interface HostCapacityDisplay {
  /**
   * False when the host reported NO capacity. The UI renders "unknown" —
   * never a zero.
   */
  known: boolean;
  /** "macOS" | "Linux" | … — null when the host never said. */
  platform: string | null;
  /** How many things can run at once here. */
  cores: number | null;
  /** The 1-minute load average, as reported. */
  load: string | null;
  /** "8.2 GB free of 32 GB". */
  memory: string | null;
  /** How old the reading is, in ms. Null when there is no reading. */
  ageMs: number | null;
  /**
   * True when the reading is too old to present as current — either it aged
   * out, or the host is not online (so its last reading is all there is).
   */
  stale: boolean;
}

/** The platform tokens the hosts report, as the UI names them. */
const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/**
 * The host's platform, as the UI names it.
 *
 * The host's own row field first (the API already prefers it for the local
 * host, so the UI does not have to pick a winner between two sources), then
 * the capacity reading's own platform as a fallback for a host whose row
 * never got one.
 */
export function formatHostPlatform(host: Host): string | null {
  const raw = host.platform ?? host.capacity?.platform ?? null;
  if (!raw) return null;
  return PLATFORM_NAMES[raw] ?? raw;
}

/** Bytes as a human string — "8.2 GB", "512 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** How old a reading is, as a short phrase — "3 min ago", "just now". */
export function formatCapacityAge(ageMs: number | null): string | null {
  if (ageMs === null || !Number.isFinite(ageMs)) return null;
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/**
 * The same display, with "now" taken at call time.
 *
 * `Date.now()` is an impure call, and React's purity lint forbids it in a
 * component's render — so it lives HERE, in a plain function, the same shape
 * as ResourceAlertBanner's own `isFresh` helper. The age it computes moves by
 * milliseconds between renders, which no user can see; the pure function
 * above stays testable because it takes "now" as an argument.
 */
export function formatHostCapacityNow(host: Host): HostCapacityDisplay {
  return formatHostCapacity(host, Date.now());
}

/**
 * The host's capacity, ready to render.
 *
 * `known: false` is the important output: the host reported nothing, and the
 * UI must say "unknown" rather than show a zero.
 */
export function formatHostCapacity(host: Host, nowMs: number): HostCapacityDisplay {
  const platform = formatHostPlatform(host);
  const capacity: HostCapacity | null | undefined = host.capacity;

  if (!capacity) {
    return {
      known: false,
      platform,
      cores: null,
      load: null,
      memory: null,
      ageMs: null,
      stale: false,
    };
  }

  const sampledAt = Date.parse(capacity.sampledAt);
  const ageMs = Number.isFinite(sampledAt) ? Math.max(0, nowMs - sampledAt) : null;
  // A host that is not online keeps its last known numbers, and those
  // numbers are all there is — so they are marked stale whatever their age.
  const stale = ageMs === null || ageMs > CAPACITY_STALE_AFTER_MS || host.health !== "online";

  return {
    known: true,
    platform,
    cores: capacity.logicalCores,
    load: capacity.loadAverage1m.toFixed(2),
    memory: `${formatBytes(capacity.memory.freeBytes)} free of ${formatBytes(capacity.memory.totalBytes)}`,
    ageMs,
    stale,
  };
}
