import type * as HostCapabilities from "../../src/services/host-capabilities.js";
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
import { createHost } from "../../src/services/host-registry.js";
import { HostUnreachableError } from "../../src/services/remote-host-errors.js";
import { insertDevice, listDeviceRows } from "../../src/services/device-store.js";
import type { IosEngine, IosEngineSpec } from "../../src/services/ios-device.js";
import type { DeviceVideoPacket } from "../../src/services/device-drivers/types.js";

// Creating, placing, running and tearing down an iOS Simulator device through
// the real entry points (#1943). The engine is a fake driver behind
// createIdbIosEngine; no simulator, simctl or idb_companion is involved.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const getCachedCapabilities = vi.fn();
vi.mock("../../src/services/host-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HostCapabilities>()),
  warmCapabilitiesOnReady: vi.fn(),
  getCachedCapabilities: (...args: unknown[]) => getCachedCapabilities(...args),
  detectCapabilities: async () => getCachedCapabilities(),
}));

const UDID = "0F4A9B7E-1111-2222-3333-444455556666";
const OTHER_UDID = "1A2B3C4D-1111-2222-3333-444455556666";
const SIMULATORS = [
  { udid: UDID, name: "iPhone 16 Pro", runtime: "iOS 18.2", state: "Booted" },
  { udid: OTHER_UDID, name: "iPhone 16", runtime: "iOS 18.2", state: "Shutdown" },
];

const listIosSimulators = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/ios-simulators.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listIosSimulators,
}));

const devices = {
  kinds: vi.fn(),
  spawn: vi.fn(),
  live: vi.fn(),
  terminate: vi.fn(),
  action: vi.fn(),
  simulators: vi.fn(),
};
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getRemoteHostClient: () => ({ devices }) };
});

// The scope backend must never be built for an iOS device.
const getDeviceScopeBackend = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/scope/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDeviceScopeBackend,
}));

// The fake engine behind createIdbIosEngine.
const engines: FakeEngine[] = [];
class FakeEngine implements IosEngine {
  readonly driver: IosEngine["driver"];
  readonly start = vi.fn(async () => {
    this.status = "streaming";
  });
  readonly stop = vi.fn(async () => {
    this.status = "exited";
  });
  status = "booting";
  readonly input = vi.fn(async () => undefined);
  constructor(readonly spec: IosEngineSpec) {
    this.driver = this.makeDriver();
  }
  private makeDriver() {
    const packets: DeviceVideoPacket[] = [
      { type: "configuration", data: new Uint8Array([0, 0, 0, 1, 0x67]) },
      { type: "data", keyframe: true, data: new Uint8Array([0, 0, 0, 1, 0x65, 9]) },
    ];
    return {
      platform: "ios" as const,
      id: this.spec.id,
      get isAlive() {
        return true;
      },
      hasLiveControl: true,
      toInfo: () => ({
        id: this.spec.id,
        kind: "emulator" as const,
        avdName: null,
        label: this.spec.label,
        status: this.status,
        serial: this.spec.udid,
        error: null,
      }),
      stop: this.stop,
      onVideoPacket: (listener: (p: DeviceVideoPacket) => void) => {
        for (const p of packets) listener(p);
        return () => undefined;
      },
      onExit: () => () => undefined,
      onClipboard: () => () => undefined,
      requestKeyframe: async () => undefined,
      input: this.input,
      supports: () => true,
    } as unknown as IosEngine["driver"];
  }
}
vi.mock("../../src/services/ios-device.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createIdbIosEngine: () => (spec: IosEngineSpec) => {
    const engine = new FakeEngine(spec);
    engines.push(engine);
    return engine;
  },
}));

const tmpDb = path.join(os.tmpdir(), `devices-ios-test-${process.pid}.db`);
type App = Awaited<ReturnType<typeof buildTestAppOnPlatform>>;

