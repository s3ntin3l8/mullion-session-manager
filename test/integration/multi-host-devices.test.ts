import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import type * as ChildProcess from "node:child_process";
import { WebSocket as NodeWebSocket } from "ws";
import { eq } from "drizzle-orm";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { warmSqliteBinding } from "../helpers/app.js";
import { overrideDefaultRequestTimeoutForTests } from "../../src/services/remote-host-client.js";
import { devices } from "../../src/db/schema.js";
import {
  getDeviceRow,
  insertDevice,
  setDevicePort,
  setDeviceStatus,
} from "../../src/services/device-store.js";
import { DeviceActionError } from "../../src/services/device-drivers/types.js";
import type { DeviceInfo, DeviceVideoPacket } from "../../src/services/device-drivers/types.js";
import { seedHostResponse } from "../helpers/hosts.js";

// Issue #3200 end to end: a real agent app and a real primary in one process,
// the primary's /api/devices* and /ws/device/:id driving devices that live on
// the agent over loopback HTTP + WS. The agent's DeviceManager is stubbed (no
// adb, no emulator, no systemd-run): its methods are spied on the agent app
// instance, so everything between the primary's route and that manager is real.

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual, { passthrough: ["git"] });
});
vi.mock("../../src/services/avd-manager.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listAvds: vi.fn(),
    listDeviceProfiles: vi.fn(),
    listInstalledSystemImages: vi.fn(),
    createAvd: vi.fn(),
  };
});

const { buildApp } = await import("../../src/app.js");
const { listAvds, listDeviceProfiles, listInstalledSystemImages, createAvd } =
  await import("../../src/services/avd-manager.js");

