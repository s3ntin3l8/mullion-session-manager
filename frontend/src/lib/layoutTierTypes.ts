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
