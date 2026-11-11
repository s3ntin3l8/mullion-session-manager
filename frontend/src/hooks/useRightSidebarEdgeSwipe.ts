/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { RefObject } from "react";
import type { LayoutTier } from "../lib/layoutTier.js";
import { attachSidebarSwipeGesture } from "../lib/sidebarSwipeGesture.js";
import { useDashboardStore } from "../store/index.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseRightSidebarEdgeSwipeParams {
  layoutTier: LayoutTier;
  rightSidebarOpen: boolean;
  appBodyRef: RefObject<HTMLDivElement | null>;
}

export function useRightSidebarEdgeSwipe({
  layoutTier,
  rightSidebarOpen,
  appBodyRef,
}: UseRightSidebarEdgeSwipeParams): void {
  // Tablet: a leftward swipe from the right edge opens the right sidebar
  // drawer (it dismisses itself — see RightSidebar). The rail sits on that
  // edge, but a tap never travels the commit threshold, so rail taps are safe.
  useEffect(() => {
    if (layoutTier !== "tablet" || rightSidebarOpen) return;
    const el = appBodyRef.current;
    if (!el) return;
    return attachSidebarSwipeGesture({
      element: el,
      commitDirection: -1,
      edge: "right",
      edgeZonePx: 24,
      ignoreSelector: ".mobile-key-bar, .tasks-phone-strip",
      onCommit: () => useDashboardStore.getState().toggleRightSidebar(),
    });
  }, [layoutTier, rightSidebarOpen]);
}
