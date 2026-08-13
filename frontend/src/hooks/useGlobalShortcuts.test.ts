// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGlobalShortcuts } from "./useGlobalShortcuts.js";

// Mirrors useDockviewDrop.test.ts's own store-mock shape: a `storeState()`
// factory serving `useDashboardStore.getState()`, the only call form this
// hook uses (`clearSplitRequest()` inside the Escape branch).
const clearSplitRequest = vi.fn();

function storeState() {
  return { clearSplitRequest };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

function dispatchKeyDown(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.clearAllMocks();
  // Belt-and-suspenders for the focused-input test below, which manually
  // appends an <input> to document.body: if an assertion in that test ever
  // throws before its own removeChild runs, this still clears it out rather
  // than leaking a stray focused input into later tests in this file.
  document.body.innerHTML = "";
});

describe("useGlobalShortcuts", () => {
  it("opens the global command palette on Ctrl+K", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    dispatchKeyDown({ key: "k", ctrlKey: true });

    expect(setPalette).toHaveBeenCalledTimes(1);
    const updater = setPalette.mock.calls[0][0] as (p: unknown) => unknown;
    expect(updater({ open: false, scope: "project", projectId: 7 })).toEqual({
      open: true,
      scope: "global",
      projectId: 7,
    });
  });

  it("opens the global command palette on Cmd+K (metaKey), case-insensitively", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    dispatchKeyDown({ key: "K", metaKey: true });

    expect(setPalette).toHaveBeenCalledTimes(1);
  });

  it("prevents the browser default on Ctrl+K/Cmd+K", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    const event = dispatchKeyDown({ key: "k", metaKey: true });

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not open the palette for a bare 'k' with no modifier", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    dispatchKeyDown({ key: "k" });

    expect(setPalette).not.toHaveBeenCalled();
  });

  it("opens settings on Ctrl+,", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    const event = dispatchKeyDown({ key: ",", ctrlKey: true });

    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens settings on Cmd+,", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    dispatchKeyDown({ key: ",", metaKey: true });

    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("does not open settings for a bare ',' with no modifier", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    dispatchKeyDown({ key: "," });

    expect(openSettings).not.toHaveBeenCalled();
  });

  it("on Escape, closes the palette, closes settings, and clears any pending split request", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    dispatchKeyDown({ key: "Escape" });

    expect(setSettingsOpen).toHaveBeenCalledWith(false);
    expect(clearSplitRequest).toHaveBeenCalledTimes(1);
    expect(setPalette).toHaveBeenCalledTimes(1);
    const updater = setPalette.mock.calls[0][0] as (p: unknown) => unknown;
    expect(updater({ open: true, scope: "global", projectId: null })).toEqual({
      open: false,
      scope: "global",
      projectId: null,
    });
  });

  it("does not call preventDefault for Escape (handleGlobalEscape has no event access)", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    const event = dispatchKeyDown({ key: "Escape" });

    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores unrelated keys entirely", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    dispatchKeyDown({ key: "a" });
    dispatchKeyDown({ key: "Enter" });
    dispatchKeyDown({ key: "Tab", ctrlKey: true });

    expect(setPalette).not.toHaveBeenCalled();
    expect(setSettingsOpen).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
    expect(clearSplitRequest).not.toHaveBeenCalled();
  });

  it("fires regardless of which element currently has DOM focus (no input/textarea guard)", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    renderHook(() => useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }));
    // Dispatched on the input itself (bubbles to window, same as a real
    // keypress while an input is focused) rather than via dispatchKeyDown's
    // window.dispatchEvent, to prove the bubbling path is what's covered.
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true });
    input.dispatchEvent(event);

    expect(setPalette).toHaveBeenCalledTimes(1);
    document.body.removeChild(input);
  });

  it("re-attaches the listener when openSettings changes identity", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings1 = vi.fn();
    const openSettings2 = vi.fn();

    const { rerender } = renderHook(
      ({ openSettings }: { openSettings: () => void }) =>
        useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }),
      { initialProps: { openSettings: openSettings1 } },
    );

    rerender({ openSettings: openSettings2 });
    dispatchKeyDown({ key: ",", ctrlKey: true });

    expect(openSettings1).not.toHaveBeenCalled();
    expect(openSettings2).toHaveBeenCalledTimes(1);
  });

  it("removes the keydown listener on unmount", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const openSettings = vi.fn();

    const { unmount } = renderHook(() =>
      useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings }),
    );
    unmount();
    dispatchKeyDown({ key: "k", ctrlKey: true });
    dispatchKeyDown({ key: "Escape" });

    expect(setPalette).not.toHaveBeenCalled();
    expect(setSettingsOpen).not.toHaveBeenCalled();
    expect(clearSplitRequest).not.toHaveBeenCalled();
  });
});
