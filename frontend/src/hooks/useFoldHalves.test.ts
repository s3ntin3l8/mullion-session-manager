// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import type { IDockviewPanel } from "dockview";
import {
  markViewRestored,
  preferredPaneFor,
  showPaneOnItsHalf,
  useFoldHalves,
} from "./useFoldHalves.js";
import type { UseFoldHalvesParams } from "./useFoldHalves.js";
import {
  focusPanelForTier,
  halvesActive,
  presentNewPanel,
  setHalvesRouter,
} from "../panelUtils.js";
import { useDashboardStore } from "../store/index.js";
import { EMPTY_FOLD_HALVES } from "../lib/foldHalves.js";

type FakePanel = {
  id: string;
  api: { setActive: ReturnType<typeof vi.fn>; location: { type: string } };
};

function makeApi(ids: string[], options: { floating?: string[] } = {}) {
  const panels: FakePanel[] = ids.map((id) => ({
    id,
    api: {
      setActive: vi.fn(),
      location: { type: options.floating?.includes(id) ? "floating" : "grid" },
    },
  }));
  let maximized: string | null = null;
  const api = {
    panels,
    get activePanel() {
      return panels.find((p) => p.id === maximized) ?? null;
    },
    getPanel: (id: string) => panels.find((p) => p.id === id),
    maximizeGroup: vi.fn((panel: FakePanel) => {
      maximized = panel.id;
    }),
    hasMaximizedGroup: () => maximized !== null,
    addPanel: vi.fn((opts: { id: string }) => {
      const panel: FakePanel = {
        id: opts.id,
        api: { setActive: vi.fn(), location: { type: "grid" } },
      };
      panels.push(panel);
      return panel;
    }),
  };
  return { api: api as unknown as DockviewApi, panels, maximized: () => maximized };
}

const halves = () => useDashboardStore.getState().foldHalves[7] ?? EMPTY_FOLD_HALVES;

beforeEach(() => {
  localStorage.clear();
  useDashboardStore.setState({
    activeWorkspaceId: 7,
    foldHalves: {},
    focusedHalf: "left",
    foldHalvesActive: false,
    rightSidebarOpen: false,
  });
});
afterEach(() => setHalvesRouter(null));

describe("fold halves in the store (per device, per workspace)", () => {
  it("keeps the assignment in localStorage, keyed by workspace", () => {
    useDashboardStore.getState().moveToHalf("session-2", "right", ["session-1", "session-2"]);
    expect(halves().right).toEqual(["session-2"]);
    const stored = JSON.parse(localStorage.getItem("crs.foldHalves") ?? "{}");
    expect(stored["7"].right).toEqual(["session-2"]);
    // Another workspace has its own.
    useDashboardStore.setState({ activeWorkspaceId: 8 });
    useDashboardStore.getState().moveToHalf("session-5", "right", ["session-4", "session-5"]);
    expect(Object.keys(JSON.parse(localStorage.getItem("crs.foldHalves") ?? "{}"))).toEqual([
      "7",
      "8",
    ]);
  });

  it("writes nothing for a change that changes nothing", () => {
    useDashboardStore.getState().toggleRightPane("session-9");
    expect(localStorage.getItem("crs.foldHalves")).toBeNull();
  });

  it("drops a deleted workspace's assignment, here and in localStorage", () => {
    useDashboardStore.getState().noteLeftPane("session-1");
    useDashboardStore.getState().forgetFoldHalvesWorkspace(7);
    expect(useDashboardStore.getState().foldHalves[7]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("crs.foldHalves") ?? "{}")).toEqual({});
    // Nothing to drop writes nothing.
    localStorage.removeItem("crs.foldHalves");
    useDashboardStore.getState().forgetFoldHalvesWorkspace(7);
    expect(localStorage.getItem("crs.foldHalves")).toBeNull();
  });

  it("lands 'Open session in Workspace' on the left half, wherever the session was", () => {
    useDashboardStore.getState().moveToHalf("session-2", "right", ["session-1", "session-2"]);
    useDashboardStore.getState().openSessionInWorkspace(2);
    expect(halves().right).toEqual([]);
    expect(useDashboardStore.getState().openSessionRequest?.sessionId).toBe(2);
  });
});

