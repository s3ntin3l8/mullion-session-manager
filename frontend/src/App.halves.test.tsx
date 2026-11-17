// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Session } from "./api/index.js";
// #3010's two halves, App-level. Split from App.test.tsx (its size ceiling);
// the mocks live in the shared harness, imported before App.
import {
  splitHarness,
  railHarness,
  foldHarness,
  setLayoutMode,
  stubWidth,
  stubLiveWidth,
  persistenceHarness,
} from "./test/appHarness.js";
import { App } from "./App.js";
import { useDashboardStore } from "./store/index.js";
import { useLayoutPresentation } from "./hooks/useLayoutPresentation.js";
import { EMPTY_FOLD_HALVES } from "./lib/foldHalves.js";

// #3010 — the two halves between 800 and 1099px.
describe("App two halves", () => {
  const setActive = vi.fn();
  function makeApi(floating: number[] = [], ids: number[] = [10, 11]) {
    const panels = ids.map((id) => ({
      id: `session-${id}`,
      title: `s${id}`,
      params: { sessionId: id },
      api: {
        location: { type: floating.includes(id) ? "floating" : "grid" },
        setActive,
        close: vi.fn(),
      },
      group: { id: `g${id}` },
    }));
    return {
      panels,
      groups: [],
      activePanel: null,
      getPanel: (id: string) => panels.find((panel) => panel.id === id) ?? null,
      addPanel: vi.fn(),
      maximizeGroup: vi.fn(),
      hasMaximizedGroup: () => false,
      exitMaximizedGroup: vi.fn(),
      onDidActivePanelChange: () => ({ dispose: vi.fn() }),
      onDidAddPanel: () => ({ dispose: vi.fn() }),
      onDidRemovePanel: () => ({ dispose: vi.fn() }),
      onWillMutateLayout: () => ({ dispose: vi.fn() }),
      onDidMutateLayout: () => ({ dispose: vi.fn() }),
    };
  }
  const session = (id: number) =>
    ({
      id,
      projectId: 7,
      name: null,
      nameLocked: false,
      lastTitle: `session ${id}`,
      command: "bash",
      status: "active",
      attention: false,
    }) as Session;

  beforeEach(() => {
    railHarness.props = null;
    foldHarness.rightHalf = null;
    foldHarness.launcher = null;
    foldHarness.onOpenSession = vi.fn();
    splitHarness.announced = false;
    splitHarness.launch = null;
    setLayoutMode("auto");
    localStorage.clear();
    useDashboardStore.setState({
      viewMode: "list",
      activeWorkspaceId: 1,
      activePanelId: "session-10",
      sessions: [session(10), session(11), session(12)],
      foldHalves: {},
      focusedHalf: "left",
      rightSidebarOpen: false,
      refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
      hydrateSettings: vi.fn(),
      startThemeWatch: vi.fn(() => () => {}),
    });
  });

  afterEach(() => {
    splitHarness.api = null;
    splitHarness.announced = false;
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    useDashboardStore.setState({
      foldHalves: {},
      focusedHalf: "left",
      activePanelId: null,
      updateCheck: null,
    });
  });

  async function renderHalves(coarse = false, api = makeApi()) {
    stubWidth("halves", coarse);
    splitHarness.api = api;
    const view = render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    return view;
  }

  it("shows the halves: the left rail lists the left half, the right rail the right one", async () => {
    const { container } = await renderHalves();
    expect(container.querySelector(".app")).toHaveClass("fold-halves");
    expect(railHarness.props?.panes.map((p) => p.id)).toEqual(["session-10", "session-11"]);
    expect(screen.queryByTestId("right-half")).toBeNull();

    act(() =>
      useDashboardStore.getState().moveToHalf("session-11", "right", ["session-10", "session-11"]),
    );
    expect(railHarness.props?.panes.map((p) => p.id)).toEqual(["session-10"]);
    expect(screen.getByTestId("right-half")).toHaveAttribute("data-session", "11");
    const rail = screen.getByRole("navigation", { name: "Right sidebar" });
    expect(within(rail).getByRole("group", { name: "Right half" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /session 11/ })).toBeInTheDocument();
  });

  it("is not the halves outside 800-1099px; in Tasks mode only the widths hold", async () => {
    stubWidth("tablet");
    const { container } = render(<App />);
    expect(container.querySelector(".app")).not.toHaveClass("fold-halves");
    cleanup();
    useDashboardStore.setState({ viewMode: "kanban", rightSidebarOpen: true });
    const tasks = await renderHalves();
    const app = tasks.container.querySelector(".app");
    expect(app).not.toHaveClass("fold-halves");
    // The halves' widths still hold: the sidebar docks on the right half.
    expect(app).toHaveClass("halves-band");
    expect(tasks.container.querySelector(".right-sidebar-panel.docked")).toHaveClass("half");
    useDashboardStore.setState({ viewMode: "list", rightSidebarOpen: false });
  });

  // #3213 — the shell banners span both halves, above them, not the left one.
  it("shows the update banner above both halves, not inside the left half", async () => {
    const { container } = await renderHalves();
    act(() =>
      useDashboardStore.setState({
        currentVersion: "1.0.0",
        dismissedUpdateVersion: null,
        updateCheck: {
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          updateAvailable: true,
          releaseUrl: null,
          assetUrl: null,
          checksumUrl: null,
        } as never,
      }),
    );
    const banner = screen.getByText("v1.0.0 → v1.1.0 available");
    expect(container.querySelector(".fold-half-left")).not.toContainElement(banner);
    const host = container.querySelector(".shell-banners");
    expect(host).toContainElement(banner);
    expect(host?.parentElement).toHaveClass("app-body", "app-body--halves");

    // Outside the halves it stays at the top of the grid area.
    cleanup();
    stubWidth("tablet");
    const wide = render(<App />);
    const gridBanner = screen.getByText("v1.0.0 → v1.1.0 available");
    expect(wide.container.querySelector(".grid-area")).toContainElement(gridBanner);
    expect(wide.container.querySelector(".shell-banners")).toBeNull();
    expect(wide.container.querySelector(".app-body")).not.toHaveClass("app-body--halves");
  });

  it("points the key bar at the focused half", async () => {
    await renderHalves(true);
    // The fake grid reports no active panel on ready; the left half's is set here.
    act(() => useDashboardStore.setState({ activePanelId: "session-10" }));
    act(() =>
      useDashboardStore.getState().moveToHalf("session-11", "right", ["session-10", "session-11"]),
    );
    act(() => useDashboardStore.getState().setFocusedHalf("right"));
    expect(screen.getByTestId("key-bar")).toHaveAttribute("data-session", "11");
    act(() => useDashboardStore.getState().setFocusedHalf("left"));
    expect(screen.getByTestId("key-bar")).toHaveAttribute("data-session", "10");
    // A view covering the right half takes the right session off the key bar.
    act(() => {
      useDashboardStore.getState().setFocusedHalf("right");
      useDashboardStore.setState({ rightSidebarOpen: true });
    });
    expect(screen.getByTestId("key-bar")).toHaveAttribute("data-session", "10");
  });

  // #3053 — one bar under both halves, not inside the left one: the two
  // terminals keep the same height, and a tap on a key is not a use of the
  // left half (which would retarget the bar away from the right session).
  it("puts one key bar under both halves, typing into the right half after it is used", async () => {
    const { container } = await renderHalves(true);
    act(() => useDashboardStore.setState({ activePanelId: "session-10" }));
    act(() =>
      useDashboardStore.getState().moveToHalf("session-11", "right", ["session-10", "session-11"]),
    );
    act(() => foldHarness.rightHalf!.onUse());
    const bars = screen.getAllByTestId("key-bar");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.parentElement).toBe(container.querySelector(".app"));
    expect(container.querySelector(".grid-area [data-testid='key-bar']")).toBeNull();
    expect(bars[0]).toHaveAttribute("data-session", "11");
    // Pressing the bar is not pressing the left half: the target stays.
    fireEvent.pointerDown(bars[0]!);
    expect(useDashboardStore.getState().focusedHalf).toBe("right");
    expect(screen.getByTestId("key-bar")).toHaveAttribute("data-session", "11");
    // Using the left half moves the bar to it, and marks its header.
    fireEvent.pointerDown(container.querySelector(".fold-half-left")!);
    expect(screen.getByTestId("key-bar")).toHaveAttribute("data-session", "10");
    expect(container.querySelector(".half-header[data-half='left']")).toHaveClass("focused");
  });

  // #3034 — a path clicked in the right half's terminal opens the project's
  // editor in the grid, which on the halves is the left half, and the left
  // half takes focus.
  it("opens a path clicked in the right half's terminal in the editor on the left half", async () => {
    const projects = useDashboardStore.getState().projects;
    useDashboardStore.setState({
      projects: [{ id: 7, name: "demo", cwd: "/proj" } as (typeof projects)[number]],
      sessions: [session(10), { ...session(11), cwd: "/proj" }],
    });
    try {
      const api = makeApi();
      await renderHalves(true, api);
      act(() =>
        useDashboardStore
          .getState()
          .moveToHalf("session-11", "right", ["session-10", "session-11"]),
      );
      act(() => foldHarness.rightHalf!.onUse());
      expect(useDashboardStore.getState().focusedHalf).toBe("right");
      // A path outside the session's root opens nothing and keeps focus.
      act(() => foldHarness.rightHalf!.onOpenFile!("../elsewhere.ts"));
      expect(api.addPanel).not.toHaveBeenCalledWith(
        expect.objectContaining({ component: "file-editor" }),
      );
      expect(useDashboardStore.getState().focusedHalf).toBe("right");
      act(() => foldHarness.rightHalf!.onOpenFile!("./src/a.ts", 12));
      expect(api.addPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "file-editor-7",
          component: "file-editor",
          params: expect.objectContaining({ projectId: 7, path: "src/a.ts", line: 12 }),
        }),
      );
      expect(useDashboardStore.getState().focusedHalf).toBe("left");
    } finally {
      useDashboardStore.setState({ projects });
    }
  });

  // #3053 — a stale stored assignment can put every open pane on the right
  // half; on load the right half's shown one comes to the left, which has
  // the header, the "x" and the menu.
  it("moves the right half's pane to the left half when no tiled pane is left there", async () => {
    persistenceHarness.restoredWorkspaceIdRef.current = 1;
    useDashboardStore.setState({
      sessionsLoaded: true,
      foldHalves: {
        1: { ...EMPTY_FOLD_HALVES, right: ["session-10", "session-11"], shownRight: "session-11" },
      },
    });
    try {
      const api = makeApi();
      await renderHalves(false, api);
      const state = useDashboardStore.getState().foldHalves[1]!;
      expect(state.right).toEqual(["session-10"]);
      expect(state.shownLeft).toBe("session-11");
      expect(api.maximizeGroup).toHaveBeenCalledWith(api.panels[1]);
      expect(railHarness.props?.panes.map((p) => p.id)).toEqual(["session-11"]);
    } finally {
      persistenceHarness.restoredWorkspaceIdRef.current = null;
    }
  });

  // #3053 — the Browser and Dock views exist only on the halves, where an
  // open one covers the right half: a fresh start does not reopen them.
  // Through a fresh store, since the store reads localStorage once, at load.
  it("does not restore an open Browser or Dock view on load; other views come back", async () => {
    for (const [view, open] of [
      ["browser", false],
      ["dock", false],
      ["git", true],
    ] as const) {
      localStorage.setItem("crs.rightSidebarOpen", "1");
      localStorage.setItem("crs.rightSidebarView", view);
      vi.resetModules();
      const fresh = await import("./store/index.js");
      const { App: FreshApp } = await import("./App.js");
      fresh.useDashboardStore.setState({
        activeWorkspaceId: 1,
        sessions: [session(10), session(11)],
        refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
        hydrateSettings: vi.fn(),
        startThemeWatch: vi.fn(() => () => {}),
      });
      stubWidth("halves");
      splitHarness.api = makeApi();
      const { container } = render(<FreshApp />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(fresh.useDashboardStore.getState().rightSidebarOpen, view).toBe(open);
      expect(fresh.useDashboardStore.getState().rightSidebarView).toBe(view);
      expect(
        !!container.querySelector('aside.right-sidebar-panel[aria-label$=" sidebar"]'),
        view,
      ).toBe(open);
      cleanup();
    }
  });

  it("lands a session launched from a half's + on that half", async () => {
    await renderHalves();
    act(() => foldHarness.launcher?.onLaunched(session(12), { half: "right" }));
    expect(useDashboardStore.getState().foldHalves[1]?.right).toEqual(["session-12"]);
    expect(foldHarness.onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 12 }));
    // Without a half, nothing is assigned.
    act(() => foldHarness.launcher?.onLaunched(session(10), null));
    expect(useDashboardStore.getState().foldHalves[1]?.right).toEqual(["session-12"]);
  });

  it("opens the launcher for the half whose + was pressed", async () => {
    await renderHalves();
    act(() => railHarness.props?.onNewSession());
    expect(useDashboardStore.getState().launcherRequest?.target).toEqual({ half: "left" });
    const rail = screen.getByRole("navigation", { name: "Right sidebar" });
    act(() => {
      fireEvent.click(within(rail).getByRole("button", { name: "New session" }));
    });
    expect(useDashboardStore.getState().launcherRequest?.target).toEqual({ half: "right" });
    act(() => useDashboardStore.setState({ launcherRequest: null }));
  });

  it("closes a pane from a rail entry's long-press menu, and moves it between halves", async () => {
    await renderHalves();
    const api = splitHarness.api as unknown as ReturnType<typeof makeApi>;
    const entry = { panelId: "session-11" } as Parameters<
      NonNullable<NonNullable<typeof railHarness.props>["menuItems"]>
    >[0];
    const items = railHarness.props?.menuItems?.(entry) ?? [];
    expect(items.map((i) => i.label)).toEqual(["Move to the right half", "Close pane"]);
    act(() => items[0]!.onSelect());
    expect(useDashboardStore.getState().foldHalves[1]?.right).toEqual(["session-11"]);
    act(() => items[1]!.onSelect());
    expect(api.panels[1]!.api.close).toHaveBeenCalled();
  });

  // Design 9.2 across 700px with App's own wiring: the band and the tier are
  // separate state, crossed here one commit apart in both orders.
  it("keeps the halves' assignment and the right half through a fold to the phone", async () => {
    const live = stubLiveWidth("halves");
    splitHarness.api = makeApi();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    const setTier = (tier: "phone" | "tablet") =>
      act(() => vi.mocked(useLayoutPresentation).mock.calls.at(-1)![0].setLayoutTier(tier));
    act(() => useDashboardStore.setState({ activePanelId: "session-10" }));
    act(() =>
      useDashboardStore.getState().moveToHalf("session-11", "right", ["session-10", "session-11"]),
    );
    // A view open on the right half, but the left session used after it.
    act(() => useDashboardStore.getState().openRightSidebarView("git"));
    act(() => useDashboardStore.getState().noteHalfUsed({ kind: "pane", panelId: "session-10" }));
    const before = useDashboardStore.getState().foldHalves[1];

    live.resize("phone"); // the band first
    setTier("phone");
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
    expect(screen.queryByTestId("right-half")).toBeNull();
    expect(useDashboardStore.getState().foldHalves[1]).toEqual(before);

    setTier("tablet"); // the tier first
    live.resize("halves");
    const state = useDashboardStore.getState();
    expect(state.foldHalves[1]).toEqual(before);
    expect(state.rightSidebarOpen).toBe(true);
    expect(state.rightSidebarView).toBe("git");
    // Closing the view uncovers the right half's session again.
    act(() => useDashboardStore.getState().closeRightSidebar());
    expect(screen.getByTestId("right-half")).toHaveAttribute("data-session", "11");
  });

  // The right sidebar's per-session views (Browser and Dock, #3032) follow the
  // store's active panel: using the right half's session leaves it on the
  // left half's pane, so they follow the left half.
  it("leaves the active panel on the left half's pane while the right half is used", async () => {
    await renderHalves();
    act(() => useDashboardStore.setState({ activePanelId: "session-10" }));
    act(() =>
      useDashboardStore.getState().moveToHalf("session-11", "right", ["session-10", "session-11"]),
    );
    act(() => foldHarness.rightHalf!.onUse());
    const state = useDashboardStore.getState();
    expect(state.focusedHalf).toBe("right");
    expect(state.activePanelId).toBe("session-10");
  });

  // Review of #3035: the left half shows a tiled pane only, so a float does
  // not keep it from being empty.
  it("does not move the only tiled pane right beside a floating one", async () => {
    await renderHalves(false, makeApi([11]));
    act(() => useDashboardStore.setState({ activePanelId: "session-10" }));
    const entry = { panelId: "session-10" } as Parameters<
      NonNullable<NonNullable<typeof railHarness.props>["menuItems"]>
    >[0];
    expect((railHarness.props?.menuItems?.(entry) ?? []).map((i) => i.label)).toEqual([
      "Close pane",
    ]);
    expect(screen.queryByRole("button", { name: "Move to the right half" })).toBeNull();
    // A launch onto the right half is refused too: it would empty the left.
    act(() => foldHarness.launcher?.onLaunched(session(10), { half: "right" }));
    expect(useDashboardStore.getState().foldHalves[1]?.right ?? []).toEqual([]);
  });

  it("lands the right half's + on the left in a workspace with no pane yet", async () => {
    await renderHalves(false, makeApi([], []));
    act(() => foldHarness.launcher?.onLaunched(session(12), { half: "right" }));
    expect(useDashboardStore.getState().foldHalves[1]?.right ?? []).toEqual([]);
    expect(foldHarness.onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 12 }));
  });

  it("gives the left header no right-half pane, even while one is active", async () => {
    const { container } = await renderHalves();
    act(() =>
      useDashboardStore.getState().moveToHalf("session-11", "right", ["session-10", "session-11"]),
    );
    const title = () => container.querySelector(".half-header-title");
    act(() => useDashboardStore.setState({ activePanelId: "session-11" }));
    expect(title()).toBeNull();
    act(() => useDashboardStore.setState({ activePanelId: "session-10" }));
    expect(title()).toHaveTextContent("session 10");
  });

  it("toggles a right-rail session like a view tab, and uncovers the half from a view", async () => {
    await renderHalves();
    act(() =>
      useDashboardStore.getState().moveToHalf("session-11", "right", ["session-10", "session-11"]),
    );
    const rail = screen.getByRole("navigation", { name: "Right sidebar" });
    const entry = () => within(rail).getByRole("button", { name: /session 11/ });
    act(() => {
      fireEvent.click(entry());
    });
    expect(screen.queryByTestId("right-half")).toBeNull();
    act(() => {
      fireEvent.click(entry());
    });
    expect(screen.getByTestId("right-half")).toBeInTheDocument();
    act(() => useDashboardStore.setState({ rightSidebarOpen: true }));
    expect(screen.queryByTestId("right-half")).toBeNull();
    act(() => {
      fireEvent.click(entry());
    });
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
    expect(screen.getByTestId("right-half")).toBeInTheDocument();
  });

  // #3015 — a session arriving on the right half mounts fresh, so its arrival
  // plays (styles/motion.css) instead of the terminal swapping in place.
  it("mounts the right half afresh for each session that arrives on it", async () => {
    const ids = [10, 11, 12];
    await renderHalves(false, makeApi([], ids));
    act(() =>
      useDashboardStore.getState().moveToHalf(
        "session-11",
        "right",
        ids.map((id) => `session-${id}`),
      ),
    );
    const first = screen.getByTestId("right-half");
    expect(first).toHaveAttribute("data-session", "11");
    act(() =>
      useDashboardStore.getState().moveToHalf(
        "session-12",
        "right",
        ids.map((id) => `session-${id}`),
      ),
    );
    const second = screen.getByTestId("right-half");
    expect(second).toHaveAttribute("data-session", "12");
    expect(second).not.toBe(first);
  });
});
