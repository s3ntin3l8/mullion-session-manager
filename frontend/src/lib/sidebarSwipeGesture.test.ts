// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachSidebarSwipeGesture } from "./sidebarSwipeGesture.js";

// Same rationale as terminalTouchScroll.test.ts: jsdom implements the
// `TouchEvent` constructor but not `Touch`, so a plain `Event` with
// `touches` bolted on is used instead of a real `TouchEvent`.
function touchEvent(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: { clientX: number; clientY: number }[],
  opts: { cancelable?: boolean } = {},
): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: opts.cancelable ?? true }), {
    touches,
  });
}

describe("attachSidebarSwipeGesture", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    // jsdom's real layout engine always reports an all-zero rect — stub it
    // so the edgeZonePx tests can exercise a non-trivial left offset.
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;
  });

  it("commits a rightward drag past the threshold, starting inside the edge zone", () => {
    const onCommit = vi.fn();
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit,
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 10, clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 80, clientY: 0 }]));

    expect(onCommit).toHaveBeenCalledTimes(1);
    detach();
  });

  it("ignores a touch starting outside the edge zone", () => {
    const onCommit = vi.fn();
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit,
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 100, clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 250, clientY: 0 }]));

    expect(onCommit).not.toHaveBeenCalled();
    detach();
  });

  it("does not commit a leftward drag when commitDirection is 1", () => {
    const onCommit = vi.fn();
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit,
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 10, clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: -80, clientY: 0 }]));

    expect(onCommit).not.toHaveBeenCalled();
    detach();
  });

  it("commits a leftward drag when commitDirection is -1, from anywhere on the element (no edge zone)", () => {
    const onCommit = vi.fn();
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: -1,
      onCommit,
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 200, clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 100, clientY: 0 }]));

    expect(onCommit).toHaveBeenCalledTimes(1);
    detach();
  });

  it("locks the vertical axis on a predominantly-vertical drag and never commits for that gesture", () => {
    const onCommit = vi.fn();
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit,
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 5, clientY: 0 }]));
    // Vertical-dominant first move locks the axis for the rest of the gesture.
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 8, clientY: 40 }]));
    // Even though this later move alone would cross the commit threshold,
    // the axis lock from above should keep it inert.
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 100, clientY: 45 }]));

    expect(onCommit).not.toHaveBeenCalled();
    detach();
  });

  it("does not call preventDefault on a vertical-locked drag, so a scroll underneath stays live", () => {
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit: vi.fn(),
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 5, clientY: 0 }]));
    const move = touchEvent("touchmove", [{ clientX: 8, clientY: 40 }]);
    const prevented = !container.dispatchEvent(move);

    expect(prevented).toBe(false);
    detach();
  });

  it("claims the gesture via preventDefault once horizontal-dominant, even before the commit threshold", () => {
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit: vi.fn(),
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 5, clientY: 0 }]));
    // Horizontal-dominant, but only 10px — short of the 60px commit distance.
    const move = touchEvent("touchmove", [{ clientX: 15, clientY: 0 }]);
    const prevented = !container.dispatchEvent(move);

    expect(prevented).toBe(true);
    detach();
  });

  it("still commits when the move event is non-cancelable, documenting the accepted tab-strip pan-x gap (see the module's own header comment)", () => {
    // A non-cancelable touchmove is what the browser dispatches once it has
    // natively granted panning on an axis (dockview's own `touch-action:
    // pan-x` on an overflowing, edge-flush tab strip is the real-world
    // trigger) — this helper has no way to detect that and doesn't try to;
    // it commits purely off `deltaX`, same as any other gesture.
    const onCommit = vi.fn();
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit,
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 5, clientY: 0 }]));
    container.dispatchEvent(
      touchEvent("touchmove", [{ clientX: 80, clientY: 0 }], { cancelable: false }),
    );

    expect(onCommit).toHaveBeenCalledTimes(1);
    detach();
  });

  it("commits at most once per gesture", () => {
    const onCommit = vi.fn();
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit,
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 5, clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 80, clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 150, clientY: 0 }]));

    expect(onCommit).toHaveBeenCalledTimes(1);
    detach();
  });

  it("abandons the gesture on a second touch (pinch) instead of committing", () => {
    const onCommit = vi.fn();
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit,
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 5, clientY: 0 }]));
    container.dispatchEvent(
      touchEvent("touchmove", [
        { clientX: 5, clientY: 0 },
        { clientX: 300, clientY: 0 },
      ]),
    );
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 100, clientY: 0 }]));

    expect(onCommit).not.toHaveBeenCalled();
    detach();
  });

  it("resets tracking state on touchcancel, same as touchend", () => {
    const onCommit = vi.fn();
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit,
    });

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 5, clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchcancel", []));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 200, clientY: 0 }]));

    expect(onCommit).not.toHaveBeenCalled();
    detach();
  });

  it("stops handling events after detach", () => {
    const onCommit = vi.fn();
    const detach = attachSidebarSwipeGesture({
      element: container,
      commitDirection: 1,
      edgeZonePx: 24,
      onCommit,
    });
    detach();

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 5, clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 200, clientY: 0 }]));

    expect(onCommit).not.toHaveBeenCalled();
  });
});
