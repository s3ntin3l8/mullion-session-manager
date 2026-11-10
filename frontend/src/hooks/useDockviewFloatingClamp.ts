/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { RefObject } from "react";
import type { DockviewApi } from "dockview-react";

// dockview's floating-window titlebar (--dv-floating-titlebar-height), added to a group's height.
const FLOATING_TITLEBAR_HEIGHT = 22;

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseDockviewFloatingClampParams {
  dockviewApi: DockviewApi | null;
  dockviewContainerRef: RefObject<HTMLDivElement | null>;
}

export function useDockviewFloatingClamp({
  dockviewApi,
  dockviewContainerRef,
}: UseDockviewFloatingClampParams): void {
  // `floatingGroupBounds="boundedWithinViewport"` clamps a floating group's
  // POSITION only; it never shrinks one. A group taller than the grid area
  // (e.g. after the Dock expands) would sit at top:0 and overhang behind the
  // opaque Dock, unreachable. So clamp the height whenever the container
  // resizes.
  useEffect(() => {
    if (!dockviewApi) return;
    const container = dockviewContainerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const clamp = () => {
      // dockview sizes a floating window as group height + its titlebar
      // (dockview's --dv-floating-titlebar-height, 22px in both themes; the
      // theme class sits on a child of this container, so it can't be read
      // from here).
      const titlebar = FLOATING_TITLEBAR_HEIGHT;
      const max = container.clientHeight - titlebar;
      if (max <= 0) return;
      for (const group of dockviewApi.groups) {
        if (group.api.location.type !== "floating") continue;
        if (group.height > max) group.api.setSize({ height: max });
      }
    };
    const observer = new ResizeObserver(clamp);
    observer.observe(container);
    return () => observer.disconnect();
  }, [dockviewApi]);
}
