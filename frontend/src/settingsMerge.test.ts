import { describe, it, expect } from "vitest";
import { deepMerge, isPlainObject } from "./settingsMerge.js";

describe("deepMerge", () => {
  it("never writes a property name sourced from the patch, so __proto__ can't pollute", () => {
    // JSON.parse builds "__proto__" as an ordinary own-enumerable key (it
    // bypasses the accessor) — a GET /api/settings response merged with a
    // patch-key-iterated deepMerge would be able to reach it. This mirrors
    // src/services/settings.ts's hardened backend copy: deepMerge only ever
    // writes keys drawn from `base`, so "__proto__" (absent from base) is
    // never touched.
    const patch = JSON.parse('{"__proto__":{"polluted":"yes"},"theme":"light"}') as unknown;

    const result = deepMerge({ theme: "dark" }, patch) as Record<string, unknown>;

    expect(result.theme).toBe("light");
    expect(Object.prototype as Record<string, unknown>).not.toHaveProperty("polluted");
  });

  it("silently drops patch keys that aren't part of base's known shape", () => {
    const base = { theme: "dark" };
    const result = deepMerge(base, { theme: "light", bogusUnknownField: "x" });
    expect(result).toEqual({ theme: "light" });
  });

  it("ignores a type-mismatched leaf value instead of persisting it", () => {
    const base = { fontSize: 14 };
    const result = deepMerge(base, { fontSize: "huge" });
    expect(result.fontSize).toBe(14);
  });

  it("ignores a wrong-shape subtree instead of collapsing it to a scalar", () => {
    const base = { terminal: { fontSize: 14 } };
    const result = deepMerge(base, { terminal: 5 });
    expect(result).toEqual({ terminal: { fontSize: 14 } });
  });

  it("merges nested plain objects while leaving unrelated sibling keys untouched", () => {
    const base = { a: { x: 1, y: 2 }, b: "unchanged" };
    const result = deepMerge(base, { a: { x: 9 } });
    expect(result).toEqual({ a: { x: 9, y: 2 }, b: "unchanged" });
  });

  it("replaces arrays outright rather than merging element-wise", () => {
    const base = { list: [1, 2, 3] };
    const result = deepMerge(base, { list: [] });
    expect(result.list).toEqual([]);
  });
});

describe("isPlainObject", () => {
  it("distinguishes plain objects from arrays, null, and primitives", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(5)).toBe(false);
  });
});
