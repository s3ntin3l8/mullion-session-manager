import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import type * as ChildProcess from "node:child_process";
import { WebSocket as NodeWebSocket } from "ws";
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

const { buildApp } = await import("../../src/app.js");

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
      { MULLION_ROLE: "agent", MULLION_AGENT_TOKEN: AGENT_TOKEN, DEVICE_ENABLED: "true" },
      "linux",
    );
    primary = await buildAndListen({ DATABASE_URL: `file:${primaryDb}` });

    const register = async (name: string, port: number, token: string) =>
      (
        await primary.app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name, baseUrl: `http://127.0.0.1:${port}`, token },
        })
      ).json().id as string;
    hostId = await register("device-agent", agent.port, AGENT_TOKEN);
    deadHostId = await register("dead-agent", await closedPort(), "unused-token");

    const dev = agent.app.device;
    spies = {
      getOrCreate: vi.spyOn(dev, "getOrCreate"),
      terminate: vi.spyOn(dev, "terminate"),
      setReservedPorts: vi.spyOn(dev, "setReservedPorts"),
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
    vi.spyOn(agent.app.device, "list").mockImplementation(() =>
      [...live.values()].map((l) => l.info),
    );
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

    // KNOWN GAP (reported with the PR that added this file): a DeviceActionError
    // with a 5xx status (the Android driver throws 502 for a dead adb server) is
    // flattened by RemoteHostTransport.request, which only forwards 4xx as a
    // HostRequestError and turns any 5xx into HostUnreachableError. The primary
    // therefore answers 503 "Host ... is unreachable" instead of the agent's 502
    // and its message, unlike a local device. Update this when that is fixed.
    it("currently answers 503 (not the agent's 502) for a 5xx DeviceActionError", async () => {
      const { id } = (await createDevice()).json();
      driver.tap.mockRejectedValueOnce(new DeviceActionError(502, "adb server unreachable"));
      const res = await primary.app.inject({
        method: "POST",
        url: `/api/devices/${id}/action`,
        payload: { action: "tap", x: 1, y: 2 },
      });
      expect(res.statusCode).toBe(503);
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

    it("DELETE keeps the row when the agent's teardown fails", async () => {
      const { id } = (await createDevice()).json();
      spies.terminate.mockRejectedValueOnce(new Error("scope stuck"));
      const res = await primary.app.inject({ method: "DELETE", url: `/api/devices/${id}` });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(getDeviceRow(primary.app, id)).toBeDefined();
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
});
