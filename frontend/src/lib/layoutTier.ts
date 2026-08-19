import { useEffect, useState } from "react";
import type { LayoutMode, TabletPaneCap } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

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

export type LayoutTier = "phone" | "tablet" | "desktop";

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

// The tier PLUS the settings the tablet-tier capped-grid policy needs
// (panelUtils.ts's tabletPositioning/positioningForTier) — bundled into one
// param object so a caller passing this through a panel-opener function
// doesn't need two positional args, and adding a future layout-relevant
// setting doesn't touch every call site's argument list again.
export interface LayoutContext {
  tier: LayoutTier;
  tabletPaneCap: TabletPaneCap;
}

// Reads both settings this app's layout logic currently needs from the
// store and resolves the live tier from them in one call — the common case
// at every open-or-focus call site that has store access (panels/
// registry.tsx, PaneActionsMenu.tsx, usePanelOpener.ts). Components that
// need the resolved tier for something else (e.g. a `key-bar` className)
// can still call useLayoutTier directly instead.
export function useLayoutContext(): LayoutContext {
  const layoutMode = useDashboardStore((s) => s.settings.layoutMode);
  const tabletPaneCap = useDashboardStore((s) => s.settings.tabletPaneCap);
  const tier = useLayoutTier(layoutMode);
  return { tier, tabletPaneCap };
}
