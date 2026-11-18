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
import { listDeviceRows } from "../../src/services/device-store.js";

// `devices.platform` / `devices.udid` through the REST API (#3202): an Android
// device reads back as such, each platform takes only its own fields, and iOS
// is refused where the host cannot run it (#1943). Nothing here boots a device.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const tmpDb = path.join(os.tmpdir(), `devices-platform-test-${process.pid}.db`);
type App = Awaited<ReturnType<typeof buildTestAppOnPlatform>>;

describe("devices platform and udid (#3202)", () => {
  let originalPlatform: NodeJS.Platform;
  beforeEach(async () => {
    await warmSqliteBinding();
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.DEVICE_ENABLED = "true";
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DEVICE_ENABLED;
  });

  const create = (app: App, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/devices", payload });

  it("creates an Android device by default and reads it back as android with no udid", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const res = await create(app, { avdName: "dev35" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ platform: "android", udid: null, kind: "emulator" });

    const id = res.json().id;
    const one = await app.inject({ method: "GET", url: `/api/devices/${id}` });
    expect(one.json()).toMatchObject({ platform: "android", udid: null });
    const list = await app.inject({ method: "GET", url: "/api/devices" });
    expect(list.json()[0]).toMatchObject({ platform: "android", udid: null });
    expect(listDeviceRows(app)[0]).toMatchObject({ platform: "android", udid: null });
  });

  it("accepts an explicit platform android", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const res = await create(app, { avdName: "dev35", platform: "android" });
    expect(res.statusCode).toBe(201);
    expect(res.json().platform).toBe("android");
  });

  it("accepts a null udid for an Android device, so a re-posted GET body is not refused", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const res = await create(app, { avdName: "dev35", platform: "android", udid: null });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ platform: "android", udid: null });
  });

  it("answers 400 for a shape-valid iOS device on a host that cannot run one, and inserts no row", async () => {
    // A Linux host has no iOS Simulator (the enabled path is test/routes/devices-ios.test.ts).
    const app = await buildTestAppOnPlatform("linux");
    const res = await create(app, {
      platform: "ios",
      udid: "0F4A9B7E-1111-2222-3333-444455556666",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/iOS Simulator is not available on this host/);
    expect(listDeviceRows(app)).toHaveLength(0);
  });

  it("requires a udid for an iOS device", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const res = await create(app, { platform: "ios" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/udid is required for an ios device/);
  });

  it.each([
    [
      { platform: "ios", kind: "physical", udid: "U" },
      /kind "physical" is not valid for an ios device/,
    ],
    [{ platform: "ios", avdName: "dev35", udid: "U" }, /avdName must not be set for an ios device/],
    [
      { platform: "ios", address: "10.0.0.2:5555", udid: "U" },
      /address must not be set for an ios device/,
    ],
    [{ avdName: "dev35", udid: "U" }, /udid must not be set for an android device/],
    [
      { avdName: "dev35", platform: "android", udid: "U" },
      /udid must not be set for an android device/,
    ],
    [{ avdName: "dev35", platform: "windows" }, /platform must be "android" or "ios"/],
  ])("rejects %j with a 400 and inserts no row", async (payload, message) => {
    const app = await buildTestAppOnPlatform("linux");
    const res = await create(app, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(message);
    expect(listDeviceRows(app)).toHaveLength(0);
  });
});
