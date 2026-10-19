import { useEffect, useRef } from "react";

// Issue #1402 — the visible region in layout-viewport coordinates. Menus are
// `position: fixed` against the layout viewport, but on iOS Safari neither
// `window.innerHeight` nor `100dvh` shrinks when the keyboard is open, so a
// flip/cap computed from them runs behind the keyboard. The visible slice is
// `[offsetTop, offsetTop + height]`. Falls back to `innerHeight` where
// `visualViewport` does not exist (jsdom, older browsers).
export interface VisibleViewport {
  top: number;
  bottom: number;
  height: number;
}

export function visibleViewport(): VisibleViewport {
  const vv = window.visualViewport;
  if (!vv) {
    const height = window.innerHeight;
    return { top: 0, bottom: height, height };
  }
  const top = vv.offsetTop;
  const height = vv.height;
  return { top, bottom: top + height, height };
}

// A non-positive `max-height` is an invalid length: the browser drops the
// declaration and the menu goes uncapped. Use the free space whenever it is
// positive — flooring a small positive gap back up to `floor` hides that
// much of the menu behind the keyboard (issue #1402). Fall back to `floor`
// only when nothing is actually free. 120px is enough to still show a few
// items when the trigger is flush with the edge (the Dock at its minimum).
export const MENU_MAX_HEIGHT_FLOOR = 120;

export function menuMaxHeight(available: number, floor = MENU_MAX_HEIGHT_FLOOR): number {
  return available > 0 ? available : floor;
}

// Issue #1399 — since #1398, `.app` pins its `top` to the visual viewport's
// `offsetTop` under `(pointer: coarse)` (tablet.css's `--shell-top`, fed by
// useVisualViewportInset.ts), so the toolbar *moves* whenever iOS pans the
// visual viewport with the keyboard open. Every toolbar-adjacent menu that's
// portaled to <body> as `position: fixed` reads its trigger's rect once on
// open, so without this it stays where it was drawn while its trigger moves
// away. Calls `onChange` (rAF-coalesced, same as useVisualViewportInset's own
// update — `resize`/`scroll` fire in a tight burst while the keyboard
// animates) on every visual-viewport `resize`/`scroll` while `active`, so a
// menu can re-read its trigger's rect. Also fires on a window `resize`.
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

    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => onChangeRef.current());
    };

    // A window `resize` (desktop window/devtools resize, orientation change,
    // crossing the toolbar's max-width:699px breakpoint) moves the trigger
    // without any visual-viewport event on browsers lacking one, and the
    // visual viewport doesn't always fire alongside it.
    window.addEventListener("resize", update);
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, [active]);
}
