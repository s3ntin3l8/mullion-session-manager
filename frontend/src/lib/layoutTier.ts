import { useEffect, useState } from "react";
import type { LayoutMode } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import type { LayoutBand, LayoutTier } from "./layoutTierTypes.js";

// Re-exported so the many `import type { LayoutTier } from "./lib/layoutTier.js"`
// call sites keep working; the definition itself lives in layoutTierTypes.ts,
// which has no imports, so a pure consumer can take the type without
// dragging this module's React and store graph in behind it.
export type { LayoutTier, LayoutBand };

// Single home for tier/breakpoint logic (previously three separate literal
// copies of "(max-width: 699px)" — panels/registry.tsx, panelUtils.ts,
// BrowserPanel.tsx — two of which carried stale comments claiming App.tsx
// owned its own copy). Tablet tier plan (.claude/plans/another-thing-to-
// investigate-lively-kitten.md, PR 4).
//
// Three widths, not two: phone/tablet/desktop. Tablet is deliberately NOT
// just a relabeled desktop — it gets a real, different layout policy (a
// grid capped at a user-configurable pane count, see panelUtils.ts's
// tabletPositioning) rather than either phone's single maximized pane or
// desktop's unbounded columns.
// Independent review — `.98px` upper bounds, not bare integers: adjacent
// `max-width: 699px` / `min-width: 700px` queries leave a live gap at any
// fractional CSS width in (699, 700) — routine under non-100% browser zoom
// or a non-integer devicePixelRatio, and exactly the kind of odd metric
// this tier's own "foldable reporting ambiguous width" motivating case
// makes plausible. Neither query matches there, so resolveLayoutTier falls
// through to its final `return "desktop"` — silently skipping tablet
// entirely — and useLayoutTier's own boundary listeners (only the phone
// and desktop MQLs) never fire for a resize that lands in that gap either,
// so it doesn't even self-correct on a later, unambiguous resize in the
// same direction. `.98px` shrinks the gap by 100x versus a bare integer,
// well under the sub-pixel precision browsers actually round CSS widths
// to, without changing the intended breakpoints.
export const PHONE_BREAKPOINT_QUERY = "(max-width: 699.98px)";
export const TABLET_BREAKPOINT_QUERY = "(min-width: 700px) and (max-width: 1279.98px)";
export const DESKTOP_BREAKPOINT_QUERY = "(min-width: 1280px)";
// Below this width a docked right sidebar would leave the workspace less than
// about 400px, so an open view covers the workspace instead (#3006). Kept
// here with the tier breakpoints so the 800px floor cannot drift from them.
export const RIGHT_SIDEBAR_FULL_WIDTH_QUERY = "(max-width: 799.98px)";

// The five bands (design section 9.1) refine the three tiers above: phone and
// desktop reuse their queries, tablet splits at 800 and 1100. The 800 edge
// is design section 9.1/7's "narrower than roughly 800px", so a full-width
// right sidebar query of "(max-width: 799.98px)" lines up with it. A band says nothing about the pointer: see
// COARSE_POINTER_QUERY below, which varies independently of it.
export const RAILS_FULL_BAND_QUERY = "(min-width: 700px) and (max-width: 799.98px)";
export const RAILS_HALVES_BAND_QUERY = "(min-width: 800px) and (max-width: 1099.98px)";
export const DESKTOP_NARROW_BAND_QUERY = "(min-width: 1100px) and (max-width: 1279.98px)";

// Touch affordances (key bar, tab-strip panning, 44px hit targets) are
// gated on pointer coarseness, NOT layout tier — a touchscreen laptop at
// desktop width still has a coarse pointer, and (the motivating case for
// this whole plan) a folding phone unfolds into tablet-width territory
// while staying touch-only throughout. Matches how dockview itself already
// classifies input (`isCoarsePrimaryInput`, dockview.js: `coarse && !fine`),
// so the two libraries stop disagreeing about the same hardware.
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

