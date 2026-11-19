import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const getCachedCapabilities = vi.fn();
vi.mock("../../src/services/host-capabilities.js", () => ({
  getCachedCapabilities: (...args: unknown[]) => getCachedCapabilities(...args),
}));

const { iosSimulatorAvailable, localDevicePlatforms } =
  await import("../../src/services/device-kinds.js");

let dir: string;
let companion: string;
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function fakeApp(overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return {
    devicePanelEnabled: true,
    deviceEmulatorEnabled: true,
    deviceKinds: ["physical", "emulator"],
    config: { DEVICE_IOS_ENABLED: true, DEVICE_IDB_COMPANION_PATH: companion, ...config },
    ...overrides,
  } as unknown as FastifyInstance;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "device-kinds-"));
  companion = path.join(dir, "idb_companion");
  fs.writeFileSync(companion, "#!/bin/sh\n", { mode: 0o755 });
  getCachedCapabilities.mockReset().mockResolvedValue(["xcode"]);
  setPlatform("darwin");
});

afterEach(() => {
  setPlatform(originalPlatform);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("iosSimulatorAvailable", () => {
  it("is true when every condition holds", async () => {
    await expect(iosSimulatorAvailable(fakeApp())).resolves.toBe(true);
  });

  it("is false off macOS", async () => {
    setPlatform("linux");
    await expect(iosSimulatorAvailable(fakeApp())).resolves.toBe(false);
  });

  it("is false when DEVICE_IOS_ENABLED is off", async () => {
    await expect(iosSimulatorAvailable(fakeApp({}, { DEVICE_IOS_ENABLED: false }))).resolves.toBe(
      false,
    );
  });

  it("is false without the xcode capability", async () => {
    getCachedCapabilities.mockResolvedValue(["docker"]);
    await expect(iosSimulatorAvailable(fakeApp())).resolves.toBe(false);
  });

  it("is false when the companion path is unset", async () => {
    await expect(
      iosSimulatorAvailable(fakeApp({}, { DEVICE_IDB_COMPANION_PATH: "" })),
    ).resolves.toBe(false);
  });

  it("is false when the companion path is missing, a directory or not executable", async () => {
    await expect(
      iosSimulatorAvailable(fakeApp({}, { DEVICE_IDB_COMPANION_PATH: path.join(dir, "nope") })),
    ).resolves.toBe(false);
    await expect(
      iosSimulatorAvailable(fakeApp({}, { DEVICE_IDB_COMPANION_PATH: dir })),
    ).resolves.toBe(false);
    fs.chmodSync(companion, 0o644);
    // root can execute anything it can read; only assert when the bit is honoured.
    if (process.getuid?.() !== 0) {
      await expect(iosSimulatorAvailable(fakeApp())).resolves.toBe(false);
    }
  });
});

describe("localDevicePlatforms", () => {
  it("is android alone when iOS is not available", async () => {
    await expect(localDevicePlatforms(fakeApp({}, { DEVICE_IOS_ENABLED: false }))).resolves.toEqual(
      ["android"],
    );
  });

  it("adds ios when the simulator is available", async () => {
    await expect(localDevicePlatforms(fakeApp())).resolves.toEqual(["android", "ios"]);
  });

  it("is empty when the panel is off, even with iOS available", async () => {
    await expect(
      localDevicePlatforms(fakeApp({ devicePanelEnabled: false, deviceKinds: [] })),
    ).resolves.toEqual([]);
  });
});
