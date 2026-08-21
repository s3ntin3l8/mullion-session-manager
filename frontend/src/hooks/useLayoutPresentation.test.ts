// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLayoutPresentation } from "./useLayoutPresentation.js";
import {
  PHONE_BREAKPOINT_QUERY,
  TABLET_BREAKPOINT_QUERY,
  DESKTOP_BREAKPOINT_QUERY,
} from "../lib/layoutTier.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import type { LayoutMode } from "../api/index.js";
import type { DockviewApi } from "dockview-react";
import type { DockviewGroupPanel } from "dockview";

// A real EventTarget (not a bare vi.fn() addEventListener no-op) so the
// breakpoint effect's own `change` subscription and its cleanup are actually
// observable — same pattern as useVisualViewportInset.test.tsx's
// FakeVisualViewport. `matches` is mutated directly by tests, then a `change`
// event dispatched, mirroring how a real MediaQueryList behaves.
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

// Tri-state stand-in for window.matchMedia — the hook (in "auto" layoutMode)
// resolves the tier by querying all three width queries fresh each time
// (lib/layoutTier.ts's resolveLayoutTier), and subscribes to `change` on the
// phone/desktop boundary ones only (tablet is "neither of the other two",
// so a change on either boundary is what can flip it — see that hook's own
// comment). `setTier` flips all three `.matches` flags consistently;
// callers still have to dispatch `change` on whichever boundary MQL they
// want the hook to observe.
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

