// Pure reorder/reindex math for drag-and-drop in WorkspaceSwitcher.tsx —
// deliberately free of React/DOM so it's directly unit-testable. Native
// HTML5 drag-and-drop is exactly the kind of interaction this project's own
// browser-automation tooling has repeatedly struggled to drive reliably
// (see the plan's Phase 4b/4c synthetic-event notes), so correctness here
// should not depend solely on live-browser verification.
//
// `position` (both `workspaces.position` and `groups.position` in
// src/db/schema.ts) is a plain integer with no DB-level uniqueness or
// ordering guarantee — every row defaults to 0 and is never reindexed by
// the backend. Ordering is entirely interpreted client-side from whatever
// order is actually rendered, so this module is the one place that
// interpretation has to stay consistent: both the drop target's bucket and
// (if different) the dragged item's previous bucket get reindexed to a
// contiguous 0..n-1 range.

export interface ReorderItem {
  id: number;
  // `null` for ungrouped workspaces. Groups themselves have no bucket
  // concept of their own — see computeGroupReorder below, which reuses
  // this same function with a single synthetic bucket.
  groupId: number | null;
  position: number;
}

export interface ReorderUpdate {
  id: number;
  groupId: number | null;
  position: number;
}

// Given the full flat set of items (each tagged with its current bucket
// `groupId` and its current `position` within that bucket) plus a drag
// operation — move `draggedId` into bucket `targetGroupId` at
// `targetIndex` — compute the minimal set of {id, groupId, position}
// updates needed to realize the new order. Only entries whose `groupId` or
// `position` actually changed are returned, so the caller can batch exactly
// that many PATCH requests rather than one per row regardless of whether
// it moved.
export function computeReorder(
  items: ReorderItem[],
  draggedId: number,
  targetIndex: number,
  targetGroupId: number | null,
): ReorderUpdate[] {
  const dragged = items.find((i) => i.id === draggedId);
  if (!dragged) return [];

  const sourceGroupId = dragged.groupId;

  const bucketOf = (groupId: number | null) =>
    items
      .filter((i) => i.id !== draggedId && i.groupId === groupId)
      .sort((a, b) => a.position - b.position);

  const targetBucket = bucketOf(targetGroupId);
  const clampedIndex = Math.max(0, Math.min(targetIndex, targetBucket.length));
  targetBucket.splice(clampedIndex, 0, dragged);

  const updates: ReorderUpdate[] = [];
  const applyBucket = (bucket: ReorderItem[], groupId: number | null) => {
    bucket.forEach((item, index) => {
      if (item.groupId !== groupId || item.position !== index) {
        updates.push({ id: item.id, groupId, position: index });
      }
    });
  };

  applyBucket(targetBucket, targetGroupId);
  if (sourceGroupId !== targetGroupId) {
    applyBucket(bucketOf(sourceGroupId), sourceGroupId);
  }

  return updates;
}

export interface PositionedItem {
  id: number;
  position: number;
}

export interface PositionUpdate {
  id: number;
  position: number;
}

// Groups have no bucket of their own (there's no "group of groups") — this
// reuses computeReorder with every group mapped into one synthetic bucket
// (groupId: 0) so the same reindexing logic applies to a flat top-level
// reorder, then strips the synthetic `groupId` back out of the result since
// `PATCH /api/groups/:id` only has a `position` field, not `groupId`.
export function computeGroupReorder(
  groups: PositionedItem[],
  draggedId: number,
  targetIndex: number,
): PositionUpdate[] {
  const SINGLE_BUCKET = 0;
  const asBucketItems: ReorderItem[] = groups.map((g) => ({
    id: g.id,
    groupId: SINGLE_BUCKET,
    position: g.position,
  }));
  return computeReorder(asBucketItems, draggedId, targetIndex, SINGLE_BUCKET).map(
    ({ id, position }) => ({
      id,
      position,
    }),
  );
}
