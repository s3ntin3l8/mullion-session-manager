// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { useTerminalSearch } from "./useTerminalSearch.js";

function makeFakeSearchAddon() {
  return {
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
  };
}

function makeFakeTermRef(): RefObject<Terminal | null> {
  return { current: { focus: vi.fn() } as unknown as Terminal };
}

describe("useTerminalSearch", () => {
  it("starts closed, empty, with no match state", () => {
    const termRef = makeFakeTermRef();
    const { result } = renderHook(() =>
      useTerminalSearch({ colorScheme: "dracula", theme: "dark", termRef }),
    );
    expect(result.current.findOpen).toBe(false);
    expect(result.current.findQuery).toBe("");
    expect(result.current.matchState).toBeNull();
  });

  it("openFind sets findOpen true", () => {
    const termRef = makeFakeTermRef();
    const { result } = renderHook(() =>
      useTerminalSearch({ colorScheme: "dracula", theme: "dark", termRef }),
    );
    act(() => result.current.openFind());
    expect(result.current.findOpen).toBe(true);
  });

  it("runSearch is a no-op with no addon or empty query", () => {
    const termRef = makeFakeTermRef();
    const { result } = renderHook(() =>
      useTerminalSearch({ colorScheme: "dracula", theme: "dark", termRef }),
    );
    // No addon attached yet — must not throw.
    expect(() => result.current.runSearch("next")).not.toThrow();
  });

  it("runSearch calls findNext/findPrevious on the attached addon", () => {
    const termRef = makeFakeTermRef();
    const { result } = renderHook(() =>
      useTerminalSearch({ colorScheme: "dracula", theme: "dark", termRef }),
    );
    const addon = makeFakeSearchAddon();
    act(() => {
      result.current.searchAddonRef.current = addon as never;
      result.current.setFindQuery("needle");
    });
    act(() => result.current.runSearch("next"));
    expect(addon.findNext).toHaveBeenCalledWith("needle", expect.any(Object));
    act(() => result.current.runSearch("previous"));
    expect(addon.findPrevious).toHaveBeenCalledWith("needle", expect.any(Object));
  });

  it("clears decorations and match state when the query is emptied while open", () => {
    const termRef = makeFakeTermRef();
    const { result } = renderHook(() =>
      useTerminalSearch({ colorScheme: "dracula", theme: "dark", termRef }),
    );
    const addon = makeFakeSearchAddon();
    act(() => {
      result.current.searchAddonRef.current = addon as never;
      result.current.setFindOpen(true);
      result.current.setFindQuery("x");
    });
    expect(addon.findNext).toHaveBeenCalled();
    act(() => result.current.setFindQuery(""));
    expect(addon.clearDecorations).toHaveBeenCalled();
    expect(result.current.matchState).toBeNull();
  });

  it("hands focus back to the terminal when the bar transitions from open to closed", () => {
    const termRef = makeFakeTermRef();
    const { result } = renderHook(() =>
      useTerminalSearch({ colorScheme: "dracula", theme: "dark", termRef }),
    );
    act(() => result.current.setFindOpen(true));
    act(() => result.current.setFindOpen(false));
    expect(termRef.current?.focus).toHaveBeenCalled();
  });

  it("does not focus the terminal on initial mount (bar never opened)", () => {
    const termRef = makeFakeTermRef();
    renderHook(() => useTerminalSearch({ colorScheme: "dracula", theme: "dark", termRef }));
    expect(termRef.current?.focus).not.toHaveBeenCalled();
  });
});