// A minimal fake DockviewApi covering exactly the surface applyLayoutPresentation
// (panelUtils.ts) and the header-sync effect touch: groups/hasMaximizedGroup/
// exitMaximizedGroup/maximizeGroup/activePanel/panels for the former,
// onDidMaximizedGroupChange/onDidAddGroup for the latter — same shape as
// useWorkspacePersistence.test.ts's own makeMockApi, extended with the two
// group-event emitters this hook additionally subscribes to.
function makeMockApi(options: { activePanel?: unknown } = {}) {
  const maximizedGroupListeners: Array<(e: { group: DockviewGroupPanel }) => void> = [];
  const addGroupListeners: Array<(group: DockviewGroupPanel) => void> = [];
  const groups: Array<{
    id: string;
    header: { hidden: boolean };
    api: {
      location: { type: string };
      width: number;
      height: number;
      setSize: ReturnType<typeof vi.fn>;
    };
  }> = [];
  const api = {
    groups,
    hasMaximizedGroup: vi.fn(() => false),
    exitMaximizedGroup: vi.fn(),
    maximizeGroup: vi.fn(),
    activePanel: options.activePanel,
    panels: [] as unknown[],
    onDidMaximizedGroupChange: vi.fn((cb: (e: { group: DockviewGroupPanel }) => void) => {
      maximizedGroupListeners.push(cb);
      return { dispose: vi.fn() };
    }),
    onDidAddGroup: vi.fn((cb: (group: DockviewGroupPanel) => void) => {
      addGroupListeners.push(cb);
      return { dispose: vi.fn() };
    }),
  };
  return {
    api: api as unknown as DockviewApi,
    groups,
    // Deliberately carries `api.location.type` but no `panels` array at
    // all — real dockview-core fires `onDidAddGroup` immediately after
    // group creation, strictly before any panel is attached (verified
    // against the installed package; see isTiledGroup's own comment in
    // panelUtils.ts), so `group.panels` is reliably `[]` at the exact
    // moment this hook's onDidAddGroup listener fires. Omitting it here
    // pins isTiledGroup to reading the group's own location rather than a
    // panels-derived fallback that would mask a regression back to that
    // broken timing assumption. Pass "floating" to exercise the
    // onDidAddGroup skip-floating path (useLayoutPresentation.ts).
    // `width`/`height`/`id` default to values the pane-skew tests below
    // override explicitly — every pre-existing call site only ever reads
    // `.header.hidden`, so these defaults are inert for them. `setSize`
    // writes back into `width`/`height` the same way `mockGroup` in
    // panelUtils.test.ts does, mirroring the real dockview-core
    // GridviewPanel/GridviewPanelApi relationship (see that helper's own
    // comment).
    addGroup: (
      locationType: "grid" | "floating" = "grid",
      options: { id?: string; width?: number; height?: number } = {},
    ) => {
      let width = options.width ?? 0;
      let height = options.height ?? 0;
      const group = {
        id: options.id ?? `group-${groups.length + 1}`,
        header: { hidden: false },
        api: {
          location: { type: locationType },
          get width() {
            return width;
          },
          get height() {
            return height;
          },
          setSize: vi.fn((event: { width?: number; height?: number }) => {
            if (event.width !== undefined) width = event.width;
            if (event.height !== undefined) height = event.height;
          }),
        },
      };
      groups.push(group);
      return group;
    },
    fireMaximizedGroupChange: (group: { header: { hidden: boolean } }) =>
      maximizedGroupListeners.forEach((cb) =>
        cb({ group: group as unknown as DockviewGroupPanel }),
      ),
    fireAddGroup: (group: { header: { hidden: boolean } }) =>
      addGroupListeners.forEach((cb) => cb(group as unknown as DockviewGroupPanel)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLayoutPresentation", () => {
  describe("breakpoint detection effect", () => {
    it("sets layoutTier to phone and maximizes the active group when already phone on mount", () => {
      stubBreakpointMedia("phone");
      const activePanel = { id: "session-1", api: { location: { type: "grid" } } };
      const { api } = makeMockApi({ activePanel });
      const setLayoutTier = vi.fn();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );

      expect(setLayoutTier).toHaveBeenCalledWith("phone");
      expect(api.maximizeGroup).toHaveBeenCalledWith(activePanel);
    });

    it("sets layoutTier to desktop and exits any maximized group when desktop on mount", () => {
      stubBreakpointMedia("desktop");
      const { api } = makeMockApi();
      vi.mocked(api.hasMaximizedGroup).mockReturnValue(true);
      const setLayoutTier = vi.fn();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );

      expect(setLayoutTier).toHaveBeenCalledWith("desktop");
      expect(api.exitMaximizedGroup).toHaveBeenCalledTimes(1);
    });

    // Tablet tier plan, PR 4 — the tier applyLayoutPresentation gives real,
    // different behavior to: never maximizes, and (via the shared
    // "not phone" branch) restores every header rather than hiding any.
    it("sets layoutTier to tablet and neither maximizes nor hides any header on mount", () => {
      stubBreakpointMedia("tablet");
      const { api, addGroup } = makeMockApi();
      const group = addGroup();
      const setLayoutTier = vi.fn();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );

      expect(setLayoutTier).toHaveBeenCalledWith("tablet");
      expect(api.maximizeGroup).not.toHaveBeenCalled();
      expect(group.header.hidden).toBe(false);
    });

    it("still updates layoutTier when dockviewApi is null, but never calls applyLayoutPresentation", () => {
      stubBreakpointMedia("phone");
      const setLayoutTier = vi.fn();

      // Should not throw despite there being no api to apply presentation to.
      expect(() =>
        renderHook(() =>
          useLayoutPresentation({ dockviewApi: null, layoutMode: "auto", setLayoutTier }),
        ),
      ).not.toThrow();

      expect(setLayoutTier).toHaveBeenCalledWith("phone");
    });

    it("re-applies presentation when dockviewApi transitions from null to non-null on the same tier", () => {
      stubBreakpointMedia("phone");
      const { api } = makeMockApi({
        activePanel: { id: "session-1", api: { location: { type: "grid" } } },
      });
      const setLayoutTier = vi.fn();

      const { rerender } = renderHook(
        ({ dockviewApi }: { dockviewApi: DockviewApi | null }) =>
          useLayoutPresentation({ dockviewApi, layoutMode: "auto", setLayoutTier }),
        { initialProps: { dockviewApi: null as DockviewApi | null } },
      );
      expect(api.maximizeGroup).not.toHaveBeenCalled();

      // dockviewApi becomes ready (e.g. DockviewReact's onReady firing after
      // this first render) — the effect's [dockviewApi] dependency change
      // re-runs it, covering "first mount while already phone" without a
      // separate call.
      rerender({ dockviewApi: api });

      expect(api.maximizeGroup).toHaveBeenCalledTimes(1);
    });

    it("flips layoutTier and re-applies presentation on a live phone-to-tablet crossing", () => {
      const media = stubBreakpointMedia("phone");
      const { api, addGroup } = makeMockApi();
      const group = addGroup();
      const setLayoutTier = vi.fn();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      expect(group.header.hidden).toBe(true);
      setLayoutTier.mockClear();

      media.setTier("tablet");
      media.phone.dispatchEvent(new Event("change"));

      expect(setLayoutTier).toHaveBeenCalledWith("tablet");
      // applyLayoutPresentation restores every header once the tier is no
      // longer phone — a direct, non-vacuous observation that the `change`
      // handler actually re-ran presentation, not just re-derived the tier.
      expect(group.header.hidden).toBe(false);
    });

    // The reverse crossing — tablet's own "not phone" branch exits any
    // maximize and keeps headers visible on entry; going back to phone
    // exercises the hide-and-maximize path again from a clean (non-desktop)
    // starting tier.
    it("flips layoutTier and hides tiled headers again on a live tablet-to-phone crossing", () => {
      const media = stubBreakpointMedia("tablet");
      const activePanel = { id: "session-1", api: { location: { type: "grid" } } };
      const { api, addGroup } = makeMockApi({ activePanel });
      const group = addGroup();
      const setLayoutTier = vi.fn();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      expect(group.header.hidden).toBe(false);
      setLayoutTier.mockClear();

      media.setTier("phone");
      media.phone.dispatchEvent(new Event("change"));

      expect(setLayoutTier).toHaveBeenCalledWith("phone");
      expect(group.header.hidden).toBe(true);
      expect(api.maximizeGroup).toHaveBeenCalledWith(activePanel);
    });

    it("flips layoutTier and un-hides headers on a live phone-to-desktop crossing", () => {
      const media = stubBreakpointMedia("phone");
      const { api, addGroup } = makeMockApi();
      vi.mocked(api.hasMaximizedGroup).mockReturnValue(true);
      const group = addGroup();
      group.header.hidden = true;
      const setLayoutTier = vi.fn();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      setLayoutTier.mockClear();

      media.setTier("desktop");
      media.desktop.dispatchEvent(new Event("change"));

      expect(setLayoutTier).toHaveBeenCalledWith("desktop");
      expect(api.exitMaximizedGroup).toHaveBeenCalledTimes(1);
      expect(group.header.hidden).toBe(false);
    });

    // layoutMode as an explicit override (the plan's own "escape hatch for
    // a foldable whose reported metrics are ambiguous") must not react to
    // window width at all — only its own value changing can flip the
    // resolved tier.
    it("does not subscribe to width-boundary queries when layoutMode is an explicit override", () => {
      const matchMediaSpy = vi.fn((query: string) => new FakeMediaQueryList(query, false));
      vi.stubGlobal("matchMedia", matchMediaSpy);
      const { api } = makeMockApi();
      const setLayoutTier = vi.fn();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "tablet", setLayoutTier }),
      );

      expect(setLayoutTier).toHaveBeenCalledWith("tablet");
      // resolveLayoutTier itself never calls matchMedia for a non-"auto"
      // mode (lib/layoutTier.ts), so no subscription — and therefore no
      // addEventListener call — should exist to remove either.
      expect(matchMediaSpy).not.toHaveBeenCalled();
    });

    it("re-resolves the tier when the layoutMode override itself changes, without any width change", () => {
      stubBreakpointMedia("phone");
      const { api } = makeMockApi();
      const setLayoutTier = vi.fn();

      const { rerender } = renderHook(
        ({ layoutMode }: { layoutMode: LayoutMode }) =>
          useLayoutPresentation({ dockviewApi: api, layoutMode, setLayoutTier }),
        { initialProps: { layoutMode: "auto" } },
      );
      expect(setLayoutTier).toHaveBeenLastCalledWith("phone");

      rerender({ layoutMode: "desktop" });

      expect(setLayoutTier).toHaveBeenLastCalledWith("desktop");
    });

    // Pane-skew fix (panelUtils.ts's snapshotTiledGroupWidths/
    // restoreTiledGroupWidths) — this is the actual fold/unfold repro: two
    // 50/50 groups on tablet, fold to phone, something (dockview's own
    // maximize/exit cache, standing in here for the mock's `setSize` calls
    // between the two events) skews them, unfold back to tablet, and the
    // restore should redistribute the CURRENT total back to the snapshotted
    // 50/50 proportions rather than leaving the skew in place.
    it("restores tiled group widths to their pre-fold proportions on a phone-to-tablet crossing", async () => {
      const media = stubBreakpointMedia("tablet");
      const { api, addGroup } = makeMockApi();
      const left = addGroup("grid", { id: "left", width: 500, height: 600 });
      const right = addGroup("grid", { id: "right", width: 500, height: 600 });
      const setLayoutTier = vi.fn();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );

      // Enter phone — the hook snapshots {left: 0.5, right: 0.5} just before
      // this. Standing in for dockview's own hide-cache clamp (the actual
      // bug's mechanism, verified against the installed dockview-core —
      // see panelUtils.ts's own comment), simulate the skew directly: total
      // width unchanged at 1000, but now 100/900 instead of 500/500.
      media.setTier("phone");
      media.phone.dispatchEvent(new Event("change"));
      left.api.setSize({ width: 100 });
      right.api.setSize({ width: 900 });
      left.api.setSize.mockClear();
      right.api.setSize.mockClear();

      // Exit back to tablet — the restore is deferred one rAF past this.
      media.setTier("tablet");
      media.phone.dispatchEvent(new Event("change"));
      await new Promise((resolve) => requestAnimationFrame(resolve));

      // Only the non-last group gets an explicit corrective setSize (see
      // restoreTiledGroupWidths's own comment on why) — asserting on `left`
      // alone is deliberate. 0.5 * (100 + 900) = 500, back to the original
      // pre-fold width despite the skewed 100/900 it was reading from.
      expect(left.api.setSize).toHaveBeenCalledWith({ width: 500 });
      expect(right.api.setSize).not.toHaveBeenCalled();
    });

    it("does not snapshot or restore on a tablet-to-desktop crossing that never touched phone", async () => {
      const media = stubBreakpointMedia("tablet");
      const { api, addGroup } = makeMockApi();
      const left = addGroup("grid", { id: "left", width: 500, height: 600 });
      const right = addGroup("grid", { id: "right", width: 500, height: 600 });
      const setLayoutTier = vi.fn();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );

      media.setTier("desktop");
      media.desktop.dispatchEvent(new Event("change"));
      await new Promise((resolve) => requestAnimationFrame(resolve));

      expect(left.api.setSize).not.toHaveBeenCalled();
      expect(right.api.setSize).not.toHaveBeenCalled();
    });

    it("does not treat mounting directly on phone as an entering-phone transition", async () => {
      // No prior tier to snapshot FROM — the very first onChange() call on
      // mount must not be mistaken for a tablet/desktop-to-phone crossing
      // (prevTierRef's own comment in the hook).
      const media = stubBreakpointMedia("phone");
      const { api, addGroup } = makeMockApi({
        activePanel: { id: "session-1", api: { location: { type: "grid" } } },
      });
      const left = addGroup("grid", { id: "left", width: 500, height: 600 });
      const right = addGroup("grid", { id: "right", width: 500, height: 600 });
      const setLayoutTier = vi.fn();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );

      media.setTier("tablet");
      media.phone.dispatchEvent(new Event("change"));
      await new Promise((resolve) => requestAnimationFrame(resolve));

      // Nothing was ever snapshotted, so exiting phone must not redistribute
      // anything either, however the two groups' widths happen to compare.
      expect(left.api.setSize).not.toHaveBeenCalled();
      expect(right.api.setSize).not.toHaveBeenCalled();
    });

    it("removes both boundary-query change listeners on unmount", () => {
      const media = stubBreakpointMedia("phone");
      const { api } = makeMockApi();
      const setLayoutTier = vi.fn();

      const { unmount } = renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      unmount();
      setLayoutTier.mockClear();

      media.setTier("tablet");
      media.phone.dispatchEvent(new Event("change"));
      media.desktop.dispatchEvent(new Event("change"));

      expect(setLayoutTier).not.toHaveBeenCalled();
    });
  });

  describe("header-sync effect", () => {
    it("hides a group's header on onDidMaximizedGroupChange while phone", () => {
      stubBreakpointMedia("phone");
      const { api, addGroup, fireMaximizedGroupChange } = makeMockApi();
      const setLayoutTier = vi.fn();
      const group = addGroup();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      fireMaximizedGroupChange(group);

      expect(group.header.hidden).toBe(true);
    });

    it("un-hides a group's header on onDidMaximizedGroupChange while desktop", () => {
      stubBreakpointMedia("desktop");
      const { api, addGroup, fireMaximizedGroupChange } = makeMockApi();
      const setLayoutTier = vi.fn();
      const group = addGroup();
      group.header.hidden = true;

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      fireMaximizedGroupChange(group);

      expect(group.header.hidden).toBe(false);
    });

    // Tablet tier plan, PR 4 — tablet shares desktop's "not phone" behavior
    // here too: a group that somehow gets maximized (e.g. a direct
    // dockviewApi.maximizeGroup() call elsewhere) still doesn't have its
    // header hidden on tablet.
    it("un-hides a group's header on onDidMaximizedGroupChange while tablet", () => {
      stubBreakpointMedia("tablet");
      const { api, addGroup, fireMaximizedGroupChange } = makeMockApi();
      const setLayoutTier = vi.fn();
      const group = addGroup();
      group.header.hidden = true;

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      fireMaximizedGroupChange(group);

      expect(group.header.hidden).toBe(false);
    });

    it("hides a newly added group's header via onDidAddGroup while phone", () => {
      stubBreakpointMedia("phone");
      const { api, addGroup, fireAddGroup } = makeMockApi();
      const setLayoutTier = vi.fn();
      const group = addGroup();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      fireAddGroup(group);

      expect(group.header.hidden).toBe(true);
    });

    it("leaves a newly added group's header visible via onDidAddGroup while tablet", () => {
      stubBreakpointMedia("tablet");
      const { api, addGroup, fireAddGroup } = makeMockApi();
      const setLayoutTier = vi.fn();
      const group = addGroup();

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      fireAddGroup(group);

      expect(group.header.hidden).toBe(false);
    });

    // Independent code review — onDidAddGroup fires for a newly created
    // floating group too (e.g. desktopPositioning's `{floating: ...}`
    // branch), and hiding a floating group's header removes its only drag
    // handle and close button, so this path needs the same isTiledGroup
    // check applyLayoutPresentation uses.
    it("leaves a newly added floating group's header visible via onDidAddGroup while phone", () => {
      stubBreakpointMedia("phone");
      const { api, addGroup, fireAddGroup } = makeMockApi();
      const setLayoutTier = vi.fn();
      const group = addGroup("floating");

      renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      fireAddGroup(group);

      expect(group.header.hidden).toBe(false);
    });

    it("does not subscribe to group events when dockviewApi is null", () => {
      stubBreakpointMedia("desktop");
      const setLayoutTier = vi.fn();

      expect(() =>
        renderHook(() =>
          useLayoutPresentation({ dockviewApi: null, layoutMode: "auto", setLayoutTier }),
        ),
      ).not.toThrow();
    });

    it("disposes both group-event subscriptions on unmount", () => {
      stubBreakpointMedia("desktop");
      const { api } = makeMockApi();
      const setLayoutTier = vi.fn();

      const { unmount } = renderHook(() =>
        useLayoutPresentation({ dockviewApi: api, layoutMode: "auto", setLayoutTier }),
      );
      const maximizedDisposable = vi.mocked(api.onDidMaximizedGroupChange).mock.results[0]
        .value as { dispose: ReturnType<typeof vi.fn> };
      const addedDisposable = vi.mocked(api.onDidAddGroup).mock.results[0].value as {
        dispose: ReturnType<typeof vi.fn>;
      };

      unmount();

      expect(maximizedDisposable.dispose).toHaveBeenCalledTimes(1);
      expect(addedDisposable.dispose).toHaveBeenCalledTimes(1);
    });

    it("re-subscribes group events when dockviewApi changes identity", () => {
      stubBreakpointMedia("desktop");
      const { api: api1 } = makeMockApi();
      const { api: api2 } = makeMockApi();
      const setLayoutTier = vi.fn();

      const { rerender } = renderHook(
        ({ dockviewApi }: { dockviewApi: DockviewApi }) =>
          useLayoutPresentation({ dockviewApi, layoutMode: "auto", setLayoutTier }),
        { initialProps: { dockviewApi: api1 } },
      );
      expect(api1.onDidMaximizedGroupChange).toHaveBeenCalledTimes(1);

      rerender({ dockviewApi: api2 });

      expect(api2.onDidMaximizedGroupChange).toHaveBeenCalledTimes(1);
    });
  });
});
