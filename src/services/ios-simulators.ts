import { execSimctl, type SimctlRunner } from "./device-drivers/ios-simulator.js";

export type IosSimulatorState = "Booted" | "Shutdown";

export interface IosSimulator {
  udid: string;
  name: string;
  runtime: string;
  state: IosSimulatorState;
}

/** Raised when `xcrun simctl list` cannot be run, exits non-zero, or returns
 * unparsable JSON — callers turn this into a 502 rather than an empty list. */
export class SimctlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimctlError";
  }
}

const SIMRUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";

/**
 * Extracts a human-readable iOS runtime label (e.g. `"iOS 18.2"`) from a
 * `simctl list devices -j` runtime key, or returns null for non-iOS runtimes
 * (tvOS, watchOS, visionOS/xrOS).
 */
function parseIosRuntime(key: string): string | null {
  const short = key.startsWith(SIMRUNTIME_PREFIX) ? key.slice(SIMRUNTIME_PREFIX.length) : key;
  if (short.startsWith("iOS-")) {
    return `iOS ${short.slice("iOS-".length).replaceAll("-", ".")}`;
  }
  if (short.startsWith("iOS ")) {
    return short;
  }
  return null;
}

/**
 * Pure parser for `xcrun simctl list devices available -j` output.
 * Keeps only available `Booted` and `Shutdown` simulators on iOS runtimes
 * (skipping tvOS, watchOS, visionOS, and unavailable entries).
 */
export function parseSimctlDevices(jsonText: string): IosSimulator[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SimctlError(`unparsable simctl output: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SimctlError("unparsable simctl output: expected JSON object");
  }
  const devices = (parsed as { devices?: unknown }).devices;
  if (!devices || typeof devices !== "object" || Array.isArray(devices)) {
    throw new SimctlError("unparsable simctl output: missing devices map");
  }

  const simulators: IosSimulator[] = [];
  for (const [runtimeKey, entries] of Object.entries(devices as Record<string, unknown>)) {
    const runtime = parseIosRuntime(runtimeKey);
    if (!runtime || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (record.isAvailable === false) continue;
      if (record.state !== "Booted" && record.state !== "Shutdown") continue;
      if (typeof record.udid !== "string" || record.udid.length === 0) continue;
      if (typeof record.name !== "string") continue;
      simulators.push({
        udid: record.udid,
        name: record.name,
        runtime,
        state: record.state,
      });
    }
  }
  return simulators;
}

/** Lists available iOS simulators on this host via `xcrun simctl`. */
export async function listIosSimulators(
  simctl: SimctlRunner = execSimctl,
): Promise<IosSimulator[]> {
  let stdout: Buffer;
  try {
    stdout = await simctl(["list", "devices", "available", "-j"]);
  } catch (err) {
    if (err instanceof SimctlError) throw err;
    throw new SimctlError(err instanceof Error ? err.message : String(err));
  }
  return parseSimctlDevices(stdout.toString("utf8"));
}
