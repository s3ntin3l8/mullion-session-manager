import { describe, expect, it, vi } from "vitest";
import {
  isDeviceAction,
  performDeviceAction,
} from "../../../src/services/device-drivers/actions.js";
import type { DeviceDriver } from "../../../src/services/device-drivers/types.js";

describe("openurl device action", () => {
  it.each(["http://127.0.0.1:3000", "https://example.com/path?q=1"])("accepts %s", (url) => {
    expect(isDeviceAction({ action: "openurl", url })).toBe(true);
  });

  it.each([
    "",
    "tel:123",
    "itms-apps://x",
    "javascript:alert(1)",
    "not a url",
    "file:///etc/passwd",
  ])("rejects %j", (url) => {
    expect(isDeviceAction({ action: "openurl", url })).toBe(false);
  });

  it("rejects a missing, non-string or oversized url", () => {
    expect(isDeviceAction({ action: "openurl" })).toBe(false);
    expect(isDeviceAction({ action: "openurl", url: 5 })).toBe(false);
    expect(isDeviceAction({ action: "openurl", url: `http://a/${"x".repeat(3000)}` })).toBe(false);
  });

  it("answers 400 on a platform that does not support it", async () => {
    const driver = { platform: "android", supports: () => false } as unknown as DeviceDriver;
    await expect(
      performDeviceAction(driver, { action: "openurl", url: "http://a" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("answers 400 if a supporting driver has no openUrl", async () => {
    const driver = { platform: "ios", supports: () => true } as unknown as DeviceDriver;
    await expect(
      performDeviceAction(driver, { action: "openurl", url: "http://a" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("delegates to the driver's openUrl", async () => {
    const openUrl = vi.fn(async () => {});
    const driver = { platform: "ios", supports: () => true, openUrl } as unknown as DeviceDriver;
    expect(await performDeviceAction(driver, { action: "openurl", url: "http://a" })).toEqual({
      ok: true,
    });
    expect(openUrl).toHaveBeenCalledWith("http://a");
  });
});
