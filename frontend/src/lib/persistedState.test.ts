// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORAGE_KEYS,
  readBool,
  readJSON,
  readNumber,
  readString,
  removeItem,
  writeBool,
  writeJSON,
  writeNumber,
  writeString,
} from "./persistedState.js";

beforeEach(() => {
  localStorage.clear();
});

describe("STORAGE_KEYS", () => {
  it("has 18 entries, each a distinct crs.* key", () => {
    const values = Object.values(STORAGE_KEYS);
    expect(values).toHaveLength(18);
    expect(new Set(values).size).toBe(values.length);
    for (const key of values) {
      expect(key.startsWith("crs.")).toBe(true);
    }
  });
});

// Exercised against real STORAGE_KEYS entries throughout (not ad-hoc
// strings) — every helper's `key` param is typed `StorageKey`, so this also
// stands in as the compile-time proof that the registry is the only
// literal-string entry point.
describe("readString / writeString", () => {
  it("returns the fallback when the key is absent", () => {
    expect(readString(STORAGE_KEYS.dismissedUpdateVersion, "fallback")).toBe("fallback");
    expect(readString(STORAGE_KEYS.dismissedUpdateVersion, null)).toBeNull();
  });

  it("round-trips a written value", () => {
    writeString(STORAGE_KEYS.dismissedUpdateVersion, "1.2.3");
    expect(readString(STORAGE_KEYS.dismissedUpdateVersion, "fallback")).toBe("1.2.3");
    expect(localStorage.getItem(STORAGE_KEYS.dismissedUpdateVersion)).toBe("1.2.3");
  });
});

describe("readNumber / writeNumber", () => {
  it("returns the fallback when the key is absent", () => {
    expect(readNumber(STORAGE_KEYS.sidebarWidth, 42)).toBe(42);
  });

  it("returns the fallback for an empty string (mirrors the pre-extraction `raw ? Number(raw) : NaN` readers)", () => {
    localStorage.setItem(STORAGE_KEYS.sidebarWidth, "");
    expect(readNumber(STORAGE_KEYS.sidebarWidth, 42)).toBe(42);
  });

  it("returns the fallback for a non-finite parse", () => {
    localStorage.setItem(STORAGE_KEYS.sidebarWidth, "not-a-number");
    expect(readNumber(STORAGE_KEYS.sidebarWidth, 42)).toBe(42);
  });

  it("round-trips a written finite number, including 0", () => {
    writeNumber(STORAGE_KEYS.sidebarWidth, 288);
    expect(readNumber(STORAGE_KEYS.sidebarWidth, 0)).toBe(288);
    writeNumber(STORAGE_KEYS.sidebarWidth, 0);
    expect(readNumber(STORAGE_KEYS.sidebarWidth, 42)).toBe(0);
  });
});

describe("readBool / writeBool", () => {
  it("opt-in semantics (fallback false): only literal '1' reads true", () => {
    expect(readBool(STORAGE_KEYS.sidebarCollapsed, false)).toBe(false); // absent
    localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, "1");
    expect(readBool(STORAGE_KEYS.sidebarCollapsed, false)).toBe(true);
    localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, "0");
    expect(readBool(STORAGE_KEYS.sidebarCollapsed, false)).toBe(false);
    localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, "garbage");
    expect(readBool(STORAGE_KEYS.sidebarCollapsed, false)).toBe(false);
  });

  it("opt-out semantics (fallback true): only literal '0' reads false", () => {
    expect(readBool(STORAGE_KEYS.sourceControlCollapsed, true)).toBe(true); // absent
    localStorage.setItem(STORAGE_KEYS.sourceControlCollapsed, "0");
    expect(readBool(STORAGE_KEYS.sourceControlCollapsed, true)).toBe(false);
    localStorage.setItem(STORAGE_KEYS.sourceControlCollapsed, "1");
    expect(readBool(STORAGE_KEYS.sourceControlCollapsed, true)).toBe(true);
    localStorage.setItem(STORAGE_KEYS.sourceControlCollapsed, "garbage");
    expect(readBool(STORAGE_KEYS.sourceControlCollapsed, true)).toBe(true);
  });

  it("writeBool always persists the canonical '1'/'0' strings", () => {
    writeBool(STORAGE_KEYS.dockCollapsed, true);
    expect(localStorage.getItem(STORAGE_KEYS.dockCollapsed)).toBe("1");
    writeBool(STORAGE_KEYS.dockCollapsed, false);
    expect(localStorage.getItem(STORAGE_KEYS.dockCollapsed)).toBe("0");
  });
});

