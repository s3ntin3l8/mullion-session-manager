// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { useDockviewFloatingClamp } from "./useDockviewFloatingClamp.js";

const originalResizeObserver = globalThis.ResizeObserver;

interface RecordedObserver {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

let observers: RecordedObserver[] = [];

class RecordingResizeObserver {
  callback: ResizeObserverCallback;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
}

function container(height: number) {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
  return element;
}

function group(type: "floating" | "grid", height: number) {
  const setSize = vi.fn();
  return { height, setSize, api: { location: { type }, setSize } };
}

function apiWith(groups: ReturnType<typeof group>[]) {
  return { groups } as unknown as DockviewApi;
}

afterEach(() => {
  observers = [];
  globalThis.ResizeObserver = originalResizeObserver;
});

describe("useDockviewFloatingClamp", () => {
  it("does nothing without a dock, a container, or ResizeObserver", () => {
    globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;
    const ref = { current: container(400) };
    renderHook(() => useDockviewFloatingClamp({ dockviewApi: null, dockviewContainerRef: ref }));
    expect(observers).toHaveLength(0);

    renderHook(() =>
      useDockviewFloatingClamp({
        dockviewApi: apiWith([]),
        dockviewContainerRef: { current: null },
      }),
    );
    expect(observers).toHaveLength(0);

    // @ts-expect-error exercising the missing-API guard
    delete globalThis.ResizeObserver;
    renderHook(() =>
      useDockviewFloatingClamp({
        dockviewApi: apiWith([group("floating", 500)]),
        dockviewContainerRef: ref,
      }),
    );
    expect(observers).toHaveLength(0);
  });

  it("shrinks only floating groups that are taller than the grid, and disconnects on unmount", () => {
    globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;
    const tall = group("floating", 500);
    const short = group("floating", 40);
    const tiled = group("grid", 900);
    const ref = { current: container(122) };
    const { unmount } = renderHook(() =>
      useDockviewFloatingClamp({
        dockviewApi: apiWith([tall, short, tiled]),
        dockviewContainerRef: ref,
      }),
    );
    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledWith(ref.current);

    observers[0].callback([], observers[0] as unknown as ResizeObserver);
    // 122px container minus the 22px floating titlebar.
    expect(tall.setSize).toHaveBeenCalledWith({ height: 100 });
    expect(short.setSize).not.toHaveBeenCalled();
    expect(tiled.setSize).not.toHaveBeenCalled();

    unmount();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not resize when the grid is shorter than the floating titlebar", () => {
    globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;
    const tall = group("floating", 500);
    const ref = { current: container(22) };
    renderHook(() =>
      useDockviewFloatingClamp({
        dockviewApi: apiWith([tall]),
        dockviewContainerRef: ref,
      }),
    );
    observers[0].callback([], observers[0] as unknown as ResizeObserver);
    expect(tall.setSize).not.toHaveBeenCalled();
  });
});
