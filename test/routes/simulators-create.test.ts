import type * as HostCapabilities from "../../src/services/host-capabilities.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildTestAppOnPlatform, warmSqliteBinding } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { createPairedHost } from "../../src/services/host-registry.js";
import { HostUnreachableError } from "../../src/services/remote-host-errors.js";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

const execFileMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...mockChildProcessSpawn(actual),
    execFile: (...args: unknown[]) => execFileMock(...args),
  };
});

const getCachedCapabilities = vi.fn();
vi.mock("../../src/services/host-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HostCapabilities>()),
  warmCapabilitiesOnReady: vi.fn(),
  getCachedCapabilities: (...args: unknown[]) => getCachedCapabilities(...args),
  detectCapabilities: async () => getCachedCapabilities(),
}));

const devices = {
  kinds: vi.fn(),
  spawn: vi.fn(),
  live: vi.fn(),
  terminate: vi.fn(),
  action: vi.fn(),
  simulators: vi.fn(),
  simulatorCatalog: vi.fn(),
  createSimulator: vi.fn(),
};
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getRemoteHostClient: () => ({ devices }) };
});

const tmpDb = path.join(os.tmpdir(), `simulators-create-route-test-${process.pid}.db`);

const IPHONE = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const IOS = "com.apple.CoreSimulator.SimRuntime.iOS-18-2";
const UDID = "5A6B7C8D-1111-2222-3333-444455556666";
const BODY = { name: "QA phone", deviceTypeId: IPHONE, runtimeId: IOS };

/** Answers each `xcrun simctl` call the way a healthy Mac would. */
function healthySimctl() {
  execFileMock.mockImplementation((_cmd, args: string[], _opts, cb) => {
    const sub = args.slice(1);
    let out = "";
    if (sub[0] === "list" && sub[1] === "devicetypes") {
      out = JSON.stringify({
        devicetypes: [{ identifier: IPHONE, name: "iPhone 16", productFamily: "iPhone" }],
      });
    } else if (sub[0] === "list" && sub[1] === "runtimes") {
      out = JSON.stringify({
        runtimes: [{ identifier: IOS, name: "iOS 18.2", isAvailable: true }],
      });
    } else if (sub[0] === "create") {
      out = `${UDID}\n`;
    }
    cb(null, Buffer.from(out), Buffer.alloc(0));
    return {};
  });
}

