// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  PHONE_BREAKPOINT_QUERY,
  TABLET_BREAKPOINT_QUERY,
  DESKTOP_BREAKPOINT_QUERY,
  COARSE_POINTER_QUERY,
  isCompactTier,
  resolveLayoutTier,
  useLayoutTier,
  useCoarsePointer,
  useLayoutContext,
  resolveLayoutBand,
  useLayoutBand,
} from "./layoutTier.js";
import type { LayoutBand, LayoutTier } from "./layoutTier.js";

// Mirrors PaneActionsMenu.test.tsx's own store-mock shape (a `storeState()`
// factory the mock module calls fresh on every selector invocation) — lets
// each test mutate `mockSettings` before rendering, without vi.mock's
// hoisted factory needing to close over anything declared later in the
// file.
let mockSettings: { layoutMode: "auto" | LayoutTier; tabletPaneCap: 2 | 3 } = {
  layoutMode: "auto",
  tabletPaneCap: 2,
};

function storeState() {
  return { settings: mockSettings };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector: (s: unknown) => unknown) => selector(storeState());
  return { useDashboardStore };
});

// A real EventTarget (not a bare vi.fn() no-op) so `change` subscription and
// cleanup are actually observable — same pattern useLayoutPresentation.test.ts
// and useMobileLayout.test.ts (pre-tablet-tier) already established.
class FakeMediaQueryList extends EventTarget {
  matches: boolean;
  media: string;
  constructor(media: string, matches: boolean) {
    super();
    this.media = media;
    this.matches = matches;
  }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    super.addEventListener(type, listener);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    super.removeEventListener(type, listener);
  }
}

