import type { LayoutTier } from "./layoutTierTypes.js";

// Issue #1881 — why the Dock cannot be shown on this device.
//
// The Dock is hidden by TWO rules, and they are not the same rule:
//
//   - `styles/tablet.css` hides `.dock` under `@media (pointer: coarse)`;
//   - `styles/mobile.css` hides it under the phone tier.
//
// So the pointer alone is NOT the whole predicate: a phone-tier window with a
// fine pointer — a narrow window, or `settings.layoutMode: "phone"` — is
// hidden by the second rule alone, and a wording that only asked about the
// pointer would claim the Dock was available there.
//
// This module is the one place that decides, so the palette's wording, the
// Settings section's note, and any future surface cannot disagree with each
// other. `Dock.tsx` gates its own groups on the same predicate.
//
// PURE ON PURPOSE: this module imports nothing but a type, so
// `scripts/check-dock-availability.ts` — a root-level node script — can
// import the predicate and compare its reasons against the stylesheets that
// hide the Dock. A vitest file cannot do that (vitest stubs CSS imports, so
// `?raw` resolves to an empty string; see check-token-contrast.mjs's header
// comment for the same reasoning), and a check script cannot import a
// module that drags React and the store in behind it. The hook lives next
// door, in useDockUnavailableReason.ts.

export type DockUnavailableReason = "phone-tier" | "coarse-pointer";

// The pure predicate — the tier the app is running at, and whether the
// primary pointer is coarse.
export function dockUnavailableReason(
  tier: LayoutTier,
  coarsePointer: boolean,
): DockUnavailableReason | null {
  if (tier === "phone") return "phone-tier";
  if (coarsePointer) return "coarse-pointer";
  return null;
}

// What each surface says. `short` is the label the palette's row carries (it
// sits beside the title, where there is no room for a sentence); `text` is
// the full reason, which the Settings section opens its note with and the
// palette keeps for assistive technology.
//
// The coarse-pointer reason names the PRIMARY pointer, because that is what
// `(pointer: coarse)` means — plugging a mouse into a touchscreen laptop
// leaves the primary pointer coarse, so "until you use a mouse" would promise
// something the CSS does not deliver.
export const DOCK_UNAVAILABLE: Record<DockUnavailableReason, { short: string; text: string }> = {
  "phone-tier": {
    short: "Not shown here",
    text: "the Dock is hidden on the phone layout",
  },
  "coarse-pointer": {
    short: "Not shown here",
    text: "the Dock is hidden while touch is the primary pointer",
  },
};
