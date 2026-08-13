// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  SEARCH_HIGHLIGHT_LIMIT,
  attachKeyConflictHandler,
  formatMatchCount,
  hasClipboardApi,
  readClipboard,
  reservedKeysFromSettings,
} from "./terminalKeys.js";

describe("reservedKeysFromSettings", () => {
  it("includes only the keys enabled in keyCapture", () => {
    expect(reservedKeysFromSettings({ ctrlR: true, ctrlL: false, ctrlK: true })).toEqual(
      new Set(["r", "k"]),
    );
  });

  it("returns an empty set when nothing is enabled", () => {
    expect(reservedKeysFromSettings({ ctrlR: false, ctrlL: false, ctrlK: false })).toEqual(
      new Set(),
    );
  });
});

describe("formatMatchCount", () => {
  it("returns an empty string when there's no active search", () => {
    expect(formatMatchCount(null)).toBe("");
  });

  it("reports 'No results' for a zero-count search", () => {
    expect(formatMatchCount({ index: -1, count: 0 })).toBe("No results");
  });

  it("formats index/count for an ordinary match", () => {
    expect(formatMatchCount({ index: 2, count: 5 })).toBe("3/5");
  });

  it("appends '+' once the decorated count hits the highlight ceiling", () => {
    expect(formatMatchCount({ index: 0, count: SEARCH_HIGHLIGHT_LIMIT })).toBe(
      `1/${SEARCH_HIGHLIGHT_LIMIT}+`,
    );
  });

  it("shows just the count when the match sits beyond the highlight limit (index -1)", () => {
    expect(formatMatchCount({ index: -1, count: SEARCH_HIGHLIGHT_LIMIT })).toBe(
      `${SEARCH_HIGHLIGHT_LIMIT}+`,
    );
  });
});

describe("hasClipboardApi / readClipboard", () => {
  afterEachRestoreClipboard();

  it("hasClipboardApi is false when navigator.clipboard is absent", () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    expect(hasClipboardApi()).toBe(false);
  });

  it("readClipboard resolves null when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await expect(readClipboard()).resolves.toBeNull();
  });

  it("readClipboard resolves the read text when available", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: vi.fn().mockResolvedValue("hello") },
      configurable: true,
    });
    await expect(readClipboard()).resolves.toBe("hello");
  });

  it("readClipboard resolves null (not a rejection) when the read is denied", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    await expect(readClipboard()).resolves.toBeNull();
  });
});

