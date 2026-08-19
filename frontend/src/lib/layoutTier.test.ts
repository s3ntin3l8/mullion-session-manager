// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  PHONE_BREAKPOINT_QUERY,
  TABLET_BREAKPOINT_QUERY,
  DESKTOP_BREAKPOINT_QUERY,
  COARSE_POINTER_QUERY,
  resolveLayoutTier,
  useLayoutTier,
  useCoarsePointer,
  useLayoutContext,
} from "./layoutTier.js";
import type { LayoutTier } from "./layoutTier.js";

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
