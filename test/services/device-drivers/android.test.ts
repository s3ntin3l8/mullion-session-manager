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
    reversePort: vi.fn().mockResolvedValue(undefined),
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
      "openurl",
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

describe("AndroidDriver.openUrl (#3559)", () => {
  const STARTING =
    "Starting: Intent { act=android.intent.action.VIEW dat=http://127.0.0.1:5173/... }";

  function liveDevice(output = STARTING) {
    const spawnWaitText = vi.fn().mockResolvedValue(output);
    const device = fakeDevice({
      adbConnection: { subprocess: { noneProtocol: { spawnWaitText } } },
    });
    return { device, spawnWaitText, reversePort: device.reversePort as ReturnType<typeof vi.fn> };
  }

  it("reverses a loopback URL's port, then fires a VIEW intent with the URL", async () => {
    const { device, spawnWaitText, reversePort } = liveDevice();
    await new AndroidDriver(device).openUrl("http://127.0.0.1:5173/app?x=1&y=2");
    expect(reversePort).toHaveBeenCalledWith(5173);
    expect(spawnWaitText).toHaveBeenCalledWith([
      "'am'",
      "'start'",
      "'-a'",
      "'android.intent.action.VIEW'",
      "'-d'",
      "'http://127.0.0.1:5173/app?x=1&y=2'",
    ]);
    expect(reversePort.mock.invocationCallOrder[0]).toBeLessThan(
      spawnWaitText.mock.invocationCallOrder[0],
    );
  });

  it("reverses the scheme's default port and every loopback spelling", async () => {
    for (const [url, port] of [
      ["http://localhost/", 80],
      ["https://localhost/", 443],
      ["http://preview-abc.localhost:3000/", 3000],
      ["http://[::1]:8080/", 8080],
      ["http://127.0.0.2:9000/", 9000],
      ["http://0.0.0.0:5173/", 5173],
      ["http://localhost.:3000/", 3000],
    ] as const) {
      const { device, reversePort } = liveDevice();
      await new AndroidDriver(device).openUrl(url);
      expect(reversePort).toHaveBeenCalledWith(port);
    }
  });

  it("opens any other host as is, without a reverse mapping", async () => {
    const { device, spawnWaitText, reversePort } = liveDevice();
    await performDeviceAction(new AndroidDriver(device), {
      action: "openurl",
      url: "https://preview-abc.mullion.example.com/?__mullion_preview=t%2Fk",
    });
    expect(reversePort).not.toHaveBeenCalled();
    expect(spawnWaitText.mock.calls[0][0].at(-1)).toBe(
      "'https://preview-abc.mullion.example.com/?__mullion_preview=t%2Fk'",
    );
  });

  it("quotes a URL carrying shell metacharacters as one argument", async () => {
    const { device, spawnWaitText } = liveDevice();
    await new AndroidDriver(device).openUrl("http://example.com/'$(reboot)';x");
    // The embedded quote closes and re-opens the quoted word ('\''), so the
    // device's `sh -c` sees one argument, never a `$(...)` or `;`.
    expect(spawnWaitText.mock.calls[0][0].at(-1)).toBe(
      "'http://example.com/'\\''$(reboot)'\\'';x'",
    );
  });

  it("400s a non-http(s) URL before touching adb", async () => {
    const { device, spawnWaitText, reversePort } = liveDevice();
    const err = await new AndroidDriver(device).openUrl("tel:123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceActionError);
    expect((err as DeviceActionError).statusCode).toBe(400);
    expect(reversePort).not.toHaveBeenCalled();
    expect(spawnWaitText).not.toHaveBeenCalled();
  });

  it("400s while adb is not live, before any reverse", async () => {
    const device = fakeDevice();
    const err = await new AndroidDriver(device).openUrl("http://127.0.0.1:1/").catch((e) => e);
    expect((err as DeviceActionError).statusCode).toBe(400);
    expect(device.reversePort).not.toHaveBeenCalled();
  });

  it("502s when am start reports an error or the reverse fails", async () => {
    const { device } = liveDevice(
      "Starting: Intent { ... }\nError: Activity not started, unable to resolve Intent { ... }\n",
    );
    const err = await new AndroidDriver(device).openUrl("http://x.example/").catch((e) => e);
    expect((err as DeviceActionError).statusCode).toBe(502);
    expect((err as Error).message).toMatch(/am start failed: Error: Activity not started/);

    const failing = liveDevice();
    failing.reversePort.mockRejectedValue(new Error("device offline"));
    const err2 = await new AndroidDriver(failing.device)
      .openUrl("http://127.0.0.1:5173/")
      .catch((e) => e);
    expect((err2 as DeviceActionError).statusCode).toBe(502);
    expect((err2 as Error).message).toBe("adb reverse tcp:5173 failed: device offline");
    expect(failing.spawnWaitText).not.toHaveBeenCalled();
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
