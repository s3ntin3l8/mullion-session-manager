import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import type * as HostCapabilities from "../../src/services/host-capabilities.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildTestAppOnPlatform, warmSqliteBinding } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  IOS_COMPANION_NOT_EXECUTABLE_REASON,
  IOS_COMPANION_UNSET_REASON,
  IOS_DISABLED_REASON,
  IOS_XCODE_REASON,
} from "../../src/services/device-kinds.js";

// GET /internal/devices/kinds (#3510): a macOS agent that cannot run the iOS
// Simulator says why, one reason per setting to change. No real systemd-run,
// adb or xcrun fires: spawn and the capability probe are mocked.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const getCachedCapabilities = vi.fn();
// Partial mock: only the probe and its startup warm-up are faked. Everything
// else stays real, so an export added to the module later (as
// warmCapabilitiesOnReady was, #3511) cannot break this suite.
vi.mock("../../src/services/host-capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HostCapabilities>();
  return {
    ...actual,
    warmCapabilitiesOnReady: () => undefined,
    getCachedCapabilities: (...args: unknown[]) => getCachedCapabilities(...args),
    detectCapabilities: async () => getCachedCapabilities(),
  };
});

const tmpDb = path.join(os.tmpdir(), `internal-devices-kinds-test-${process.pid}.db`);
const auth = { authorization: "Bearer secret-agent-token" };

describe("GET /internal/devices/kinds — why iOS is unavailable", () => {
  let originalPlatform: NodeJS.Platform;
  let tmpDir: string;
  let companion: string;

  beforeEach(async () => {
    await warmSqliteBinding();
    originalPlatform = process.platform;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-devices-kinds-"));
    companion = path.join(tmpDir, "idb_companion");
    fs.writeFileSync(companion, "#!/bin/sh\n", { mode: 0o755 });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "secret-agent-token";
    process.env.DEVICE_ENABLED = "true";
    process.env.DEVICE_IOS_ENABLED = "true";
    process.env.DEVICE_IDB_COMPANION_PATH = companion;
    getCachedCapabilities.mockReset().mockResolvedValue(["xcode"]);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of [
      "DATABASE_URL",
      "MULLION_ROLE",
      "MULLION_AGENT_TOKEN",
      "DEVICE_ENABLED",
      "DEVICE_IOS_ENABLED",
      "DEVICE_IDB_COMPANION_PATH",
    ]) {
      delete process.env[key];
    }
  });

  async function kinds(platform: NodeJS.Platform) {
    const app = await buildTestAppOnPlatform(platform);
    // The platform is read per request, so it stays stubbed for the inject.
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/internal/devices/kinds",
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      return res.json();
    } finally {
      await app.close();
    }
  }

  it("reports ios and no reason when the simulator is available", async () => {
    const body = await kinds("darwin");
    expect(body.platforms).toContain("ios");
    expect(body).not.toHaveProperty("unavailable");
  });

  it("names DEVICE_ENABLED when the device panel is off", async () => {
    process.env.DEVICE_ENABLED = "false";
    const body = await kinds("darwin");
    expect(body.platforms).toEqual([]);
    expect(body.unavailable).toEqual({
      ios: "Device panel is disabled — set DEVICE_ENABLED=true.",
    });
  });

  it("names DEVICE_IOS_ENABLED when iOS is off", async () => {
    process.env.DEVICE_IOS_ENABLED = "false";
    const body = await kinds("darwin");
    expect(body.platforms).not.toContain("ios");
    expect(body.unavailable).toEqual({ ios: IOS_DISABLED_REASON });
  });

  it("names Xcode when the xcode capability is missing", async () => {
    getCachedCapabilities.mockResolvedValue([]);
    const body = await kinds("darwin");
    expect(body.unavailable).toEqual({ ios: IOS_XCODE_REASON });
  });

  it("names DEVICE_IDB_COMPANION_PATH when it is unset", async () => {
    process.env.DEVICE_IDB_COMPANION_PATH = "";
    const body = await kinds("darwin");
    expect(body.unavailable).toEqual({ ios: IOS_COMPANION_UNSET_REASON });
  });

  it("says the companion is not executable when the path is missing or a directory", async () => {
    process.env.DEVICE_IDB_COMPANION_PATH = path.join(tmpDir, "nope");
    expect((await kinds("darwin")).unavailable).toEqual({
      ios: IOS_COMPANION_NOT_EXECUTABLE_REASON,
    });
    process.env.DEVICE_IDB_COMPANION_PATH = tmpDir;
    expect((await kinds("darwin")).unavailable).toEqual({
      ios: IOS_COMPANION_NOT_EXECUTABLE_REASON,
    });
  });

  it("puts a darwin primary's own reason on its entry in GET /api/devices/hosts", async () => {
    delete process.env.MULLION_ROLE;
    process.env.DEVICE_IOS_ENABLED = "false";
    const app = await buildTestAppOnPlatform("darwin");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const res = await app.inject({ method: "GET", url: "/api/devices/hosts" });
      expect(res.statusCode).toBe(200);
      expect(res.json()[0]).toMatchObject({
        hostId: "local",
        unavailable: { ios: IOS_DISABLED_REASON },
      });
    } finally {
      await app.close();
    }
  });

  it("reports no reason on Linux, with the panel on or off", async () => {
    expect(await kinds("linux")).not.toHaveProperty("unavailable");
    process.env.DEVICE_ENABLED = "false";
    expect(await kinds("linux")).not.toHaveProperty("unavailable");
  });
});
