import { useDashboardStore } from "../store/index.js";
import { dockUnavailableReason, type DockUnavailableReason } from "./dockAvailability.js";
import { useCoarsePointer, useLayoutTier } from "./layoutTier.js";

// Issue #1881 — the hook the palette and the Settings section read.
//
// It asks the shared predicate (dockAvailability.ts) for the tier the app is
// actually running at — `settings.layoutMode` can force it, and it is
// persisted across restarts — and for the pointer it has.
//
// The hook lives in its own module so `dockAvailability.ts` stays pure: a
// root-level check script imports that module to compare the predicate's
// reasons against the stylesheets, and importing React and the store into
// that script would break both its typecheck and its runtime.

export function useDockUnavailableReason(): DockUnavailableReason | null {
  const layoutMode = useDashboardStore((s) => s.settings.layoutMode);
  const tier = useLayoutTier(layoutMode);
  const coarsePointer = useCoarsePointer();
  return dockUnavailableReason(tier, coarsePointer);
}
