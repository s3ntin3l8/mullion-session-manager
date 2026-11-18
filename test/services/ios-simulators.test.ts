import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ChildProcess from "node:child_process";

const execFileMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => execFileMock(...args),
  };
});

const { parseSimctlDevices, listIosSimulators, SimctlError } =
  await import("../../src/services/ios-simulators.js");

const SAMPLE_SIMCTL_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      {
        udid: "0F4A9B7E-1111-2222-3333-444455556666",
        name: "iPhone 16 Pro",
        state: "Booted",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      },
      {
        udid: "1A2B3C4D-1111-2222-3333-444455556666",
        name: "iPhone 16",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      },
      {
        udid: "2B3C4D5E-1111-2222-3333-444455556666",
        name: "iPhone Unavailable",
        state: "Shutdown",
        isAvailable: false,
      },
      {
        udid: "3C4D5E6F-1111-2222-3333-444455556666",
        name: "iPhone Creating",
        state: "Creating",
        isAvailable: true,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-18-2": [
      {
        udid: "4D5E6F70-1111-2222-3333-444455556666",
        name: "Apple TV 4K",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-11-2": [
      {
        udid: "5E6F7081-1111-2222-3333-444455556666",
        name: "Apple Watch Series 10",
        state: "Booted",
        isAvailable: true,
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.xrOS-2-2": [
      {
        udid: "6F708192-1111-2222-3333-444455556666",
        name: "Apple Vision Pro",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
  },
});

describe("parseSimctlDevices", () => {
  it("parses booted and shutdown iOS simulators and skips tvOS, watchOS, visionOS, unavailable, and transient states", () => {
    expect(parseSimctlDevices(SAMPLE_SIMCTL_JSON)).toEqual([
      {
        udid: "0F4A9B7E-1111-2222-3333-444455556666",
        name: "iPhone 16 Pro",
        runtime: "iOS 18.2",
        state: "Booted",
      },
      {
        udid: "1A2B3C4D-1111-2222-3333-444455556666",
        name: "iPhone 16",
        runtime: "iOS 18.2",
        state: "Shutdown",
      },
    ]);
  });

  it("throws SimctlError on invalid JSON or missing devices map", () => {
    expect(() => parseSimctlDevices("not json")).toThrow(SimctlError);
    expect(() => parseSimctlDevices("[]")).toThrow(SimctlError);
    expect(() => parseSimctlDevices("{}")).toThrow(SimctlError);
    expect(() => parseSimctlDevices('{"devices": []}')).toThrow(SimctlError);
  });
});

describe("listIosSimulators", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("invokes xcrun simctl with an argument array (no shell) and parses the output", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, Buffer.from(SAMPLE_SIMCTL_JSON), Buffer.alloc(0));
      return {};
    });

    const sims = await listIosSimulators();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe("xcrun");
    expect(execFileMock.mock.calls[0][1]).toEqual(["simctl", "list", "devices", "available", "-j"]);
    expect(sims).toHaveLength(2);
  });

  it("throws SimctlError with stderr summary when simctl fails", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(
        new Error("Command failed: xcrun simctl list devices available -j"),
        Buffer.alloc(0),
        Buffer.from('xcrun: error: unable to find utility "simctl"'),
      );
      return {};
    });

    await expect(listIosSimulators()).rejects.toThrow(SimctlError);
    await expect(listIosSimulators()).rejects.toThrow(/unable to find utility "simctl"/);
  });
});