// Captures the descriptor BEFORE any test in the describe block runs (jsdom
// doesn't define navigator.clipboard by default, so `original` is usually
// undefined) and restores exactly that afterward — deleting the property
// rather than defining it to `undefined` when there was no original
// descriptor. Getting this wrong (e.g. a no-op restore when `original` is
// undefined) would leak whatever the last test in this block set
// navigator.clipboard to into every later describe block in this file,
// since `navigator` is a module-global, not per-test state.
function afterEachRestoreClipboard() {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (original) {
      Object.defineProperty(navigator, "clipboard", original);
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
}

// Minimal fake Terminal — attachKeyConflictHandler only touches
// attachCustomKeyEventHandler and (on the opt-in Ctrl+C path) hasSelection/
// clearSelection, so that's all this stub needs.
function makeFakeTerm() {
  let handler: ((event: KeyboardEvent) => boolean) | null = null;
  const term = {
    attachCustomKeyEventHandler: vi.fn((h: (event: KeyboardEvent) => boolean) => {
      handler = h;
    }),
    hasSelection: vi.fn(() => false),
    clearSelection: vi.fn(),
  };
  return {
    term: term as unknown as Terminal,
    fire: (event: Partial<KeyboardEvent> & { key: string }) =>
      handler?.({
        type: "keydown",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        ...event,
      } as KeyboardEvent),
  };
}

describe("attachKeyConflictHandler", () => {
  it("intercepts Ctrl+Shift+F to toggle the find bar", () => {
    const { term, fire } = makeFakeTerm();
    const onToggleFind = vi.fn();
    attachKeyConflictHandler({
      term,
      reservedKeys: new Set(),
      getClipboardKeys: () => ({ ctrlV: false, ctrlC: false }),
      onToggleFind,
    });
    const result = fire({ key: "f", ctrlKey: true, shiftKey: true });
    expect(onToggleFind).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it("routes Cmd+V and Shift+Insert to onPaste unconditionally", () => {
    const { term, fire } = makeFakeTerm();
    const onPaste = vi.fn();
    attachKeyConflictHandler({
      term,
      reservedKeys: new Set(),
      onPaste,
      getClipboardKeys: () => ({ ctrlV: false, ctrlC: false }),
    });
    fire({ key: "v", metaKey: true });
    fire({ key: "insert", shiftKey: true });
    expect(onPaste).toHaveBeenCalledTimes(2);
  });

  it("only routes plain Ctrl+V to onPaste when clipboardKeys.ctrlV is enabled", () => {
    const { term, fire } = makeFakeTerm();
    const onPaste = vi.fn();
    let ctrlV = false;
    attachKeyConflictHandler({
      term,
      reservedKeys: new Set(),
      onPaste,
      getClipboardKeys: () => ({ ctrlV, ctrlC: false }),
    });
    fire({ key: "v", ctrlKey: true });
    expect(onPaste).not.toHaveBeenCalled();
    ctrlV = true;
    fire({ key: "v", ctrlKey: true });
    expect(onPaste).toHaveBeenCalledTimes(1);
  });

  it("routes Ctrl+Insert to onCopy", () => {
    const { term, fire } = makeFakeTerm();
    const onCopy = vi.fn();
    attachKeyConflictHandler({
      term,
      reservedKeys: new Set(),
      onCopy,
      getClipboardKeys: () => ({ ctrlV: false, ctrlC: false }),
    });
    fire({ key: "insert", ctrlKey: true });
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("captureCtrlC swallows plain Ctrl+C and calls onCopy instead of SIGINT", () => {
    const { term, fire } = makeFakeTerm();
    const onCopy = vi.fn();
    attachKeyConflictHandler({
      term,
      reservedKeys: new Set(),
      onCopy,
      captureCtrlC: true,
      getClipboardKeys: () => ({ ctrlV: false, ctrlC: false }),
    });
    const result = fire({ key: "c", ctrlKey: true });
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it("plain Ctrl+C falls through to SIGINT when captureCtrlC/ctrlC-setting are both off", () => {
    const { term, fire } = makeFakeTerm();
    const onCopy = vi.fn();
    attachKeyConflictHandler({
      term,
      reservedKeys: new Set(),
      onCopy,
      getClipboardKeys: () => ({ ctrlV: false, ctrlC: false }),
    });
    const result = fire({ key: "c", ctrlKey: true });
    expect(onCopy).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("opt-in ctrlC copy only fires when there's a selection", () => {
    // The opt-in ctrlC branch additionally gates on hasClipboardApi() (see
    // terminalKeys.ts's own comment on why) — stub navigator.clipboard
    // truthy for this one test, restored via afterEachRestoreClipboard's
    // same delete-if-no-original logic so it can't leak into later tests.
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: {}, configurable: true });
    try {
      const { term, fire } = makeFakeTerm();
      (term.hasSelection as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const onCopy = vi.fn().mockResolvedValue(true);
      attachKeyConflictHandler({
        term,
        reservedKeys: new Set(),
        onCopy,
        getClipboardKeys: () => ({ ctrlV: false, ctrlC: true }),
      });
      const result = fire({ key: "c", ctrlKey: true });
      expect(onCopy).toHaveBeenCalledTimes(1);
      expect(result).toBe(false);
    } finally {
      if (original) {
        Object.defineProperty(navigator, "clipboard", original);
      } else {
        delete (navigator as { clipboard?: unknown }).clipboard;
      }
    }
  });

  it("preventDefault-only path for reserved browser chords (Ctrl+R/L/K)", () => {
    const { term, fire } = makeFakeTerm();
    attachKeyConflictHandler({
      term,
      reservedKeys: new Set(["r"]),
      getClipboardKeys: () => ({ ctrlV: false, ctrlC: false }),
    });
    const result = fire({ key: "r", ctrlKey: true });
    // Falls through to `return true` (doesn't swallow the event), it just
    // calls preventDefault along the way.
    expect(result).toBe(true);
  });
});
