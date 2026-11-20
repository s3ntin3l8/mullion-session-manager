// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import {
  OUTSIDE_TOLERANCE,
  dropTargetAt,
  edgeScrollSpeed,
  overList,
  usePointerReorder,
} from "./usePointerReorder.js";
import type { DropTarget, ZoneRect } from "./usePointerReorder.js";

describe("dropTargetAt", () => {
  const zones: ZoneRect[] = [
    {
      groupId: 1,
      top: 0,
      bottom: 100,
      rows: [
        { id: 1, top: 10, bottom: 40 },
        { id: 2, top: 40, bottom: 70 },
        { id: 3, top: 70, bottom: 100 },
      ],
    },
    { groupId: 2, top: 120, bottom: 150, rows: [] },
    { groupId: null, top: 160, bottom: 200, rows: [{ id: 4, top: 160, bottom: 200 }] },
  ];

  it("counts the other rows whose middle is above the pointer", () => {
    expect(dropTargetAt(20, zones, 3)).toEqual({ groupId: 1, index: 0 });
    expect(dropTargetAt(60, zones, 3)).toEqual({ groupId: 1, index: 2 });
    // The dragged row itself does not count.
    expect(dropTargetAt(90, zones, 1)).toEqual({ groupId: 1, index: 2 });
  });

  it("lands in an empty zone, in No group, and in the nearest zone outside them all", () => {
    expect(dropTargetAt(130, zones, 1)).toEqual({ groupId: 2, index: 0 });
    expect(dropTargetAt(190, zones, 1)).toEqual({ groupId: null, index: 1 });
    expect(dropTargetAt(-40, zones, 2)).toEqual({ groupId: 1, index: 0 });
    expect(dropTargetAt(500, zones, 2)).toEqual({ groupId: null, index: 1 });
    // In the gap between two zones: the closer one.
    expect(dropTargetAt(115, zones, 1)).toEqual({ groupId: 2, index: 0 });
    expect(dropTargetAt(10, [], 1)).toBeNull();
  });
});

describe("overList", () => {
  const rect = { top: 100, bottom: 300, left: 50, right: 250 };
  it("takes the list's box plus a small tolerance, nothing further away", () => {
    expect(overList(100, 200, rect)).toBe(true);
    expect(overList(100, 100 - OUTSIDE_TOLERANCE, rect)).toBe(true);
    expect(overList(100, 300 + OUTSIDE_TOLERANCE, rect)).toBe(true);
    expect(overList(100, 99 - OUTSIDE_TOLERANCE, rect)).toBe(false);
    expect(overList(100, 2000, rect)).toBe(false);
    expect(overList(250 + OUTSIDE_TOLERANCE + 1, 200, rect)).toBe(false);
    expect(overList(0, 200, rect)).toBe(false);
  });
});

describe("edgeScrollSpeed", () => {
  it("scrolls up near the top, down near the bottom, faster closer to the edge", () => {
    expect(edgeScrollSpeed(200, 0, 400)).toBe(0);
    expect(edgeScrollSpeed(0, 0, 400)).toBe(-14);
    expect(edgeScrollSpeed(18, 0, 400)).toBe(-7);
    expect(edgeScrollSpeed(400, 0, 400)).toBe(14);
    expect(edgeScrollSpeed(450, 0, 400)).toBe(14);
    // A list too short to have a middle does not scroll.
    expect(edgeScrollSpeed(0, 0, 60)).toBe(0);
  });
});

// A list laid out by data attributes: group 1 holds 1, 2, 3; group 2 is
// empty; No group holds 4. Positions come from data-top/data-bottom. With
// `split`, the list (0-200) sits inside a larger scrolling element, as the
// docked sidebar's switcher does (#3224).
function Harness({
  onDrop,
  split = false,
}: {
  onDrop: (id: number, target: DropTarget) => void;
  split?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { dragging, onPointerDown } = usePointerReorder({
    scrollRef,
    listRef: split ? listRef : undefined,
    enabled: true,
    onDrop,
  });
  const row = (id: number, top: number) => (
    <div key={id} data-drag-id={id} data-top={top} data-bottom={top + 30}>
      <button aria-label={`grip ${id}`} onPointerDown={(e) => onPointerDown(id, e)} />
    </div>
  );
  const zones = (
    <>
      <div data-drop-zone="1" data-top={0} data-bottom={100}>
        {row(1, 10)}
        {row(2, 40)}
        {row(3, 70)}
      </div>
      <div data-drop-zone="2" data-top={120} data-bottom={150} />
      <div data-drop-zone="none" data-top={160} data-bottom={200}>
        {row(4, 160)}
      </div>
    </>
  );
  return (
    <div ref={scrollRef} data-testid="scroll" data-top={-1000} data-bottom={1000}>
      {split ? (
        <div ref={listRef} data-top={0} data-bottom={200}>
          {zones}
        </div>
      ) : (
        zones
      )}
      <output data-testid="state">{JSON.stringify(dragging)}</output>
    </div>
  );
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const top = Number(this.dataset.top ?? 0);
    const bottom = Number(this.dataset.bottom ?? 0);
    return { top, bottom, left: 0, right: 100, height: bottom - top, width: 100 } as DOMRect;
  });
});
afterEach(() => vi.restoreAllMocks());

