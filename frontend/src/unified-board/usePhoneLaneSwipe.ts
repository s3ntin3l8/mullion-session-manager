import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { attachSidebarSwipeGesture } from "../lib/sidebarSwipeGesture.js";
import type { PhoneSegmentId } from "../tasksBoard.js";

// Swipe left for the next lane and right for the previous one, on the board's
// body. The same discrete threshold gesture the sidebars use
// (lib/sidebarSwipeGesture.ts): a vertical scroll locks vertical and never
// changes lane.
export function usePhoneLaneSwipe(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  lanes: readonly PhoneSegmentId[],
  current: PhoneSegmentId,
  onSelect: (id: PhoneSegmentId) => void,
): void {
  // Read at commit time, so the listeners are attached once per activation.
  const state = useRef({ lanes, current, onSelect });
  useEffect(() => {
    state.current = { lanes, current, onSelect };
  });
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const step = (delta: number) => {
      const { lanes: ids, current: at, onSelect: select } = state.current;
      const next = ids[ids.indexOf(at) + delta];
      if (next !== undefined) select(next);
    };
    const detachNext = attachSidebarSwipeGesture({
      element,
      commitDirection: -1,
      onCommit: () => step(1),
    });
    const detachPrev = attachSidebarSwipeGesture({
      element,
      commitDirection: 1,
      onCommit: () => step(-1),
    });
    return () => {
      detachNext();
      detachPrev();
    };
  }, [ref, active]);
}
