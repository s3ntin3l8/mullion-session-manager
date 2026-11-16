import { describe, it, expect } from "vitest";
import { columnsOfGroups, placePendingOpen } from "./panelUtils.js";
import type { GroupRect } from "./panelUtils.js";
import { terminalCellPx } from "./dock/dockHelpers.js";

// #3033 — the owner's placement rule for a session opened on the fold or the
// phone, applied by a desktop client. At the default 14px font a cell is
// 8.4 x 18.9 px, so the 80 x 20 floor is 672 x 378 px.
const metrics = terminalCellPx(14);

function rect(id: string, x: number, y: number, width: number, height: number): GroupRect {
  return { id, x, y, width, height };
}

function place(
  groups: GroupRect[],
  referenceGroupId: string | null = null,
  activeGroupId: string | null = null,
) {
  return placePendingOpen({ groups, referenceGroupId, activeGroupId, metrics });
}

describe("placePendingOpen", () => {
  it("adds nothing positional to an empty workspace (it becomes the single pane)", () => {
    expect(place([])).toBeNull();
  });

  it("opens to the right of a single pane", () => {
    expect(place([rect("a", 0, 0, 1600, 1000)])).toEqual({
      referenceGroup: "a",
      direction: "right",
    });
  });

  it("tabs onto a single pane too narrow to halve", () => {
    expect(place([rect("a", 0, 0, 1000, 1000)])).toEqual({ referenceGroup: "a", tab: true });
    // Its height does not matter for a split to the right.
    expect(place([rect("a", 0, 0, 1400, 200)])).toEqual({
      referenceGroup: "a",
      direction: "right",
    });
  });

  it("splits the reference pane's column below when there are two columns", () => {
    const groups = [rect("a", 0, 0, 800, 1000), rect("b", 800, 0, 800, 1000)];
    expect(place(groups, "b")).toEqual({ referenceGroup: "b", direction: "below" });
    expect(place(groups, "a")).toEqual({ referenceGroup: "a", direction: "below" });
  });

  it("splits the other column when the reference's column already has two rows", () => {
    const groups = [
      rect("a", 0, 0, 800, 1000),
      rect("b1", 800, 0, 800, 500),
      rect("b2", 800, 500, 800, 500),
    ];
    expect(place(groups, "b2")).toEqual({ referenceGroup: "a", direction: "below" });
  });

  it("tabs onto the reference pane at 2x2", () => {
    const groups = [
      rect("a1", 0, 0, 800, 500),
      rect("a2", 0, 500, 800, 500),
      rect("b1", 800, 0, 800, 500),
      rect("b2", 800, 500, 800, 500),
    ];
    expect(place(groups, "b1", "a2")).toEqual({ referenceGroup: "b1", tab: true });
    // No reference: the pane last active.
    expect(place(groups, null, "a2")).toEqual({ referenceGroup: "a2", tab: true });
  });

  it("fills three columns to 3x2, then tabs", () => {
    const three = [
      rect("a", 0, 0, 800, 1000),
      rect("b", 800, 0, 800, 1000),
      rect("c", 1600, 0, 800, 1000),
    ];
    expect(place(three, "c")).toEqual({ referenceGroup: "c", direction: "below" });
    const twoSplit = [
      rect("a1", 0, 0, 800, 500),
      rect("a2", 0, 500, 800, 500),
      rect("b", 800, 0, 800, 1000),
      rect("c1", 1600, 0, 800, 500),
      rect("c2", 1600, 500, 800, 500),
    ];
    expect(place(twoSplit, "c1")).toEqual({ referenceGroup: "b", direction: "below" });
    const full = [
      ...twoSplit.filter((g) => g.id !== "b"),
      rect("b1", 800, 0, 800, 500),
      rect("b2", 800, 500, 800, 500),
    ];
    expect(place(full, "c1")).toEqual({ referenceGroup: "c1", tab: true });
  });

  it("tabs when splitting a column would go under the size floor", () => {
    // 700 px tall: two rows of 350 px are under 20 rows (378 px).
    const groups = [rect("a", 0, 0, 800, 700), rect("b", 800, 0, 800, 700)];
    expect(place(groups, "a")).toEqual({ referenceGroup: "a", tab: true });
    // Only the halved axis counts: a column narrower than 80 cells (a 1440px
    // laptop with the sidebar open, ~550px columns) still splits below.
    const narrow = [rect("a", 0, 0, 550, 900), rect("b", 550, 0, 550, 900)];
    expect(place(narrow, "a")).toEqual({ referenceGroup: "a", direction: "below" });
  });

  it("splits the largest allowed pane without a reference", () => {
    const groups = [rect("a", 0, 0, 700, 1000), rect("b", 700, 0, 900, 1000)];
    expect(place(groups)).toEqual({ referenceGroup: "b", direction: "below" });
    // A reference that is no longer open counts as none.
    expect(place(groups, "gone")).toEqual({ referenceGroup: "b", direction: "below" });
  });

  it("counts leaf panes in a layout nested the other way", () => {
    // Two rows: the top one split into two columns, the bottom one full width.
    // That is one top-level column (the bottom pane straddles every line).
    const nested = [
      rect("t1", 0, 0, 800, 500),
      rect("t2", 800, 0, 800, 500),
      rect("bottom", 0, 500, 1600, 500),
    ];
    expect(columnsOfGroups(nested)).toHaveLength(1);
    // Three leaves, not fewer than 2 x 1 columns: a tab.
    expect(place(nested, "t2")).toEqual({ referenceGroup: "t2", tab: true });

    // Three columns, the right one nested (a row split side by side over a
    // full-width row): five leaves, fewer than 2 x 3, so the largest pane is
    // split below.
    const nestedColumns = [
      rect("a", 0, 0, 800, 1000),
      rect("b", 800, 0, 700, 1000),
      rect("c1", 1500, 0, 400, 500),
      rect("c2", 1900, 0, 400, 500),
      rect("c3", 1500, 500, 800, 500),
    ];
    expect(columnsOfGroups(nestedColumns)).toHaveLength(3);
    expect(place(nestedColumns, "c1")).toEqual({ referenceGroup: "a", direction: "below" });
    // Six leaves (2 x 3): a tab on the reference pane.
    const sixLeaves = [
      ...nestedColumns.filter((g) => g.id !== "b"),
      rect("b1", 800, 0, 700, 500),
      rect("b2", 800, 500, 700, 500),
    ];
    expect(place(sixLeaves, "c1")).toEqual({ referenceGroup: "c1", tab: true });
  });
});

describe("terminalCellPx", () => {
  it("scales the measured 14px cell with the font size", () => {
    expect(terminalCellPx(14)).toEqual({ cellWidth: 8.4, cellHeight: 18.9 });
    expect(terminalCellPx(28).cellWidth).toBeCloseTo(16.8);
  });
});
