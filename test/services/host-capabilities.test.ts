import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// `xcrun` is faked at node:child_process, as agent-detect.test.ts fakes its
// probes: no real binary runs, whatever the host has installed.
const execFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFile(...args),
}));

const { detectCapabilities, getCachedCapabilities } =
  await import("../../src/services/host-capabilities.js");

const realPlatform = process.platform;
function stubPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function xcrunExits(ok: boolean) {
  execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) =>
      cb(ok ? null : new Error("xcrun: error: unable to find utility")),
  );
}

let dir: string;
let emulator: string;
function fakeApp(opts: { enabled: boolean; emulatorPath: string }) {
  return {
    deviceEmulatorEnabled: opts.enabled,
    config: { DEVICE_EMULATOR_PATH: opts.emulatorPath },
  } as unknown as FastifyInstance;
}

describe("host capability detection (issue #2306)", () => {
  beforeEach(() => {
    execFile.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "caps-"));
    emulator = path.join(dir, "emulator");
    fs.writeFileSync(emulator, "#!/bin/sh\n", { mode: 0o755 });
  });
  afterEach(() => {
    stubPlatform(realPlatform);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports xcode on darwin when simctl resolves", async () => {
    stubPlatform("darwin");
    xcrunExits(true);
    const app = fakeApp({ enabled: false, emulatorPath: "" });
    expect(await detectCapabilities(app)).toEqual(["xcode"]);
    expect(execFile).toHaveBeenCalledWith(
      "xcrun",
      ["--find", "simctl"],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it("omits xcode on darwin with only the Command Line Tools", async () => {
    stubPlatform("darwin");
    xcrunExits(false);
    expect(await detectCapabilities(fakeApp({ enabled: false, emulatorPath: "" }))).toEqual([]);
  });

  it("omits xcode when xcrun cannot even be launched", async () => {
    stubPlatform("darwin");
    execFile.mockImplementation(() => {
      throw new Error("spawn xcrun ENOENT");
    });
    expect(await detectCapabilities(fakeApp({ enabled: false, emulatorPath: "" }))).toEqual([]);
  });

  it.each(["linux", "win32"])("never spawns xcrun on %s", async (platform) => {
    stubPlatform(platform);
    xcrunExits(true);
    expect(await detectCapabilities(fakeApp({ enabled: false, emulatorPath: "" }))).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports android-emulator when enabled and DEVICE_EMULATOR_PATH is executable", async () => {
    stubPlatform("linux");
    expect(await detectCapabilities(fakeApp({ enabled: true, emulatorPath: emulator }))).toEqual([
      "android-emulator",
    ]);
  });

  it("omits android-emulator when the device panel's emulator support is off", async () => {
    expect(await detectCapabilities(fakeApp({ enabled: false, emulatorPath: emulator }))).toEqual(
      [],
    );
  });

  it("omits android-emulator for an empty path (DeviceManager has no PATH fallback)", async () => {
    expect(await detectCapabilities(fakeApp({ enabled: true, emulatorPath: "" }))).toEqual([]);
  });

  it("omits android-emulator when the binary is missing or not executable", async () => {
    expect(
      await detectCapabilities(fakeApp({ enabled: true, emulatorPath: path.join(dir, "nope") })),
    ).toEqual([]);
    const plain = path.join(dir, "plain");
    fs.writeFileSync(plain, "x", { mode: 0o644 });
    expect(await detectCapabilities(fakeApp({ enabled: true, emulatorPath: plain }))).toEqual([]);
  });

  it("can report both", async () => {
    stubPlatform("darwin");
    xcrunExits(true);
    expect(await detectCapabilities(fakeApp({ enabled: true, emulatorPath: emulator }))).toEqual([
      "xcode",
      "android-emulator",
    ]);
  });

  it("caches, and re-probes in the background once the TTL lapses", async () => {
    stubPlatform("darwin");
    xcrunExits(true);
    const app = fakeApp({ enabled: false, emulatorPath: "" });
    vi.useFakeTimers();
    try {
      expect(await getCachedCapabilities(app)).toEqual(["xcode"]);
      expect(await getCachedCapabilities(app)).toEqual(["xcode"]);
      expect(execFile).toHaveBeenCalledTimes(1);

      xcrunExits(false);
      vi.advanceTimersByTime(61_000);
      // Stale-while-revalidate: the stale answer is returned, the refresh runs.
      expect(await getCachedCapabilities(app)).toEqual(["xcode"]);
      await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => expect(await getCachedCapabilities(app)).toEqual([]));
    } finally {
      vi.useRealTimers();
    }
  });
});
