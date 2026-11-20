// The layout tier's own names, in a module with no imports.
//
// `layoutTier.ts` is runtime code — React hooks and the store — so anything
// that needs only the TYPE of a tier would otherwise pull that whole graph
// in behind it. That matters for `dockAvailability.ts`'s pure predicate
// (issue #1881), which a root-level check script imports to compare the
// predicate's reasons against the stylesheets that hide the Dock: importing
// the tier type from `layoutTier.ts` would drag React and the store into
// that script's typecheck and its runtime.
//
// `layoutTier.ts` re-exports this type, so every existing
// `import type { LayoutTier } from "./lib/layoutTier.js"` keeps working —
// only the definition moved.
export type LayoutTier = "phone" | "tablet" | "desktop";

// The finer, five-way split of the width (Tasks mode redesign, design
// section 9.1). `LayoutTier` above stays the coarse three-way answer every
// existing consumer reads; the band is a separate value for the slices that
// need to tell a narrow tablet from a foldable's two-halves width.
//   phone          under 700
//   rails-full     700 to 799.98: rails, an open view takes the full width
//   rails-halves   800 to 1099.98: rails, two halves side by side
//   desktop-narrow 1100 to 1279.98: desktop structure, left sidebar collapsed
//   desktop        1280 and up
export type LayoutBand = "phone" | "rails-full" | "rails-halves" | "desktop-narrow" | "desktop";
