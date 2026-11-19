import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildTestAppOnPlatform, warmSqliteBinding } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  DevicePlacementError,
  getDeviceHost,
  liveInfoForRows,
} from "../../src/services/device-host.js";
import { HostRequestError } from "../../src/services/remote-host-errors.js";
import { getDeviceRow, insertDevice, setDevicePort } from "../../src/services/device-store.js";
import { createHost } from "../../src/services/host-registry.js";
import type { DeviceInfo } from "../../src/services/device-drivers/types.js";

// The primary's DeviceHost layer (#3200): what a remote host is sent, what the
// primary persists from its answer, and how a listing treats a host that is
// down. The agent's own routes are covered by the multi-host integration test.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const devices = {
  kinds: vi.fn(),
  spawn: vi.fn(),
  live: vi.fn(),
  liveWithPorts: vi.fn(),
  terminate: vi.fn(),
  action: vi.fn(),
  pair: vi.fn(),
  discovered: vi.fn(),
};
const client = { devices };
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getRemoteHostClient: () => client };
});

const tmpDb = path.join(os.tmpdir(), `device-host-test-${process.pid}.db`);

function info(id: number, status: DeviceInfo["status"] = "streaming"): DeviceInfo {
  return {
    id: String(id),
    kind: "emulator",
    avdName: "a",
    label: null,
    status,
    serial: null,
    error: null,
  };
}

