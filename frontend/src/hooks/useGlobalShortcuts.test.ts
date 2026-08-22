// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGlobalShortcuts } from "./useGlobalShortcuts.js";
import { canLaunchTerminal } from "../panelUtils.js";

// Mirrors useDockviewDrop.test.ts's own store-mock shape: a `storeState()`
// factory serving `useDashboardStore.getState()`, the only call form this
// hook uses (`clearSplitRequest()` inside the Escape branch, and the ⌘K
// handler's `openGlobalLauncher` reads `viewMode` via getState()).
const clearSplitRequest = vi.fn();
let viewMode: string = "list";

function storeState() {
  return { clearSplitRequest, viewMode };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

// Faithful copy of App.tsx's `openGlobalLauncher` gate (issue #730) — used by
// the kanban regression test so the keyboard path is exercised end to end
// (hook → openGlobalLauncher → canLaunchTerminal → setPalette) instead of
// with a no-op mock that would hide a gate regression. Returns a spy so the
// hook's call is itself observable.
type ShortcutArgs = Parameters<typeof useGlobalShortcuts>[0];

function makeOpenGlobalLauncher(setPalette: ShortcutArgs["setPalette"]) {
  return vi.fn(() => {
    if (!canLaunchTerminal(viewMode)) return;
    setPalette({ open: true, scope: "global", projectId: null });
  });
}

function renderShortcuts(overrides: Partial<ShortcutArgs> = {}) {
  const setPalette = overrides.setPalette ?? vi.fn();
  const setSettingsOpen = overrides.setSettingsOpen ?? vi.fn();
  const openSettings = overrides.openSettings ?? vi.fn();
  const openGlobalLauncher = overrides.openGlobalLauncher ?? vi.fn();
  const hook = renderHook(() =>
    useGlobalShortcuts({ setPalette, setSettingsOpen, openSettings, openGlobalLauncher }),
  );
  return { setPalette, setSettingsOpen, openSettings, openGlobalLauncher, ...hook };
}

function dispatchKeyDown(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.clearAllMocks();
  viewMode = "list";
  // Belt-and-suspenders for the focused-input test below, which manually
  // appends an <input> to document.body: if an assertion in that test ever
  // throws before its own removeChild runs, this still clears it out rather
  // than leaking a stray focused input into later tests in this file.
  document.body.innerHTML = "";
});

