import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

// #3217 — drag a workspace by its handle to reorder it within its group, move
// it into another group, or out of all groups, with Pointer Events and pointer
// capture, so one code path serves a mouse and a finger. The browser's native
// drag (`draggable`) does not start reliably from a touch. No drag library:
// this is all of it. The rail's picker (rail/WorkspaceChip.tsx) and, since
// #3224, the docked sidebar's switcher (WorkspaceSwitcher.tsx) both use it.
//
// The list it drives marks its parts with data attributes, and the hook reads
// their positions on screen at each move rather than keeping a model of its
// own, so whatever the list renders is what it hit-tests against:
//
// - a drop zone (one per group, one for "No group") carries
//   `data-drop-zone="<group id>"` or `data-drop-zone="none"`; its whole box,
//   header included, is the zone, so an empty group is a target;
// - a draggable row inside it carries `data-drag-id="<workspace id>"`.
//
// Only the handle starts a drag (its CSS sets `touch-action: none`), so a
// finger on a row still scrolls the list. Escape or a pointer cancel puts the
// row back; nothing moves until the pointer is released over a zone. Away
// from the list (beyond OUTSIDE_TOLERANCE of its box) there is no target, so
// a release there moves nothing either.

/** Where a dragged workspace lands: a bucket and an index in it, counted
 *  without the dragged workspace itself (moveWorkspace's index rule). */
export interface DropTarget {
  groupId: number | null;
  index: number;
}

export interface ZoneRect {
  groupId: number | null;
  top: number;
  bottom: number;
  rows: { id: number; top: number; bottom: number }[];
}

/** The drop target under `y`: the zone containing it (the nearest one when it
 *  is above or below them all, or in a gap between two), and in that zone the
 *  number of other rows whose middle is above `y`. */
export function dropTargetAt(y: number, zones: ZoneRect[], draggedId: number): DropTarget | null {
  if (zones.length === 0) return null;
  let zone = zones[0];
  let best = Infinity;
  for (const z of zones) {
    const distance = y < z.top ? z.top - y : y > z.bottom ? y - z.bottom : 0;
    if (distance < best) {
      best = distance;
      zone = z;
    }
  }
  const index = zone.rows.filter((r) => r.id !== draggedId && (r.top + r.bottom) / 2 < y).length;
  return { groupId: zone.groupId, index };
}

/** Pixels to scroll the list by per frame with the pointer at `y`: negative
 *  near its top edge, positive near its bottom one, faster the closer to the
 *  edge (or past it), 0 in between. */
export function edgeScrollSpeed(
  y: number,
  top: number,
  bottom: number,
  edge = 36,
  max = 14,
): number {
  if (bottom - top <= edge * 2) return 0;
  if (y < top + edge) return -Math.round(max * Math.min(1, (top + edge - y) / edge));
  if (y > bottom - edge) return Math.round(max * Math.min(1, (y - (bottom - edge)) / edge));
  return 0;
}

function parseZone(value: string | undefined): number | null {
  return value === undefined || value === "none" ? null : Number(value);
}

function measureZones(root: HTMLElement): ZoneRect[] {
  return [...root.querySelectorAll<HTMLElement>("[data-drop-zone]")].map((zone) => {
    const rect = zone.getBoundingClientRect();
    return {
      groupId: parseZone(zone.dataset.dropZone),
      top: rect.top,
      bottom: rect.bottom,
      rows: [...zone.querySelectorAll<HTMLElement>("[data-drag-id]")].map((row) => {
        const r = row.getBoundingClientRect();
        return { id: Number(row.dataset.dragId), top: r.top, bottom: r.bottom };
      }),
    };
  });
}

/** The pointer has to travel this far before a press on the handle becomes a
 *  drag, so a click on it does not flash the drop indicator. */
const DRAG_THRESHOLD = 4;

/** How far outside the list's box the pointer may be and still drop: enough
 *  for a slightly overshot edge row, not a release elsewhere on screen. */
export const OUTSIDE_TOLERANCE = 16;

