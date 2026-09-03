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

  // Regression (issue #957/#958): opencode.implementerModel and friends are
  // this schema's first fields whose default is `null`. Before the
  // `defaults` param existed, a null-defaulted field could never receive a
  // value (sameType(null, "x") was always false) NOR be cleared back to
  // null once set (sameType("x", null) was also always false) — a value
  // picked in Settings -> Models silently never persisted. These pin both
  // directions, using the explicit third `defaults` argument the way every
  // real call site (routes/settings.ts, store/slices/ui.ts) does.
  describe("a field whose declared default is null", () => {
    it("accepts a first-ever value (null -> string)", () => {
      const defaults = { model: null as string | null };
      const base = { model: null as string | null };
      const result = deepMerge(base, { model: "anthropic/claude-sonnet-4-5" }, defaults);
      expect(result.model).toBe("anthropic/claude-sonnet-4-5");
    });

    it("accepts clearing an already-set value back to null (string -> null)", () => {
      const defaults = { model: null as string | null };
      const base = { model: "anthropic/claude-sonnet-4-5" as string | null };
      const result = deepMerge(base, { model: null }, defaults);
      expect(result.model).toBeNull();
    });

    it("still rejects a non-scalar patch (object) for a null-defaulted field", () => {
      const defaults = { model: null as unknown };
      const base = { model: null as unknown };
      const result = deepMerge(base, { model: { nested: true } }, defaults);
      expect(result.model).toBeNull();
    });

    // Code review on the first version of this fix caught that a
    // null-defaulted field accepted ANY scalar type (string/number/boolean),
    // not just the field's actual `string | null` type — a
    // `{opencode:{implementerModel: 42}}` patch would have silently
    // corrupted a string field. `defaultValue === null` proves nullability
    // but nothing about the non-null type, so the check is narrowed to
    // `string` specifically (every current null-defaulted field's real
    // type), not "any JSON scalar."
    it("rejects a number or boolean patch for a null-defaulted (string-typed) field", () => {
      const defaults = { model: null as unknown };
      const base = { model: null as unknown };
      expect(deepMerge(base, { model: 42 }, defaults).model).toBeNull();
      expect(deepMerge(base, { model: true }, defaults).model).toBeNull();
    });
  });

  it("a field whose default is non-null still rejects null (no unintended relaxation)", () => {
    // Confirms the null-defaulted branch above is scoped to fields that are
    // ACTUALLY declared nullable — a field with a normal non-null default
    // (e.g. theme: "dark") must not start accepting `null` patches just
    // because the nullability check now exists elsewhere in the schema.
    const defaults = { theme: "dark" };
    const base = { theme: "dark" };
    const result = deepMerge(base, { theme: null }, defaults);
    expect(result.theme).toBe("dark");
  });

  it("without an explicit `defaults` argument, falls back to `base` (existing call-site behavior)", () => {
    // getStoredSettings' own `deepMerge(DEFAULT_SETTINGS, stored)` call
    // relies on this default — base IS the defaults tree at that call site,
    // so omitting the third argument must remain equivalent to passing it.
    const base = { model: null as string | null };
    const result = deepMerge(base, { model: "anthropic/claude-sonnet-4-5" });
    expect(result.model).toBe("anthropic/claude-sonnet-4-5");
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