describe("iOS Simulator devices (#1943)", () => {
  let originalPlatform: NodeJS.Platform;
  let tmpDir: string;

  beforeEach(async () => {
    await warmSqliteBinding();
    originalPlatform = process.platform;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devices-ios-"));
    const companion = path.join(tmpDir, "idb_companion");
    fs.writeFileSync(companion, "#!/bin/sh\n", { mode: 0o755 });
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_IOS_ENABLED = "true";
    process.env.DEVICE_IDB_COMPANION_PATH = companion;
    getCachedCapabilities.mockReset().mockResolvedValue(["xcode"]);
    listIosSimulators.mockReset().mockResolvedValue(SIMULATORS);
    getDeviceScopeBackend.mockReset();
    for (const fn of Object.values(devices)) fn.mockReset();
    engines.length = 0;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of [
      "DATABASE_URL",
      "DEVICE_ENABLED",
      "DEVICE_IOS_ENABLED",
      "DEVICE_IDB_COMPANION_PATH",
      "MULLION_ROLE",
      "MULLION_AGENT_TOKEN",
    ]) {
      delete process.env[key];
    }
  });

  const create = (app: App, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/devices", payload: { platform: "ios", ...payload } });

  describe("on the primary's own host", () => {
    it("creates a device, starts its engine and reads it back live", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const res = await create(app, { udid: UDID, name: "My iPhone" });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        platform: "ios",
        kind: "emulator",
        udid: UDID,
        avdName: null,
        serial: null,
        hostId: "local",
        name: "My iPhone",
        status: "active",
      });
      expect(engines).toHaveLength(1);
      expect(engines[0]!.spec).toEqual({
        id: String(res.json().id),
        udid: UDID,
        label: "My iPhone",
      });
      await vi.waitFor(() => expect(engines[0]!.start).toHaveBeenCalled());

      const one = await app.inject({ method: "GET", url: `/api/devices/${res.json().id}` });
      expect(one.json().live).toMatchObject({ status: "streaming", serial: UDID });
      expect(listDeviceRows(app)[0]).toMatchObject({ platform: "ios", udid: UDID, avdName: null });
      expect(getDeviceScopeBackend).not.toHaveBeenCalled();
      await app.close();
    });

    it("answers 400 naming the UDID for a simulator the host does not list, and inserts no row", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const missing = "99999999-1111-2222-3333-444455556666";
      const res = await create(app, { udid: missing });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain(missing);
      expect(listDeviceRows(app)).toHaveLength(0);
      expect(engines).toHaveLength(0);
      await app.close();
    });

    it("answers 400 when the udid is missing", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const res = await create(app, {});
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/udid is required/);
      expect(listDeviceRows(app)).toHaveLength(0);
      await app.close();
    });

    it("answers 409 for a second ACTIVE row on the same simulator, and allows it once the first is stopped", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const first = await create(app, { udid: UDID });
      expect(first.statusCode).toBe(201);

      const dup = await create(app, { udid: UDID });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().message).toContain(String(first.json().id));
      expect(listDeviceRows(app)).toHaveLength(1);

      const other = await create(app, { udid: OTHER_UDID });
      expect(other.statusCode).toBe(201);

      await app.inject({ method: "POST", url: `/api/devices/${first.json().id}/stop` });
      const again = await create(app, { udid: UDID });
      expect(again.statusCode).toBe(201);

      // Starting the stopped first row would now make two active rows on one simulator.
      const start = await app.inject({
        method: "POST",
        url: `/api/devices/${first.json().id}/start`,
      });
      expect(start.statusCode).toBe(409);
      await app.close();
    });

    it("answers 400 when iOS is not available on this host, and inserts no row", async () => {
      process.env.DEVICE_IOS_ENABLED = "false";
      const app = await buildTestAppOnPlatform("darwin");
      const res = await create(app, { udid: UDID });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/iOS Simulator is not available/);
      expect(listDeviceRows(app)).toHaveLength(0);
      await app.close();
    });

    it("names the disabled panel, not iOS config, when DEVICE_ENABLED is off", async () => {
      delete process.env.DEVICE_ENABLED;
      const app = await buildTestAppOnPlatform("darwin");
      const res = await create(app, { udid: UDID });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe(app.devicePanelUnavailableMessage);
      expect(listDeviceRows(app)).toHaveLength(0);
      await app.close();
    });

    it("stop and delete tear down through the engine and never the scope backend", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const { id } = (await create(app, { udid: UDID })).json();

      const stop = await app.inject({ method: "POST", url: `/api/devices/${id}/stop` });
      expect(stop.statusCode).toBe(204);
      expect(engines[0]!.stop).toHaveBeenCalledTimes(1);
      expect(listDeviceRows(app)[0]).toMatchObject({ status: "killed" });

      // Restart reaches getOrCreate again and builds a fresh engine.
      const start = await app.inject({ method: "POST", url: `/api/devices/${id}/start` });
      expect(start.statusCode).toBe(200);
      expect(engines).toHaveLength(2);

      const del = await app.inject({ method: "DELETE", url: `/api/devices/${id}` });
      expect(del.statusCode).toBe(204);
      expect(engines[1]!.stop).toHaveBeenCalledTimes(1);
      expect(listDeviceRows(app)).toHaveLength(0);

      // A stop with nothing in memory (e.g. after a Mullion restart) finds no
      // engine to stop, and still never resolves a scope for the id.
      const orphan = insertDevice(app, {
        kind: "emulator",
        platform: "ios",
        udid: OTHER_UDID,
        avdName: null,
        serial: null,
        projectId: null,
        name: null,
        hostId: "local",
      });
      const orphanStop = await app.inject({
        method: "POST",
        url: `/api/devices/${orphan.id}/stop`,
      });
      expect(orphanStop.statusCode).toBe(204);
      expect(getDeviceScopeBackend).not.toHaveBeenCalled();
      await app.close();
    });

    it("gates an iOS row by iOS availability, never by the Android emulator gate", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const { id } = (await create(app, { udid: UDID })).json();
      await app.inject({ method: "POST", url: `/api/devices/${id}/stop` });

      // The Android emulator gate is off; the iOS row does not care.
      (app as unknown as { deviceEmulatorEnabled: boolean }).deviceEmulatorEnabled = false;
      const start = await app.inject({ method: "POST", url: `/api/devices/${id}/start` });
      expect(start.statusCode).toBe(200);
      const ws = await app.inject({ method: "GET", url: `/ws/device/${id}` });
      expect(ws.statusCode).not.toBe(400); // upgrade required, not refused

      // iOS itself going away refuses both.
      await app.inject({ method: "POST", url: `/api/devices/${id}/stop` });
      getCachedCapabilities.mockResolvedValue([]);
      const refused = await app.inject({ method: "POST", url: `/api/devices/${id}/start` });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().message).toMatch(/iOS Simulator is not available/);
      await app.close();
    });

    it("streams the driver's frames over the panel socket and relays input to it", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const { id } = (await create(app, { udid: UDID })).json();
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("bad address");

      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/device/${id}`);
      ws.binaryType = "arraybuffer";
      const frames: Uint8Array[] = [];
      ws.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) frames.push(new Uint8Array(event.data));
      });
      await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      // [type][flags][payload]: the configuration, then the keyframe.
      expect([...frames[0]!.slice(0, 2)]).toEqual([0, 0]);
      expect([...frames[1]!.slice(0, 2)]).toEqual([1, 1]);
      expect([...frames[1]!.slice(2)]).toEqual([0, 0, 0, 1, 0x65, 9]);

      ws.send(JSON.stringify({ type: "tap", x: 10, y: 20, videoWidth: 100, videoHeight: 200 }));
      await vi.waitFor(() => expect(engines[0]!.input).toHaveBeenCalled());
      expect(engines[0]!.input).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tap", x: 10, y: 20 }),
      );
      ws.close();
      await app.close();
    });
  });

  describe("on an agent host", () => {
    const placeOnAgent = (app: App) =>
      createHost(app, { name: "mac-mini", baseUrl: "http://mac.test", token: "t" }).id;

    it("creates a device on an agent that reports ios, sending the platform and udid", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const mac = placeOnAgent(app);
      devices.kinds.mockResolvedValue({ deviceKinds: ["physical"], platforms: ["android", "ios"] });
      devices.simulators.mockResolvedValue(SIMULATORS);
      devices.spawn.mockResolvedValue({
        info: { id: "1", kind: "emulator", status: "booting", serial: UDID },
        port: null,
      });

      const res = await create(app, { udid: UDID, hostId: mac });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ hostId: mac, platform: "ios", udid: UDID });
      expect(devices.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ id: String(res.json().id), platform: "ios", udid: UDID }),
      );
      // Nothing ran on the primary itself.
      expect(engines).toHaveLength(0);

      // Stopping names the platform, so the agent never falls back to a scope.
      const stop = await app.inject({ method: "POST", url: `/api/devices/${res.json().id}/stop` });
      expect(stop.statusCode).toBe(204);
      expect(devices.terminate).toHaveBeenCalledWith(String(res.json().id), "emulator", "ios");

      // The same simulator on ANOTHER host is not a duplicate.
      expect(listDeviceRows(app)[0]).toMatchObject({ hostId: mac, status: "killed" });
      await app.close();
    });

    it("refuses an agent that does not report ios: 400 naming the host, no row, no spawn", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const mac = placeOnAgent(app);
      // An agent that predates `platforms` is normalised to Android-only by the client.
      devices.kinds.mockResolvedValue({ deviceKinds: ["emulator"], platforms: ["android"] });

      const res = await create(app, { udid: UDID, hostId: mac });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain(mac);
      expect(listDeviceRows(app)).toHaveLength(0);
      expect(devices.simulators).not.toHaveBeenCalled();
      expect(devices.spawn).not.toHaveBeenCalled();

      devices.kinds.mockResolvedValue(null);
      const old = await create(app, { udid: UDID, hostId: mac });
      expect(old.statusCode).toBe(400);
      expect(old.json().message).toContain("update its agent");
      expect(devices.spawn).not.toHaveBeenCalled();
      await app.close();
    });

    it("refuses to send an iOS spec to a host that stopped reporting ios (start of an existing row)", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const mac = placeOnAgent(app);
      const row = insertDevice(app, {
        kind: "emulator",
        platform: "ios",
        udid: UDID,
        avdName: null,
        serial: null,
        projectId: null,
        name: null,
        hostId: mac,
      });
      devices.kinds.mockResolvedValue({ deviceKinds: ["emulator"], platforms: ["android"] });

      const res = await app.inject({ method: "POST", url: `/api/devices/${row.id}/start` });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain(mac);
      expect(devices.spawn).not.toHaveBeenCalled();
      await app.close();
    });

    it("answers 503 and inserts no row when the agent is down", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const mac = placeOnAgent(app);
      devices.kinds.mockRejectedValue(new HostUnreachableError(mac, new Error("ECONNREFUSED")));

      const res = await create(app, { udid: UDID, hostId: mac });
      expect(res.statusCode).toBe(503);
      expect(res.json().message).toContain(mac);
      expect(listDeviceRows(app)).toHaveLength(0);
      await app.close();
    });

    it("answers 400 for a simulator the agent does not list", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const mac = placeOnAgent(app);
      devices.kinds.mockResolvedValue({ deviceKinds: [], platforms: ["ios"] });
      devices.simulators.mockResolvedValue([SIMULATORS[1]]);

      const res = await create(app, { udid: UDID, hostId: mac });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain(UDID);
      expect(devices.spawn).not.toHaveBeenCalled();

      devices.simulators.mockResolvedValue(null);
      const outdated = await create(app, { udid: UDID, hostId: mac });
      expect(outdated.statusCode).toBe(400);
      expect(outdated.json().message).toContain("update its agent");
      await app.close();
    });
  });

  describe("the agent's own routes", () => {
    const auth = { authorization: "Bearer secret-agent-token" };
    const spec = {
      id: "5",
      kind: "emulator",
      avdName: null,
      serial: null,
      label: "iPhone",
      port: null,
      platform: "ios",
      udid: UDID,
      reservedPorts: [],
    };

    beforeEach(() => {
      process.env.MULLION_ROLE = "agent";
      process.env.MULLION_AGENT_TOKEN = "secret-agent-token";
    });

    it("reports ios, spawns the simulator and tears it down through the engine", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const kinds = await app.inject({
        method: "GET",
        url: "/internal/devices/kinds",
        headers: auth,
      });
      expect(kinds.json().platforms).toContain("ios");

      const spawned = await app.inject({
        method: "POST",
        url: "/internal/devices",
        headers: auth,
        payload: spec,
      });
      expect(spawned.statusCode).toBe(200);
      expect(spawned.json()).toMatchObject({ port: null, info: { id: "5", serial: UDID } });
      expect(engines[0]!.spec).toEqual({ id: "5", udid: UDID, label: "iPhone" });

      const live = await app.inject({
        method: "GET",
        url: "/internal/devices/live",
        headers: auth,
      });
      expect(live.json().devices).toHaveLength(1);

      const stop = await app.inject({
        method: "POST",
        url: "/internal/devices/5/terminate",
        headers: auth,
        payload: { kind: "emulator", platform: "ios" },
      });
      expect(stop.statusCode).toBe(204);
      expect(engines[0]!.stop).toHaveBeenCalledTimes(1);
      expect(getDeviceScopeBackend).not.toHaveBeenCalled();
      await app.close();
    });

    it("refuses an iOS spec without a udid, or when iOS is not available, before the manager sees it", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const noUdid = await app.inject({
        method: "POST",
        url: "/internal/devices",
        headers: auth,
        payload: { ...spec, udid: null },
      });
      expect(noUdid.statusCode).toBe(400);
      expect(noUdid.json().message).toMatch(/udid is required/);

      getCachedCapabilities.mockResolvedValue([]);
      const off = await app.inject({
        method: "POST",
        url: "/internal/devices",
        headers: auth,
        payload: spec,
      });
      expect(off.statusCode).toBe(400);
      expect(off.json().message).toMatch(/iOS Simulator is not available/);
      expect(engines).toHaveLength(0);
      await app.close();
    });

    it("gates the agent's device socket by iOS availability for an iOS device", async () => {
      const app = await buildTestAppOnPlatform("darwin");
      const ok = await app.inject({
        method: "GET",
        url: `/internal/ws/device/5?kind=emulator&platform=ios&udid=${UDID}`,
        headers: auth,
      });
      expect(ok.statusCode).not.toBe(400); // upgrade required

      const noUdid = await app.inject({
        method: "GET",
        url: "/internal/ws/device/5?kind=emulator&platform=ios",
        headers: auth,
      });
      expect(noUdid.statusCode).toBe(400);
      const badPlatform = await app.inject({
        method: "GET",
        url: "/internal/ws/device/5?kind=emulator&platform=windows",
        headers: auth,
      });
      expect(badPlatform.statusCode).toBe(400);

      getCachedCapabilities.mockResolvedValue([]);
      const off = await app.inject({
        method: "GET",
        url: `/internal/ws/device/5?kind=emulator&platform=ios&udid=${UDID}`,
        headers: auth,
      });
      expect(off.statusCode).toBe(400);
      expect(off.json().message).toMatch(/iOS Simulator is not available/);
      await app.close();
    });
  });
});
