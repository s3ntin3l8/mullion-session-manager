// Which layout bands a right-sidebar view exists in (Tasks mode redesign,
// #3012). Browser and Dock are right-sidebar views below 1100px: on the rails
// layouts (700 to 1099.98px) the screen is a session beside its companions,
// and on the phone the "more" sheet lists what the rail lists (design 9.4),
// each opening full screen. From 1100px the browser is a grid pane and the
// Dock the bottom panel, as they always were, so the two views are not
// registered there.
//
// `bands` on a registry entry is the declarative record (the panel reads it
// to close a view the current band has no place for);
// `useEnabledInCompanionBands` is the hook form of the same rule, which the
// rail and the phone's "more" sheet call through the entry's `useEnabled`.
import { useLayoutBand } from "../lib/layoutTier.js";
import type { LayoutBand } from "../lib/layoutTierTypes.js";
import { useDashboardStore } from "../store/index.js";

export const RAILS_BANDS: readonly LayoutBand[] = ["rails-full", "rails-halves"];

/** Where Browser and Dock are views: the phone and the rails bands. */
export const COMPANION_BANDS: readonly LayoutBand[] = ["phone", ...RAILS_BANDS];

export function viewInBand(view: { bands?: readonly LayoutBand[] }, band: LayoutBand): boolean {
  return view.bands === undefined || view.bands.includes(band);
}

/** The live layout band, from the user's layout-mode setting. */
export function useCurrentLayoutBand(): LayoutBand {
  return useLayoutBand(useDashboardStore((s) => s.settings.layoutMode));
}

/** `useEnabled` for a view that exists only in the companion bands. */
export function useEnabledInCompanionBands(): boolean {
  return viewInBand({ bands: COMPANION_BANDS }, useCurrentLayoutBand());
}
