import { describe, it, expect, vi } from "vitest";
import type { WebSocket as NodeWebSocket } from "ws";
import {
  DEVICE_REQUEST_TIMEOUT_MS,
  createDevicesClient,
} from "../../src/services/remote-host-devices.js";
import { HostRequestError } from "../../src/services/remote-host-errors.js";

// The devices facet behind RemoteHostClient.devices (#3200, #3301): what
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

const unusedOpenInbound = () => {
  throw new Error("unexpected openInbound call");
};

describe("remote-host-devices", () => {
  it("gives a spawn, a teardown and an action longer than the client's default timeout", async () => {
    const request = vi.fn().mockResolvedValue({});
    const devices = createDevicesClient({ request, openInbound: unusedOpenInbound });
    await devices.spawn(SPEC);
    await devices.terminate("7", "emulator");
    await devices.action("7", { action: "tap", x: 1, y: 2 });

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
      .mockResolvedValueOnce({ deviceKinds: ["physical"], platforms: ["android"] });
    const devices = createDevicesClient({ request, openInbound: unusedOpenInbound });
    await expect(devices.live()).resolves.toEqual([]);
    await expect(devices.kinds()).resolves.toEqual({
      deviceKinds: ["physical"],
      platforms: ["android"],
    });
    expect(request.mock.calls.map((c) => c.length)).toEqual([1, 1]);
  });

  it("lists simulators on /internal/simulators with DEVICE_REQUEST_TIMEOUT_MS", async () => {
    const sims = [
      {
        udid: "0F4A9B7E-1111-2222-3333-444455556666",
        name: "iPhone 16 Pro",
        runtime: "iOS 18.2",
        state: "Booted",
      },
    ];
    const request = vi.fn().mockResolvedValueOnce({ simulators: sims });
    const devices = createDevicesClient({ request, openInbound: unusedOpenInbound });
    await expect(devices.simulators()).resolves.toEqual(sims);
    expect(request).toHaveBeenCalledWith(
      "/internal/simulators",
      undefined,
      DEVICE_REQUEST_TIMEOUT_MS,
    );
  });

  it("reads an agent answer with no platforms as Android-only", async () => {
    const some = vi.fn().mockResolvedValue({ deviceKinds: ["physical", "emulator"] });
    await expect(
      createDevicesClient({ request: some, openInbound: unusedOpenInbound }).kinds(),
    ).resolves.toEqual({ deviceKinds: ["physical", "emulator"], platforms: ["android"] });
    const none = vi.fn().mockResolvedValue({ deviceKinds: [] });
    await expect(
      createDevicesClient({ request: none, openInbound: unusedOpenInbound }).kinds(),
    ).resolves.toEqual({ deviceKinds: [], platforms: [] });
    const ios = vi
      .fn()
      .mockResolvedValue({ deviceKinds: ["physical"], platforms: ["android", "ios"] });
    await expect(
      createDevicesClient({ request: ios, openInbound: unusedOpenInbound }).kinds(),
    ).resolves.toEqual({ deviceKinds: ["physical"], platforms: ["android", "ios"] });
  });

  it("answers null for an agent that predates the kinds or simulators route, and rethrows anything else", async () => {
    const old = vi.fn().mockRejectedValue(new HostRequestError("h", 404, "nope"));
    await expect(
      createDevicesClient({ request: old, openInbound: unusedOpenInbound }).kinds(),
    ).resolves.toBeNull();
    await expect(
      createDevicesClient({ request: old, openInbound: unusedOpenInbound }).simulators(),
    ).resolves.toBeNull();
    const broken = vi.fn().mockRejectedValue(new HostRequestError("h", 500, "boom"));
    await expect(
      createDevicesClient({ request: broken, openInbound: unusedOpenInbound }).kinds(),
    ).rejects.toThrow();
    await expect(
      createDevicesClient({ request: broken, openInbound: unusedOpenInbound }).simulators(),
    ).rejects.toThrow();
  });

  it("builds the socket target with only the query values that are set", () => {
    const openInbound = vi.fn((target: string) => target as unknown as NodeWebSocket);
    const devices = createDevicesClient({ request: vi.fn(), openInbound });
    devices.openSocket("7", { kind: "physical", serial: "1.2.3.4:5555" });
    devices.openSocket("7", { kind: "emulator", avdName: "a b", port: "5554" });
    expect(openInbound.mock.calls.map(([target]) => target)).toEqual([
      "/internal/ws/device/7?kind=physical&serial=1.2.3.4%3A5555",
      "/internal/ws/device/7?kind=emulator&avdName=a+b&port=5554",
    ]);
  });
});