const AGENT_TOKEN = "device-agent-token";
const primaryDb = path.join(
  os.tmpdir(),
  `multi-host-devices-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
);

type Built = Awaited<ReturnType<typeof buildAndListen>>;

async function buildAndListen(env: Record<string, string>, platform?: NodeJS.Platform) {
  const full: Record<string, string> = {
    SESSIONS_DIR: path.join(
      os.tmpdir(),
      `multi-host-devices-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
    ),
    ...env,
  };
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(full)) {
    prev[key] = process.env[key];
    process.env[key] = full[key];
  }
  const originalPlatform = process.platform;
  // The device plugin reads the platform when Fastify readies the app (inside
  // listen), so the stub spans both.
  if (platform) Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no bound address");
    return { app, port: address.port };
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    for (const key of Object.keys(full)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

/** A port nothing listens on: the "agent is down" host. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// What the agent's stubbed manager keeps: the live devices by id, the spawn
// options it was given, and one fake driver shared by every device.
interface FakeLive {
  info: DeviceInfo;
  port: number;
}
interface SpawnOpts {
  id: string;
  kind: "emulator" | "physical";
  avdName: string | null;
  serial: string | null;
  label: string | null;
  port: number | null;
}
const live = new Map<string, FakeLive>();
let nextPort = 5554;
let videoListeners: Array<(p: DeviceVideoPacket) => void> = [];
const driver = {
  platform: "android" as const,
  hasLiveControl: true,
  supports: () => true,
  screenshot: vi.fn(),
  tap: vi.fn(),
  input: vi.fn(),
  requestKeyframe: vi.fn(),
  onVideoPacket: vi.fn((cb: (p: DeviceVideoPacket) => void) => {
    videoListeners.push(cb);
    return () => {
      videoListeners = videoListeners.filter((l) => l !== cb);
    };
  }),
  onExit: vi.fn(() => () => {}),
  onClipboard: vi.fn(() => () => {}),
};

describe("devices on an agent host (issue #3200)", () => {
  let agent: Built;
  let primary: Built;
  let hostId: string;
  let deadHostId: string;
  let restoreTimeout: (() => void) | undefined;
  let spies: {
    getOrCreate: ReturnType<typeof vi.spyOn>;
    terminate: ReturnType<typeof vi.spyOn>;
    setReservedPorts: ReturnType<typeof vi.spyOn>;
    pair: ReturnType<typeof vi.spyOn>;
  };

  const getOrCreateCalls = () =>
    spies.getOrCreate.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
  const createDevice = (payload: Record<string, unknown> = {}) =>
    primary.app.inject({
      method: "POST",
      url: "/api/devices",
      payload: { avdName: "dev35", hostId, ...payload },
    });

  beforeAll(async () => {
    restoreTimeout = overrideDefaultRequestTimeoutForTests(15_000);
    fs.rmSync(primaryDb, { force: true });
    await warmSqliteBinding();
    agent = await buildAndListen(
      {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: AGENT_TOKEN,
        DEVICE_ENABLED: "true",
        DEVICE_AVDMANAGER_PATH: "/usr/bin/avdmanager",
        DEVICE_ANDROID_SDK_ROOT: "/opt/android-sdk",
      },
      "linux",
    );
    primary = await buildAndListen({ DATABASE_URL: `file:${primaryDb}` });

    const register = async (name: string, port: number, token: string) =>
      (
        await seedHostResponse(primary.app, { name, baseUrl: `http://127.0.0.1:${port}`, token })
      ).json().id as string;
    hostId = await register("device-agent", agent.port, AGENT_TOKEN);
    deadHostId = await register("dead-agent", await closedPort(), "unused-token");

    const dev = agent.app.device;
    spies = {
      getOrCreate: vi.spyOn(dev, "getOrCreate"),
      terminate: vi.spyOn(dev, "terminate"),
      setReservedPorts: vi.spyOn(dev, "setReservedPorts"),
      pair: vi.spyOn(dev, "pair"),
    };
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await primary.app.close();
    await agent.app.close();
    fs.rmSync(primaryDb, { force: true });
    restoreTimeout?.();
  });

  beforeEach(() => {
    live.clear();
    nextPort = 5554;
    videoListeners = [];
    vi.mocked(listAvds).mockReset().mockResolvedValue(["dev35", "dev36"]);
    vi.mocked(listDeviceProfiles).mockReset().mockResolvedValue(["pixel_7"]);
    vi.mocked(listInstalledSystemImages)
      .mockReset()
      .mockReturnValue([
        {
          packagePath: "system-images;android-35;google_apis;x86_64",
          apiLevel: "35",
          tagDisplay: "Google APIs",
          abi: "x86_64",
        },
      ]);
    vi.mocked(createAvd).mockReset().mockResolvedValue(undefined);
    driver.screenshot.mockReset().mockResolvedValue(new Uint8Array());
    driver.tap.mockReset().mockResolvedValue(undefined);
    driver.input.mockReset().mockResolvedValue(undefined);
    driver.requestKeyframe.mockReset().mockResolvedValue(undefined);
    spies.getOrCreate.mockReset().mockImplementation(async (opts: SpawnOpts) => {
      const existing = live.get(opts.id);
      if (existing) return { toInfo: () => existing.info, port: existing.port } as never;
      const port = opts.port ?? nextPort;
      nextPort = port + 2;
      const entry: FakeLive = {
        port,
        info: {
          id: opts.id,
          kind: opts.kind,
          avdName: opts.avdName,
          label: opts.label,
          status: "booting",
          serial: opts.kind === "emulator" ? `emulator-${port}` : opts.serial,
          error: null,
        },
      };
      live.set(opts.id, entry);
      return { toInfo: () => entry.info, port } as never;
    });
    spies.terminate.mockReset().mockImplementation(async (id: string) => {
      live.delete(id);
    });
    spies.setReservedPorts.mockReset().mockImplementation(() => {});
    spies.pair.mockReset().mockResolvedValue(undefined);
    vi.spyOn(agent.app.device, "list").mockImplementation(() =>
      [...live.values()].map((l) => l.info),
    );
    vi.spyOn(agent.app.device, "get").mockImplementation((id: string) => {
      const entry = live.get(id);
      return entry ? ({ toInfo: () => entry.info, port: entry.port } as never) : undefined;
    });
    vi.spyOn(agent.app.device, "getDriver").mockImplementation((id: string) =>
      live.has(id) ? (driver as never) : undefined,
    );
    vi.spyOn(agent.app.device, "getOrCreateDriver").mockImplementation(async (opts: SpawnOpts) => {
      await agent.app.device.getOrCreate(opts);
      return driver as never;
    });
  });

  afterEach(() => {
    primary.app.db.delete(devices).run();
  });

  describe("the agent's /internal/devices routes", () => {
    it("require the agent token and report the kinds the agent can run", async () => {
      const anon = await agent.app.inject({ method: "GET", url: "/internal/devices/kinds" });
      expect([401, 403]).toContain(anon.statusCode);
      const wrong = await agent.app.inject({
        method: "GET",
        url: "/internal/devices/live",
        headers: { authorization: "Bearer not-the-token" },
      });
      expect([401, 403]).toContain(wrong.statusCode);

      const ok = await agent.app.inject({
        method: "GET",
        url: "/internal/devices/kinds",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().deviceKinds).toEqual(expect.arrayContaining(["emulator", "physical"]));
      // DEVICE_IOS_ENABLED is unset: Android only.
      expect(ok.json().platforms).toEqual(["android"]);
      // A Linux agent cannot run iOS at all, so it gives no reason why not (#3510).
      expect(ok.json()).not.toHaveProperty("unavailable");
    });

    it("refuses a spawn for an iOS device when the agent has no iOS Simulator available", async () => {
      const res = await agent.app.inject({
        method: "POST",
        url: "/internal/devices",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        payload: {
          id: "9",
          kind: "emulator",
          avdName: null,
          serial: null,
          label: null,
          port: null,
          reservedPorts: [],
          platform: "ios",
          udid: "0F4A9B7E-1111-2222-3333-444455556666",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/iOS Simulator is not available on this host/);
    });

    it("refuses a device socket whose port is outside 1-65535 or whose kind is unknown", async () => {
      const headers = { authorization: `Bearer ${AGENT_TOKEN}` };
      for (const query of ["kind=emulator&port=0", "kind=emulator&port=65536", "kind=tablet"]) {
        const res = await agent.app.inject({
          method: "GET",
          url: `/internal/ws/device/5?${query}`,
          headers,
        });
        expect(res.statusCode, query).toBe(400);
      }
    });

    it("answers 424 with deviceStatus for a 5xx DeviceActionError, keeps 4xx, and leaves unexpected errors as 500", async () => {
      live.set("1", {
        port: 5554,
        info: {
          id: "1",
          kind: "emulator",
          avdName: "dev35",
          label: null,
          status: "booting",
          serial: "emulator-5554",
          error: null,
        },
      });
      const headers = { authorization: `Bearer ${AGENT_TOKEN}` };

      driver.tap.mockRejectedValueOnce(new DeviceActionError(502, "adb server unreachable"));
      const r502 = await agent.app.inject({
        method: "POST",
        url: "/internal/devices/1/action",
        headers,
        payload: { action: "tap", x: 1, y: 2 },
      });
      expect(r502.statusCode).toBe(424);
      expect(r502.json()).toEqual({
        statusCode: 424,
        error: "Failed Dependency",
        message: "adb server unreachable",
        deviceStatus: 502,
      });

      driver.tap.mockRejectedValueOnce(new DeviceActionError(400, "bad coords"));
      const r400 = await agent.app.inject({
        method: "POST",
        url: "/internal/devices/1/action",
        headers,
        payload: { action: "tap", x: 1, y: 2 },
      });
      expect(r400.statusCode).toBe(400);
      expect(r400.json().message).toContain("bad coords");

      driver.tap.mockRejectedValueOnce(new Error("boom"));
      const r500 = await agent.app.inject({
        method: "POST",
        url: "/internal/devices/1/action",
        headers,
        payload: { action: "tap", x: 1, y: 2 },
      });
      expect(r500.statusCode).toBe(500);
    });

    it("answers 424 with deviceStatus 500 when terminate throws, and 204 on success", async () => {
      const headers = { authorization: `Bearer ${AGENT_TOKEN}` };
      spies.terminate.mockRejectedValueOnce(new Error("scope stuck"));
      const fail = await agent.app.inject({
        method: "POST",
        url: "/internal/devices/1/terminate",
        headers,
        payload: { kind: "emulator" },
      });
      expect(fail.statusCode).toBe(424);
      expect(fail.json()).toEqual({
        statusCode: 424,
        error: "Failed Dependency",
        message: "scope stuck",
        deviceStatus: 500,
      });

      const ok = await agent.app.inject({
        method: "POST",
        url: "/internal/devices/1/terminate",
        headers,
        payload: { kind: "emulator" },
      });
      expect(ok.statusCode).toBe(204);
    });
  });

  describe("POST /api/devices with a hostId", () => {
    it("creates the row on that host, spawns on the agent with the right spec and persists the port it reports", async () => {
      const res = await createDevice({ name: "Pixel" });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ hostId, kind: "emulator", avdName: "dev35", name: "Pixel" });
      expect(body.live).toMatchObject({ id: String(body.id), status: "booting" });

      expect(getOrCreateCalls()).toEqual([
        {
          id: String(body.id),
          kind: "emulator",
          avdName: "dev35",
          serial: null,
          label: "Pixel",
          port: null,
        },
      ]);
      expect(spies.setReservedPorts).toHaveBeenCalledWith([]);
      expect(getDeviceRow(primary.app, body.id)).toMatchObject({ hostId, port: 5554 });
    });

    it("reserves the ports of the OTHER active rows on that host only", async () => {
      const first = (await createDevice()).json();
      // A killed row on this host and an active one on another host hold ports too.
      const killed = insertDevice(primary.app, {
        kind: "emulator",
        avdName: "old",
        serial: null,
        projectId: null,
        name: null,
        hostId,
      });
      setDevicePort(primary.app, killed.id, 5700);
      setDeviceStatus(primary.app, killed.id, "killed");
      const elsewhere = insertDevice(primary.app, {
        kind: "emulator",
        avdName: "far",
        serial: null,
        projectId: null,
        name: null,
        hostId: deadHostId,
      });
      setDevicePort(primary.app, elsewhere.id, 5800);

      const second = (await createDevice({ avdName: "dev36" })).json();
      expect(second.id).not.toBe(first.id);
      expect(spies.setReservedPorts).toHaveBeenLastCalledWith([5554]);
      expect(getDeviceRow(primary.app, second.id)?.port).toBe(5556);
    });

    it("rejects an unknown hostId with 400 and inserts no row", async () => {
      const res = await createDevice({ hostId: "no-such-host" });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("Unknown host");
      expect(primary.app.db.select().from(devices).all()).toEqual([]);
      expect(spies.getOrCreate).not.toHaveBeenCalled();
    });

    it("refuses a kind the agent does not report before inserting a row", async () => {
      const mutable = agent.app as unknown as { deviceKinds: string[] };
      const original = mutable.deviceKinds;
      mutable.deviceKinds = ["physical"];
      try {
        const res = await createDevice();
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain("cannot run emulator");
      } finally {
        mutable.deviceKinds = original;
      }
      expect(primary.app.db.select().from(devices).all()).toEqual([]);
      expect(spies.getOrCreate).not.toHaveBeenCalled();
    });

    it("refuses with the panel-off message when the agent has the device panel disabled", async () => {
      const mutable = agent.app as unknown as { devicePanelEnabled: boolean };
      mutable.devicePanelEnabled = false;
      try {
        const res = await createDevice();
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain("DEVICE_ENABLED=true");
      } finally {
        mutable.devicePanelEnabled = true;
      }
      expect(primary.app.db.select().from(devices).all()).toEqual([]);
    });

    it("forwards the agent's own refusal of a spawn", async () => {
      spies.getOrCreate.mockRejectedValueOnce(new Error("scope left over"));
      const res = await createDevice();
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("scope left over");
    });

    it("answers 503 when the agent cannot be reached", async () => {
      const res = await createDevice({ hostId: deadHostId });
      expect(res.statusCode).toBe(503);
      expect(primary.app.db.select().from(devices).all()).toEqual([]);
    });
  });

  describe("GET /api/devices", () => {
    it("lists the agent's device with its live info, and marks a down host's rows unreachable", async () => {
      const mine = (await createDevice()).json();
      const stranded = insertDevice(primary.app, {
        kind: "emulator",
        avdName: "far",
        serial: null,
        projectId: null,
        name: null,
        hostId: deadHostId,
      });

      const res = await primary.app.inject({ method: "GET", url: "/api/devices" });
      expect(res.statusCode).toBe(200);
      const items = res.json() as Array<Record<string, unknown>>;
      const ok = items.find((i) => i.id === mine.id);
      expect(ok).toMatchObject({ hostId, live: { id: String(mine.id), status: "booting" } });
      expect(ok).not.toHaveProperty("hostUnreachable");
      expect(items.find((i) => i.id === stranded.id)).toMatchObject({
        hostId: deadHostId,
        live: null,
        hostUnreachable: true,
      });
    });

    it("still lists (200) when the agent starts failing mid-flight", async () => {
      await createDevice();
      vi.spyOn(agent.app.device, "list").mockImplementation(() => {
        throw new Error("manager gone");
      });
      const res = await primary.app.inject({ method: "GET", url: "/api/devices" });
      expect(res.statusCode).toBe(200);
      expect(res.json()[0]).toMatchObject({ live: null, hostUnreachable: true });
    });
  });

  describe("POST /api/devices/:id/action", () => {
    it("runs the action on the agent's driver and returns its result", async () => {
      const { id } = (await createDevice()).json();
      const res = await primary.app.inject({
        method: "POST",
        url: `/api/devices/${id}/action`,
        payload: { action: "tap", x: 10, y: 20 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(driver.tap).toHaveBeenCalledWith(10, 20);
    });

    it("forwards an agent-side DeviceActionError(400) with its status and message", async () => {
      const { id } = (await createDevice()).json();
      driver.tap.mockRejectedValueOnce(new DeviceActionError(400, "no live adb connection"));
      const res = await primary.app.inject({
        method: "POST",
        url: `/api/devices/${id}/action`,
        payload: { action: "tap", x: 1, y: 2 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("no live adb connection");
    });

    it("forwards a 502 from the agent's screenshot driver with its status and message", async () => {
      const { id } = (await createDevice()).json();
      driver.screenshot.mockRejectedValueOnce(
        new DeviceActionError(502, "screencap did not return a PNG"),
      );
      const res = await primary.app.inject({
        method: "POST",
        url: `/api/devices/${id}/action`,
        payload: { action: "screenshot" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toContain("screencap did not return a PNG");
    });

    it("answers 503 unreachable when the agent's action route throws an unexpected error", async () => {
      const { id } = (await createDevice()).json();
      driver.tap.mockRejectedValueOnce(new Error("unexpected crash"));
      const res = await primary.app.inject({
        method: "POST",
        url: `/api/devices/${id}/action`,
        payload: { action: "tap", x: 1, y: 2 },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().message).toContain("unreachable");
    });

    it("answers 400 for a device the agent has no live driver for", async () => {
      const { id } = (await createDevice()).json();
      live.clear();
      const res = await primary.app.inject({
        method: "POST",
        url: `/api/devices/${id}/action`,
        payload: { action: "tap", x: 1, y: 2 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("no live adb connection");
    });

    it("answers 503, not 500, when the agent is unreachable", async () => {
      const row = insertDevice(primary.app, {
        kind: "emulator",
        avdName: "far",
        serial: null,
        projectId: null,
        name: null,
        hostId: deadHostId,
      });
      const res = await primary.app.inject({
        method: "POST",
        url: `/api/devices/${row.id}/action`,
        payload: { action: "tap", x: 1, y: 2 },
      });
      expect(res.statusCode).toBe(503);
    });
  });

  describe("stop and delete", () => {
    it("POST /stop tears the agent's device down with its kind and keeps the row", async () => {
      const { id } = (await createDevice()).json();
      const res = await primary.app.inject({ method: "POST", url: `/api/devices/${id}/stop` });
      expect(res.statusCode).toBe(204);
      expect(spies.terminate).toHaveBeenCalledWith(String(id), "emulator");
      expect(getDeviceRow(primary.app, id)?.status).toBe("killed");
      expect(live.has(String(id))).toBe(false);
    });

    it("DELETE tears down through the agent, then removes the row", async () => {
      const { id } = (await createDevice()).json();
      const res = await primary.app.inject({ method: "DELETE", url: `/api/devices/${id}` });
      expect(res.statusCode).toBe(204);
      expect(spies.terminate).toHaveBeenCalledWith(String(id), "emulator");
      expect(getDeviceRow(primary.app, id)).toBeUndefined();
    });

    it("DELETE answers 500 with the teardown message and keeps the row when the agent's teardown fails", async () => {
      const { id } = (await createDevice()).json();
      spies.terminate.mockRejectedValueOnce(new Error("scope stuck"));
      const res = await primary.app.inject({ method: "DELETE", url: `/api/devices/${id}` });
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toContain("scope stuck");
      expect(getDeviceRow(primary.app, id)).toBeDefined();
    });

    it("POST /stop answers 500 with the teardown message and keeps the row when the agent's teardown fails", async () => {
      const { id } = (await createDevice()).json();
      spies.terminate.mockRejectedValueOnce(new Error("scope stuck"));
      const res = await primary.app.inject({ method: "POST", url: `/api/devices/${id}/stop` });
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toContain("scope stuck");
      expect(getDeviceRow(primary.app, id)).toBeDefined();
    });

    it("falls back to 502/500 with a generic message when an agent 424 has a garbage body or out-of-range deviceStatus", async () => {
      let nextReply: { body: string } = { body: "not-json" };
      const stubServer = http.createServer((_req, res) => {
        res.statusCode = 424;
        res.setHeader("content-type", "application/json");
        res.end(nextReply.body);
      });
      await new Promise<void>((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
      const { port } = stubServer.address() as net.AddressInfo;
      let stubHostId: string | undefined;
      try {
        const reg = await seedHostResponse(primary.app, {
          name: "bad-424-agent",
          baseUrl: `http://127.0.0.1:${port}`,
          token: "t",
        });
        stubHostId = reg.json().id as string;
        const row = insertDevice(primary.app, {
          kind: "emulator",
          avdName: "far",
          serial: null,
          projectId: null,
          name: null,
          hostId: stubHostId,
        });

        nextReply = { body: "not-json" };
        const badAction = await primary.app.inject({
          method: "POST",
          url: `/api/devices/${row.id}/action`,
          payload: { action: "tap", x: 1, y: 2 },
        });
        expect(badAction.statusCode).toBe(502);
        expect(badAction.json().message).toBe(`the device failed on host ${stubHostId}`);

        nextReply = { body: JSON.stringify({ deviceStatus: 200, message: 123 }) };
        const badTerminate = await primary.app.inject({
          method: "POST",
          url: `/api/devices/${row.id}/stop`,
        });
        expect(badTerminate.statusCode).toBe(500);
        expect(badTerminate.json().message).toBe(`the device failed on host ${stubHostId}`);

        const badActionStatus = await primary.app.inject({
          method: "POST",
          url: `/api/devices/${row.id}/action`,
          payload: { action: "tap", x: 1, y: 2 },
        });
        expect(badActionStatus.statusCode).toBe(502);
        expect(badActionStatus.json().message).toBe(`the device failed on host ${stubHostId}`);
      } finally {
        if (stubHostId) {
          await primary.app.inject({ method: "DELETE", url: `/api/hosts/${stubHostId}` });
        }
        await new Promise<void>((resolve) => stubServer.close(() => resolve()));
      }
    });

    it("DELETE keeps the row (503) when the agent is unreachable", async () => {
      const row = insertDevice(primary.app, {
        kind: "emulator",
        avdName: "far",
        serial: null,
        projectId: null,
        name: null,
        hostId: deadHostId,
      });
      const res = await primary.app.inject({ method: "DELETE", url: `/api/devices/${row.id}` });
      expect(res.statusCode).toBe(503);
      expect(getDeviceRow(primary.app, row.id)).toBeDefined();
    });
  });

  describe("reattach after an agent restart", () => {
    it("sends the persisted port in the spec when the row is spawned again", async () => {
      const { id } = (await createDevice()).json();
      expect(getDeviceRow(primary.app, id)?.port).toBe(5554);

      // The agent restarts: a fresh manager knows nothing.
      live.clear();
      spies.getOrCreate.mockClear();
      const res = await primary.app.inject({ method: "POST", url: `/api/devices/${id}/start` });
      expect(res.statusCode).toBe(200);
      expect(getOrCreateCalls()).toEqual([
        expect.objectContaining({ id: String(id), kind: "emulator", port: 5554 }),
      ]);
      expect(getDeviceRow(primary.app, id)?.port).toBe(5554);
    });

    it("recovers a port lost from the spawn response on the next list, and sends it after an agent restart", async () => {
      const { id } = (await createDevice()).json();
      expect(getDeviceRow(primary.app, id)?.port).toBe(5554);

      // Simulate a lost spawn response leaving the primary's row at port = null.
      primary.app.db.update(devices).set({ port: null }).where(eq(devices.id, id)).run();
      expect(getDeviceRow(primary.app, id)?.port).toBeNull();

      // The next listing reconciles the port from GET /internal/devices/live.
      const list = await primary.app.inject({ method: "GET", url: "/api/devices" });
      expect(list.statusCode).toBe(200);
      expect(getDeviceRow(primary.app, id)?.port).toBe(5554);

      // After an agent restart, a later spawn sends the recovered port in the spec.
      live.clear();
      spies.getOrCreate.mockClear();
      const res = await primary.app.inject({ method: "POST", url: `/api/devices/${id}/start` });
      expect(res.statusCode).toBe(200);
      expect(getOrCreateCalls()).toEqual([
        expect.objectContaining({ id: String(id), kind: "emulator", port: 5554 }),
      ]);
    });
  });

  describe("WS /ws/device/:id for a remote row", () => {
    async function connect(id: number) {
      const ws = new NodeWebSocket(`ws://127.0.0.1:${primary.port}/ws/device/${id}`);
      const frames: Array<{ data: Buffer; binary: boolean }> = [];
      ws.on("message", (data, binary) => frames.push({ data: data as Buffer, binary }));
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      // The agent's half is attached once it has subscribed to the device's video.
      await vi.waitFor(() => expect(videoListeners).toHaveLength(1), { timeout: 5_000 });
      return { ws, frames };
    }

    it("relays a video frame from the agent's device unchanged, and input back to its driver", async () => {
      const { id } = (await createDevice()).json();
      const { ws, frames } = await connect(id);
      try {
        // The agent spawned the device for this row (the proxy's REST get-or-create).
        expect(getOrCreateCalls().every((c: Record<string, unknown>) => c.id === String(id))).toBe(
          true,
        );

        const payload = new Uint8Array([0, 0, 0, 1, 0x65, 0xaa, 0xbb]);
        for (const l of [...videoListeners]) l({ type: "data", keyframe: true, data: payload });
        await vi.waitFor(() => expect(frames.filter((f) => f.binary)).toHaveLength(1));
        const got = frames.filter((f) => f.binary)[0].data;
        expect([...got]).toEqual([1, 1, ...payload]);

        const tap = { type: "tap", x: 5, y: 6, videoWidth: 100, videoHeight: 200 };
        ws.send(JSON.stringify(tap));
        await vi.waitFor(() => expect(driver.input).toHaveBeenCalledWith(tap));
      } finally {
        ws.close();
      }
      // Closing the browser socket unsubscribes the agent's listener.
      await vi.waitFor(() => expect(videoListeners).toHaveLength(0));
    });

    it("reports an agent-side spawn failure on the socket and closes it", async () => {
      const { id } = (await createDevice()).json();
      live.clear();
      spies.getOrCreate.mockRejectedValue(new Error("Scope dead"));
      const ws = new NodeWebSocket(`ws://127.0.0.1:${primary.port}/ws/device/${id}`);
      const messages: string[] = [];
      ws.on("message", (d) => messages.push(String(d)));
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
      expect(messages.map((m) => JSON.parse(m))).toEqual([
        expect.objectContaining({ type: "error", message: expect.stringContaining("Scope dead") }),
      ]);
    });
  });

  describe("pairing and discovery on agent hosts (#3271)", () => {
    const sampleDiscovered = {
      id: "Pixel-7.local",
      name: "Pixel 7",
      host: "192.168.1.23",
      pairingAddress: "192.168.1.23:41234",
      connectAddress: "192.168.1.23:37251",
      discoveredAt: "2026-01-01T00:00:00.000Z",
    };

    it("requires the agent bearer token on /internal/devices/pair and /discovered and validates addresses", async () => {
      const anonDiscovered = await agent.app.inject({
        method: "GET",
        url: "/internal/devices/discovered",
      });
      expect([401, 403]).toContain(anonDiscovered.statusCode);

      const anonPair = await agent.app.inject({
        method: "POST",
        url: "/internal/devices/pair",
        payload: { pairingAddress: "192.168.1.23:41234", pairingCode: "123456" },
      });
      expect([401, 403]).toContain(anonPair.statusCode);

      const badAddr = await agent.app.inject({
        method: "POST",
        url: "/internal/devices/pair",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        payload: { pairingAddress: "192.168.1.23:99999", pairingCode: "123456" },
      });
      expect(badAddr.statusCode).toBe(400);

      const badCode = await agent.app.inject({
        method: "POST",
        url: "/internal/devices/pair",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        payload: { pairingAddress: "192.168.1.23:41234", pairingCode: "abcdef" },
      });
      expect(badCode.statusCode).toBe(400);

      const badPhysicalSpawn = await agent.app.inject({
        method: "POST",
        url: "/internal/devices",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        payload: {
          id: "9",
          kind: "physical",
          avdName: null,
          serial: "bad:1:2",
          label: null,
          port: null,
          reservedPorts: [],
        },
      });
      expect(badPhysicalSpawn.statusCode).toBe(400);
    });

    it("lists discovered devices on an agent and answers 503 when unreachable", async () => {
      const discSpy = vi
        .spyOn(agent.app.deviceDiscovery, "getDiscovered")
        .mockReturnValue([sampleDiscovered]);
      try {
        const res = await primary.app.inject({
          method: "GET",
          url: `/api/devices/discovered?hostId=${hostId}`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual([sampleDiscovered]);

        const down = await primary.app.inject({
          method: "GET",
          url: `/api/devices/discovered?hostId=${deadHostId}`,
        });
        expect(down.statusCode).toBe(503);

        const unknown = await primary.app.inject({
          method: "GET",
          url: "/api/devices/discovered?hostId=no-such-host",
        });
        expect(unknown.statusCode).toBe(400);
      } finally {
        discSpy.mockRestore();
      }
    });

    it("routes POST /api/devices/pair to the agent and answers 503 when unreachable", async () => {
      const res = await primary.app.inject({
        method: "POST",
        url: "/api/devices/pair",
        payload: {
          pairingAddress: "192.168.1.23:41234",
          pairingCode: "123456",
          hostId,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(spies.pair).toHaveBeenCalledWith("192.168.1.23:41234", "123456");

      spies.pair.mockRejectedValueOnce(new Error("wrong code"));
      const bad = await primary.app.inject({
        method: "POST",
        url: "/api/devices/pair",
        payload: {
          pairingAddress: "192.168.1.23:41234",
          pairingCode: "123456",
          hostId,
        },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().message).toContain("wrong code");

      const down = await primary.app.inject({
        method: "POST",
        url: "/api/devices/pair",
        payload: {
          pairingAddress: "192.168.1.23:41234",
          pairingCode: "123456",
          hostId: deadHostId,
        },
      });
      expect(down.statusCode).toBe(503);
    });

    it("routes pair-and-connect to the agent, scopes discoveryId per host, and scopes collision guard per host", async () => {
      const agentDiscSpy = vi
        .spyOn(agent.app.deviceDiscovery, "getDiscovered")
        .mockReturnValue([sampleDiscovered]);
      const localDiscSpy = vi
        .spyOn(primary.app.deviceDiscovery, "getById")
        .mockImplementation((id) =>
          id === "Local-Phone.local"
            ? {
                id: "Local-Phone.local",
                name: "Local Phone",
                host: "192.168.1.50",
                pairingAddress: "192.168.1.50:41234",
                connectAddress: "192.168.1.50:37251",
                discoveredAt: "2026-01-01T00:00:00.000Z",
              }
            : undefined,
        );
      try {
        // Cross-host discoveryId is refused: primary cannot use agent's discoveryId,
        // and agent cannot use primary's discoveryId.
        const agentIdOnPrimary = await primary.app.inject({
          method: "POST",
          url: "/api/devices/pair-and-connect",
          payload: { discoveryId: sampleDiscovered.id, pairingCode: "123456", hostId: "local" },
        });
        expect(agentIdOnPrimary.statusCode).toBe(400);

        const primaryIdOnAgent = await primary.app.inject({
          method: "POST",
          url: "/api/devices/pair-and-connect",
          payload: { discoveryId: "Local-Phone.local", pairingCode: "123456", hostId },
        });
        expect(primaryIdOnAgent.statusCode).toBe(400);
        expect(primaryIdOnAgent.json().message).toContain("no longer in the discovery cache");

        // Valid discoveryId on the agent pairs and connects on the agent.
        const ok = await primary.app.inject({
          method: "POST",
          url: "/api/devices/pair-and-connect",
          payload: { discoveryId: sampleDiscovered.id, pairingCode: "123456", hostId, name: "Lab" },
        });
        expect(ok.statusCode).toBe(201);
        expect(ok.json()).toMatchObject({
          hostId,
          kind: "physical",
          serial: sampleDiscovered.connectAddress,
          name: "Lab",
        });
        expect(spies.pair).toHaveBeenCalledWith(sampleDiscovered.pairingAddress, "123456");
        expect(getOrCreateCalls()).toEqual([
          expect.objectContaining({
            kind: "physical",
            serial: sampleDiscovered.connectAddress,
          }),
        ]);

        // Duplicate connectAddress on the SAME hostId is refused with 409.
        const dup = await primary.app.inject({
          method: "POST",
          url: "/api/devices/pair-and-connect",
          payload: {
            pairingAddress: "192.168.1.23:41234",
            connectAddress: sampleDiscovered.connectAddress,
            pairingCode: "123456",
            hostId,
          },
        });
        expect(dup.statusCode).toBe(409);

        // Same connectAddress on a DIFFERENT hostId is allowed (separate LAN).
        const localRow = insertDevice(primary.app, {
          kind: "physical",
          serial: sampleDiscovered.connectAddress,
          avdName: null,
          projectId: null,
          name: "Local same IP",
          hostId: "local",
        });
        expect(localRow.hostId).toBe("local");

        // Unreachable host rolls back the row and answers 503.
        const beforeCount = primary.app.db.select().from(devices).all().length;
        const down = await primary.app.inject({
          method: "POST",
          url: "/api/devices/pair-and-connect",
          payload: {
            pairingAddress: "192.168.1.99:41234",
            connectAddress: "192.168.1.99:37251",
            pairingCode: "123456",
            hostId: deadHostId,
          },
        });
        expect(down.statusCode).toBe(503);
        expect(primary.app.db.select().from(devices).all()).toHaveLength(beforeCount);
      } finally {
        agentDiscSpy.mockRestore();
        localDiscSpy.mockRestore();
      }
    });
  });

  describe("AVD listing and creation on an agent host (issue #3272)", () => {
    it("rejects unauthenticated requests to /internal/avds* and /internal/system-images and /internal/device-profiles", async () => {
      for (const [method, url] of [
        ["GET", "/internal/avds"],
        ["GET", "/internal/system-images"],
        ["GET", "/internal/device-profiles"],
        ["POST", "/internal/avds"],
      ] as const) {
        const res = await agent.app.inject({
          method,
          url,
          ...(method === "POST"
            ? {
                payload: {
                  name: "pixel_test",
                  systemImage: "system-images;android-35;google_apis;x86_64",
                  deviceProfile: "pixel_7",
                },
              }
            : {}),
        });
        expect(res.statusCode).toBe(401);
      }
    });

    it("lists the agent's AVDs, system images, and device profiles via ?hostId=", async () => {
      vi.mocked(listAvds).mockResolvedValueOnce(["agent_avd_1", "agent_avd_2"]);
      const avdsRes = await primary.app.inject({
        method: "GET",
        url: `/api/avds?hostId=${encodeURIComponent(hostId)}`,
      });
      expect(avdsRes.statusCode).toBe(200);
      expect(avdsRes.json()).toEqual({ avds: ["agent_avd_1", "agent_avd_2"] });

      const imagesRes = await primary.app.inject({
        method: "GET",
        url: `/api/system-images?hostId=${encodeURIComponent(hostId)}`,
      });
      expect(imagesRes.statusCode).toBe(200);
      expect(imagesRes.json().systemImages).toEqual([
        expect.objectContaining({ packagePath: "system-images;android-35;google_apis;x86_64" }),
      ]);

      const profilesRes = await primary.app.inject({
        method: "GET",
        url: `/api/device-profiles?hostId=${encodeURIComponent(hostId)}`,
      });
      expect(profilesRes.statusCode).toBe(200);
      expect(profilesRes.json()).toEqual({ deviceProfiles: ["pixel_7"] });
    });

    it("creates an AVD on the agent host via POST /api/avds and forwards agent refusals", async () => {
      const okRes = await primary.app.inject({
        method: "POST",
        url: "/api/avds",
        payload: {
          hostId,
          name: "remote_avd",
          systemImage: "system-images;android-35;google_apis;x86_64",
          deviceProfile: "pixel_7",
          sdcardSize: "512M",
        },
      });
      expect(okRes.statusCode).toBe(201);
      expect(okRes.json()).toEqual({ name: "remote_avd" });
      expect(createAvd).toHaveBeenCalledWith(
        expect.objectContaining({
          avdmanagerPath: "/usr/bin/avdmanager",
          name: "remote_avd",
          systemImage: "system-images;android-35;google_apis;x86_64",
          deviceProfile: "pixel_7",
          sdcardSize: "512M",
        }),
      );

      // Agent allowlists systemImage against its own installed images.
      const badImageRes = await primary.app.inject({
        method: "POST",
        url: "/api/avds",
        payload: {
          hostId,
          name: "remote_avd_2",
          systemImage: "system-images;android-99;google_apis;x86_64",
          deviceProfile: "pixel_7",
        },
      });
      expect(badImageRes.statusCode).toBe(400);
      expect(badImageRes.json().message).toContain("installed system images");

      // Agent allowlists deviceProfile against its own known profiles.
      const badProfileRes = await primary.app.inject({
        method: "POST",
        url: "/api/avds",
        payload: {
          hostId,
          name: "remote_avd_3",
          systemImage: "system-images;android-35;google_apis;x86_64",
          deviceProfile: "no_such_profile",
        },
      });
      expect(badProfileRes.statusCode).toBe(400);
      expect(badProfileRes.json().message).toContain("known device profiles");
    });

    it("answers 503 (not 500) when the agent host is unreachable, and 400 for an unknown hostId", async () => {
      const deadGet = await primary.app.inject({
        method: "GET",
        url: `/api/avds?hostId=${encodeURIComponent(deadHostId)}`,
      });
      expect(deadGet.statusCode).toBe(503);

      const deadPost = await primary.app.inject({
        method: "POST",
        url: "/api/avds",
        payload: {
          hostId: deadHostId,
          name: "remote_avd",
          systemImage: "system-images;android-35;google_apis;x86_64",
          deviceProfile: "pixel_7",
        },
      });
      expect(deadPost.statusCode).toBe(503);

      const unknownGet = await primary.app.inject({
        method: "GET",
        url: "/api/avds?hostId=no-such-host",
      });
      expect(unknownGet.statusCode).toBe(400);
    });

    it("refuses POST /api/devices with 400 naming the host and inserts no row when the agent lacks the AVD", async () => {
      const res = await createDevice({ avdName: "missing_on_agent" });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain(hostId);
      expect(res.json().message).toContain("missing_on_agent");
      expect(primary.app.db.select().from(devices).all()).toEqual([]);
      expect(spies.getOrCreate).not.toHaveBeenCalled();
    });

    it("translates a 404 from an older agent on the AVD routes into an actionable 400", async () => {
      const { createServer } = await import("node:http");
      const oldAgent = createServer((req, res) => {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: `Route ${req.method}:${req.url} not found` }));
      });
      await new Promise<void>((resolve) => oldAgent.listen(0, "127.0.0.1", () => resolve()));
      const address = oldAgent.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");

      const oldHostId = (
        await seedHostResponse(primary.app, {
          name: "old-agent",
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "unused-token",
        })
      ).json().id as string;

      try {
        for (const url of [
          `/api/avds?hostId=${encodeURIComponent(oldHostId)}`,
          `/api/system-images?hostId=${encodeURIComponent(oldHostId)}`,
          `/api/device-profiles?hostId=${encodeURIComponent(oldHostId)}`,
        ]) {
          const res = await primary.app.inject({ method: "GET", url });
          expect(res.statusCode).toBe(400);
          expect(res.json().message).toBe(
            `Host ${oldHostId} does not report AVDs — update its agent.`,
          );
        }

        const postRes = await primary.app.inject({
          method: "POST",
          url: "/api/avds",
          payload: {
            hostId: oldHostId,
            name: "remote_avd",
            systemImage: "system-images;android-35;google_apis;x86_64",
            deviceProfile: "pixel_7",
          },
        });
        expect(postRes.statusCode).toBe(400);
        expect(postRes.json().message).toBe(
          `Host ${oldHostId} does not report AVDs — update its agent.`,
        );
      } finally {
        await primary.app.inject({ method: "DELETE", url: `/api/hosts/${oldHostId}` });
        await new Promise<void>((resolve) => oldAgent.close(() => resolve()));
      }
    });
  });
});
