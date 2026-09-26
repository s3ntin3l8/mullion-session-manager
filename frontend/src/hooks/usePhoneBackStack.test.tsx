// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { resetPhoneBackStackForTests, usePhoneBackStack } from "./usePhoneBackStack.js";

let pushState: ReturnType<typeof vi.spyOn>;
let back: ReturnType<typeof vi.spyOn>;

const pop = () => act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
const flushTimers = () => act(() => void vi.runAllTimers());

beforeEach(() => {
  vi.useFakeTimers();
  resetPhoneBackStackForTests();
  pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  back = vi.spyOn(window.history, "back").mockImplementation(() => {});
});

afterEach(() => {
  resetPhoneBackStackForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("usePhoneBackStack", () => {
  it("does nothing while inactive", () => {
    renderHook(() => usePhoneBackStack(false, vi.fn()));
    expect(pushState).not.toHaveBeenCalled();
    pop();
    flushTimers();
    expect(back).not.toHaveBeenCalled();
  });

  it("pushes one guard entry when opened and closes the overlay on back", () => {
    const close = vi.fn();
    renderHook(() => usePhoneBackStack(true, close));
    expect(pushState).toHaveBeenCalledTimes(1);
    pop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("consumes its own guard entry (and ignores that pop) when closed another way", () => {
    const close = vi.fn();
    const { rerender } = renderHook(({ on }) => usePhoneBackStack(on, close), {
      initialProps: { on: true },
    });
    rerender({ on: false });
    flushTimers();
    expect(back).toHaveBeenCalledTimes(1);
    // The popstate from our own history.back() is not a user back press.
    pop();
    expect(close).not.toHaveBeenCalled();
  });

  it("closes only the topmost of stacked overlays per back press, re-arming the guard", () => {
    const closeNav = vi.fn();
    const closeSheet = vi.fn();
    renderHook(() => usePhoneBackStack(true, closeNav));
    renderHook(() => usePhoneBackStack(true, closeSheet));
    expect(pushState).toHaveBeenCalledTimes(1);

    pop();
    expect(closeSheet).toHaveBeenCalledTimes(1);
    expect(closeNav).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledTimes(2);

    pop();
    expect(closeNav).toHaveBeenCalledTimes(1);
  });

  it("reuses the guard across a same-tick hand-off instead of racing history.back()", () => {
    const closeSettings = vi.fn();
    const nav = renderHook(({ on }) => usePhoneBackStack(on, vi.fn()), {
      initialProps: { on: true },
    });
    // Navigator closes as Settings opens in the same tick.
    nav.rerender({ on: false });
    renderHook(() => usePhoneBackStack(true, closeSettings));
    flushTimers();
    expect(back).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledTimes(1);
    pop();
    expect(closeSettings).toHaveBeenCalledTimes(1);
  });

  it("consumes the guard when the tier leaves phone (active flips off)", () => {
    const { rerender } = renderHook(({ on }) => usePhoneBackStack(on, vi.fn()), {
      initialProps: { on: true },
    });
    rerender({ on: false });
    flushTimers();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("calls the latest onClose, not the one from when it opened", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => usePhoneBackStack(true, cb), {
      initialProps: { cb: first },
    });
    rerender({ cb: second });
    pop();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("orders by when each overlay opened, not by hook call order", () => {
    // App declares the navigator's hook BEFORE the Tasks board's. Open Tasks
    // first, then the navigator on top of it: back must close the navigator.
    const closeNav = vi.fn();
    const closeTasks = vi.fn();
    const { rerender } = renderHook(
      ({ nav, tasks }) => {
        usePhoneBackStack(nav, closeNav);
        usePhoneBackStack(tasks, closeTasks);
      },
      { initialProps: { nav: false, tasks: false } },
    );
    rerender({ nav: false, tasks: true });
    rerender({ nav: true, tasks: true });

    pop();
    expect(closeNav).toHaveBeenCalledTimes(1);
    expect(closeTasks).not.toHaveBeenCalled();
    pop();
    expect(closeTasks).toHaveBeenCalledTimes(1);
  });
});