describe("useGlobalShortcuts", () => {
  it("routes Ctrl+K through openGlobalLauncher (issue #730 — no direct setPalette)", () => {
    const setPalette = vi.fn();
    const openGlobalLauncher = vi.fn();

    renderShortcuts({ setPalette, openGlobalLauncher });
    dispatchKeyDown({ key: "k", ctrlKey: true });

    expect(openGlobalLauncher).toHaveBeenCalledTimes(1);
    // The hook no longer opens the palette itself — that is openGlobalLauncher's
    // job (which carries the workspace gate), so setPalette is untouched here.
    expect(setPalette).not.toHaveBeenCalled();
  });

  it("routes Cmd+K (metaKey), case-insensitively, through openGlobalLauncher", () => {
    const openGlobalLauncher = vi.fn();

    renderShortcuts({ openGlobalLauncher });
    dispatchKeyDown({ key: "K", metaKey: true });

    expect(openGlobalLauncher).toHaveBeenCalledTimes(1);
  });

  it("prevents the browser default on Ctrl+K/Cmd+K", () => {
    const openGlobalLauncher = vi.fn();

    renderShortcuts({ openGlobalLauncher });
    const event = dispatchKeyDown({ key: "k", metaKey: true });

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not route a bare 'k' (no modifier) to openGlobalLauncher", () => {
    const openGlobalLauncher = vi.fn();

    renderShortcuts({ openGlobalLauncher });
    dispatchKeyDown({ key: "k" });

    expect(openGlobalLauncher).not.toHaveBeenCalled();
  });

  // Issue #730 regression — ⌘K must be inert in the Task view, exactly like
  // the disabled launcher buttons. Exercises the real gate (viewMode wired
  // through the mocked store) rather than a no-op mock.
  it("does not open the palette from the Task view via Ctrl+K (issue #730)", () => {
    viewMode = "kanban";
    const setPalette = vi.fn();
    const openGlobalLauncher = makeOpenGlobalLauncher(setPalette);

    renderShortcuts({ setPalette, openGlobalLauncher });
    dispatchKeyDown({ key: "k", ctrlKey: true });

    expect(openGlobalLauncher).toHaveBeenCalledTimes(1);
    // canLaunchTerminal("kanban") is false → openGlobalLauncher returns early.
    expect(setPalette).not.toHaveBeenCalled();
  });

  it("opens the global palette via Ctrl+K from a workspace (viewMode list)", () => {
    viewMode = "list";
    const setPalette = vi.fn();
    const openGlobalLauncher = makeOpenGlobalLauncher(setPalette);

    renderShortcuts({ setPalette, openGlobalLauncher });
    dispatchKeyDown({ key: "k", ctrlKey: true });

    expect(setPalette).toHaveBeenCalledTimes(1);
    expect(setPalette).toHaveBeenCalledWith({ open: true, scope: "global", projectId: null });
  });

  it("opens settings on Ctrl+,", () => {
    const { openSettings } = renderShortcuts();
    const event = dispatchKeyDown({ key: ",", ctrlKey: true });

    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens settings on Cmd+,", () => {
    const { openSettings } = renderShortcuts();
    dispatchKeyDown({ key: ",", metaKey: true });

    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("does not open settings for a bare ',' with no modifier", () => {
    const { openSettings } = renderShortcuts();
    dispatchKeyDown({ key: "," });

    expect(openSettings).not.toHaveBeenCalled();
  });

  it("on Escape, closes the palette, closes settings, and clears any pending split request", () => {
    const setPalette = vi.fn();
    const setSettingsOpen = vi.fn();
    const { openSettings } = renderShortcuts({ setPalette, setSettingsOpen });

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
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("does not call preventDefault for Escape (handleGlobalEscape has no event access)", () => {
    renderShortcuts({});
    const event = dispatchKeyDown({ key: "Escape" });

    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores unrelated keys entirely", () => {
    const openGlobalLauncher = vi.fn();

    renderShortcuts({ openGlobalLauncher });
    dispatchKeyDown({ key: "a" });
    dispatchKeyDown({ key: "Enter" });
    dispatchKeyDown({ key: "Tab", ctrlKey: true });

    expect(openGlobalLauncher).not.toHaveBeenCalled();
    expect(clearSplitRequest).not.toHaveBeenCalled();
  });

  it("fires regardless of which element currently has DOM focus (no input/textarea guard)", () => {
    const openGlobalLauncher = vi.fn();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    renderShortcuts({ openGlobalLauncher });
    // Dispatched on the input itself (bubbles to window, same as a real
    // keypress while an input is focused) rather than via dispatchKeyDown's
    // window.dispatchEvent, to prove the bubbling path is what's covered.
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true });
    input.dispatchEvent(event);

    expect(openGlobalLauncher).toHaveBeenCalledTimes(1);
    document.body.removeChild(input);
  });

  it("re-attaches the listener when openGlobalLauncher changes identity", () => {
    const openGlobalLauncher1 = vi.fn();
    const openGlobalLauncher2 = vi.fn();

    const { rerender } = renderHook(
      ({ openGlobalLauncher }: { openGlobalLauncher: () => void }) =>
        useGlobalShortcuts({
          setPalette: vi.fn(),
          setSettingsOpen: vi.fn(),
          openSettings: vi.fn(),
          openGlobalLauncher,
        }),
      { initialProps: { openGlobalLauncher: openGlobalLauncher1 } },
    );

    rerender({ openGlobalLauncher: openGlobalLauncher2 });
    dispatchKeyDown({ key: "k", ctrlKey: true });

    expect(openGlobalLauncher1).not.toHaveBeenCalled();
    expect(openGlobalLauncher2).toHaveBeenCalledTimes(1);
  });

  it("removes the keydown listener on unmount", () => {
    const openGlobalLauncher = vi.fn();

    const { unmount } = renderShortcuts({ openGlobalLauncher });
    unmount();
    dispatchKeyDown({ key: "k", ctrlKey: true });
    dispatchKeyDown({ key: "Escape" });

    expect(openGlobalLauncher).not.toHaveBeenCalled();
    expect(clearSplitRequest).not.toHaveBeenCalled();
  });
});