function stubBreakpointMedia(initialTier: LayoutTier) {
  const phone = new FakeMediaQueryList(PHONE_BREAKPOINT_QUERY, initialTier === "phone");
  const tablet = new FakeMediaQueryList(TABLET_BREAKPOINT_QUERY, initialTier === "tablet");
  const desktop = new FakeMediaQueryList(DESKTOP_BREAKPOINT_QUERY, initialTier === "desktop");
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      if (query === PHONE_BREAKPOINT_QUERY) return phone;
      if (query === TABLET_BREAKPOINT_QUERY) return tablet;
      if (query === DESKTOP_BREAKPOINT_QUERY) return desktop;
      throw new Error(`unexpected matchMedia query in test: ${query}`);
    }),
  );
  return {
    phone,
    tablet,
    desktop,
    setTier: (tier: LayoutTier) => {
      phone.matches = tier === "phone";
      tablet.matches = tier === "tablet";
      desktop.matches = tier === "desktop";
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Independent review — jsdom's matchMedia never evaluates real CSS (every
// test in this file mocks it), so this can't exercise actual browser-side
// query evaluation. What it CAN pin: the query strings themselves use a
// `.98px` upper bound rather than a bare integer, so a future edit can't
// silently reintroduce the adjacent-integer gap at the phone/tablet and
// tablet/desktop seams (any fractional width in that gap — routine under
// non-100% browser zoom or a non-integer devicePixelRatio — would match
// neither the "max" nor the "min" query, and resolveLayoutTier's fallthrough
// silently resolves it to desktop, the one tier with no explicit handling).
describe("breakpoint query boundaries", () => {
  it("uses a fractional upper bound, not a bare integer, to avoid an adjacent-query gap", () => {
    expect(PHONE_BREAKPOINT_QUERY).toMatch(/max-width:\s*699\.\d+px/);
    expect(TABLET_BREAKPOINT_QUERY).toMatch(/max-width:\s*1279\.\d+px/);
  });
});

describe("resolveLayoutTier", () => {
  it("resolves phone/tablet/desktop from live width when layoutMode is auto", () => {
    stubBreakpointMedia("phone");
    expect(resolveLayoutTier("auto")).toBe("phone");
  });

  it("resolves tablet from live width when layoutMode is auto", () => {
    stubBreakpointMedia("tablet");
    expect(resolveLayoutTier("auto")).toBe("tablet");
  });

  it("resolves desktop from live width when layoutMode is auto", () => {
    stubBreakpointMedia("desktop");
    expect(resolveLayoutTier("auto")).toBe("desktop");
  });

  // The escape hatch: an explicit override ignores window width entirely,
  // even when it contradicts what the width queries would report — this is
  // the whole point (a foldable whose reported metrics are ambiguous, or
  // reproducing a tier in a desktop browser for testing).
  it("returns the explicit override unconditionally, ignoring width", () => {
    stubBreakpointMedia("phone");
    expect(resolveLayoutTier("tablet")).toBe("tablet");
    expect(resolveLayoutTier("desktop")).toBe("desktop");
    expect(resolveLayoutTier("phone")).toBe("phone");
  });

  it("never calls matchMedia for a non-auto layoutMode", () => {
    const matchMediaSpy = vi.fn();
    vi.stubGlobal("matchMedia", matchMediaSpy);
    resolveLayoutTier("desktop");
    expect(matchMediaSpy).not.toHaveBeenCalled();
  });
});

describe("isCompactTier", () => {
  it("is true for phone and tablet, false for desktop", () => {
    expect(isCompactTier("phone")).toBe(true);
    expect(isCompactTier("tablet")).toBe(true);
    expect(isCompactTier("desktop")).toBe(false);
  });
});

describe("useLayoutTier", () => {
  it("resolves the initial tier synchronously on first render", () => {
    stubBreakpointMedia("tablet");
    const { result } = renderHook(() => useLayoutTier("auto"));
    expect(result.current).toBe("tablet");
  });

  it("re-renders with the new tier on a live phone-to-desktop crossing", () => {
    const media = stubBreakpointMedia("phone");
    const { result } = renderHook(() => useLayoutTier("auto"));
    expect(result.current).toBe("phone");

    act(() => {
      media.setTier("desktop");
      media.desktop.dispatchEvent(new Event("change"));
    });

    expect(result.current).toBe("desktop");
  });

  it("re-renders on a tablet boundary crossing observed via the phone query", () => {
    const media = stubBreakpointMedia("phone");
    const { result } = renderHook(() => useLayoutTier("auto"));

    act(() => {
      media.setTier("tablet");
      media.phone.dispatchEvent(new Event("change"));
    });

    expect(result.current).toBe("tablet");
  });

  it("does not subscribe to any width query for an explicit override", () => {
    const matchMediaSpy = vi.fn((q: string) => new FakeMediaQueryList(q, false));
    vi.stubGlobal("matchMedia", matchMediaSpy);

    const { result } = renderHook(() => useLayoutTier("tablet"));

    expect(result.current).toBe("tablet");
    expect(matchMediaSpy).not.toHaveBeenCalled();
  });

  it("re-resolves when the layoutMode prop itself changes", () => {
    stubBreakpointMedia("phone");
    const { result, rerender } = renderHook(
      ({ layoutMode }: { layoutMode: "auto" | LayoutTier }) => useLayoutTier(layoutMode),
      { initialProps: { layoutMode: "auto" } },
    );
    expect(result.current).toBe("phone");

    rerender({ layoutMode: "desktop" });

    expect(result.current).toBe("desktop");
  });

  it("removes both boundary listeners on unmount", () => {
    const media = stubBreakpointMedia("phone");
    const { unmount, result } = renderHook(() => useLayoutTier("auto"));
    unmount();

    media.setTier("desktop");
    media.phone.dispatchEvent(new Event("change"));
    media.desktop.dispatchEvent(new Event("change"));

    // No re-render happened post-unmount, so the stale snapshot from before
    // unmount is what's left — the real assertion is that dispatching these
    // events after unmount doesn't throw (no listener left to run against a
    // torn-down component).
    expect(result.current).toBe("phone");
  });
});

describe("useCoarsePointer", () => {
  function stubPointerMedia(matches: boolean) {
    const mql = new FakeMediaQueryList(COARSE_POINTER_QUERY, matches);
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => {
        if (query === COARSE_POINTER_QUERY) return mql;
        throw new Error(`unexpected matchMedia query in test: ${query}`);
      }),
    );
    return mql;
  }

  it("resolves the initial value synchronously", () => {
    stubPointerMedia(true);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(true);
  });

  it("re-renders when the pointer query changes", () => {
    const mql = stubPointerMedia(false);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(false);

    act(() => {
      mql.matches = true;
      mql.dispatchEvent(new Event("change"));
    });

    expect(result.current).toBe(true);
  });

  it("removes the change listener on unmount", () => {
    const mql = stubPointerMedia(false);
    const { unmount, result } = renderHook(() => useCoarsePointer());
    unmount();

    mql.matches = true;
    mql.dispatchEvent(new Event("change"));

    expect(result.current).toBe(false);
  });
});

describe("useLayoutContext", () => {
  it("combines the resolved tier with the store's tabletPaneCap", () => {
    stubBreakpointMedia("tablet");
    mockSettings = { layoutMode: "auto", tabletPaneCap: 3 };

    const { result } = renderHook(() => useLayoutContext());

    expect(result.current).toEqual({ tier: "tablet", tabletPaneCap: 3 });
  });

  it("respects an explicit layoutMode override from settings", () => {
    stubBreakpointMedia("phone");
    mockSettings = { layoutMode: "desktop", tabletPaneCap: 2 };

    const { result } = renderHook(() => useLayoutContext());

    expect(result.current).toEqual({ tier: "desktop", tabletPaneCap: 2 });
  });
});

