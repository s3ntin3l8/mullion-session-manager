import { useEffect, useState } from "react";

// Mobile UI/UX overhaul, item B.1 (see .claude/plans/we-need-to-work-
// iterative-planet.md) — `.app` is `position: fixed; inset: 0`
// (styles.css), and there is no `visualViewport` handling anywhere in this
// codebase, so an iOS/Android soft keyboard shrinks the *visual* viewport
// without the layout viewport (or this fixed shell) reflowing at all: the
// terminal's active line, and any focused input, can end up rendered behind
// the keyboard. `window.visualViewport` is the one API that reports the
// keyboard's actual on-screen height — `innerHeight - (visualViewport.height
// + visualViewport.offsetTop)` is the gap between the layout viewport's
// bottom edge and the visible viewport's bottom edge, which is exactly the
// keyboard's height when it's open (0 when it's closed, or on a browser
// with no visualViewport support at all).
//
// rAF-coalesced for the same reason terminalRepaintRegistry.ts's own
// repaint dispatch is: `resize`/`scroll` on visualViewport can fire in a
// tight burst while the keyboard animates open/closed, and this value flows
// straight into a CSS custom property that resizes `.app` — no need to
// re-render on every intermediate frame.
export function useVisualViewportInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setInset(Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)));
      });
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}
