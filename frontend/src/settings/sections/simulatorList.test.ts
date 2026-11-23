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

describe("sortDeviceTypes", () => {
  it("is newest first with iPhones before iPads, without mutating its input", () => {
    // simctl order: oldest first.
    const input = [
      { name: "iPhone 15" },
      { name: "iPad Air" },
      { name: "iPhone 16" },
      { name: "iPad Pro" },
    ];
    const copy = [...input];
    expect(sortDeviceTypes(input).map((t) => t.name)).toEqual([
      "iPhone 16",
      "iPhone 15",
      "iPad Pro",
      "iPad Air",
    ]);
    expect(input).toEqual(copy);
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