// Evaluates real min/max-width bounds against a number, so the boundary
// widths (699.98/700, ...) are exercised through the actual query strings.
function stubWidthAndPointer(width: number, coarse: boolean) {
  const lists = new Map<string, FakeMediaQueryList>();
  const evaluate = (q: string) => {
    if (q === COARSE_POINTER_QUERY) return coarse;
    const min = /min-width: ([\d.]+)px/.exec(q);
    const max = /max-width: ([\d.]+)px/.exec(q);
    return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => {
      if (!lists.has(q)) lists.set(q, new FakeMediaQueryList(q, evaluate(q)));
      return lists.get(q)!;
    }),
  );
  return {
    setWidth: (w: number) => {
      width = w;
      for (const [q, l] of lists) {
        l.matches = evaluate(q);
        l.dispatchEvent(new Event("change"));
      }
    },
    setCoarse: (c: boolean) => {
      coarse = c;
      for (const [q, l] of lists) {
        l.matches = evaluate(q);
        l.dispatchEvent(new Event("change"));
      }
    },
  };
}

describe("resolveLayoutBand", () => {
  it.each<[number, LayoutBand]>([
    [320, "phone"],
    [699.98, "phone"],
    [700, "rails-full"],
    [799.98, "rails-full"],
    [800, "rails-halves"],
    [851, "rails-halves"],
    [1099.98, "rails-halves"],
    [1100, "desktop-narrow"],
    [1279.98, "desktop-narrow"],
    [1280, "desktop"],
    [1920, "desktop"],
  ])("resolves %s px to %s", (width, band) => {
    stubWidthAndPointer(width, false);
    expect(resolveLayoutBand("auto")).toBe(band);
  });

  it("agrees with the existing three tiers at every boundary", () => {
    const tierOf: Record<LayoutBand, LayoutTier> = {
      phone: "phone",
      "rails-full": "tablet",
      "rails-halves": "tablet",
      "desktop-narrow": "tablet",
      desktop: "desktop",
    };
    for (const w of [699.98, 700, 799.98, 800, 1099.98, 1100, 1279.98, 1280]) {
      stubWidthAndPointer(w, false);
      expect(tierOf[resolveLayoutBand("auto")]).toBe(resolveLayoutTier("auto"));
    }
  });

  it("maps an explicit override without reading the width", () => {
    const spy = vi.fn();
    vi.stubGlobal("matchMedia", spy);
    expect(resolveLayoutBand("phone")).toBe("phone");
    expect(resolveLayoutBand("tablet")).toBe("rails-halves");
    expect(resolveLayoutBand("desktop")).toBe("desktop");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("useLayoutBand", () => {
  it("re-renders across each boundary", () => {
    const m = stubWidthAndPointer(699.98, false);
    const { result } = renderHook(() => useLayoutBand("auto"));
    expect(result.current).toBe("phone");
    for (const [w, band] of [
      [700, "rails-full"],
      [800, "rails-halves"],
      [1100, "desktop-narrow"],
      [1280, "desktop"],
    ] as const) {
      act(() => m.setWidth(w));
      expect(result.current).toBe(band);
    }
  });

  it("does not subscribe for an explicit override", () => {
    stubWidthAndPointer(1000, false);
    const { result } = renderHook(() => useLayoutBand("tablet"));
    expect(result.current).toBe("rails-halves");
    expect(window.matchMedia).not.toHaveBeenCalled();
  });
});

describe("band and pointer type vary independently", () => {
  it.each([700, 851, 1200, 1500])("at %s px a coarse pointer does not change the band", (w) => {
    stubWidthAndPointer(w, false);
    const fine = resolveLayoutBand("auto");
    stubWidthAndPointer(w, true);
    expect(resolveLayoutBand("auto")).toBe(fine);
  });

  it("flipping the pointer re-renders only the pointer hook, and the width only the band", () => {
    const m = stubWidthAndPointer(851, false);
    const { result } = renderHook(() => ({
      band: useLayoutBand("auto"),
      coarse: useCoarsePointer(),
    }));
    expect(result.current).toEqual({ band: "rails-halves", coarse: false });
    act(() => m.setCoarse(true));
    expect(result.current).toEqual({ band: "rails-halves", coarse: true });
    act(() => m.setWidth(1500));
    expect(result.current).toEqual({ band: "desktop", coarse: true });
  });
});
