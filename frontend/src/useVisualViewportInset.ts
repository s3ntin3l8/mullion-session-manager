import { useEffect } from "react";

// Mobile UI/UX overhaul, item B.1 (see .claude/plans/we-need-to-work-
// iterative-planet.md) — `.app` is `position: fixed; inset: 0`
// (styles.css), and there is no `visualViewport` handling anywhere in this
// codebase, so an iOS/Android soft keyboard shrinks the *visual* viewport
// without the layout viewport (or this fixed shell) reflowing at all: the
// terminal's active line, and any focused input, can end up rendered behind
// the keyboard. `window.visualViewport` is the one API that reports the
// keyboard's actual on-screen height — `documentElement.clientHeight -
// (visualViewport.height + visualViewport.offsetTop)` is the gap between the
// layout viewport's bottom edge and the visible viewport's bottom edge,
// which is exactly the keyboard's height when it's open (0 when it's
// closed, or on a browser with no visualViewport support at all).
//
// Independent code review, PR #615 — `document.documentElement.clientHeight`
// specifically, NOT `window.innerHeight`: `.app`'s `position: fixed` box is
// sized against the initial containing block, i.e. clientHeight, and the two
// aren't reliably the same number on mobile Safari, where innerHeight can
// diverge from clientHeight as the address bar/toolbar collapses and
// expands — the same underlying quirk `dvh`/`svh`/`lvh` CSS units exist to
// work around. Using innerHeight here risked a permanent non-zero
// --kb-inset (clipping the bottom of .app) on iOS with no keyboard open at
// all, on exactly the platform this hook does all of its real work on
// (interactive-widget=resizes-content, index.html, is Chrome/Android-only).
//
// Hermes review, PR #615 (round 2) — writes `--kb-inset` directly onto
// `document.documentElement.style` inside the rAF callback instead of
// routing it through React state. This has no return value on purpose: a
// `useState` here, as an earlier version of this hook had, re-renders the
// entire App tree once per coalesced frame for the whole keyboard open/close
// animation (~15 full-tree reconciliations across a ~250ms animation) on
// exactly the platform this hook exists to help. CSS custom properties
// inherit down the DOM tree, so setting it on `documentElement` (the `<html>`
// element, an ancestor of `.app`) resolves identically for `.app`'s own
// `bottom: var(--kb-inset, 0px)` rule (styles.css) as setting it on `.app`
// directly would — no ref-passing needed, and App.tsx doesn't need to know
// this hook exists beyond calling it once for its effect.
//
// Also guards against pinch-zoom (Hermes's own suggestion): zooming shrinks
// `visualViewport.height` and can move `offsetTop` with no keyboard
// involved, which would otherwise be mistaken for a keyboard opening and
// incorrectly shrink `.app`. Skips (not zeros) the update while zoomed, so
// a keyboard that's genuinely open when a pinch-zoom starts doesn't have its
// own inset erased mid-gesture — the CSS variable just holds its last
// known-good value until the zoom ends and a real update lands again.
//
// rAF-coalesced for the same reason terminalRepaintRegistry.ts's own
// repaint dispatch is: `resize`/`scroll` on visualViewport can fire in a
// tight burst while the keyboard animates open/closed.
export function useVisualViewportInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (vv.scale !== 1) return;
        const layoutHeight = document.documentElement.clientHeight;
        const inset = Math.max(0, layoutHeight - (vv.height + vv.offsetTop));
        document.documentElement.style.setProperty("--kb-inset", `${inset}px`);
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
}
