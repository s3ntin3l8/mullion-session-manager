import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

// Consolidates the three independently hand-rolled single-axis
// mousedown/mousemove/mouseup drag-to-resize implementations found across
// the frontend: App.tsx's sidebar width, Dock.tsx's dock-region height, and
// UnifiedBoard.tsx's task-detail drawer width. All three share the same
// shape (drag a handle, clamp a single number between a fixed min and a
// max computed fresh at drag start, restore cursor/user-select on the
// document body for the drag's duration) — verified nearly byte-identical
// aside from axis, clamp bounds, and which direction along that axis grows
// the value.
//
// Deliberately NOT covering Dock.tsx's *other* drag handle (the
// column-divider between two adjacent DockColumns): that one splits a
// fixed total width between two values from one drag, not "clamp one value
// between a min and a max" — a genuinely different shape, not a fourth
// copy of this one. It stays hand-written.
//
// This hook is intentionally uncontrolled-value-adjacent rather than
// value-owning: the caller keeps its own `useState` for the resized value
// (needed anyway, since each call site already has its own default/
// persisted-read logic that differs — see `lib/persistedState.ts`'s own
// note on why serialization wasn't unified either) and passes it in via
// `value`; this hook only drives the drag gesture and calls `onChange`
// during the drag and `onCommit` once at drag end. `onChange`/`onCommit`
// are read through refs kept current every render (same technique
// `usePolling.ts` uses for `fn`), so passing fresh inline closures each
// render is fine.
export interface UseDragResizeOptions {
  /** Which pointer coordinate drives the drag. */
  axis: "x" | "y";
  /** True when growing the value corresponds to a DECREASING pointer
   * coordinate — a handle on the left or top border of the thing being
   * resized (Dock's height handle sits on the top border: dragging up
   * grows it; UnifiedBoard's drawer handle sits on its left border: same
   * idea). Defaults to `false` (pointer increase = value increase), which
   * is what App.tsx's sidebar handle — on its right border — needs. */
  invert?: boolean;
  /** Fixed floor for the resized value. */
  min: number;
  /** Computed once, fresh, at the start of each drag (e.g. from a live DOM
   * measurement of however much room is actually available right now) —
   * NOT memoized, matching every pre-extraction call site, which all
   * recomputed their own equivalent inline in the mousedown handler. */
  getMax: () => number;
  /** The current value, read once at the start of each drag as the drag's
   * own baseline. */
  value: number;
  /** Called on every `mousemove` during a drag, with the newly clamped
   * value — the caller's own `useState` setter, typically. */
  onChange: (next: number) => void;
  /** Called once on `mouseup`, with the final value — never called on
   * mount or for any reason other than an actual completed drag, so a
   * caller that persists here (e.g. `writeNumber(STORAGE_KEYS.dockHeight,
   * v)`) doesn't need its own "skip the initial mount" guard the way each
   * pre-extraction call site did by hand. */
  onCommit?: (final: number) => void;
  /** `document.body.style.cursor` for the drag's duration. */
  cursor: "col-resize" | "ns-resize";
  /** Opt in to the window-splitter keyboard pattern (issue #1264): the
   * handle becomes focusable, arrow keys along `axis` nudge the value by
   * `step` px (the direction the handle would move on screen, honouring
   * `invert`), Home/End jump to `min`/`max`, and `keyboardProps` carries the
   * `aria-value*` attributes. Bounds are exactly the drag's own
   * (`min`, `getMax()`), and each key press goes through the same
   * `onChange` + `onCommit` pair a completed drag does, so persistence is
   * identical. Off by default: `getMax` is then only called at drag start
   * (it may measure the DOM), not on every render. */
  keyboardStep?: number;
}

export interface SeparatorKeyboardProps {
  tabIndex: 0;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  "aria-valuenow": number;
  "aria-valuemin": number;
  "aria-valuemax": number;
}

export interface UseDragResizeResult {
  /** True for exactly the duration of an in-progress drag. */
  dragging: boolean;
  /** Wire this to the handle's own `onMouseDown`. */
  onMouseDown: (e: ReactMouseEvent) => void;
  /** Spread onto the handle when `keyboardStep` is set; `undefined`
   * otherwise. */
  keyboardProps: SeparatorKeyboardProps | undefined;
}

export function useDragResize({
  axis,
  invert = false,
  min,
  getMax,
  value,
  onChange,
  onCommit,
  cursor,
  keyboardStep,
}: UseDragResizeOptions): UseDragResizeResult {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startCoord: number; startValue: number; max: number } | null>(null);
  // The drag's own running value, updated synchronously inside `onMove` —
  // NOT read back from `value`/React state, since a `mouseup` can fire
  // before React has re-rendered off the last `onChange` call. Mirrors
  // App.tsx's own pre-extraction `sidebarWidthRef` technique exactly.
  const lastValueRef = useRef(value);

  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onChangeRef.current = onChange;
    onCommitRef.current = onCommit;
  });

  const getMaxRef = useRef(getMax);
  useEffect(() => {
    getMaxRef.current = getMax;
  });

  const onMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const startCoord = axis === "x" ? e.clientX : e.clientY;
      dragRef.current = { startCoord, startValue: value, max: getMaxRef.current() };
      lastValueRef.current = value;
      setDragging(true);
    },
    [axis, value],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (keyboardStep === undefined) return;
      const max = Math.max(min, getMaxRef.current());
      const growKey =
        axis === "x" ? (invert ? "ArrowLeft" : "ArrowRight") : invert ? "ArrowUp" : "ArrowDown";
      const shrinkKey =
        axis === "x" ? (invert ? "ArrowRight" : "ArrowLeft") : invert ? "ArrowDown" : "ArrowUp";
      const current = Math.min(Math.max(value, min), max);
      let next: number;
      if (e.key === growKey) next = current + keyboardStep;
      else if (e.key === shrinkKey) next = current - keyboardStep;
      else if (e.key === "Home") next = min;
      else if (e.key === "End") next = max;
      else return;
      e.preventDefault();
      e.stopPropagation();
      next = Math.min(Math.max(next, min), max);
      if (next === value) return;
      onChangeRef.current(next);
      onCommitRef.current?.(next);
    },
    [axis, invert, min, value, keyboardStep],
  );

  let keyboardProps: SeparatorKeyboardProps | undefined;
  if (keyboardStep !== undefined) {
    const max = Math.max(min, getMax());
    keyboardProps = {
      tabIndex: 0,
      onKeyDown,
      "aria-valuenow": Math.round(Math.min(Math.max(value, min), max)),
      "aria-valuemin": min,
      "aria-valuemax": Math.round(max),
    };
  }

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const coord = axis === "x" ? e.clientX : e.clientY;
      const delta = invert ? d.startCoord - coord : coord - d.startCoord;
      const max = Math.max(min, d.max);
      const next = Math.min(Math.max(d.startValue + delta, min), max);
      lastValueRef.current = next;
      onChangeRef.current(next);
    };

    const onUp = () => {
      onCommitRef.current?.(lastValueRef.current);
      setDragging(false);
      dragRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = cursor;
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [dragging, axis, invert, min, cursor]);

  return { dragging, onMouseDown, keyboardProps };
}
