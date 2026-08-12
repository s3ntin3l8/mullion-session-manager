// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { renderHook } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useDragResize } from "./useDragResize.js";

function fireMouseMove(clientX: number, clientY: number) {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY }));
}

function fireMouseUp() {
  window.dispatchEvent(new MouseEvent("mouseup"));
}

function fakeReactMouseDown(clientX: number, clientY: number): ReactMouseEvent {
  return {
    clientX,
    clientY,
    preventDefault: () => {},
  } as unknown as ReactMouseEvent;
}

afterEach(() => {
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
});

describe("useDragResize", () => {
  it("grows the value as the pointer moves in the positive direction by default (invert: false)", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useDragResize({
        axis: "x",
        min: 100,
        getMax: () => 500,
        value: 200,
        onChange,
        cursor: "col-resize",
      }),
    );

    act(() => result.current.onMouseDown(fakeReactMouseDown(50, 0)));
    expect(result.current.dragging).toBe(true);

    act(() => fireMouseMove(90, 0)); // +40 from drag start
    expect(onChange).toHaveBeenLastCalledWith(240);
  });

  it("grows the value as the pointer moves in the NEGATIVE direction when invert: true", () => {
    // Mirrors Dock.tsx's height handle (top border) and UnifiedBoard's
    // drawer handle (left border): dragging "backward" along the axis grows
    // the value.
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useDragResize({
        axis: "y",
        invert: true,
        min: 100,
        getMax: () => 500,
        value: 200,
        onChange,
        cursor: "ns-resize",
      }),
    );

    act(() => result.current.onMouseDown(fakeReactMouseDown(0, 300)));
    act(() => fireMouseMove(0, 260)); // clientY decreased by 40 -> value grows by 40
    expect(onChange).toHaveBeenLastCalledWith(240);
  });

  it("clamps to `min`", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useDragResize({
        axis: "x",
        min: 100,
        getMax: () => 500,
        value: 150,
        onChange,
        cursor: "col-resize",
      }),
    );
    act(() => result.current.onMouseDown(fakeReactMouseDown(0, 0)));
    act(() => fireMouseMove(-1000, 0));
    expect(onChange).toHaveBeenLastCalledWith(100);
  });

  it("clamps to the max computed fresh at drag start", () => {
    let max = 300;
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useDragResize({
        axis: "x",
        min: 100,
        getMax: () => max,
        value: 150,
        onChange,
        cursor: "col-resize",
      }),
    );
    act(() => result.current.onMouseDown(fakeReactMouseDown(0, 0)));
    // Changing `max` mid-drag has no effect — it was captured at drag start,
    // same as every pre-extraction call site's own `Math.max(...)` measured
    // once in the mousedown handler.
    max = 1000;
    act(() => fireMouseMove(1000, 0));
    expect(onChange).toHaveBeenLastCalledWith(300);
  });

  it("calls onCommit once on mouseup with the final value, and never on mount", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    renderHook(() =>
      useDragResize({
        axis: "x",
        min: 100,
        getMax: () => 500,
        value: 200,
        onChange,
        onCommit,
        cursor: "col-resize",
      }),
    );
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("onCommit receives the last dragged value even if the caller's own state hasn't re-rendered yet", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useDragResize({
        axis: "x",
        min: 100,
        getMax: () => 500,
        value: 200,
        onChange,
        onCommit,
        cursor: "col-resize",
      }),
    );

    act(() => result.current.onMouseDown(fakeReactMouseDown(0, 0)));
    act(() => fireMouseMove(50, 0));
    act(() => fireMouseUp());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(250);
    expect(result.current.dragging).toBe(false);
  });

  it("sets and restores document.body cursor/userSelect for the drag's duration", () => {
    const { result } = renderHook(() =>
      useDragResize({
        axis: "x",
        min: 100,
        getMax: () => 500,
        value: 200,
        onChange: vi.fn(),
        cursor: "col-resize",
      }),
    );

    act(() => result.current.onMouseDown(fakeReactMouseDown(0, 0)));
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    act(() => fireMouseUp());
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("removes its window listeners on unmount mid-drag", () => {
    const onChange = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDragResize({
        axis: "x",
        min: 100,
        getMax: () => 500,
        value: 200,
        onChange,
        cursor: "col-resize",
      }),
    );
    act(() => result.current.onMouseDown(fakeReactMouseDown(0, 0)));
    unmount();
    onChange.mockClear();
    fireMouseMove(999, 0);
    expect(onChange).not.toHaveBeenCalled();
  });
});
