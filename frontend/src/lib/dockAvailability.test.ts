import { describe, expect, it } from "vitest";
import { DOCK_UNAVAILABLE, dockUnavailableReason } from "./dockAvailability.js";
import type { LayoutTier } from "./layoutTierTypes.js";

// Issue #1881 — the Dock's availability, and the wording that says so.
//
// The predicate is small; what matters is that it agrees with the CSS that
// hides the Dock. The Dock is hidden by two rules — a coarse pointer and the
// phone tier — and a phone-tier window with a FINE pointer (a narrow window,
// or `settings.layoutMode: "phone"`) is hidden by the second rule alone. A
// predicate that only asked about the pointer would claim the Dock was
// available there, and the palette would promise a panel the user cannot see.
//
// The CSS↔predicate parity itself is NOT checked here: vitest stubs CSS
// imports (`css: false` in frontend/vitest.config.ts), so a test cannot read
// a stylesheet's text. It lives in `scripts/check-dock-availability.ts`,
// wired into `npm run lint`, which imports this very predicate so the two
// cannot drift apart.

describe("dockUnavailableReason", () => {
  it("reports nothing when the Dock can be shown", () => {
    expect(dockUnavailableReason("desktop", false)).toBeNull();
    expect(dockUnavailableReason("tablet", false)).toBeNull();
  });

  it("reports the coarse pointer for a touch-only device", () => {
    expect(dockUnavailableReason("desktop", true)).toBe("coarse-pointer");
    expect(dockUnavailableReason("tablet", true)).toBe("coarse-pointer");
  });

  // A phone-tier window with a fine pointer is hidden by mobile.css's
  // phone-tier rule, so the pointer alone is not the predicate.
  it("reports the phone tier even with a fine pointer", () => {
    expect(dockUnavailableReason("phone", false)).toBe("phone-tier");
    expect(dockUnavailableReason("phone", true)).toBe("phone-tier");
  });

  // The set of reasons is what the check script compares against the
  // stylesheets, so it is pinned here too: a new reason has to come with a
  // hiding rule, and this is where that shows up first.
  it("covers exactly the two conditions the stylesheets hide the Dock under", () => {
    const reasons = new Set(
      (["phone", "tablet", "desktop"] as LayoutTier[]).flatMap((tier) =>
        [false, true].map((coarse) => dockUnavailableReason(tier, coarse)),
      ),
    );
    expect([...reasons].filter(Boolean).sort()).toEqual(["coarse-pointer", "phone-tier"]);
  });
});

describe("DOCK_UNAVAILABLE", () => {
  it("has wording for every reason the predicate can return", () => {
    const reasons = new Set(
      (["phone", "tablet", "desktop"] as LayoutTier[]).flatMap((tier) =>
        [false, true].map((coarse) => dockUnavailableReason(tier, coarse)),
      ),
    );
    for (const reason of reasons) {
      if (!reason) continue;
      expect(DOCK_UNAVAILABLE[reason]?.short).toBeTruthy();
      expect(DOCK_UNAVAILABLE[reason]?.text).toBeTruthy();
    }
  });

  // The coarse-pointer reason names the PRIMARY pointer, because that is
  // what `(pointer: coarse)` means — plugging a mouse into a touchscreen
  // laptop leaves the primary pointer coarse, so promising the Dock would
  // come back "until you use a mouse" would promise something the CSS does
  // not deliver.
  it("does not promise a mouse brings the Dock back on a coarse pointer", () => {
    expect(DOCK_UNAVAILABLE["coarse-pointer"].text).not.toMatch(/mouse|trackpad/i);
  });
});