describe("readJSON / writeJSON", () => {
  it("returns the fallback when the key is absent", () => {
    expect(readJSON(STORAGE_KEYS.dockManualProjects, { a: 1 })).toEqual({ a: 1 });
  });

  it("returns the fallback on malformed JSON", () => {
    localStorage.setItem(STORAGE_KEYS.dockManualProjects, "{not valid json");
    expect(readJSON(STORAGE_KEYS.dockManualProjects, [] as number[])).toEqual([]);
  });

  it("round-trips an array", () => {
    writeJSON(STORAGE_KEYS.dockManualProjects, [1, 2, 3]);
    expect(readJSON<number[]>(STORAGE_KEYS.dockManualProjects, [])).toEqual([1, 2, 3]);
  });

  it("round-trips an object", () => {
    writeJSON(STORAGE_KEYS.projectCollapsed, { 1: true, 2: false });
    expect(readJSON<Record<string, boolean>>(STORAGE_KEYS.projectCollapsed, {})).toEqual({
      1: true,
      2: false,
    });
  });
});

describe("removeItem", () => {
  it("clears a previously written key", () => {
    writeString(STORAGE_KEYS.dismissedUpdateVersion, "1.2.3");
    expect(localStorage.getItem(STORAGE_KEYS.dismissedUpdateVersion)).toBe("1.2.3");
    removeItem(STORAGE_KEYS.dismissedUpdateVersion);
    expect(localStorage.getItem(STORAGE_KEYS.dismissedUpdateVersion)).toBeNull();
  });
});

// localStorage can throw on get/set/remove (private browsing + Safari ITP,
// quota exceeded, disabled by policy, ...) — every helper must degrade to
// "value absent" / "write silently dropped" instead of letting the
// exception escape and crash a render or a module-load-time initializer.
describe("localStorage access failures", () => {
  let getItemSpy: ReturnType<typeof vi.spyOn>;
  let setItemSpy: ReturnType<typeof vi.spyOn>;
  let removeItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    removeItemSpy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
  });

  afterEach(() => {
    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
    removeItemSpy.mockRestore();
  });

  it("read helpers fall back instead of throwing", () => {
    expect(() => readString(STORAGE_KEYS.themeHint, "fallback")).not.toThrow();
    expect(readString(STORAGE_KEYS.themeHint, "fallback")).toBe("fallback");
    expect(readNumber(STORAGE_KEYS.sidebarWidth, 7)).toBe(7);
    expect(readBool(STORAGE_KEYS.sidebarCollapsed, true)).toBe(true);
    expect(readJSON(STORAGE_KEYS.dockManualProjects, { ok: true })).toEqual({ ok: true });
  });

  it("write helpers swallow the error instead of throwing", () => {
    expect(() => writeString(STORAGE_KEYS.themeHint, "light")).not.toThrow();
    expect(() => writeNumber(STORAGE_KEYS.sidebarWidth, 1)).not.toThrow();
    expect(() => writeBool(STORAGE_KEYS.sidebarCollapsed, true)).not.toThrow();
    expect(() => writeJSON(STORAGE_KEYS.dockManualProjects, [1])).not.toThrow();
    expect(() => removeItem(STORAGE_KEYS.themeHint)).not.toThrow();
  });
});
