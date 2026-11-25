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

const unusedOpenChannel = () => {
  throw new Error("unexpected openChannel call");
};

describe("remote-host-devices", () => {
  it("gives a spawn, a teardown and an action longer than the client's default timeout", async () => {
    const request = vi.fn().mockResolvedValue({});
    const devices = createDevicesClient({
      request,
      openInbound: unusedOpenInbound,
      openChannel: unusedOpenChannel,
    });
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

  it("names the platform in a teardown only for a non-Android device", async () => {
    const request = vi.fn().mockResolvedValue({});
    const devices = createDevicesClient({
      request,
      openInbound: unusedOpenInbound,
      openChannel: unusedOpenChannel,
    });
    await devices.terminate("7", "emulator", "android");
    await devices.terminate("8", "emulator", "ios");
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ kind: "emulator" });
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({
      kind: "emulator",
      platform: "ios",
    });
  });

  it("passes an agent's iOS unavailable reason on, and drops a malformed or missing one (#3510)", async () => {
    const request = vi.fn();
    const devices = createDevicesClient({
      request,
      openInbound: unusedOpenInbound,
      openChannel: unusedOpenChannel,
    });
    request.mockResolvedValueOnce({
      deviceKinds: [],
      platforms: [],
      unavailable: { ios: "iOS Simulator is off — set DEVICE_IOS_ENABLED=true." },
    });
    await expect(devices.kinds()).resolves.toEqual({
      deviceKinds: [],
      platforms: [],
      unavailable: { ios: "iOS Simulator is off — set DEVICE_IOS_ENABLED=true." },
    });
    // An older agent omits the field.
    request.mockResolvedValueOnce({ deviceKinds: ["physical"], platforms: ["android"] });
    await expect(devices.kinds()).resolves.toEqual({
      deviceKinds: ["physical"],
      platforms: ["android"],
    });
    request.mockResolvedValueOnce({ deviceKinds: [], platforms: [], unavailable: { ios: 42 } });
    await expect(devices.kinds()).resolves.not.toHaveProperty("unavailable");
    // An empty reason would render as a bare "Mac (x): " row.
    request.mockResolvedValueOnce({ deviceKinds: [], platforms: [], unavailable: { ios: "" } });
    await expect(devices.kinds()).resolves.not.toHaveProperty("unavailable");
  });

  it("leaves the cheap reads on the default timeout", async () => {
    const discoveredDevice = {
      id: "Android.local",
      name: "Pixel 7",
      host: "192.168.1.23",
      pairingAddress: "192.168.1.23:41234",
      connectAddress: "192.168.1.23:37251",
      discoveredAt: "2026-01-01T00:00:00.000Z",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ devices: [], ports: { "7": 5554 } })
      .mockResolvedValueOnce({ deviceKinds: ["physical"], platforms: ["android"] })
      .mockResolvedValueOnce({ devices: [discoveredDevice] });
    const devices = createDevicesClient({
      request,
      openInbound: unusedOpenInbound,
      openChannel: unusedOpenChannel,
    });
    await expect(devices.live()).resolves.toEqual({ devices: [], ports: { "7": 5554 } });
    await expect(devices.kinds()).resolves.toEqual({
      deviceKinds: ["physical"],
      platforms: ["android"],
    });
    await expect(devices.discovered()).resolves.toEqual([discoveredDevice]);
    expect(request.mock.calls.map((c) => c.length)).toEqual([1, 1, 1]);
  });

  it("sends pair to /internal/devices/pair with DEVICE_REQUEST_TIMEOUT_MS", async () => {
    const request = vi.fn().mockResolvedValueOnce({ ok: true });
    const devices = createDevicesClient({
      request,
      openInbound: unusedOpenInbound,
      openChannel: unusedOpenChannel,
    });
    await expect(devices.pair("192.168.1.23:41234", "123456")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(
      "/internal/devices/pair",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ pairingAddress: "192.168.1.23:41234", pairingCode: "123456" }),
      }),
      DEVICE_REQUEST_TIMEOUT_MS,
    );
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
    const devices = createDevicesClient({
      request,
      openInbound: unusedOpenInbound,
      openChannel: unusedOpenChannel,
    });
    await expect(devices.simulators()).resolves.toEqual(sims);
    expect(request).toHaveBeenCalledWith(
      "/internal/simulators",
      undefined,
      DEVICE_REQUEST_TIMEOUT_MS,
    );
  });

  it("reads the simulator catalog and creates a simulator, answering null from an old agent", async () => {
    const catalog = { deviceTypes: [{ id: "t", name: "iPhone 16" }], runtimes: [] };
    const sim = { udid: "U", name: "QA", runtime: "iOS 18.2", state: "Shutdown" };
    const request = vi
      .fn()
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce({ simulator: sim });
    const client = createDevicesClient({
      request,
      openInbound: unusedOpenInbound,
      openChannel: unusedOpenChannel,
    });
    await expect(client.simulatorCatalog()).resolves.toEqual(catalog);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/internal/simulators/catalog",
      undefined,
      DEVICE_REQUEST_TIMEOUT_MS,
    );
    const input = { name: "QA", deviceTypeId: "t", runtimeId: "r" };
    await expect(client.createSimulator(input)).resolves.toEqual(sim);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/internal/simulators",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
      DEVICE_REQUEST_TIMEOUT_MS,
    );

    const old = vi.fn().mockRejectedValue(new HostRequestError("h", 404, "nope"));
    const oldClient = createDevicesClient({
      request: old,
      openInbound: unusedOpenInbound,
      openChannel: unusedOpenChannel,
    });
    await expect(oldClient.simulatorCatalog()).resolves.toBeNull();
    await expect(oldClient.createSimulator(input)).resolves.toBeNull();

    const broken = vi.fn().mockRejectedValue(new HostRequestError("h", 500, "boom"));
    const brokenClient = createDevicesClient({
      request: broken,
      openInbound: unusedOpenInbound,
      openChannel: unusedOpenChannel,
    });
    await expect(brokenClient.simulatorCatalog()).rejects.toThrow(HostRequestError);
    await expect(brokenClient.createSimulator(input)).rejects.toThrow(HostRequestError);
  });

  it("reads an agent answer with no platforms as Android-only", async () => {
    const some = vi.fn().mockResolvedValue({ deviceKinds: ["physical", "emulator"] });
    await expect(
      createDevicesClient({
        request: some,
        openInbound: unusedOpenInbound,
        openChannel: unusedOpenChannel,
      }).kinds(),
    ).resolves.toEqual({ deviceKinds: ["physical", "emulator"], platforms: ["android"] });
    const none = vi.fn().mockResolvedValue({ deviceKinds: [] });
    await expect(
      createDevicesClient({
        request: none,
        openInbound: unusedOpenInbound,
        openChannel: unusedOpenChannel,
      }).kinds(),
    ).resolves.toEqual({ deviceKinds: [], platforms: [] });
    const ios = vi
      .fn()
      .mockResolvedValue({ deviceKinds: ["physical"], platforms: ["android", "ios"] });
    await expect(
      createDevicesClient({
        request: ios,
        openInbound: unusedOpenInbound,
        openChannel: unusedOpenChannel,
      }).kinds(),
    ).resolves.toEqual({ deviceKinds: ["physical"], platforms: ["android", "ios"] });
  });

  it("answers null for an agent that predates the kinds or simulators route, and rethrows anything else", async () => {
    const old = vi.fn().mockRejectedValue(new HostRequestError("h", 404, "nope"));
    await expect(
      createDevicesClient({
        request: old,
        openInbound: unusedOpenInbound,
        openChannel: unusedOpenChannel,
      }).kinds(),
    ).resolves.toBeNull();
    await expect(
      createDevicesClient({
        request: old,
        openInbound: unusedOpenInbound,
        openChannel: unusedOpenChannel,
      }).simulators(),
    ).resolves.toBeNull();
    const broken = vi.fn().mockRejectedValue(new HostRequestError("h", 500, "boom"));
    await expect(
      createDevicesClient({
        request: broken,
        openInbound: unusedOpenInbound,
        openChannel: unusedOpenChannel,
      }).kinds(),
    ).rejects.toThrow();
    await expect(
      createDevicesClient({
        request: broken,
        openInbound: unusedOpenInbound,
        openChannel: unusedOpenChannel,
      }).simulators(),
    ).rejects.toThrow();
  });

  it("prefers the channel for the device socket, and falls back to the inbound route for a legacy peer", () => {
    const openInbound = vi.fn((target: string) => target as unknown as NodeWebSocket);
    const openChannel = vi.fn((): NodeWebSocket | null => null);
    const devices = createDevicesClient({ request: vi.fn(), openInbound, openChannel });
    // A legacy peer (no channel negotiated): the inbound route is dialed.
    devices.openSocket("7", { kind: "emulator" });
    expect(openChannel).toHaveBeenCalledWith("device", "7", { id: "7", kind: "emulator" });
    expect(openInbound).toHaveBeenCalledWith("/internal/ws/device/7?kind=emulator");

    // A host that negotiated the channel: the inbound route is never dialed.
    const channelSocket = {} as NodeWebSocket;
    openChannel.mockReturnValue(channelSocket);
    const bound = createDevicesClient({ request: vi.fn(), openInbound, openChannel });
    expect(bound.openSocket("8", { kind: "physical", serial: "1.2.3.4:5555" })).toBe(channelSocket);
    expect(openChannel).toHaveBeenLastCalledWith("device", "8", {
      id: "8",
      kind: "physical",
      serial: "1.2.3.4:5555",
    });
    expect(openInbound).toHaveBeenCalledTimes(1);
  });

  it("builds the socket target with only the query values that are set", () => {
    const openInbound = vi.fn((target: string) => target as unknown as NodeWebSocket);
    const devices = createDevicesClient({
      request: vi.fn(),
      openInbound,
      openChannel: vi.fn(() => null),
    });
    devices.openSocket("7", { kind: "physical", serial: "1.2.3.4:5555" });
    devices.openSocket("7", { kind: "emulator", avdName: "a b", port: "5554" });
    devices.openSocket("8", { kind: "emulator", platform: "ios", udid: "U-1" });
    expect(openInbound.mock.calls.map(([target]) => target)).toEqual([
      "/internal/ws/device/7?kind=physical&serial=1.2.3.4%3A5555",
      "/internal/ws/device/7?kind=emulator&avdName=a+b&port=5554",
      "/internal/ws/device/8?kind=emulator&platform=ios&udid=U-1",
    ]);
  });
});
