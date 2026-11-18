import { describe, it, expect, vi } from "vitest";
import { AndroidDriver } from "../../../src/services/device-drivers/android.js";
import { performDeviceAction } from "../../../src/services/device-drivers/actions.js";
import { parseDeviceInput } from "../../../src/services/device-drivers/input.js";
import { DeviceActionError } from "../../../src/services/device-drivers/types.js";
import type { Device } from "../../../src/services/device-manager.js";

// The Android driver is a lazy adapter over a Device; these cover the seam's
// own logic (what it reads from the Device, when it refuses). The adb/scrcpy
// call shapes are exercised end to end by test/routes/devices.test.ts and
// test/routes/device.test.ts.

function fakeDevice(over: Record<string, unknown> = {}): Device {
  return {
    id: "7",
    isAlive: true,
    controller: undefined,
    adbConnection: undefined,
    lastClipboard: null,
    toInfo: () => ({ status: "booting" }),
    kill: vi.fn().mockResolvedValue(undefined),
    setClipboard: vi.fn().mockResolvedValue(undefined),
    onVideoPacket: vi.fn(),
    onExit: vi.fn(),
    onClipboard: vi.fn(),
    ...over,
  } as unknown as Device;
}

describe("AndroidDriver", () => {
  it("reports its platform and supports every Android action (not iOS button)", async () => {
    const driver = new AndroidDriver(fakeDevice());
    expect(driver.platform).toBe("android");
    for (const action of [
      "screenshot",
      "tap",
      "swipe",
      "text",
      "key",
      "logcat",
      "clipboard",
    ] as const) {
      expect(driver.supports(action)).toBe(true);
    }
    expect(driver.supports("button")).toBe(false);
    await expect(driver.button("home")).rejects.toThrow(
      'action "button" is not supported on android devices',
    );
  });

  it("reads liveness and the control channel lazily from the Device", () => {
    const device = fakeDevice();
    const driver = new AndroidDriver(device);
    expect(driver.id).toBe("7");
    expect(driver.isAlive).toBe(true);
    expect(driver.hasLiveControl).toBe(false);
    (device as unknown as { controller: unknown }).controller = {};
    expect(driver.hasLiveControl).toBe(true);
  });

  it("requestKeyframe resolves without a control channel and resets video with one", async () => {
    const device = fakeDevice();
    const driver = new AndroidDriver(device);
    await expect(driver.requestKeyframe()).resolves.toBeUndefined();
    const resetVideo = vi.fn().mockResolvedValue(undefined);
    (device as unknown as { controller: unknown }).controller = { resetVideo };
    await driver.requestKeyframe();
    expect(resetVideo).toHaveBeenCalledTimes(1);
  });

  it("drops live input while there is no control channel", async () => {
    const device = fakeDevice();
    const driver = new AndroidDriver(device);
    await expect(driver.input({ type: "text", text: "hi" })).resolves.toBeUndefined();
    await expect(driver.input({ type: "clipboard", text: "x" })).resolves.toBeUndefined();
    expect(device.setClipboard).not.toHaveBeenCalled();
  });

  it("stop kills the Device", async () => {
    const device = fakeDevice();
    await new AndroidDriver(device).stop();
    expect(device.kill).toHaveBeenCalledTimes(1);
  });

  it("answers one-shot actions with a 400 naming the status while adb is not live", async () => {
    const driver = new AndroidDriver(fakeDevice());
    const err = await driver.tap(1, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceActionError);
    expect((err as DeviceActionError).statusCode).toBe(400);
    expect((err as Error).message).toBe("device 7 has no live adb connection (status: booting)");
  });

  it("answers text and clipboard with the scrcpy-specific 400 when only adb is live", async () => {
    const device = fakeDevice({
      adbConnection: { subprocess: { noneProtocol: {} } },
    });
    const driver = new AndroidDriver(device);
    await expect(driver.text("a")).rejects.toThrow(/no live scrcpy control connection yet/);
    expect(() => driver.clipboard.get()).toThrow(/no live scrcpy control connection yet/);
    await expect(driver.clipboard.set("a", false)).rejects.toThrow(
      /no live scrcpy control connection yet/,
    );
  });
});

describe("performDeviceAction", () => {
  it("rejects an unsupported action before touching the driver", async () => {
    const driver = new AndroidDriver(fakeDevice());
    vi.spyOn(driver, "supports").mockReturnValue(false);
    const tap = vi.spyOn(driver, "tap");
    await expect(performDeviceAction(driver, { action: "tap", x: 1, y: 2 })).rejects.toThrow(
      'action "tap" is not supported on android devices',
    );
    expect(tap).not.toHaveBeenCalled();
  });
});

describe("parseDeviceInput", () => {
  it("accepts a valid touch and normalizes a missing metaState", () => {
    expect(
      parseDeviceInput({
        type: "touchDown",
        x: 1,
        y: 2,
        videoWidth: 100,
        videoHeight: 200,
        pointerId: 0,
      }),
    ).toEqual({ type: "touchDown", x: 1, y: 2, videoWidth: 100, videoHeight: 200, pointerId: 0 });
    expect(parseDeviceInput({ type: "keyEvent", androidKeyCode: 4, action: "down" })).toEqual({
      type: "keyEvent",
      androidKeyCode: 4,
      action: "down",
      metaState: 0,
    });
  });

  it("rejects malformed messages", () => {
    expect(parseDeviceInput(null)).toBeNull();
    expect(parseDeviceInput({ type: "nope" })).toBeNull();
    expect(parseDeviceInput({ type: "tap", x: "1" })).toBeNull();
    expect(
      parseDeviceInput({ type: "keyEvent", androidKeyCode: 4, action: "down", metaState: -1 }),
    ).toBeNull();
    expect(parseDeviceInput({ type: "clipboard", text: "" })).toBeNull();
  });
});
