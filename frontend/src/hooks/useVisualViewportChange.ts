import { useEffect, useRef } from "react";

// Issue #1399 — since #1398, `.app` pins its `top` to the visual viewport's
// `offsetTop` under `(pointer: coarse)` (tablet.css's `--shell-top`, fed by
// useVisualViewportInset.ts), so the toolbar *moves* whenever iOS pans the
// visual viewport with the keyboard open. Every toolbar-adjacent menu that's
// portaled to <body> as `position: fixed` reads its trigger's rect once on
// open, so without this it stays where it was drawn while its trigger moves
// away. Calls `onChange` (rAF-coalesced, same as useVisualViewportInset's own
// update — `resize`/`scroll` fire in a tight burst while the keyboard
// animates) on every visual-viewport `resize`/`scroll` while `active`, so a
// menu can re-read its trigger's rect.
//
// Ordering: useVisualViewportInset is mounted once at App level, so its
// listeners are registered before any menu's — its rAF is queued first in
// the same frame and writes `--kb-offset-top` before `onChange` runs here.
// `getBoundingClientRect()` inside `onChange` then forces a synchronous
// layout, so it reads the trigger's *moved* position, no double-rAF needed.
//
// `onChange` is held in a ref, so callers can pass an inline closure without
// re-subscribing on every render.
export function useVisualViewportChange(active: boolean, onChange: () => void): void {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => onChangeRef.current());
    };

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);
}