// Live-subscribed pointer-coarseness check, for gating touch affordances
// (App.tsx's key bar, its `.key-bar` className) independently of layoutTier
// above. A device's primary pointer type essentially never changes at
// runtime, but this still subscribes to `change` rather than reading once —
// consistent with useLayoutTier, and covers a 2-in-1 laptop's
// keyboard-attach transition or a devtools pointer-emulation toggle during
// development.
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => window.matchMedia(COARSE_POINTER_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(COARSE_POINTER_QUERY);
    const onChange = () => setCoarse(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

// "Compact" = phone OR tablet: the tiers where the sidebar is a floating
// overlay (not docked) and the phone-era navigation affordances (navigator,
// session picker, back stack) apply. Prefer this over a bare
// `tier !== "desktop"` so the intent is greppable.
export function isCompactTier(tier: LayoutTier): boolean {
  return tier !== "desktop";
}

// Pure, synchronous, DOM-reading resolution — no React dependency, so
// call sites that just need a one-off snapshot (e.g. a live matchMedia()
// check at click time — the pattern the pre-tablet-tier codebase's own
// MOBILE_BREAKPOINT_QUERY reads used before this module existed) don't
// need to mount a hook.
export function resolveLayoutTier(layoutMode: LayoutMode): LayoutTier {
  if (layoutMode !== "auto") return layoutMode;
  if (window.matchMedia(PHONE_BREAKPOINT_QUERY).matches) return "phone";
  if (window.matchMedia(TABLET_BREAKPOINT_QUERY).matches) return "tablet";
  return "desktop";
}

// Live-subscribed variant for components that need to re-render across a
// breakpoint crossing (or a layoutMode setting change). Listens on the
// phone/desktop boundary queries rather than tablet's own compound one —
// tablet is "neither of the other two," so a change on either boundary is
// exactly the set of events that can flip the resolved tier. Skips
// subscribing entirely once layoutMode is an explicit override: an
// override's resolved tier can only change via its own value (already a
// dependency), not via window width.
export function useLayoutTier(layoutMode: LayoutMode): LayoutTier {
  const [tier, setTier] = useState(() => resolveLayoutTier(layoutMode));

  useEffect(() => {
    // Re-syncs the tier when `layoutMode` itself changes (the `useState`
    // initializer above only ever runs once, at mount) — same
    // matchMedia-driven resync shape this repo's react-hooks/set-state-in-effect
    // rule flags elsewhere (App.tsx, useSessionDeepLink.ts, Sidebar.tsx),
    // and the same reasoning applies: this synchronizes React state with an
    // external system's current value (the live width/pointer query),
    // which is exactly what the rule's own guidance carves out as fine.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTier(resolveLayoutTier(layoutMode));
    if (layoutMode !== "auto") return;

    const phone = window.matchMedia(PHONE_BREAKPOINT_QUERY);
    const desktop = window.matchMedia(DESKTOP_BREAKPOINT_QUERY);
    const recompute = () => setTier(resolveLayoutTier(layoutMode));
    phone.addEventListener("change", recompute);
    desktop.addEventListener("change", recompute);
    return () => {
      phone.removeEventListener("change", recompute);
      desktop.removeEventListener("change", recompute);
    };
  }, [layoutMode]);

  return tier;
}

// What the panel openers need to place a panel (panelUtils.ts's
// positioningForTier) — an object, so adding a layout input later does not
// touch every call site's argument list. The tablet pane cap setting it used
// to carry is gone (#3010): the band decides.
export interface LayoutContext {
  tier: LayoutTier;
}

// Reads both settings this app's layout logic currently needs from the
// store and resolves the live tier from them in one call — the common case
// at every open-or-focus call site that has store access (panels/
// registry.tsx, PaneActionsMenu.tsx, usePanelOpener.ts). Components that
// need the resolved tier for something else (e.g. a `key-bar` className)
// can still call useLayoutTier directly instead.
export function useLayoutContext(): LayoutContext {
  const layoutMode = useDashboardStore((s) => s.settings.layoutMode);
  const tier = useLayoutTier(layoutMode);
  return { tier };
}

// An explicit layoutMode override has no real width, so it maps to the band
// that behaves like today's forced tier: tablet is the two-halves rails layout.
const OVERRIDE_BAND: Record<LayoutTier, LayoutBand> = {
  phone: "phone",
  tablet: "rails-halves",
  desktop: "desktop",
};

// Pure counterpart of resolveLayoutTier for the five bands. Falls through to
// "desktop" like resolveLayoutTier does.
export function resolveLayoutBand(layoutMode: LayoutMode): LayoutBand {
  if (layoutMode !== "auto") return OVERRIDE_BAND[layoutMode];
  if (window.matchMedia(PHONE_BREAKPOINT_QUERY).matches) return "phone";
  if (window.matchMedia(RAILS_FULL_BAND_QUERY).matches) return "rails-full";
  if (window.matchMedia(RAILS_HALVES_BAND_QUERY).matches) return "rails-halves";
  if (window.matchMedia(DESKTOP_NARROW_BAND_QUERY).matches) return "desktop-narrow";
  return "desktop";
}

export const BAND_BOUNDARY_QUERIES = [
  PHONE_BREAKPOINT_QUERY,
  RAILS_FULL_BAND_QUERY,
  RAILS_HALVES_BAND_QUERY,
  DESKTOP_NARROW_BAND_QUERY,
];

// Live-subscribed band, the five-way sibling of useLayoutTier. Listens on
// the queries resolveLayoutBand reads (the desktop band is the fall-through).
export function useLayoutBand(layoutMode: LayoutMode): LayoutBand {
  const [band, setBand] = useState(() => resolveLayoutBand(layoutMode));

  useEffect(() => {
    // Same external-system resync as useLayoutTier above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBand(resolveLayoutBand(layoutMode));
    if (layoutMode !== "auto") return;

    const recompute = () => setBand(resolveLayoutBand(layoutMode));
    const lists = BAND_BOUNDARY_QUERIES.map((q) => window.matchMedia(q));
    for (const mq of lists) mq.addEventListener("change", recompute);
    return () => {
      for (const mq of lists) mq.removeEventListener("change", recompute);
    };
  }, [layoutMode]);

  return band;
}

/**
 * How the grid is presented (#3010): the phone shows one pane, the two-halves
 * band (800-1099px) shows one grid pane per half on the left with the right
 * half beside it, every other width shows the grid. Both one-pane
 * presentations are a device-local view of the workspace: saves are
 * suspended while either is on screen (useWorkspacePersistence).
 */
export type LayoutPresentation = "phone" | "halves" | "grid";

export function resolveLayoutPresentation(layoutMode: LayoutMode): LayoutPresentation {
  if (resolveLayoutTier(layoutMode) === "phone") return "phone";
  return resolveLayoutBand(layoutMode) === "rails-halves" ? "halves" : "grid";
}
