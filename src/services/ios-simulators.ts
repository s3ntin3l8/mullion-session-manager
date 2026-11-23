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

export interface SimulatorDeviceType {
  id: string;
  name: string;
}

export interface SimulatorRuntime {
  id: string;
  name: string;
}

export interface SimulatorCatalog {
  deviceTypes: SimulatorDeviceType[];
  runtimes: SimulatorRuntime[];
}

/** Raised for a create request the catalog rejects (unknown id, bad name). The
 * routes answer it with a 400, never a 502. */
export class SimulatorRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulatorRequestError";
  }
}

const MAX_SIMULATOR_NAME_LENGTH = 64;
// Unicode letters and digits plus the punctuation a device name reasonably
// carries ("Björn's iPhone"). The name rides as one argv element (never a
// shell), but a leading "-" would still read as a simctl flag, so the first
// character must be a letter or digit. Control characters never match.
const SIMULATOR_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._()'-]*$/u;
const SIMULATOR_UDID_PATTERN = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

function parseJsonObject(jsonText: string): Record<string, unknown> {
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
  return parsed as Record<string, unknown>;
}

/**
 * Pure parser for `xcrun simctl list devicetypes -j`. Keeps the iPhone and iPad
 * device types (the ones an iOS runtime can host), dropping Apple TV, Apple
 * Watch and Vision Pro.
 */
export function parseSimctlDeviceTypes(jsonText: string): SimulatorDeviceType[] {
  const list = parseJsonObject(jsonText).devicetypes;
  if (!Array.isArray(list)) throw new SimctlError("unparsable simctl output: missing devicetypes");
  const types: SimulatorDeviceType[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.identifier !== "string" || typeof record.name !== "string") continue;
    const family = record.productFamily;
    const isIos =
      family === "iPhone" ||
      family === "iPad" ||
      (typeof family !== "string" && /^(iPhone|iPad)\b/.test(record.name));
    if (isIos) types.push({ id: record.identifier, name: record.name });
  }
  return types;
}

/**
 * Pure parser for `xcrun simctl list runtimes available -j`. Keeps available iOS
 * runtimes only.
 */
export function parseSimctlRuntimes(jsonText: string): SimulatorRuntime[] {
  const list = parseJsonObject(jsonText).runtimes;
  if (!Array.isArray(list)) throw new SimctlError("unparsable simctl output: missing runtimes");
  const runtimes: SimulatorRuntime[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.isAvailable === false) continue;
    if (typeof record.identifier !== "string") continue;
    const label = parseIosRuntime(record.identifier);
    if (!label) continue;
    runtimes.push({
      id: record.identifier,
      name: typeof record.name === "string" ? record.name : label,
    });
  }
  return runtimes;
}

async function runSimctl(simctl: SimctlRunner, args: string[]): Promise<Buffer> {
  try {
    return await simctl(args);
  } catch (err) {
    if (err instanceof SimctlError) throw err;
    throw new SimctlError(err instanceof Error ? err.message : String(err));
  }
}

/** The device types and iOS runtimes a new simulator can be created from. */
export async function listSimulatorCatalog(
  simctl: SimctlRunner = execSimctl,
): Promise<SimulatorCatalog> {
  const [types, runtimes] = await Promise.all([
    runSimctl(simctl, ["list", "devicetypes", "-j"]),
    runSimctl(simctl, ["list", "runtimes", "available", "-j"]),
  ]);
  return {
    deviceTypes: parseSimctlDeviceTypes(types.toString("utf8")),
    runtimes: parseSimctlRuntimes(runtimes.toString("utf8")),
  };
}

export interface CreateSimulatorInput {
  name: string;
  deviceTypeId: string;
  runtimeId: string;
}

/**
 * Creates a simulator with `xcrun simctl create` and returns it as the listing
 * would show it (`Shutdown`). The ids are checked against this host's own
 * catalog and the name against a conservative pattern before anything is run;
 * everything reaches simctl as separate argv elements. Only ever creates —
 * Mullion never deletes or erases a simulator.
 */
export async function createIosSimulator(
  input: CreateSimulatorInput,
  simctl: SimctlRunner = execSimctl,
): Promise<IosSimulator> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_SIMULATOR_NAME_LENGTH) {
    throw new SimulatorRequestError(
      `Simulator name must be 1-${MAX_SIMULATOR_NAME_LENGTH} characters`,
    );
  }
  if (!SIMULATOR_NAME_PATTERN.test(name)) {
    throw new SimulatorRequestError(
      "Simulator name may only contain letters, digits, spaces and . _ ( ) ' -, and must start with a letter or digit",
    );
  }
  const catalog = await listSimulatorCatalog(simctl);
  if (!catalog.deviceTypes.some((type) => type.id === input.deviceTypeId)) {
    throw new SimulatorRequestError(`Unknown device type ${input.deviceTypeId}`);
  }
  const runtime = catalog.runtimes.find((candidate) => candidate.id === input.runtimeId);
  if (!runtime) throw new SimulatorRequestError(`Unknown iOS runtime ${input.runtimeId}`);

  const out = await runSimctl(simctl, ["create", name, input.deviceTypeId, input.runtimeId]);
  // A bare UDID on its own line; take the last non-empty line so a stray
  // warning or blank trailer cannot fail a create that already happened.
  const lines = out
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const udid = lines[lines.length - 1] ?? "";
  if (!SIMULATOR_UDID_PATTERN.test(udid)) {
    throw new SimctlError(`simctl create returned an unexpected result: ${udid.slice(0, 80)}`);
  }
  return {
    udid,
    name,
    runtime: parseIosRuntime(runtime.id) ?? runtime.name,
    state: "Shutdown",
  };
}
