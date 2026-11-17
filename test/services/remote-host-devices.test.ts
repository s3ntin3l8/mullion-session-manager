import { describe, it, expect, vi } from "vitest";
import {
  DEVICE_REQUEST_TIMEOUT_MS,
  deviceAction,
  deviceWsTarget,
  liveDevices,
  resolveDeviceKinds,
  spawnDevice,
  terminateDevice,
} from "../../src/services/remote-host-devices.js";
import { HostRequestError } from "../../src/services/remote-host-errors.js";

// The request builders behind RemoteHostClient's device methods (#3200): what
// path, body and timeout each call uses. The primary-side behaviour built on
// them is in device-host.test.ts.

const SPEC = {
  id: "7",
  kind: "emulator" as const,
  avdName: "dev35",
  serial: null,
  label: null,
  port: null,
  reservedPorts: [],
};

describe("remote-host-devices", () => {
  it("gives a spawn, a teardown and an action longer than the client's default timeout", async () => {
    const request = vi.fn().mockResolvedValue({});
    await spawnDevice(request, SPEC);
    await terminateDevice(request, "7", "emulator");
    await deviceAction(request, "7", { action: "tap", x: 1, y: 2 });

    expect(DEVICE_REQUEST_TIMEOUT_MS).toBeGreaterThan(5_000);
    expect(request.mock.calls.map(([path, , timeout]) => [path, timeout])).toEqual([
      ["/internal/devices", DEVICE_REQUEST_TIMEOUT_MS],
      ["/internal/devices/7/terminate", DEVICE_REQUEST_TIMEOUT_MS],
      ["/internal/devices/7/action", DEVICE_REQUEST_TIMEOUT_MS],
    ]);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(SPEC);
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ kind: "emulator" });
  });

  it("leaves the cheap reads on the default timeout", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ devices: [] })
      .mockResolvedValueOnce({ deviceKinds: ["physical"] });
    await expect(liveDevices(request)).resolves.toEqual([]);
    await expect(resolveDeviceKinds(request)).resolves.toEqual(["physical"]);
    expect(request.mock.calls.map((c) => c.length)).toEqual([1, 1]);
  });

  it("answers null for an agent that predates the kinds route, and rethrows anything else", async () => {
    const old = vi.fn().mockRejectedValue(new HostRequestError("h", 404, "nope"));
    await expect(resolveDeviceKinds(old)).resolves.toBeNull();
    const broken = vi.fn().mockRejectedValue(new HostRequestError("h", 500, "boom"));
    await expect(resolveDeviceKinds(broken)).rejects.toThrow();
  });

  it("builds the socket target with only the query values that are set", () => {
    expect(deviceWsTarget("7", { kind: "physical", serial: "1.2.3.4:5555" })).toBe(
      "/internal/ws/device/7?kind=physical&serial=1.2.3.4%3A5555",
    );
    expect(deviceWsTarget("7", { kind: "emulator", avdName: "a b", port: "5554" })).toBe(
      "/internal/ws/device/7?kind=emulator&avdName=a+b&port=5554",
    );
  });
});