describe("showPaneOnItsHalf (the halves' router)", () => {
  it("maximizes a left pane's group and gives the left half focus", () => {
    const { api, panels, maximized } = makeApi(["session-1", "session-2"]);
    useDashboardStore.setState({ focusedHalf: "right" });
    expect(showPaneOnItsHalf(api, panels[1] as unknown as IDockviewPanel)).toBe(true);
    expect(panels[1]!.api.setActive).toHaveBeenCalled();
    expect(maximized()).toBe("session-2");
    expect(halves().shownLeft).toBe("session-2");
    expect(useDashboardStore.getState().focusedHalf).toBe("left");
  });

  it("shows a right pane on the right half, without touching the grid", () => {
    const { api, panels, maximized } = makeApi(["session-1", "session-2"]);
    useDashboardStore.getState().moveToHalf("session-2", "right", ["session-1", "session-2"]);
    useDashboardStore.getState().showRightPane(null);
    expect(showPaneOnItsHalf(api, panels[1] as unknown as IDockviewPanel)).toBe(true);
    expect(halves().shownRight).toBe("session-2");
    expect(useDashboardStore.getState().focusedHalf).toBe("right");
    expect(maximized()).toBeNull();
  });

  it("leaves a sidebar view covering the right half (automatic focus does not uncover it)", () => {
    const { api, panels } = makeApi(["session-1", "session-2"]);
    useDashboardStore.getState().moveToHalf("session-2", "right", ["session-1", "session-2"]);
    useDashboardStore.getState().showRightPane(null);
    useDashboardStore.setState({ rightSidebarOpen: true });
    showPaneOnItsHalf(api, panels[1] as unknown as IDockviewPanel);
    expect(halves().shownRight).toBe("session-2");
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);
    expect(useDashboardStore.getState().focusedHalf).toBe("left");
  });

  it("leaves a float to the ordinary path", () => {
    const { api, panels } = makeApi(["session-1"], { floating: ["session-1"] });
    expect(showPaneOnItsHalf(api, panels[0] as unknown as IDockviewPanel)).toBe(false);
  });

  it("is what focusPanelForTier and presentNewPanel use while registered", () => {
    const { api, panels, maximized } = makeApi(["session-1", "session-2"]);
    expect(halvesActive()).toBe(false);
    focusPanelForTier(api, panels[1] as unknown as IDockviewPanel, "tablet");
    expect(maximized()).toBeNull();
    setHalvesRouter(showPaneOnItsHalf);
    expect(halvesActive()).toBe(true);
    focusPanelForTier(api, panels[1] as unknown as IDockviewPanel, "tablet");
    expect(maximized()).toBe("session-2");
    presentNewPanel(api, panels[0] as unknown as IDockviewPanel, "tablet");
    expect(maximized()).toBe("session-1");
  });
});

describe("preferredPaneFor (folding and unfolding)", () => {
  it("shows the pane used last on the phone, and the remembered left pane in the halves", () => {
    useDashboardStore.getState().noteLeftPane("session-1");
    useDashboardStore.getState().moveToHalf("session-2", "right", ["session-1", "session-2"]);
    expect(preferredPaneFor("phone")).toBe("session-2");
    expect(preferredPaneFor("halves")).toBe("session-1");
    expect(preferredPaneFor("grid")).toBeNull();
    useDashboardStore.getState().noteHalfUsed({ kind: "view" });
    expect(preferredPaneFor("phone")).toBeNull();
  });
});