describe("iOS simulator catalog and create routes", () => {
  let originalPlatform: NodeJS.Platform;
  let tmpDir: string;

  beforeEach(async () => {
    await warmSqliteBinding();
    originalPlatform = process.platform;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "simulators-create-route-"));
    const companion = path.join(tmpDir, "idb_companion");
    fs.writeFileSync(companion, "#!/bin/sh\n", { mode: 0o755 });

    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_IOS_ENABLED = "true";
    process.env.DEVICE_IDB_COMPANION_PATH = companion;
    getCachedCapabilities.mockReset().mockResolvedValue(["xcode"]);
    execFileMock.mockReset();
    for (const fn of Object.values(devices)) fn.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DEVICE_ENABLED;
    delete process.env.DEVICE_IOS_ENABLED;
    delete process.env.DEVICE_IDB_COMPANION_PATH;
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
  });

  it("serves the catalog and creates a simulator on the local host", async () => {
    healthySimctl();
    const app = await buildTestAppOnPlatform("darwin");

    const catalog = await app.inject({ method: "GET", url: "/api/simulators/catalog" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual({
      deviceTypes: [{ id: IPHONE, name: "iPhone 16" }],
      runtimes: [{ id: IOS, name: "iOS 18.2" }],
    });

    const created = await app.inject({ method: "POST", url: "/api/simulators", payload: BODY });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      udid: UDID,
      name: "QA phone",
      runtime: "iOS 18.2",
      state: "Shutdown",
    });
    await app.close();
  });

  it("answers 400 for an id the host's catalog does not know", async () => {
    healthySimctl();
    const app = await buildTestAppOnPlatform("darwin");
    const res = await app.inject({
      method: "POST",
      url: "/api/simulators",
      payload: { ...BODY, runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-1-0" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Unknown iOS runtime/);
    await app.close();
  });

  it("answers 400 for a body missing a field and for a bad name", async () => {
    healthySimctl();
    const app = await buildTestAppOnPlatform("darwin");
    const missing = await app.inject({
      method: "POST",
      url: "/api/simulators",
      payload: { name: "x", deviceTypeId: IPHONE },
    });
    expect(missing.statusCode).toBe(400);
    const bad = await app.inject({
      method: "POST",
      url: "/api/simulators",
      payload: { ...BODY, name: "-rf" },
    });
    expect(bad.statusCode).toBe(400);
    expect(execFileMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 502 when simctl create fails locally", async () => {
    execFileMock.mockImplementation((_cmd, args: string[], _opts, cb) => {
      if (args[1] === "create") {
        cb(new Error("failed"), Buffer.alloc(0), Buffer.from("Invalid runtime"));
        return {};
      }
      cb(
        null,
        Buffer.from(
          args[2] === "devicetypes"
            ? JSON.stringify({ devicetypes: [{ identifier: IPHONE, name: "iPhone 16" }] })
            : JSON.stringify({ runtimes: [{ identifier: IOS, isAvailable: true }] }),
        ),
        Buffer.alloc(0),
      );
      return {};
    });
    const app = await buildTestAppOnPlatform("darwin");
    const res = await app.inject({ method: "POST", url: "/api/simulators", payload: BODY });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/Invalid runtime/);
    await app.close();
  });

  it("answers 400 naming a local host without iOS", async () => {
    process.env.DEVICE_IOS_ENABLED = "false";
    const app = await buildTestAppOnPlatform("darwin");
    const cat = await app.inject({ method: "GET", url: "/api/simulators/catalog" });
    expect(cat.statusCode).toBe(400);
    const post = await app.inject({ method: "POST", url: "/api/simulators", payload: BODY });
    expect(post.statusCode).toBe(400);
    expect(post.json().message).toContain("local");
    await app.close();
  });

  it("forwards both calls to a remote host that reports ios", async () => {
    const app = await buildTestAppOnPlatform("darwin");
    const mac = createPairedHost(app, {
      hostname: "mac-mini",
      name: "mac-mini",
      baseUrl: "http://mac.test",
    }).hostId;
    devices.kinds.mockResolvedValue({ deviceKinds: [], platforms: ["ios"] });
    const catalog = { deviceTypes: [{ id: IPHONE, name: "iPhone 16" }], runtimes: [] };
    devices.simulatorCatalog.mockResolvedValue(catalog);
    const sim = { udid: UDID, name: "QA phone", runtime: "iOS 18.2", state: "Shutdown" };
    devices.createSimulator.mockResolvedValue(sim);

    const cat = await app.inject({
      method: "GET",
      url: `/api/simulators/catalog?hostId=${encodeURIComponent(mac)}`,
    });
    expect(cat.statusCode).toBe(200);
    expect(cat.json()).toEqual(catalog);

    const res = await app.inject({
      method: "POST",
      url: "/api/simulators",
      payload: { ...BODY, hostId: mac },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(sim);
    expect(devices.createSimulator).toHaveBeenCalledWith(BODY);
    await app.close();
  });

  it("asks for an agent update on a null answer and 503s an unreachable host", async () => {
    const app = await buildTestAppOnPlatform("darwin");
    const mac = createPairedHost(app, {
      hostname: "mac-mini",
      name: "mac-mini",
      baseUrl: "http://mac.test",
    }).hostId;
    devices.kinds.mockResolvedValue({ deviceKinds: [], platforms: ["ios"] });
    devices.simulatorCatalog.mockResolvedValueOnce(null);
    devices.createSimulator.mockResolvedValueOnce(null);

    const cat = await app.inject({
      method: "GET",
      url: `/api/simulators/catalog?hostId=${encodeURIComponent(mac)}`,
    });
    expect(cat.statusCode).toBe(400);
    expect(cat.json().message).toContain("update its agent");
    const post = await app.inject({
      method: "POST",
      url: "/api/simulators",
      payload: { ...BODY, hostId: mac },
    });
    expect(post.statusCode).toBe(400);
    expect(post.json().message).toContain("update its agent");

    devices.createSimulator.mockRejectedValueOnce(
      new HostUnreachableError(mac, new Error("ECONNREFUSED")),
    );
    const down = await app.inject({
      method: "POST",
      url: "/api/simulators",
      payload: { ...BODY, hostId: mac },
    });
    expect(down.statusCode).toBe(503);
    await app.close();
  });

  it("answers 400 for an unknown hostId", async () => {
    const app = await buildTestAppOnPlatform("darwin");
    const res = await app.inject({
      method: "POST",
      url: "/api/simulators",
      payload: { ...BODY, hostId: "missing-host" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("missing-host");
    await app.close();
  });

  it("serves the agent routes behind internal auth", async () => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "secret-agent-token";
    healthySimctl();
    const app = await buildTestAppOnPlatform("darwin");
    const auth = { authorization: "Bearer secret-agent-token" };

    const unauth = await app.inject({ method: "GET", url: "/internal/simulators/catalog" });
    expect([401, 403]).toContain(unauth.statusCode);

    const cat = await app.inject({
      method: "GET",
      url: "/internal/simulators/catalog",
      headers: auth,
    });
    expect(cat.statusCode).toBe(200);
    expect(cat.json().deviceTypes).toHaveLength(1);

    const created = await app.inject({
      method: "POST",
      url: "/internal/simulators",
      headers: auth,
      payload: BODY,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().simulator.udid).toBe(UDID);

    const bad = await app.inject({
      method: "POST",
      url: "/internal/simulators",
      headers: auth,
      payload: { ...BODY, runtimeId: "nope" },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("agent routes refuse a host without iOS and surface a simctl failure as 502", async () => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "secret-agent-token";
    const auth = { authorization: "Bearer secret-agent-token" };
    process.env.DEVICE_IOS_ENABLED = "false";
    let app = await buildTestAppOnPlatform("darwin");
    for (const req of [
      { method: "GET" as const, url: "/internal/simulators/catalog" },
      { method: "POST" as const, url: "/internal/simulators", payload: BODY },
    ]) {
      const res = await app.inject({ ...req, headers: auth });
      expect(res.statusCode).toBe(400);
    }
    await app.close();

    process.env.DEVICE_IOS_ENABLED = "true";
    execFileMock.mockImplementation((_c, _a, _o, cb) => {
      cb(new Error("boom"), Buffer.alloc(0), Buffer.from("simctl stderr"));
      return {};
    });
    app = await buildTestAppOnPlatform("darwin");
    const cat = await app.inject({
      method: "GET",
      url: "/internal/simulators/catalog",
      headers: auth,
    });
    expect(cat.statusCode).toBe(502);
    const post = await app.inject({
      method: "POST",
      url: "/internal/simulators",
      headers: auth,
      payload: BODY,
    });
    expect(post.statusCode).toBe(502);
    await app.close();
  });
});
