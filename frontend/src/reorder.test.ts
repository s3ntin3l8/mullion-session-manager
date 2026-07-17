import { describe, it, expect } from "vitest";
import { computeReorder } from "./reorder.js";
import type { ReorderItem } from "./reorder.js";

describe("computeReorder", () => {
  it("reorders within the same (ungrouped) bucket", () => {
    // ids 1,2,3 ungrouped at positions 0,1,2 — drag id 3 to index 0.
    const items: ReorderItem[] = [
      { id: 1, groupId: null, position: 0 },
      { id: 2, groupId: null, position: 1 },
      { id: 3, groupId: null, position: 2 },
    ];
    const updates = computeReorder(items, 3, 0, null);
    // New order should be 3,1,2 — only rows whose position actually
    // changed are returned (id 3: 2->0, id 1: 0->1, id 2: 1->2).
    const byId = Object.fromEntries(updates.map((u) => [u.id, u]));
    expect(byId[3]).toEqual({ id: 3, groupId: null, position: 0 });
    expect(byId[1]).toEqual({ id: 1, groupId: null, position: 1 });
    expect(byId[2]).toEqual({ id: 2, groupId: null, position: 2 });
    expect(updates).toHaveLength(3);
  });

  it("is a no-op when dropped back at its own position", () => {
    const items: ReorderItem[] = [
      { id: 1, groupId: null, position: 0 },
      { id: 2, groupId: null, position: 1 },
    ];
    // Removing id 1 leaves [2] at index 0; reinserting id 1 at index 0
    // restores the exact original order — nothing actually changed.
    expect(computeReorder(items, 1, 0, null)).toEqual([]);
  });

  it("moves a workspace from ungrouped into a group at a given index", () => {
    const items: ReorderItem[] = [
      { id: 1, groupId: null, position: 0 }, // dragged
      { id: 2, groupId: 10, position: 0 },
      { id: 3, groupId: 10, position: 1 },
    ];
    const updates = computeReorder(items, 1, 1, 10);
    const byId = Object.fromEntries(updates.map((u) => [u.id, u]));
    // Target bucket (group 10) becomes [2, 1, 3] -> positions 0,1,2.
    expect(byId[1]).toEqual({ id: 1, groupId: 10, position: 1 });
    expect(byId[3]).toEqual({ id: 3, groupId: 10, position: 2 });
    // id 2 stays at position 0 in group 10 — unchanged, not returned.
    expect(byId[2]).toBeUndefined();
    // Source bucket (ungrouped) had only the dragged item — nothing left
    // to reindex there.
    expect(updates).toHaveLength(2);
  });

  it("moves a workspace between two different groups", () => {
    const items: ReorderItem[] = [
      { id: 1, groupId: 10, position: 0 }, // dragged
      { id: 2, groupId: 10, position: 1 },
      { id: 3, groupId: 20, position: 0 },
    ];
    const updates = computeReorder(items, 1, 0, 20);
    const byId = Object.fromEntries(updates.map((u) => [u.id, u]));
    // Target bucket (group 20) becomes [1, 3] -> id 3 shifts to position 1.
    expect(byId[1]).toEqual({ id: 1, groupId: 20, position: 0 });
    expect(byId[3]).toEqual({ id: 3, groupId: 20, position: 1 });
    // Source bucket (group 10) loses id 1, id 2 reindexes from 1 -> 0.
    expect(byId[2]).toEqual({ id: 2, groupId: 10, position: 0 });
    expect(updates).toHaveLength(3);
  });

  it("clamps an out-of-range target index to the end of the bucket", () => {
    const items: ReorderItem[] = [
      { id: 1, groupId: null, position: 0 },
      { id: 2, groupId: null, position: 1 }, // dragged
    ];
    const updates = computeReorder(items, 2, 999, null);
    // Already at the end — dropping past the end is a no-op.
    expect(updates).toEqual([]);
  });

  it("returns [] when the dragged id isn't in the list", () => {
    const items: ReorderItem[] = [{ id: 1, groupId: null, position: 0 }];
    expect(computeReorder(items, 999, 0, null)).toEqual([]);
  });
});