describe("useFoldHalves", () => {
  function setup(over: Partial<UseFoldHalvesParams> & { ids?: string[] } = {}) {
    const fake = makeApi(over.ids ?? ["session-1", "session-2"]);
    const reopenSession = vi.fn((sessionId: number) => {
      (fake.api as unknown as { addPanel: (o: { id: string }) => void }).addPanel({
        id: `session-${sessionId}`,
      });
      return true;
    });
    const props: UseFoldHalvesParams = {
      dockviewApi: fake.api,
      presentation: "halves",
      activeWorkspaceId: 7,
      panelsVersion: 1,
      isRestored: () => true,
      sessionsLoaded: true,
      reopenSession,
      ...over,
    };
    const hook = renderHook((p: UseFoldHalvesParams) => useFoldHalves(p), { initialProps: props });
    return { ...fake, ...hook, props, reopenSession };
  }

  it("registers the router and the store flag only while the halves show", () => {
    const { rerender, props } = setup();
    expect(halvesActive()).toBe(true);
    expect(useDashboardStore.getState().foldHalvesActive).toBe(true);
    rerender({ ...props, presentation: "grid" });
    expect(halvesActive()).toBe(false);
    expect(useDashboardStore.getState().foldHalvesActive).toBe(false);
  });

  it("puts a left pane on show on the left half after a restore", () => {
    useDashboardStore.getState().noteLeftPane("session-2", false);
    const { maximized } = setup();
    expect(maximized()).toBe("session-2");
  });

  it("remembers the open sessions and reopens the missing ones once after a restore", () => {
    useDashboardStore.setState({
      foldHalves: {
        7: { ...EMPTY_FOLD_HALVES, open: ["session-1", "session-3"], right: ["session-3"] },
      },
    });
    const { reopenSession, panels, rerender, props } = setup({ ids: ["session-1"] });
    expect(reopenSession).toHaveBeenCalledTimes(1);
    expect(reopenSession).toHaveBeenCalledWith(3);
    expect(panels.map((p) => p.id)).toEqual(["session-1", "session-3"]);
    // The assignment survives the reopen, and the router is back.
    expect(halves().right).toEqual(["session-3"]);
    expect(halvesActive()).toBe(true);
    rerender({ ...props, panelsVersion: 2 });
    expect(reopenSession).toHaveBeenCalledTimes(1);
    expect(halves().open).toEqual(["session-1", "session-3"]);
  });

  it("waits for the sessions list before reopening, without pruning meanwhile", () => {
    useDashboardStore.setState({
      foldHalves: { 7: { ...EMPTY_FOLD_HALVES, open: ["session-3"], right: ["session-3"] } },
    });
    const { reopenSession, rerender, props } = setup({ ids: ["session-1"], sessionsLoaded: false });
    expect(reopenSession).not.toHaveBeenCalled();
    expect(halves().right).toEqual(["session-3"]);
    rerender({ ...props, sessionsLoaded: true });
    expect(reopenSession).toHaveBeenCalledWith(3);
  });

  it("retries while the restore is still settling", () => {
    vi.useFakeTimers();
    let restored = false;
    useDashboardStore.setState({
      foldHalves: { 7: { ...EMPTY_FOLD_HALVES, open: ["session-3"] } },
    });
    const { reopenSession } = setup({ ids: ["session-1"], isRestored: () => restored });
    expect(reopenSession).not.toHaveBeenCalled();
    restored = true;
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(reopenSession).toHaveBeenCalledWith(3);
    vi.useRealTimers();
  });

  it("forgets a pane seen closing, wherever it closes", () => {
    useDashboardStore.setState({
      foldHalves: { 7: { ...EMPTY_FOLD_HALVES, open: ["session-3"], right: ["session-3"] } },
    });
    const { panels, rerender, props } = setup({
      ids: ["session-1", "session-3"],
      presentation: "phone",
    });
    expect(halves().right).toEqual(["session-3"]);
    panels.splice(1, 1);
    rerender({ ...props, panelsVersion: 2 });
    expect(halves().right).toEqual([]);
    expect(halves().open).toEqual([]);
  });

  it("keeps the fold's sessions through a reload while folded (absent is not closed)", () => {
    useDashboardStore.setState({
      foldHalves: { 7: { ...EMPTY_FOLD_HALVES, open: ["session-3"], right: ["session-3"] } },
    });
    const { reopenSession, rerender, props } = setup({ ids: ["session-1"], presentation: "phone" });
    rerender({ ...props, panelsVersion: 2 });
    expect(reopenSession).not.toHaveBeenCalled();
    expect(halves().right).toEqual(["session-3"]);
    expect(halves().open).toEqual(["session-3"]);
    // Unfolding reopens it.
    rerender({ ...props, presentation: "halves", panelsVersion: 3 });
    expect(reopenSession).toHaveBeenCalledWith(3);
  });

  it("forgets a remembered session that ended and cannot be reopened", () => {
    useDashboardStore.setState({
      foldHalves: { 7: { ...EMPTY_FOLD_HALVES, open: ["session-3"], right: ["session-3"] } },
    });
    setup({ ids: ["session-1"], reopenSession: vi.fn(() => false) });
    expect(halves().right).toEqual([]);
    // What stays remembered is what is open now.
    expect(halves().open).toEqual(["session-1"]);
  });

  // Design 9.2 with the phone layout (#3014): crossing 700px in either
  // direction keeps which pane is on which half, the phone starts on the pane
  // used last, and unfolding shows the left pane again on the left.
  it("keeps the assignment through a fold to the phone and back", () => {
    useDashboardStore.getState().noteLeftPane("session-1");
    useDashboardStore.getState().moveToHalf("session-2", "right", ["session-1", "session-2"]);
    const { rerender, props, panels, maximized } = setup();
    expect(maximized()).toBe("session-1");
    const before = halves();
    rerender({ ...props, presentation: "phone", panelsVersion: 2 });
    expect(halvesActive()).toBe(false);
    expect(preferredPaneFor("phone")).toBe("session-2");
    // The phone shows the right half's session as its one pane.
    act(() => {
      props.dockviewApi!.maximizeGroup(panels[1] as never);
    });
    rerender({ ...props, presentation: "phone", panelsVersion: 3 });
    expect(halves()).toEqual(before);
    rerender({ ...props, presentation: "halves", panelsVersion: 4 });
    expect(halvesActive()).toBe(true);
    expect(maximized()).toBe("session-1");
    expect(halves().right).toEqual(["session-2"]);
    expect(halves().shownRight).toBe("session-2");
    expect(halves().shownLeft).toBe("session-1");
    expect(preferredPaneFor("phone")).toBe("session-2");
  });

  it("does not count a view put back on unfolding as used", () => {
    useDashboardStore.getState().noteLeftPane("session-1");
    setup();
    markViewRestored();
    act(() => useDashboardStore.setState({ rightSidebarOpen: true }));
    expect(halves().lastUsed).toEqual({ kind: "pane", panelId: "session-1" });
    // Only that once: closing and opening again is using it.
    act(() => useDashboardStore.setState({ rightSidebarOpen: false }));
    act(() => useDashboardStore.setState({ rightSidebarOpen: true }));
    expect(halves().lastUsed).toEqual({ kind: "view" });
  });

  it("counts opening a sidebar view as using it", () => {
    setup();
    act(() => useDashboardStore.setState({ rightSidebarOpen: true }));
    expect(halves().lastUsed).toEqual({ kind: "view" });
  });
});