const grip = (id: number) => screen.getByRole("button", { name: `grip ${id}` });
const down = (id: number, clientY: number) =>
  fireEvent.pointerDown(grip(id), { pointerId: 7, isPrimary: true, button: 0, clientY });
const move = (id: number, clientY: number) =>
  fireEvent.pointerMove(grip(id), { pointerId: 7, clientY });
const up = (id: number, clientY: number) =>
  fireEvent.pointerUp(grip(id), { pointerId: 7, clientY });
const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "null");

describe("usePointerReorder", () => {
  it("reorders within a group", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    down(1, 20);
    move(1, 80);
    expect(state()).toEqual({ id: 1, target: { groupId: 1, index: 1 } });
    up(1, 80);
    expect(onDrop).toHaveBeenCalledWith(1, { groupId: 1, index: 1 });
    expect(state()).toBeNull();
  });

  it("moves a workspace into another group, an empty one included", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    down(2, 50);
    move(2, 135);
    up(2, 135);
    expect(onDrop).toHaveBeenCalledWith(2, { groupId: 2, index: 0 });
  });

  it("moves a workspace out of all groups", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    down(3, 80);
    move(3, 165);
    up(3, 165);
    expect(onDrop).toHaveBeenCalledWith(3, { groupId: null, index: 0 });
  });

  it("puts the row back on Escape, without letting the key reach the picker", () => {
    const onDrop = vi.fn();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(<Harness onDrop={onDrop} />);
    down(1, 20);
    move(1, 80);
    fireEvent.keyDown(grip(1), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    expect(state()).toBeNull();
    // The drag is over: releasing the pointer moves nothing.
    up(1, 80);
    expect(onDrop).not.toHaveBeenCalled();
    // Other keys pass while dragging.
    down(1, 20);
    fireEvent.keyDown(grip(1), { key: "a" });
    expect(outer).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", outer);
  });

  it("puts the row back on a pointer cancel", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    down(1, 20);
    move(1, 80);
    fireEvent.pointerCancel(grip(1), { pointerId: 7 });
    expect(state()).toBeNull();
    up(1, 80);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("moves nothing when released away from the list", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    down(1, 20);
    move(1, 80);
    expect(state().target).not.toBeNull();
    move(1, 5000);
    expect(state()).toEqual({ id: 1, target: null });
    up(1, 5000);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("hit-tests the list, not the larger element scrolling it, when they differ", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} split />);
    down(1, 20);
    move(1, 80);
    expect(state().target).toEqual({ groupId: 1, index: 1 });
    // Inside the scrolling element but well below the list: no target.
    move(1, 500);
    expect(state()).toEqual({ id: 1, target: null });
    up(1, 500);
    expect(onDrop).not.toHaveBeenCalled();
    down(4, 170);
    move(4, 130);
    up(4, 130);
    expect(onDrop).toHaveBeenCalledWith(4, { groupId: 2, index: 0 });
  });

  it("drops nothing on the part of the list scrolled out of its scroller's view", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} split />);
    // The scroller now starts at 100: the list's 0-100 is scrolled out of view.
    screen.getByTestId("scroll").dataset.top = "100";
    down(4, 170);
    move(4, 130);
    expect(state().target).toEqual({ groupId: 2, index: 0 });
    move(4, 40);
    expect(state()).toEqual({ id: 4, target: null });
    up(4, 40);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("treats a press without travel as a click, not a drop", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    down(1, 20);
    move(1, 22);
    expect(state()).toBeNull();
    up(1, 22);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("ignores another pointer, a secondary button, and a second press mid-drag", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    fireEvent.pointerDown(grip(1), { pointerId: 7, isPrimary: true, button: 2, clientY: 20 });
    move(1, 80);
    expect(state()).toBeNull();
    down(1, 20);
    fireEvent.pointerMove(grip(1), { pointerId: 9, clientY: 80 });
    expect(state()).toBeNull();
    fireEvent.pointerDown(grip(2), { pointerId: 9, isPrimary: true, button: 0, clientY: 50 });
    move(1, 80);
    up(1, 80);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(1, { groupId: 1, index: 1 });
  });

  it("scrolls the list while the pointer is near its edge", async () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const scroll = screen.getByTestId("scroll");
    scroll.dataset.top = "0";
    scroll.dataset.bottom = "200";
    let scrollTop = 0;
    Object.defineProperty(scroll, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = Math.max(0, Math.min(100, v));
      },
    });
    down(1, 20);
    move(1, 199);
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(scrollTop).toBeGreaterThan(0);
    up(1, 199);
    const after = scrollTop;
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(scrollTop).toBe(after);
  });
});
