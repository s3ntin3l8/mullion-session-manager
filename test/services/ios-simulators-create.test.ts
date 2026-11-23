import { describe, it, expect, vi } from "vitest";
import {
  createIosSimulator,
  listSimulatorCatalog,
  parseSimctlDeviceTypes,
  parseSimctlRuntimes,
  SimctlError,
  SimulatorRequestError,
} from "../../src/services/ios-simulators.js";
import type { SimctlRunner } from "../../src/services/device-drivers/ios-simulator.js";

const DEVICE_TYPES = JSON.stringify({
  devicetypes: [
    {
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      name: "iPhone 16",
      productFamily: "iPhone",
    },
    {
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4",
      name: "iPad Pro 11-inch (M4)",
      productFamily: "iPad",
    },
    {
      identifier: "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K",
      name: "Apple TV 4K",
      productFamily: "Apple TV",
    },
    {
      // No productFamily: falls back to the name.
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-SE",
      name: "iPhone SE",
    },
    { identifier: 5, name: "bad" },
    null,
  ],
});

const RUNTIMES = JSON.stringify({
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
      name: "iOS 18.2",
      isAvailable: true,
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-5",
      isAvailable: false,
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-18-2",
      name: "tvOS 18.2",
      isAvailable: true,
    },
    { name: "no identifier" },
    "junk",
  ],
});

const IPHONE = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const IOS = "com.apple.CoreSimulator.SimRuntime.iOS-18-2";
const UDID = "5A6B7C8D-1111-2222-3333-444455556666";

function runner(createOut = `${UDID}\n`): ReturnType<typeof vi.fn> & SimctlRunner {
  return vi.fn(async (args: string[]) => {
    if (args[0] === "list" && args[1] === "devicetypes") return Buffer.from(DEVICE_TYPES);
    if (args[0] === "list" && args[1] === "runtimes") return Buffer.from(RUNTIMES);
    if (args[0] === "create") return Buffer.from(createOut);
    throw new Error(`unexpected simctl ${args.join(" ")}`);
  }) as ReturnType<typeof vi.fn> & SimctlRunner;
}

describe("simulator catalog parsers", () => {
  it("keeps iPhone and iPad device types only", () => {
    expect(parseSimctlDeviceTypes(DEVICE_TYPES).map((t) => t.name)).toEqual([
      "iPhone 16",
      "iPad Pro 11-inch (M4)",
      "iPhone SE",
    ]);
  });

  it("keeps available iOS runtimes only", () => {
    expect(parseSimctlRuntimes(RUNTIMES)).toEqual([{ id: IOS, name: "iOS 18.2" }]);
  });

  it("throws SimctlError for unparsable or malformed output", () => {
    expect(() => parseSimctlDeviceTypes("nope")).toThrow(SimctlError);
    expect(() => parseSimctlDeviceTypes("[]")).toThrow(/expected JSON object/);
    expect(() => parseSimctlDeviceTypes("{}")).toThrow(/missing devicetypes/);
    expect(() => parseSimctlRuntimes("{}")).toThrow(/missing runtimes/);
  });
});

describe("listSimulatorCatalog", () => {
  it("runs the two list calls with argv arrays", async () => {
    const simctl = runner();
    const catalog = await listSimulatorCatalog(simctl);
    expect(catalog.deviceTypes).toHaveLength(3);
    expect(catalog.runtimes).toHaveLength(1);
    expect(simctl).toHaveBeenCalledWith(["list", "devicetypes", "-j"]);
    expect(simctl).toHaveBeenCalledWith(["list", "runtimes", "available", "-j"]);
  });

  it("wraps a runner failure in SimctlError", async () => {
    const simctl: SimctlRunner = async () => {
      throw new Error("xcrun missing");
    };
    await expect(listSimulatorCatalog(simctl)).rejects.toThrow(SimctlError);
    await expect(listSimulatorCatalog(simctl)).rejects.toThrow(/xcrun missing/);
  });
});

describe("createIosSimulator", () => {
  it("creates through simctl with separate argv elements and returns a Shutdown simulator", async () => {
    const simctl = runner();
    const sim = await createIosSimulator(
      { name: "  My iPhone (QA)  ", deviceTypeId: IPHONE, runtimeId: IOS },
      simctl,
    );
    expect(simctl).toHaveBeenLastCalledWith(["create", "My iPhone (QA)", IPHONE, IOS]);
    expect(sim).toEqual({
      udid: UDID,
      name: "My iPhone (QA)",
      runtime: "iOS 18.2",
      state: "Shutdown",
    });
  });

  it.each(["Björn's iPhone", "QA 日本語 (2)"])("accepts the name %j", async (name) => {
    const simctl = runner();
    const sim = await createIosSimulator({ name, deviceTypeId: IPHONE, runtimeId: IOS }, simctl);
    expect(sim.name).toBe(name);
    expect(simctl).toHaveBeenLastCalledWith(["create", name, IPHONE, IOS]);
  });

  it("takes the last non-empty line of simctl create's output as the UDID", async () => {
    const sim = await createIosSimulator(
      { name: "A", deviceTypeId: IPHONE, runtimeId: IOS },
      runner(`warning: something\r\n${UDID}\r\n\r\n`),
    );
    expect(sim.udid).toBe(UDID);
  });

  it.each(["", "   ", "x".repeat(65), "-flag", "a;rm -rf", "name\nnewline", "$(id)", "a\u0000b"])(
    "rejects the name %j before running simctl",
    async (name) => {
      const simctl = runner();
      await expect(
        createIosSimulator({ name, deviceTypeId: IPHONE, runtimeId: IOS }, simctl),
      ).rejects.toThrow(SimulatorRequestError);
      expect(simctl).not.toHaveBeenCalled();
    },
  );

  it("rejects an id missing from the host's catalog without creating", async () => {
    const simctl = runner();
    await expect(
      createIosSimulator({ name: "A", deviceTypeId: "bogus", runtimeId: IOS }, simctl),
    ).rejects.toThrow(/Unknown device type/);
    await expect(
      createIosSimulator({ name: "A", deviceTypeId: IPHONE, runtimeId: "bogus" }, simctl),
    ).rejects.toThrow(/Unknown iOS runtime/);
    expect(simctl.mock.calls.some(([args]) => args[0] === "create")).toBe(false);
  });

  it("reports an unexpected create result as a SimctlError", async () => {
    await expect(
      createIosSimulator({ name: "A", deviceTypeId: IPHONE, runtimeId: IOS }, runner("oops")),
    ).rejects.toThrow(/unexpected result/);
  });

  it("wraps a create failure in SimctlError", async () => {
    const simctl = vi.fn(async (args: string[]) => {
      if (args[0] === "create") throw new Error("Invalid device type");
      return Buffer.from(args[1] === "devicetypes" ? DEVICE_TYPES : RUNTIMES);
    }) as unknown as SimctlRunner;
    await expect(
      createIosSimulator({ name: "A", deviceTypeId: IPHONE, runtimeId: IOS }, simctl),
    ).rejects.toThrow(SimctlError);
  });
});
