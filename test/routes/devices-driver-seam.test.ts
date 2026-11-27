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
import { DeviceActionError } from "../../src/services/device-drivers/types.js";
import type {
  DeviceActionName,
  DeviceDriver,
  DevicePlatform,
} from "../../src/services/device-drivers/types.js";

// Exercises POST /api/devices/:id/action through the DeviceDriver seam
// (#3201): the route must call only the driver interface, answer an action
// the driver's platform does not implement with a clear 4xx, and map a
// driver's DeviceActionError to its status. The Android primitives
// themselves are covered, unchanged, by test/routes/devices.test.ts.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const tmpDb = path.join(os.tmpdir(), `devices-driver-seam-test-${process.pid}.db`);

function fakeDriver(
  overrides: Partial<DeviceDriver> & {
    platform?: DevicePlatform;
    unsupported?: DeviceActionName[];
  },
): DeviceDriver {
  const { unsupported = [], ...rest } = overrides;
  return {
    platform: "android",
    id: "1",
    isAlive: true,
    hasLiveControl: true,
    toInfo: vi.fn(),
    stop: vi.fn(),
    onVideoPacket: vi.fn(),
    onExit: vi.fn(),
    onClipboard: vi.fn(),
    requestKeyframe: vi.fn(),
    input: vi.fn(),
    screenshot: vi.fn(),
    tap: vi.fn().mockResolvedValue(undefined),
    swipe: vi.fn(),
    text: vi.fn(),
    key: vi.fn(),
    button: vi.fn().mockResolvedValue(undefined),
    logs: vi.fn(),
    clipboard: { get: vi.fn(), set: vi.fn() },
    supports: (action) => !unsupported.includes(action),
    ...rest,
  } as DeviceDriver;
}

describe("POST /api/devices/:id/action through the DeviceDriver seam", () => {
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

  async function createDevice(app: Awaited<ReturnType<typeof buildTestAppOnPlatform>>) {
    const created = await app.inject({
      method: "POST",
      url: "/api/devices",
      payload: { avdName: "dev35" },
    });
    return created.json().id as number;
  }

  it("answers an action the platform does not support with a 400 naming the action and platform", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const id = await createDevice(app);
    const driver = fakeDriver({ platform: "ios", unsupported: ["key", "logcat"] });
    vi.spyOn(app.device, "getDriver").mockReturnValue(driver);

    const key = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "key", androidKeyCode: 4 },
    });
    expect(key.statusCode).toBe(400);
    expect(key.json().message).toBe('action "key" is not supported on ios devices');
    expect(driver.key).not.toHaveBeenCalled();

    const logs = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "logcat" },
    });
    expect(logs.statusCode).toBe(400);
    expect(logs.json().message).toBe('action "logcat" is not supported on ios devices');
    expect(driver.logs).not.toHaveBeenCalled();
  });

  it("runs a supported action on the driver and returns its REST shape", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const id = await createDevice(app);
    const driver = fakeDriver({ platform: "ios", unsupported: ["key"] });
    vi.spyOn(app.device, "getDriver").mockReturnValue(driver);

    const res = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "tap", x: 10, y: 20 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(driver.tap).toHaveBeenCalledWith(10, 20);
  });

  it("executes button action on an iOS driver (200) and rejects it on an Android driver (400)", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const id = await createDevice(app);
    const iosDriver = fakeDriver({ platform: "ios", unsupported: ["key"] });
    vi.spyOn(app.device, "getDriver").mockReturnValue(iosDriver);

    for (const button of ["home", "lock", "side", "siri"] as const) {
      const ok = await app.inject({
        method: "POST",
        url: `/api/devices/${id}/action`,
        payload: { action: "button", button },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true });
      expect(iosDriver.button).toHaveBeenLastCalledWith(button);
    }

    // Closed schema: unknown button name or stray field is rejected with 400.
    const badName = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "button", button: "power" },
    });
    expect(badName.statusCode).toBe(400);

    const extraKey = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "button", button: "home", extra: true },
    });
    expect(extraKey.statusCode).toBe(400);

    const androidDriver = fakeDriver({ platform: "android", unsupported: ["button"] });
    vi.spyOn(app.device, "getDriver").mockReturnValue(androidDriver);

    const unsupported = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "button", button: "home" },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().message).toBe('action "button" is not supported on android devices');
    expect(androidDriver.button).not.toHaveBeenCalled();
  });

  it("runs openurl on a driver, 400s a non-http(s) URL and a driver without openUrl (#3429)", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const id = await createDevice(app);
    const openUrl = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(app.device, "getDriver").mockReturnValue(fakeDriver({ platform: "ios", openUrl }));

    const ok = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "openurl", url: "http://127.0.0.1:5173" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:5173");

    const bad = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "openurl", url: "tel:123" },
    });
    expect(bad.statusCode).toBe(400);
    expect(openUrl).toHaveBeenCalledTimes(1);

    // A driver that claims the action but implements no openUrl still 400s
    // (the real Android driver implements it since #3559; see devices.test.ts).
    vi.spyOn(app.device, "getDriver").mockReturnValue(fakeDriver({ platform: "android" }));
    const android = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "openurl", url: "http://127.0.0.1:5173" },
    });
    expect(android.statusCode).toBe(400);
    expect(android.json().message).toBe('action "openurl" is not supported on android devices');
  });

  it("maps a DeviceActionError to its own status", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const id = await createDevice(app);
    const driver = fakeDriver({
      tap: vi.fn().mockRejectedValue(new DeviceActionError(502, "simulator went away")),
    });
    vi.spyOn(app.device, "getDriver").mockReturnValue(driver);

    const res = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "tap", x: 1, y: 1 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe("simulator went away");
  });

  it("leaves an unexpected driver error as a 500", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const id = await createDevice(app);
    vi.spyOn(app.device, "getDriver").mockReturnValue(
      fakeDriver({ tap: vi.fn().mockRejectedValue(new Error("boom")) }),
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "tap", x: 1, y: 1 },
    });
    expect(res.statusCode).toBe(500);
  });

  it("says the device is not running when there is no live driver", async () => {
    const app = await buildTestAppOnPlatform("linux");
    const id = await createDevice(app);
    vi.spyOn(app.device, "getDriver").mockReturnValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: `/api/devices/${id}/action`,
      payload: { action: "screenshot" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe(
      `device ${id} has no live adb connection (status: not running)`,
    );
  });
});
