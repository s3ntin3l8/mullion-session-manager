/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseSidebarOpenTierResetParams {
  compact: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
}

export function useSidebarOpenTierReset({
  compact,
  setSidebarOpen,
}: UseSidebarOpenTierResetParams): void {
  // Review finding — without this, resizing from tablet (drawer open) to
  // desktop and back re-opened the drawer unbidden: `sidebarOpen` has no
  // other tier-transition reset, so it just carried the stale `true` back
  // across the boundary. The overlay CSS only reads `sb-open` on the phone
  // and tablet tiers, so this was a surprising re-open on
  // tier reversion, not a desktop-side visual bug. Direct setState is
  // genuinely needed here (canceling in response to an externally-driven
  // `layoutTier` change, not a pure render-time derivation) — same shape as
  // MobileSessionBar.tsx's rename-cancel effect.
  useEffect(() => {
    // Synchronous setSidebarOpen on a tier change, same as App.tsx. That
    // file suppressed react-hooks/set-state-in-effect on this line because
    // the reset is a response to layoutTier, not a derived render. The
    // setter is a parameter here, so the rule does not flag it and the
    // directive is not repeated (an unused one fails lint).
    if (!compact) setSidebarOpen(false);
  }, [compact]);
}
