import { execFile } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { PLACEMENT_CAPABILITIES, type PlacementCapability } from "../shared/constants.js";
// Per step and attempt; a timeout must not read as "lacks" (see ProbeResult).
import { XCODE_PROBE_ATTEMPTS, XCRUN_TIMEOUT_MS } from "./xcode-probe-budget.js";

/**
 * What this host can do beyond running agent CLIs (issue #2306): `xcode` (the
 * iOS Simulator toolchain) and `android-emulator` (an emulator Mullion can
 * start). Detected, never configured, and kept in memory only: enrollment's
 * static `capabilities` snapshot goes stale and is deliberately not read.
 */

/** `ok`/`lacks` are verdicts; `unknown` (timeout, spawn error) is not one. */
type ProbeResult =
  { kind: "ok" } | { kind: "lacks"; reason: string } | { kind: "unknown"; detail: string };

type ExecOutcome =
  { kind: "exit0"; stdout: string } | { kind: "nonzero" } | { kind: "error"; detail: string };

function run(cmd: string, args: string[]): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: XCRUN_TIMEOUT_MS }, (err, stdout) => {
        if (err === null || err === undefined)
          return resolve({ kind: "exit0", stdout: String(stdout ?? "") });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        // A clean non-zero exit has a numeric code; a timeout kill, a signal or a
        // spawn failure (string code like ENOENT) does not.
        if (typeof e.code === "number" && !e.killed && !e.signal)
          return resolve({ kind: "nonzero" });
        resolve({ kind: "error", detail: e.message });
      });
    } catch (err) {
      resolve({ kind: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * Ordered, short-circuiting. Step 3 (`simctl list`) starts the first-launch
 * installer on an incomplete install, so it must never run after step 2 failed.
 */
async function probeXcode(): Promise<ProbeResult> {
  const find = await run("xcrun", ["--find", "simctl"]);
  if (find.kind === "error") return { kind: "unknown", detail: find.detail };
  if (find.kind === "nonzero") return { kind: "lacks", reason: "simctl missing" };

  const first = await run("xcodebuild", ["-checkFirstLaunchStatus"]);
  if (first.kind === "error") return { kind: "unknown", detail: first.detail };
  if (first.kind === "nonzero") return { kind: "lacks", reason: "first launch incomplete" };

  const list = await run("xcrun", ["simctl", "list", "runtimes", "available", "-j"]);
  if (list.kind === "error") return { kind: "unknown", detail: list.detail };
  if (list.kind === "nonzero") return { kind: "lacks", reason: "no simulator runtime" };
  try {
    const parsed = JSON.parse(list.stdout) as { runtimes?: unknown };
    if (Array.isArray(parsed.runtimes) && parsed.runtimes.length > 0) return { kind: "ok" };
    return { kind: "lacks", reason: "no simulator runtime" };
  } catch (err) {
    return { kind: "unknown", detail: `unparsable simctl output: ${(err as Error).message}` };
  }
}

interface XcodeState {
  /** Last verdict (never set from `unknown`). */
  last: boolean | undefined;
  /** Last logged reason, so a persistent absence logs once per state change. */
  loggedReason: string | undefined;
}
// Per app tree, like the cache: tests build many Fastify instances in one process.
const xcodeStates = new WeakMap<object, XcodeState>();

/**
 * One key per Fastify app tree. Every route plugin gets its own encapsulated
 * child instance, but they all share the root's `server`, so the warm-up and
 * every caller read one cache (#3511). Test doubles without a server key on
 * themselves.
 */
function treeKey(app: FastifyInstance): object {
  return (app as { server?: object }).server ?? app;
}

async function xcodeAvailable(app: FastifyInstance): Promise<boolean> {
  let state = xcodeStates.get(treeKey(app));
  if (!state) xcodeStates.set(treeKey(app), (state = { last: undefined, loggedReason: undefined }));
  // One retry: an inconclusive probe on a cold, loaded Mac usually succeeds the
  // second time, and the fallback below reads as "lacks" until a verdict lands.
  let result = await probeXcode();
  for (let i = 1; i < XCODE_PROBE_ATTEMPTS && result.kind === "unknown"; i++) {
    result = await probeXcode();
  }
  if (result.kind === "unknown") {
    app.log.warn(
      { detail: result.detail },
      "[host-capabilities] xcode probe inconclusive; keeping the last known value",
    );
    return state.last ?? false;
  }
  if (result.kind === "ok") {
    if (state.last !== true) app.log.info("[host-capabilities] xcode available");
    state.last = true;
    state.loggedReason = undefined;
    return true;
  }
  if (state.loggedReason !== result.reason) {
    app.log.info(`[host-capabilities] xcode unavailable: ${result.reason}`);
  }
  state.last = false;
  state.loggedReason = result.reason;
  return false;
}

/**
 * Mirrors DeviceManager exactly: it launches `DEVICE_EMULATOR_PATH` verbatim,
 * with no PATH or SDK-root fallback, so an empty path means "cannot start one".
 */
async function androidEmulatorAvailable(app: FastifyInstance): Promise<boolean> {
  if (!app.deviceEmulatorEnabled) return false;
  const path = app.config.DEVICE_EMULATOR_PATH;
  if (!path) return false;
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Pure, uncached probe. Never spawns anything off darwin. */
export async function detectCapabilities(app: FastifyInstance): Promise<PlacementCapability[]> {
  const probes: Record<PlacementCapability, () => Promise<boolean>> = {
    xcode: () => (process.platform === "darwin" ? xcodeAvailable(app) : Promise.resolve(false)),
    "android-emulator": () => androidEmulatorAvailable(app),
  };
  const found = await Promise.all(PLACEMENT_CAPABILITIES.map((c) => probes[c]()));
  return PLACEMENT_CAPABILITIES.filter((_, i) => found[i]);
}

interface CacheEntry {
  data: PlacementCapability[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
// Per app tree (treeKey): tests build many Fastify instances in one process.
const caches = new WeakMap<object, CacheEntry>();
const inflight = new WeakMap<object, Promise<PlacementCapability[]>>();

function refresh(app: FastifyInstance): Promise<PlacementCapability[]> {
  const key = treeKey(app);
  const running = inflight.get(key);
  if (running) return running;
  const p = detectCapabilities(app)
    .then((data) => {
      caches.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Starts the first probe when the app is ready rather than on the first
 * request (#3511), so the cache is usually warm by the time anyone asks; a
 * request meanwhile joins the in-flight probe. Not under test: a suite on a Mac
 * would spawn the real `xcodebuild` for every app it builds.
 */
export function warmCapabilitiesOnReady(app: FastifyInstance): void {
  // No config at all is a bare test double, never a booted server.
  if (!app.config || app.config.NODE_ENV === "test") return;
  app.addHook("onReady", () => {
    refresh(app).catch((err: unknown) => {
      app.log.warn({ err }, "[host-capabilities] startup probe failed");
    });
  });
}

/** Stale-while-revalidate: only the very first call waits on the probes. */
export async function getCachedCapabilities(app: FastifyInstance): Promise<PlacementCapability[]> {
  const cached = caches.get(treeKey(app));
  if (!cached) return refresh(app);
  if (cached.expiresAt <= Date.now()) refresh(app).catch(() => {});
  return cached.data;
}
