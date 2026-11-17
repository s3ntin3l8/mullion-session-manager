// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// #3214 — the flat/hierarchical sidebar toggle is gone; hierarchical is the
// only grouping. A browser that still has the old key from before must load
// the store without an error and without the old flag coming back.
describe("old crs.hierarchicalView value (#3214)", () => {
  afterEach(() => localStorage.clear());

  it.each(["1", "0", "not-a-bool"])("is ignored when it is %j", async (stored) => {
    localStorage.setItem("crs.hierarchicalView", stored);
    vi.resetModules();
    const { useDashboardStore } = await import("./index.js");
    const state = useDashboardStore.getState() as unknown as Record<string, unknown>;
    expect("hierarchicalView" in state).toBe(false);
    expect("setHierarchicalView" in state).toBe(false);
  });
});
