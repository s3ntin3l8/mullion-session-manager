// Which layout bands a right-sidebar view exists in (Tasks mode redesign,
// #3012). Browser and Dock are right-rail views only on the rails layouts
// (700 to 1099.98px): there the screen is a session beside its companions.
// From 1100px the browser is a grid pane and the Dock the bottom panel, as
// they always were, so the two views are not registered there.
//
// `bands` on a registry entry is the declarative record (a surface that
// cannot call a hook per entry, like the phone's "more" sheet, reads it);
// `useEnabledInBands` is the rail's hook form of the same rule.
import { useLayoutBand } from "../lib/layoutTier.js";
import type { LayoutBand } from "../lib/layoutTierTypes.js";
import { useDashboardStore } from "../store/index.js";

export const RAILS_BANDS: readonly LayoutBand[] = ["rails-full", "rails-halves"];

export function viewInBand(view: { bands?: readonly LayoutBand[] }, band: LayoutBand): boolean {
  return view.bands === undefined || view.bands.includes(band);
}

/** The live layout band, from the user's layout-mode setting. */
export function useCurrentLayoutBand(): LayoutBand {
  return useLayoutBand(useDashboardStore((s) => s.settings.layoutMode));
}

/** `useEnabled` for a view that exists only in the rails bands. */
export function useEnabledInRailsBands(): boolean {
  return viewInBand({ bands: RAILS_BANDS }, useCurrentLayoutBand());
}
