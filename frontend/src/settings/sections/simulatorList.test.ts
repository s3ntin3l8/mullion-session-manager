import { describe, expect, it } from "vitest";
import type { IosSimulator } from "../../api/index.js";
import {
  compareRuntimesNewestFirst,
  groupSimulators,
  isUsedSimulator,
  runtimeVersion,
  sortDeviceTypes,
  sortRuntimes,
  viewSimulators,
} from "./simulatorList.js";

const sim = (over: Partial<IosSimulator> & { udid: string; name: string }): IosSimulator => ({
  runtime: "iOS 27.0",
  state: "Shutdown",
  ...over,
});

const NONE = new Set<string>();

describe("runtimes", () => {
  it("reads the version out of the label", () => {
    expect(runtimeVersion("iOS 27.0")).toEqual([27, 0]);
    expect(runtimeVersion("iOS 18.2.1")).toEqual([18, 2, 1]);
    expect(runtimeVersion("Unknown")).toEqual([]);
  });

  it("orders newest first, numerically, and an unversioned label last", () => {
    expect(
      ["iOS 9.3", "iOS 26.5", "iOS 27.0", "iOS 26.10", "Beta"].sort(compareRuntimesNewestFirst),
    ).toEqual(["iOS 27.0", "iOS 26.10", "iOS 26.5", "iOS 9.3", "Beta"]);
    expect(sortRuntimes([{ name: "iOS 17.5" }, { name: "iOS 18.2" }])).toEqual([
      { name: "iOS 18.2" },
      { name: "iOS 17.5" },
    ]);
  });
});

// `xcrun simctl list devicetypes -j` on Xcode 27.2, in the order simctl returned
// it (newest first), trimmed to a representative slice. Captured on a real Mac.
const XCODE_27_ORDER = [
  "iPhone 18 Pro",
  "iPhone 18 Pro Max",
  "iPhone Duo",
  "iPhone 17 Pro",
  "iPhone 17e",
  "iPhone Air",
  "iPhone 17",
  "iPhone 16 Pro",
  "iPhone 16e",
  "iPhone 15",
  "iPhone SE (3rd generation)",
  "iPhone 13 mini",
  "iPhone Xʀ",
  "iPhone 8",
  "iPhone SE (1st generation)",
  "iPhone 6s Plus",
  "iPad mini (A20 Pro)",
  "iPad Pro 13-inch (M5) (16GB)",
  "iPad Pro 13-inch (M5)",
  "iPad Air 13-inch (M4)",
  "iPad (A16)",
  "iPad (10th generation)",
  "iPad Air 2",
  "iPad mini 4",
  "iPod touch (7th generation)",
].map((name) => ({ name }));

describe("sortDeviceTypes", () => {
  it("keeps Xcode's newest-first order, iPhones then iPads then the rest, and preselects the newest iPhone", () => {
    const sorted = sortDeviceTypes(XCODE_27_ORDER);
    expect(sorted.map((t) => t.name)).toEqual(XCODE_27_ORDER.map((t) => t.name));
    expect(sorted[0].name).toBe("iPhone 18 Pro");
    expect(sorted[sorted.length - 1].name).toBe("iPod touch (7th generation)");
  });

  it("gives the same answer when simctl lists oldest first", () => {
    const oldestFirst = [...XCODE_27_ORDER].reverse();
    const sorted = sortDeviceTypes(oldestFirst);
    // The iPod touch is the lone "other"; the iPads and iPhones come back newest first.
    expect(sorted[0].name).toBe("iPhone 18 Pro");
    expect(sorted.slice(0, 3).map((t) => t.name)).toEqual([
      "iPhone 18 Pro",
      "iPhone 18 Pro Max",
      "iPhone Duo",
    ]);
    expect(sorted.findIndex((t) => t.name.startsWith("iPad"))).toBeGreaterThan(
      sorted.findIndex((t) => t.name === "iPhone 6s Plus"),
    );
    expect(sorted[sorted.length - 1].name).toBe("iPod touch (7th generation)");
  });

  it("does not mutate its input and copes with a short or unnumbered list", () => {
    const input = [{ name: "iPad Air" }, { name: "iPhone Air" }];
    const copy = [...input];
    expect(sortDeviceTypes(input).map((t) => t.name)).toEqual(["iPhone Air", "iPad Air"]);
    expect(input).toEqual(copy);
    expect(sortDeviceTypes([])).toEqual([]);
  });
});

