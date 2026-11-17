// #3214 — whether a pane group's header is hiding its own Split right / Split
// down buttons (PaneHeaderActions.tsx hides them when the header row is too
// narrow). The pane menu (PaneActionsMenu.tsx) lists the same two actions only
// while they are hidden there, so it reads the header's own measurement from
// here rather than applying a second width threshold of its own.
//
// Keyed by dockview group id. A group with no entry has no header measuring
// it (the header has not mounted yet, or there is no grid header), which reads
// as "hidden": the menu then keeps the split entries as the fallback, so the
// actions are never unreachable.
const hiddenByGroup = new Map<string, boolean>();

export function setHeaderSplitHidden(groupId: string, hidden: boolean): void {
  hiddenByGroup.set(groupId, hidden);
}

export function clearHeaderSplitHidden(groupId: string): void {
  hiddenByGroup.delete(groupId);
}

export function isHeaderSplitHidden(groupId: string | undefined): boolean {
  if (groupId === undefined) return true;
  return hiddenByGroup.get(groupId) ?? true;
}