/** Whether (x, y) is over the list, within OUTSIDE_TOLERANCE of its box. */
export function overList(
  x: number,
  y: number,
  rect: { top: number; bottom: number; left: number; right: number },
): boolean {
  return (
    y >= rect.top - OUTSIDE_TOLERANCE &&
    y <= rect.bottom + OUTSIDE_TOLERANCE &&
    x >= rect.left - OUTSIDE_TOLERANCE &&
    x <= rect.right + OUTSIDE_TOLERANCE
  );
}

export interface PointerReorderState {
  id: number;
  target: DropTarget | null;
}

export function usePointerReorder({
  scrollRef,
  listRef,
  enabled,
  onDrop,
}: {
  /** The scrolling element: it scrolls while the pointer is near its top or
   *  bottom edge. Also the list (below) unless `listRef` is given. */
  scrollRef: RefObject<HTMLElement | null>;
  /** The list, when it is not itself the scrolling element but sits in a
   *  larger one (the docked sidebar's switcher scrolls with the whole
   *  sidebar): drop zones are looked up inside it, and a release away from
   *  it drops nothing, even over the rest of the scrolling element. */
  listRef?: RefObject<HTMLElement | null>;
  /** False while the list is filtered (its rows are then not the buckets'). */
  enabled: boolean;
  onDrop: (id: number, target: DropTarget) => void;
}) {
  const [dragging, setDragging] = useState<PointerReorderState | null>(null);
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);
  // Tears down the drag in progress (listeners, capture, auto-scroll).
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = useCallback(
    (id: number, e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || !e.isPrimary || e.button !== 0 || cleanupRef.current) return;
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      // No text selection, and no compatibility mousedown (which a popover's
      // outside-click check would otherwise see) while dragging.
      e.preventDefault();
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // Not capturable (the pointer is already gone): events still reach
        // the handle while the pointer is over it.
      }
      const startY = e.clientY;
      let lastY = startY;
      let lastX = e.clientX;
      let started = false;
      let target: DropTarget | null = null;
      let frame = 0;

      const retarget = () => {
        const root = (listRef ?? scrollRef).current;
        // A list inside a larger scroller can be scrolled partly out of its
        // view: the part outside the scroller's box is not a target either.
        const scroller = listRef ? scrollRef.current : null;
        target =
          root &&
          overList(lastX, lastY, root.getBoundingClientRect()) &&
          (!scroller || overList(lastX, lastY, scroller.getBoundingClientRect()))
            ? dropTargetAt(lastY, measureZones(root), id)
            : null;
        setDragging({ id, target });
      };
      const autoScroll = () => {
        frame = 0;
        const root = scrollRef.current;
        if (!root || !started) return;
        const rect = root.getBoundingClientRect();
        const speed = edgeScrollSpeed(lastY, rect.top, rect.bottom);
        if (speed === 0) return;
        const before = root.scrollTop;
        root.scrollTop = before + speed;
        if (root.scrollTop !== before) retarget();
        frame = requestAnimationFrame(autoScroll);
      };
      const finish = (commit: boolean) => {
        const landed = commit && started ? target : null;
        cleanup();
        setDragging(null);
        if (landed) onDropRef.current(id, landed);
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        lastY = ev.clientY;
        lastX = ev.clientX;
        if (!started) {
          if (Math.abs(lastY - startY) < DRAG_THRESHOLD) return;
          started = true;
        }
        retarget();
        if (!frame) frame = requestAnimationFrame(autoScroll);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish(true);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish(false);
      };
      // Capture phase on window: ahead of the popover's and the sheet's own
      // Escape, which would close the whole picker.
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      };
      const cleanup = () => {
        cleanupRef.current = null;
        if (frame) cancelAnimationFrame(frame);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onCancel);
        handle.removeEventListener("lostpointercapture", onCancel);
        window.removeEventListener("keydown", onKey, true);
        try {
          if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        } catch {
          // Already released.
        }
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onCancel);
      handle.addEventListener("lostpointercapture", onCancel);
      window.addEventListener("keydown", onKey, true);
      cleanupRef.current = cleanup;
    },
    [enabled, scrollRef, listRef],
  );

  return { dragging, onPointerDown };
}
