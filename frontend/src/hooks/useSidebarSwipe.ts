/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { attachSidebarSwipeGesture } from "../lib/sidebarSwipeGesture.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseSidebarSwipeParams {
  compact: boolean;
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  appBodyRef: RefObject<HTMLDivElement | null>;
  sidebarWrapperRef: RefObject<HTMLDivElement | null>;
}

export function useSidebarSwipe({
  compact,
  sidebarOpen,
  setSidebarOpen,
  appBodyRef,
  sidebarWrapperRef,
}: UseSidebarSwipeParams): void {
  useEffect(() => {
    if (!compact) return;
    if (sidebarOpen) {
      const el = sidebarWrapperRef.current;
      if (!el) return;
      return attachSidebarSwipeGesture({
        element: el,
        commitDirection: -1,
        // Panning the Tasks status strip must not dismiss the navigator.
        ignoreSelector: ".tasks-phone-strip",
        onCommit: () => setSidebarOpen(false),
      });
    }
    const el = appBodyRef.current;
    if (!el) return;
    return attachSidebarSwipeGesture({
      element: el,
      commitDirection: 1,
      edgeZonePx: 24,
      // The key bar is flush with the left edge; its taps/pans stay its own.
      ignoreSelector: ".mobile-key-bar, .tasks-phone-strip",
      onCommit: () => setSidebarOpen(true),
    });
  }, [compact, sidebarOpen]);
}
