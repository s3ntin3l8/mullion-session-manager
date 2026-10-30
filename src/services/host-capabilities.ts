import { execFile } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { PLACEMENT_CAPABILITIES, type PlacementCapability } from "../shared/constants.js";

/**
 * What this host can do beyond running agent CLIs (issue #2306): `xcode` (the
 * iOS Simulator toolchain) and `android-emulator` (an emulator Mullion can
 * start). Detected, never configured, and kept in memory only: enrollment's
 * static `capabilities` snapshot goes stale and is deliberately not read.
 */

// Well under the primary's request timeout, so a slow xcrun cannot make every
// read time out (the capacity probe uses the same 2s budget).
const XCRUN_TIMEOUT_MS = 2000;

/** `xcrun --find simctl` exits 0 only with full Xcode (Command Line Tools alone lack it). */
function xcodeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile("xcrun", ["--find", "simctl"], { timeout: XCRUN_TIMEOUT_MS }, (err) =>
        resolve(err === null),
      );
    } catch {
      resolve(false);
    }
  });
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
    xcode: () => (process.platform === "darwin" ? xcodeAvailable() : Promise.resolve(false)),
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
// Per app: tests build many Fastify instances in one process.
const caches = new WeakMap<FastifyInstance, CacheEntry>();
const inflight = new WeakMap<FastifyInstance, Promise<PlacementCapability[]>>();

function refresh(app: FastifyInstance): Promise<PlacementCapability[]> {
  const running = inflight.get(app);
  if (running) return running;
  const p = detectCapabilities(app)
    .then((data) => {
      caches.set(app, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      return data;
    })
    .finally(() => inflight.delete(app));
  inflight.set(app, p);
  return p;
}

/** Stale-while-revalidate: only the very first call waits on the probes. */
export async function getCachedCapabilities(app: FastifyInstance): Promise<PlacementCapability[]> {
  const cached = caches.get(app);
  if (!cached) return refresh(app);
  if (cached.expiresAt <= Date.now()) refresh(app).catch(() => {});
  return cached.data;
}
