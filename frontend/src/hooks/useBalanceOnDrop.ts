import { useEffect } from "react";
import type { DockviewApi } from "dockview";
import { balanceSiblingsOf, isTiledGroup } from "../panelUtils.js";

interface UseBalanceOnDropParams {
  dockviewApi: DockviewApi | null;
  enabled: boolean;
}

// After a user drag docks a panel into the grid, even out the row or column it
// landed in (settings.balancePanesOnDrop). dockview's own drop sizing halves
// only the target group — 50/25/25 for a third pane — where the split button
// distributes evenly; see balanceSiblingsOf (panelUtils.ts) for the why.
//
// Detects a dock by diffing the tiled group ids across a user-origin "move"
// mutation: a drop into a tab strip adds no tiled group, so it's left alone,
// as is an API-origin move (e.g. this app's own `moveTo` menu actions) and
// every other mutation kind. Exactly one new tiled group is the drop; any
// other count means something else is going on, so it does nothing.
export function useBalanceOnDrop({ dockviewApi, enabled }: UseBalanceOnDropParams): void {
  useEffect(() => {
    if (!dockviewApi || !enabled) return;
    let before: Set<string> | null = null;
    const tiledIds = () =>
      new Set(dockviewApi.groups.filter(isTiledGroup).map((group) => group.id));
    const will = dockviewApi.onWillMutateLayout((event) => {
      before = event.kind === "move" && event.origin === "user" ? tiledIds() : null;
    });
    const did = dockviewApi.onDidMutateLayout((event) => {
      const snapshot = before;
      before = null;
      if (!snapshot || event.kind !== "move" || event.origin !== "user") return;
      const added = [...tiledIds()].filter((id) => !snapshot.has(id));
      if (added.length === 1) balanceSiblingsOf(dockviewApi, added[0]!);
    });
    return () => {
      will.dispose();
      did.dispose();
    };
  }, [dockviewApi, enabled]);
}