describe("DeviceHost", () => {
  let originalPlatform: NodeJS.Platform;
  beforeEach(async () => {
    await warmSqliteBinding();
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.DEVICE_ENABLED = "true";
    for (const fn of Object.values(devices)) fn.mockReset();
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DEVICE_ENABLED;
  });

  type App = Awaited<ReturnType<typeof buildTestAppOnPlatform>>;
  // `devices.host_id` is a foreign key, so a remote device needs a real host row.
  const host = (app: App, name: string) =>
    createHost(app, { name, baseUrl: `http://${name}.test`, token: "t" }).id;
  const emulator = (app: App, hostId: string) =>
    insertDevice(app, {
      kind: "emulator",
      avdName: "a",
      serial: null,
      projectId: null,
      name: "n",
      hostId,
    });

  it("sends a remote host the full spawn spec, naming the OTHER active ports on that host", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const mac = host(app, "mac");
    const mine = emulator(app, mac);
    const sibling = emulator(app, mac);
    const elsewhere = emulator(app, host(app, "other-host"));
    const stopped = emulator(app, mac);
    for (const [row, port, status] of [
      [sibling, 5556, "active"],
      [elsewhere, 5558, "active"],
      [stopped, 5560, "killed"],
    ] as const) {
      app.db.$client
        .prepare("UPDATE devices SET port = ?, status = ? WHERE id = ?")
        .run(port, status, row.id);
    }
    client.devices.spawn.mockResolvedValue({ info: info(mine.id), port: 5554 });

    await getDeviceHost(app, mac).getOrCreate(getDeviceRow(app, mine.id)!);

    expect(client.devices.spawn).toHaveBeenCalledWith({
      id: String(mine.id),
      kind: "emulator",
      avdName: "a",
      serial: null,
      label: "n",
      port: null,
      reservedPorts: [5556],
    });
  });

  it("names the platform in the spawn spec only for a device that is not Android (#3202)", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const mac = host(app, "mac");
    const row = emulator(app, mac);
    client.devices.spawn.mockResolvedValue({ info: info(row.id), port: null });
    const remote = getDeviceHost(app, mac);

    await remote.getOrCreate(row);
    expect(client.devices.spawn.mock.calls[0][0]).not.toHaveProperty("platform");
    expect(client.devices.spawn.mock.calls[0][0]).not.toHaveProperty("udid");

    client.devices.kinds.mockResolvedValue({ deviceKinds: [], platforms: ["ios"] });
    await remote.getOrCreate({ ...row, platform: "ios", udid: "UDID-1" });
    expect(client.devices.spawn.mock.calls[1][0]).toMatchObject({
      platform: "ios",
      udid: "UDID-1",
    });
  });

  it("refuses to send an iOS spec to a host that does not report ios, or does not report at all", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const mac = host(app, "mac");
    const row = { ...emulator(app, mac), platform: "ios" as const, udid: "UDID-1" };
    const remote = getDeviceHost(app, mac);

    // An agent that predates `platforms` is Android-only (the client reports it so).
    client.devices.kinds.mockResolvedValue({ deviceKinds: ["emulator"], platforms: ["android"] });
    await expect(remote.getOrCreate(row)).rejects.toThrow(
      new RegExp(`Host ${mac} does not support iOS simulators`),
    );
    client.devices.kinds.mockResolvedValue(null);
    await expect(remote.getOrCreate(row)).rejects.toThrow(/does not support iOS simulators/);
    expect(client.devices.spawn).not.toHaveBeenCalled();
  });

  it("persists the port a remote emulator reports, and not an unchanged one", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const mac = host(app, "mac");
    const row = emulator(app, mac);
    client.devices.spawn.mockResolvedValue({ info: info(row.id), port: 5554 });
    const remote = getDeviceHost(app, mac);

    await remote.getOrCreate(row);
    expect(getDeviceRow(app, row.id)!.port).toBe(5554);

    // A reattach sends the persisted port back, and the agent answers the same one.
    client.devices.spawn.mockClear();
    await remote.getOrCreate(getDeviceRow(app, row.id)!);
    expect(client.devices.spawn.mock.calls[0][0].port).toBe(5554);
    expect(getDeviceRow(app, row.id)!.port).toBe(5554);
  });

  it("routes terminate, action and info to the remote client", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const remote = getDeviceHost(app, host(app, "mac"));
    client.devices.terminate.mockResolvedValue(undefined);
    client.devices.action.mockResolvedValue({ ok: true });
    client.devices.live.mockResolvedValue([info(7)]);

    await remote.terminate(7, "emulator");
    expect(client.devices.terminate).toHaveBeenCalledWith("7", "emulator");
    await expect(remote.action(7, { action: "tap", x: 1, y: 2 })).resolves.toEqual({ ok: true });
    expect(client.devices.action).toHaveBeenCalledWith("7", { action: "tap", x: 1, y: 2 });
    await expect(remote.info(7)).resolves.toEqual(info(7));
    await expect(remote.info(8)).resolves.toBeUndefined();
  });

  it("answers local info from this process's own manager", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const local = getDeviceHost(app, "local");
    expect(local.isLocal).toBe(true);
    expect(getDeviceHost(app, "mac").isLocal).toBe(false);
    await expect(local.info(99)).resolves.toBeUndefined();
    await expect(local.action(99, { action: "screenshot" })).rejects.toThrow(
      /no live adb connection \(status: not running\)/,
    );
  });

  it("asks each agent host once for a listing and marks a silent host's rows unreachable", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const mac = host(app, "mac");
    const a1 = emulator(app, mac);
    const a2 = emulator(app, mac);
    const b1 = emulator(app, host(app, "down"));
    const localRow = emulator(app, "local");
    client.devices.liveWithPorts.mockImplementation(async () => {
      if (client.devices.liveWithPorts.mock.calls.length === 2) throw new Error("ECONNREFUSED");
      return { devices: [info(a1.id)] };
    });
    // Both hosts share one fake client, so make the first call "mac" and the second "down".
    const rows = [a1, a2, b1, localRow].map((r) => getDeviceRow(app, r.id)!);
    const lives = await liveInfoForRows(app, rows);

    expect(client.devices.liveWithPorts).toHaveBeenCalledTimes(2);
    expect(lives.get(a1.id)).toEqual({ live: info(a1.id), unreachable: false });
    expect(lives.get(a2.id)).toEqual({ live: undefined, unreachable: false });
    expect(lives.get(b1.id)).toEqual({ live: undefined, unreachable: true });
    expect(lives.get(localRow.id)).toEqual({ live: undefined, unreachable: false });
    expect(getDeviceRow(app, a1.id)!.port).toBeNull();
  });

  it("backfills a null remote emulator port from liveInfoForRows and logs without overwriting a different persisted port", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const mac = host(app, "mac");
    const missing = emulator(app, mac);
    const mismatch = emulator(app, mac);
    setDevicePort(app, mismatch.id, 5556);
    const warnSpy = vi.spyOn(app.log, "warn");
    client.devices.liveWithPorts.mockResolvedValue({
      devices: [info(missing.id), info(mismatch.id)],
      ports: { [String(missing.id)]: 5554, [String(mismatch.id)]: 5558 },
    });

    await liveInfoForRows(app, [getDeviceRow(app, missing.id)!, getDeviceRow(app, mismatch.id)!]);

    expect(getDeviceRow(app, missing.id)!.port).toBe(5554);
    expect(getDeviceRow(app, mismatch.id)!.port).toBe(5556);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: mismatch.id,
        hostId: mac,
        persistedPort: 5556,
        livePort: 5558,
      }),
      expect.stringContaining("differs from persisted port"),
    );
  });

  it("logs when a remote spawn returns a different port than persisted", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const mac = host(app, "mac");
    const row = emulator(app, mac);
    setDevicePort(app, row.id, 5554);
    const warnSpy = vi.spyOn(app.log, "warn");
    client.devices.spawn.mockResolvedValue({ info: info(row.id), port: 5556 });

    await getDeviceHost(app, mac).getOrCreate(getDeviceRow(app, row.id)!);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: row.id,
        hostId: mac,
        persistedPort: 5554,
        livePort: 5556,
      }),
      expect.stringContaining("different port than persisted"),
    );
    expect(getDeviceRow(app, row.id)!.port).toBe(5556);
  });

  it("routes pair and discovered to the remote client or local manager", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const mac = host(app, "mac");
    const remote = getDeviceHost(app, mac);
    const sample = [
      {
        id: "Android.local",
        name: "Pixel 7",
        host: "192.168.1.23",
        pairingAddress: "192.168.1.23:41234",
        connectAddress: "192.168.1.23:37251",
        discoveredAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    client.devices.pair.mockResolvedValue(undefined);
    client.devices.discovered.mockResolvedValue(sample);

    await remote.pair("192.168.1.23:41234", "123456");
    expect(client.devices.pair).toHaveBeenCalledWith("192.168.1.23:41234", "123456");
    await expect(remote.discovered()).resolves.toEqual(sample);

    const local = getDeviceHost(app, "local");
    const pairSpy = vi.spyOn(app.device, "pair").mockResolvedValue(undefined);
    await local.pair("192.168.1.24:41234", "654321");
    expect(pairSpy).toHaveBeenCalledWith("192.168.1.24:41234", "654321");
    await expect(local.discovered()).resolves.toEqual([]);
  });

  it("maps an older agent's 404 on pair() and discovered() to DevicePlacementError", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const mac = host(app, "mac");
    const remote = getDeviceHost(app, mac);

    client.devices.pair.mockRejectedValue(new HostRequestError(mac, 404, "Not Found"));
    await expect(remote.pair("192.168.1.23:41234", "123456")).rejects.toThrow(DevicePlacementError);
    await expect(remote.pair("192.168.1.23:41234", "123456")).rejects.toThrow(/update its agent/);

    client.devices.discovered.mockRejectedValue(new HostRequestError(mac, 404, "Not Found"));
    await expect(remote.discovered()).rejects.toThrow(DevicePlacementError);
    await expect(remote.discovered()).rejects.toThrow(/update its agent/);

    // Non-404 errors pass through unchanged so replyDeviceError forwards their status.
    client.devices.pair.mockRejectedValue(new HostRequestError(mac, 400, "bad code"));
    await expect(remote.pair("192.168.1.23:41234", "123456")).rejects.toThrow(HostRequestError);

    client.devices.discovered.mockRejectedValue(new HostRequestError(mac, 500, "boom"));
    await expect(remote.discovered()).rejects.toThrow(HostRequestError);
  });
});
