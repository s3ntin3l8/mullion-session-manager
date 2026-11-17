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
import { getDeviceHost, liveInfoForRows } from "../../src/services/device-host.js";
import { getDeviceRow, insertDevice } from "../../src/services/device-store.js";
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
  terminate: vi.fn(),
  action: vi.fn(),
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

    await remote.getOrCreate({ ...row, platform: "ios", udid: "UDID-1" });
    expect(client.devices.spawn.mock.calls[1][0]).toMatchObject({ platform: "ios", udid: "UDID-1" });
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
    client.devices.live.mockImplementation(async () => {
      if (client.devices.live.mock.calls.length === 2) throw new Error("ECONNREFUSED");
      return [info(a1.id)];
    });
    // Both hosts share one fake client, so make the first call "mac" and the second "down".
    const rows = [a1, a2, b1, localRow].map((r) => getDeviceRow(app, r.id)!);
    const lives = await liveInfoForRows(app, rows);

    expect(client.devices.live).toHaveBeenCalledTimes(2);
    expect(lives.get(a1.id)).toEqual({ live: info(a1.id), unreachable: false });
    expect(lives.get(a2.id)).toEqual({ live: undefined, unreachable: false });
    expect(lives.get(b1.id)).toEqual({ live: undefined, unreachable: true });
    expect(lives.get(localRow.id)).toEqual({ live: undefined, unreachable: false });
  });
});
