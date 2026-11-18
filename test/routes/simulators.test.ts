import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildTestAppOnPlatform, warmSqliteBinding } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { createHost } from "../../src/services/host-registry.js";
import { HostRequestError, HostUnreachableError } from "../../src/services/remote-host-errors.js";

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
vi.mock("../../src/services/host-capabilities.js", () => ({
  getCachedCapabilities: (...args: unknown[]) => getCachedCapabilities(...args),
  detectCapabilities: async () => getCachedCapabilities(),
  clearCapabilityCache: () => undefined,
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

const tmpDb = path.join(os.tmpdir(), `simulators-route-test-${process.pid}.db`);

const SIMCTL_SAMPLE = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      {
        udid: "0F4A9B7E-1111-2222-3333-444455556666",
        name: "iPhone 16 Pro",
        state: "Booted",
        isAvailable: true,
      },
      {
        udid: "1A2B3C4D-1111-2222-3333-444455556666",
        name: "iPhone 16",
        state: "Shutdown",
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
  },
});

describe("GET /api/simulators and GET /internal/simulators", () => {
  let originalPlatform: NodeJS.Platform;
  let tmpDir: string;
  let companion: string;

  beforeEach(async () => {
    await warmSqliteBinding();
    originalPlatform = process.platform;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "simulators-route-"));
    companion = path.join(tmpDir, "idb_companion");
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

  it("lists iOS simulators on the local host when iOS is available", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, Buffer.from(SIMCTL_SAMPLE), Buffer.alloc(0));
      return {};
    });

    const app = await buildTestAppOnPlatform("darwin");
    const res = await app.inject({ method: "GET", url: "/api/simulators" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
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
    await app.close();
  });

  it("answers 502 with stderr summary when simctl fails on the local host", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(
        new Error("Command failed: xcrun simctl list devices available -j"),
        Buffer.alloc(0),
        Buffer.from('xcrun: error: unable to find utility "simctl"'),
      );
      return {};
    });

    const app = await buildTestAppOnPlatform("darwin");
    const res = await app.inject({ method: "GET", url: "/api/simulators" });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/unable to find utility "simctl"/);
    await app.close();
  });

  it("answers 400 naming the local host when it does not report ios", async () => {
    process.env.DEVICE_IOS_ENABLED = "false";
    const app = await buildTestAppOnPlatform("darwin");
    const res = await app.inject({ method: "GET", url: "/api/simulators" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("local");
    await app.close();
  });

  it("lists simulators on a remote host that reports ios", async () => {
    const app = await buildTestAppOnPlatform("darwin");
    const mac = createHost(app, { name: "mac-mini", baseUrl: "http://mac.test", token: "t" }).id;
    devices.kinds.mockResolvedValue({ deviceKinds: ["physical"], platforms: ["android", "ios"] });
    const expected = [
      {
        udid: "0F4A9B7E-1111-2222-3333-444455556666",
        name: "iPhone 16 Pro",
        runtime: "iOS 18.2",
        state: "Booted",
      },
    ];
    devices.simulators.mockResolvedValue(expected);

    const res = await app.inject({
      method: "GET",
      url: `/api/simulators?hostId=${encodeURIComponent(mac)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expected);
    await app.close();
  });

  it("answers 400 naming the remote host when it does not report ios", async () => {
    const app = await buildTestAppOnPlatform("darwin");
    const linux = createHost(app, {
      name: "linux-box",
      baseUrl: "http://linux.test",
      token: "t",
    }).id;
    devices.kinds.mockResolvedValue({ deviceKinds: ["emulator"], platforms: ["android"] });

    const res = await app.inject({
      method: "GET",
      url: `/api/simulators?hostId=${encodeURIComponent(linux)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain(linux);
    expect(devices.simulators).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers 503 when the remote host is down", async () => {
    const app = await buildTestAppOnPlatform("darwin");
    const mac = createHost(app, { name: "mac-mini", baseUrl: "http://mac.test", token: "t" }).id;
    devices.kinds.mockRejectedValue(new HostUnreachableError(mac, new Error("ECONNREFUSED")));

    const res = await app.inject({
      method: "GET",
      url: `/api/simulators?hostId=${encodeURIComponent(mac)}`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toContain(mac);
    await app.close();
  });

  it("forwards a remote agent's 4xx via forwardHostRequestError, maps 5xx transport failures to 503, and prompts agent update on null", async () => {
    const app = await buildTestAppOnPlatform("darwin");
    const mac = createHost(app, { name: "mac-mini", baseUrl: "http://mac.test", token: "t" }).id;
    devices.kinds.mockResolvedValue({ deviceKinds: [], platforms: ["ios"] });
    devices.simulators.mockRejectedValueOnce(
      new HostRequestError(mac, 400, JSON.stringify({ message: "iOS Simulator is not available" })),
    );

    const badReq = await app.inject({
      method: "GET",
      url: `/api/simulators?hostId=${encodeURIComponent(mac)}`,
    });
    expect(badReq.statusCode).toBe(400);
    expect(badReq.json().message).toBe("iOS Simulator is not available");

    // RemoteHostClient maps agent 5xx (including simctl 502) to HostUnreachableError,
    // which replyHostUnreachable turns into 503.
    devices.simulators.mockRejectedValueOnce(new HostUnreachableError(mac, new Error("HTTP 502")));
    const badGw = await app.inject({
      method: "GET",
      url: `/api/simulators?hostId=${encodeURIComponent(mac)}`,
    });
    expect(badGw.statusCode).toBe(503);
    expect(badGw.json().message).toContain(mac);

    devices.simulators.mockResolvedValueOnce(null);
    const outdated = await app.inject({
      method: "GET",
      url: `/api/simulators?hostId=${encodeURIComponent(mac)}`,
    });
    expect(outdated.statusCode).toBe(400);
    expect(outdated.json().message).toContain("update its agent");
    await app.close();
  });

  it("answers 400 for an unknown hostId", async () => {
    const app = await buildTestAppOnPlatform("darwin");
    const res = await app.inject({ method: "GET", url: "/api/simulators?hostId=missing-host" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("missing-host");
    await app.close();
  });

  it("serves GET /internal/simulators behind internal auth and handles simctl failure", async () => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "secret-agent-token";
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, Buffer.from(SIMCTL_SAMPLE), Buffer.alloc(0));
      return {};
    });

    const app = await buildTestAppOnPlatform("darwin");
    const unauth = await app.inject({ method: "GET", url: "/internal/simulators" });
    expect([401, 403]).toContain(unauth.statusCode);

    const ok = await app.inject({
      method: "GET",
      url: "/internal/simulators",
      headers: { authorization: "Bearer secret-agent-token" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().simulators).toHaveLength(2);

    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(new Error("boom"), Buffer.alloc(0), Buffer.from("simctl stderr"));
      return {};
    });
    const fail = await app.inject({
      method: "GET",
      url: "/internal/simulators",
      headers: { authorization: "Bearer secret-agent-token" },
    });
    expect(fail.statusCode).toBe(502);
    expect(fail.json().message).toMatch(/simctl stderr/);
    await app.close();
  });
});
