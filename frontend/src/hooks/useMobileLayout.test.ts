// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMobileLayout } from "./useMobileLayout.js";
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

// One shared instance per test so `window.matchMedia(...)` (called fresh on
// every invocation — the breakpoint effect once on mount, the header-sync
// effect's `hideIfMobile` on every group event) always resolves to the same
// object a test can flip `.matches` on and fire `change` against.
function stubMatchMedia(initialMatches: boolean): FakeMediaQueryList {
  const mql = new FakeMediaQueryList("(max-width: 699px)", initialMatches);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
  return mql;
}

// A minimal fake DockviewApi covering exactly the surface applyMobilePresentation
// (panelUtils.ts) and the header-sync effect touch: groups/hasMaximizedGroup/
// exitMaximizedGroup/maximizeGroup/activePanel/panels for the former,
// onDidMaximizedGroupChange/onDidAddGroup for the latter — same shape as
// useWorkspacePersistence.test.ts's own makeMockApi, extended with the two
// group-event emitters this hook additionally subscribes to.
function makeMockApi(options: { activePanel?: unknown } = {}) {
  const maximizedGroupListeners: Array<(e: { group: DockviewGroupPanel }) => void> = [];
  const addGroupListeners: Array<(group: DockviewGroupPanel) => void> = [];
  const groups: Array<{ header: { hidden: boolean } }> = [];
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
    addGroup: () => {
      const group = { header: { hidden: false } };
      groups.push(group);
      return group as unknown as { header: { hidden: boolean } };
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

describe("useMobileLayout", () => {
  describe("breakpoint detection effect", () => {
    it("sets isMobile true and maximizes the active group when already mobile on mount", () => {
      stubMatchMedia(true);
      const activePanel = { id: "session-1" };
      const { api } = makeMockApi({ activePanel });
      const setIsMobile = vi.fn();

      renderHook(() => useMobileLayout({ dockviewApi: api, setIsMobile }));

      expect(setIsMobile).toHaveBeenCalledWith(true);
      expect(api.maximizeGroup).toHaveBeenCalledWith(activePanel);
    });

    it("sets isMobile false and exits any maximized group when desktop on mount", () => {
      stubMatchMedia(false);
      const { api } = makeMockApi();
      vi.mocked(api.hasMaximizedGroup).mockReturnValue(true);
      const setIsMobile = vi.fn();

      renderHook(() => useMobileLayout({ dockviewApi: api, setIsMobile }));

      expect(setIsMobile).toHaveBeenCalledWith(false);
      expect(api.exitMaximizedGroup).toHaveBeenCalledTimes(1);
    });

    it("still updates isMobile when dockviewApi is null, but never calls applyMobilePresentation", () => {
      stubMatchMedia(true);
      const setIsMobile = vi.fn();

      // Should not throw despite there being no api to apply presentation to.
      expect(() =>
        renderHook(() => useMobileLayout({ dockviewApi: null, setIsMobile })),
      ).not.toThrow();

      expect(setIsMobile).toHaveBeenCalledWith(true);
    });

    it("re-applies presentation when dockviewApi transitions from null to non-null on the same breakpoint", () => {
      stubMatchMedia(true);
      const { api } = makeMockApi({ activePanel: { id: "session-1" } });
      const setIsMobile = vi.fn();

      const { rerender } = renderHook(
        ({ dockviewApi }: { dockviewApi: DockviewApi | null }) =>
          useMobileLayout({ dockviewApi, setIsMobile }),
        { initialProps: { dockviewApi: null as DockviewApi | null } },
      );
      expect(api.maximizeGroup).not.toHaveBeenCalled();

      // dockviewApi becomes ready (e.g. DockviewReact's onReady firing after
      // this first render) — the effect's [dockviewApi] dependency change
      // re-runs it, covering "first mount while already mobile" per the
      // hook's own header comment.
      rerender({ dockviewApi: api });

      expect(api.maximizeGroup).toHaveBeenCalledTimes(1);
    });

    it("flips isMobile and re-applies presentation on a live breakpoint change", () => {
      const mql = stubMatchMedia(false);
      const { api, addGroup } = makeMockApi();
      const group = addGroup();
      const setIsMobile = vi.fn();

      renderHook(() => useMobileLayout({ dockviewApi: api, setIsMobile }));
      expect(group.header.hidden).toBe(false);
      setIsMobile.mockClear();

      mql.matches = true;
      mql.dispatchEvent(new Event("change"));

      expect(setIsMobile).toHaveBeenCalledWith(true);
      // applyMobilePresentation sets header.hidden = isMobile for every
      // group — a direct, non-vacuous observation that the `change` handler
      // actually re-ran presentation (not just re-derived `isMobile`),
      // rather than asserting a mock call that mount's own initial
      // applyMobilePresentation(api, false) would already satisfy.
      expect(group.header.hidden).toBe(true);
    });

    it("removes the change listener on unmount", () => {
      const mql = stubMatchMedia(false);
      const { api } = makeMockApi();
      const setIsMobile = vi.fn();

      const { unmount } = renderHook(() => useMobileLayout({ dockviewApi: api, setIsMobile }));
      unmount();
      setIsMobile.mockClear();

      mql.matches = true;
      mql.dispatchEvent(new Event("change"));

      expect(setIsMobile).not.toHaveBeenCalled();
    });
  });

  describe("header-sync effect", () => {
    it("hides a group's header on onDidMaximizedGroupChange while mobile", () => {
      stubMatchMedia(true);
      const { api, addGroup, fireMaximizedGroupChange } = makeMockApi();
      const setIsMobile = vi.fn();
      const group = addGroup();

      renderHook(() => useMobileLayout({ dockviewApi: api, setIsMobile }));
      fireMaximizedGroupChange(group);

      expect(group.header.hidden).toBe(true);
    });

    it("un-hides a group's header on onDidMaximizedGroupChange while desktop", () => {
      stubMatchMedia(false);
      const { api, addGroup, fireMaximizedGroupChange } = makeMockApi();
      const setIsMobile = vi.fn();
      const group = addGroup();
      group.header.hidden = true;

      renderHook(() => useMobileLayout({ dockviewApi: api, setIsMobile }));
      fireMaximizedGroupChange(group);

      expect(group.header.hidden).toBe(false);
    });

    it("hides a newly added group's header via onDidAddGroup while mobile", () => {
      stubMatchMedia(true);
      const { api, addGroup, fireAddGroup } = makeMockApi();
      const setIsMobile = vi.fn();
      const group = addGroup();

      renderHook(() => useMobileLayout({ dockviewApi: api, setIsMobile }));
      fireAddGroup(group);

      expect(group.header.hidden).toBe(true);
    });

    it("does not subscribe to group events when dockviewApi is null", () => {
      stubMatchMedia(false);
      const setIsMobile = vi.fn();

      expect(() =>
        renderHook(() => useMobileLayout({ dockviewApi: null, setIsMobile })),
      ).not.toThrow();
    });

    it("disposes both group-event subscriptions on unmount", () => {
      stubMatchMedia(false);
      const { api } = makeMockApi();
      const setIsMobile = vi.fn();

      const { unmount } = renderHook(() => useMobileLayout({ dockviewApi: api, setIsMobile }));
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
      stubMatchMedia(false);
      const { api: api1 } = makeMockApi();
      const { api: api2 } = makeMockApi();
      const setIsMobile = vi.fn();

      const { rerender } = renderHook(
        ({ dockviewApi }: { dockviewApi: DockviewApi }) =>
          useMobileLayout({ dockviewApi, setIsMobile }),
        { initialProps: { dockviewApi: api1 } },
      );
      expect(api1.onDidMaximizedGroupChange).toHaveBeenCalledTimes(1);

      rerender({ dockviewApi: api2 });

      expect(api2.onDidMaximizedGroupChange).toHaveBeenCalledTimes(1);
    });
  });
});