describe("isUsedSimulator", () => {
  it("is booted, already added, or booted before", () => {
    expect(isUsedSimulator(sim({ udid: "a", name: "A", state: "Booted" }), NONE)).toBe(true);
    expect(isUsedSimulator(sim({ udid: "b", name: "B" }), new Set(["b"]))).toBe(true);
    expect(
      isUsedSimulator(sim({ udid: "c", name: "C", lastBootedAt: "2026-11-01T00:00:00Z" }), NONE),
    ).toBe(true);
    expect(isUsedSimulator(sim({ udid: "d", name: "D" }), NONE)).toBe(false);
  });
});

describe("groupSimulators", () => {
  it("groups by runtime newest first; booted, then iPhones before iPads, then by name", () => {
    const groups = groupSimulators([
      sim({ udid: "1", name: "iPad Air", runtime: "iOS 26.5" }),
      sim({ udid: "2", name: "iPhone 17", runtime: "iOS 27.0" }),
      sim({ udid: "3", name: "iPad Pro", runtime: "iOS 27.0" }),
      sim({ udid: "4", name: "iPhone 18 Pro", runtime: "iOS 27.0", state: "Booted" }),
      sim({ udid: "5", name: "iPhone Air", runtime: "iOS 27.0" }),
    ]);
    expect(groups.map((g) => g.runtime)).toEqual(["iOS 27.0", "iOS 26.5"]);
    expect(groups[0].simulators.map((s) => s.name)).toEqual([
      "iPhone 18 Pro",
      "iPhone 17",
      "iPhone Air",
      "iPad Pro",
    ]);
  });
});

describe("viewSimulators", () => {
  const all = [
    sim({ udid: "1", name: "iPhone 18 Pro", state: "Booted" }),
    sim({ udid: "2", name: "iPhone 17", lastBootedAt: "2026-11-01T00:00:00Z" }),
    sim({ udid: "3", name: "iPhone Air" }),
    sim({ udid: "4", name: "iPad Pro", runtime: "iOS 26.5" }),
  ];
  const names = (v: ReturnType<typeof viewSimulators>) =>
    v.groups.flatMap((g) => g.simulators.map((s) => s.name));

  it("opens on the used simulators and counts what it leaves out", () => {
    const view = viewSimulators(all, { query: "", showAll: false, activeUdids: NONE });
    expect(names(view)).toEqual(["iPhone 18 Pro", "iPhone 17"]);
    expect(view).toMatchObject({ total: 4, hidden: 2 });
  });

  it("shows everything on request", () => {
    const view = viewSimulators(all, { query: "", showAll: true, activeUdids: NONE });
    expect(names(view)).toHaveLength(4);
    expect(view.hidden).toBe(0);
  });

  it("counts an added simulator as used, and always keeps the selection", () => {
    const view = viewSimulators(all, {
      query: "",
      showAll: false,
      activeUdids: new Set(["3"]),
      keepUdid: "4",
    });
    expect(names(view)).toEqual(["iPhone 18 Pro", "iPhone 17", "iPhone Air", "iPad Pro"]);
  });

  it("shows all of them when none has been used (a fresh Xcode)", () => {
    const fresh = all.map((s) => ({ ...s, state: "Shutdown" as const, lastBootedAt: undefined }));
    const view = viewSimulators(fresh, { query: "", showAll: false, activeUdids: NONE });
    expect(names(view)).toHaveLength(4);
    expect(view.hidden).toBe(0);
  });

  it("a search matches every simulator by name, runtime or state", () => {
    expect(names(viewSimulators(all, { query: "air", showAll: false, activeUdids: NONE }))).toEqual(
      ["iPhone Air"],
    );
    expect(
      names(viewSimulators(all, { query: "26.5", showAll: false, activeUdids: NONE })),
    ).toEqual(["iPad Pro"]);
    expect(
      names(viewSimulators(all, { query: "booted", showAll: false, activeUdids: NONE })),
    ).toEqual(["iPhone 18 Pro"]);
    expect(viewSimulators(all, { query: "zzz", showAll: false, activeUdids: NONE }).groups).toEqual(
      [],
    );
  });
});
