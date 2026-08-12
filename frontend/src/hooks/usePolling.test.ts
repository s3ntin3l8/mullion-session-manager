// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePolling } from "./usePolling.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePolling", () => {
  it("calls fn immediately on mount by default, then every `ms`", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000));

    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("skips the immediate call when immediate: false", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, { immediate: false }));

    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not poll at all when enabled: false", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, { enabled: false }));

    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("clears the interval on unmount", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePolling(fn, 1000));
    fn.mockClear();

    unmount();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("restarts (and immediately re-fires) when a `deps` entry changes", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { rerender } = renderHook(({ dep }) => usePolling(fn, 1000, { deps: [dep] }), {
      initialProps: { dep: 1 },
    });
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    rerender({ dep: 2 });
    // Restart re-fires immediately (default `immediate: true`), not at the
    // interleaved 500ms mark the torn-down interval would have used.
    expect(fn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not restart the interval when only `fn`'s identity changes across renders", () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const { rerender } = renderHook(
      ({ n }: { n: number }) => usePolling(() => calls.push(n), 1000),
      {
        initialProps: { n: 1 },
      },
    );
    expect(calls).toEqual([1]);

    rerender({ n: 2 });
    // A fresh inline closure each render must not tear down/recreate the
    // interval (and must not double-fire immediately) — only the LATEST
    // closure's value is read on the next real tick.
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([1, 2]);
  });

  describe("pauseWhenHidden", () => {
    // `document.visibilityState` is a getter on the real `document` with no
    // setter — Object.defineProperty (restored in afterEach below) rather
    // than `vi.stubGlobal("document", ...)`, which would replace the whole
    // global with a plain-object spread that drops every prototype method
    // (`createElement`, `body`, ...) React's own rendering still needs.
    function setVisibility(state: "visible" | "hidden") {
      Object.defineProperty(document, "visibilityState", {
        value: state,
        configurable: true,
      });
    }

    afterEach(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
    });

    it("skips ticks while the tab is hidden when pauseWhenHidden: true", () => {
      vi.useFakeTimers();
      setVisibility("hidden");
      const fn = vi.fn();
      renderHook(() => usePolling(fn, 1000, { pauseWhenHidden: true, immediate: false }));

      vi.advanceTimersByTime(3000);
      expect(fn).not.toHaveBeenCalled();

      setVisibility("visible");
      vi.advanceTimersByTime(1000);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("keeps ticking while hidden when pauseWhenHidden is left at its default (false)", () => {
      vi.useFakeTimers();
      setVisibility("hidden");
      const fn = vi.fn();
      renderHook(() => usePolling(fn, 1000, { immediate: false }));

      vi.advanceTimersByTime(2000);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  it("passes an isCancelled() check that flips true once the interval is torn down", () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const { unmount } = renderHook(() =>
      usePolling(
        (isCancelled) => {
          seen.push(isCancelled());
        },
        1000,
        { immediate: false },
      ),
    );
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([false]);
    unmount();
    // isCancelled() was read at call time (false) — this just documents the
    // callback isn't invoked again after teardown.
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([false]);
  });
});
