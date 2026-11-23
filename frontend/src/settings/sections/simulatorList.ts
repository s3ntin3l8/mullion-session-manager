import type { IosSimulator } from "../../api/index.js";
import { matchesQuery } from "../../matchQuery.js";

// The pure half of the simulator picker (SimulatorPicker.tsx): which simulators
// are worth showing first, and how the rest are grouped.

/** "iOS 27.0" -> [27, 0]; a label with no version sorts last. */
export function runtimeVersion(runtime: string): number[] {
  const match = /(\d+(?:\.\d+)*)/.exec(runtime);
  return match ? match[1].split(".").map(Number) : [];
}

/** Descending: the newest runtime first. */
export function compareRuntimesNewestFirst(a: string, b: string): number {
  const va = runtimeVersion(a);
  const vb = runtimeVersion(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const diff = (vb[i] ?? -1) - (va[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

/**
 * Whether a simulator is one someone uses, as opposed to one Xcode provisioned
 * with the runtime. simctl cannot say so outright; booted now, added to
 * Mullion, or booted at some point (`lastBootedAt`) is the signal it has.
 */
export function isUsedSimulator(sim: IosSimulator, activeUdids: ReadonlySet<string>): boolean {
  return sim.state === "Booted" || activeUdids.has(sim.udid) || Boolean(sim.lastBootedAt);
}

export interface SimulatorGroup {
  runtime: string;
  simulators: IosSimulator[];
}

const isIpad = (sim: IosSimulator) => /^ipad/i.test(sim.name);

function compareWithinRuntime(a: IosSimulator, b: IosSimulator): number {
  if (a.state !== b.state) return a.state === "Booted" ? -1 : 1;
  if (isIpad(a) !== isIpad(b)) return isIpad(a) ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/** Runtimes newest first; within one, booted first, iPhones before iPads. */
export function groupSimulators(sims: readonly IosSimulator[]): SimulatorGroup[] {
  const byRuntime = new Map<string, IosSimulator[]>();
  for (const sim of sims) {
    const list = byRuntime.get(sim.runtime) ?? [];
    list.push(sim);
    byRuntime.set(sim.runtime, list);
  }
  return [...byRuntime.entries()]
    .sort(([a], [b]) => compareRuntimesNewestFirst(a, b))
    .map(([runtime, list]) => ({ runtime, simulators: [...list].sort(compareWithinRuntime) }));
}

export interface SimulatorView {
  groups: SimulatorGroup[];
  /** How many simulators the list holds in all. */
  total: number;
  /** How many the current view leaves out. */
  hidden: number;
}

/**
 * What the picker shows. A search matches every simulator; otherwise "show all"
 * does, and by default only the used ones (all of them when none qualifies, so
 * a fresh Xcode is not an empty list). `keepUdid` (the current selection) is
 * never hidden.
 */
export function viewSimulators(
  sims: readonly IosSimulator[],
  options: {
    query: string;
    showAll: boolean;
    activeUdids: ReadonlySet<string>;
    keepUdid?: string;
  },
): SimulatorView {
  const query = options.query.trim();
  let visible: readonly IosSimulator[];
  if (query !== "") {
    visible = sims.filter((s) => matchesQuery([s.name, s.runtime, s.state], query));
  } else if (options.showAll) {
    visible = sims;
  } else {
    const used = sims.filter(
      (s) => isUsedSimulator(s, options.activeUdids) || s.udid === options.keepUdid,
    );
    visible = used.length > 0 ? used : sims;
  }
  return {
    groups: groupSimulators(visible),
    total: sims.length,
    hidden: query === "" ? sims.length - visible.length : 0,
  };
}

const deviceFamily = (name: string) => (/^iphone/i.test(name) ? 0 : /^ipad/i.test(name) ? 1 : 2);

/** The model number in "iPhone 17 Pro" (17); undefined for "iPhone Air", "iPhone SE (3rd generation)"... */
const iphoneModelNumber = (name: string): number | undefined => {
  const match = /^iphone (\d+)/i.exec(name);
  return match ? Number(match[1]) : undefined;
};

/**
 * Device types for the new-simulator form, newest first, iPhones then iPads
 * then the rest (an iPod touch). simctl carries no release date and its array
 * order has run both ways, so the direction is read off the iPhone model
 * numbers (the first numbered iPhone against the last) rather than assumed;
 * Xcode 27.2 lists newest first. A stable sort keeps that order inside each
 * family.
 */
export function sortDeviceTypes<T extends { name: string }>(types: readonly T[]): T[] {
  const numbers = types.map((t) => iphoneModelNumber(t.name)).filter((n) => n !== undefined);
  const oldestFirst = numbers.length > 1 && numbers[0] < numbers[numbers.length - 1];
  const ordered = oldestFirst ? [...types].reverse() : [...types];
  return ordered.sort((a, b) => deviceFamily(a.name) - deviceFamily(b.name));
}

/** Runtimes, newest first ("iOS 27.0" before "iOS 26.5"). */
export function sortRuntimes<T extends { name: string }>(runtimes: readonly T[]): T[] {
  return [...runtimes].sort((a, b) => compareRuntimesNewestFirst(a.name, b.name));
}
