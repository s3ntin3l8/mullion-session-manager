// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Session } from "./api/index.js";
// The mocks live in the shared harness; import it before App.
import {
  splitHarness,
  sidebarHarness,
  dockHarness,
  persistenceHarness,
  railHarness,
  setLayoutMode,
  stubWidth,
} from "./test/appHarness.js";
import { App } from "./App.js";
import { useDashboardStore } from "./store/index.js";
import { attachSidebarSwipeGesture } from "./lib/sidebarSwipeGesture.js";
import { usePhoneBackStack } from "./hooks/usePhoneBackStack.js";

describe("App tier wiring", () => {
  beforeEach(() => {
    // Mount-time store actions that would otherwise hit the network (and
    // hydrateSettings would overwrite the layoutMode each test sets).
    useDashboardStore.setState({
      refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
      hydrateSettings: vi.fn(),
      startThemeWatch: vi.fn(() => () => {}),
    });
    setLayoutMode("auto");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each(["phone", "tablet", "desktop"] as const)(
    "seeds data-tier from the live width on the first render (%s)",
    (tier) => {
      stubWidth(tier);
      const { container } = render(<App />);
      expect(container.querySelector(".app")?.getAttribute("data-tier")).toBe(tier);
    },
  );

  it.each([
    [500, "phone"],
    [750, "rails-full"],
    [1000, "rails-halves"],
    [1200, "desktop-narrow"],
    [1500, "desktop"],
  ])("exposes data-band next to data-tier at %s px (%s)", (width, band) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => {
        const min = /min-width: ([\d.]+)px/.exec(query);
        const max = /max-width: ([\d.]+)px/.exec(query);
        return {
          matches: (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
      }),
    );
    const { container } = render(<App />);
    expect(container.querySelector(".app")?.getAttribute("data-band")).toBe(band);
  });

  it("lets an explicit layoutMode override the width", () => {
    stubWidth("desktop");
    setLayoutMode("tablet");
    const { container } = render(<App />);
    expect(container.querySelector(".app")?.getAttribute("data-tier")).toBe("tablet");
  });

  it("toggles the floating sidebar overlay on a compact tier", () => {
    stubWidth("tablet");
    const { container } = render(<App />);
    const app = container.querySelector(".app")!;
    expect(app.classList.contains("sb-open")).toBe(false);
    fireEvent.click(screen.getByTestId("toggle-sidebar"));
    expect(app.classList.contains("sb-open")).toBe(true);
    // The swipe-dismiss gesture attaches to the wrapper while it's open.
    expect(attachSidebarSwipeGesture).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("toggle-sidebar"));
    expect(app.classList.contains("sb-open")).toBe(false);
  });

  // The compact tier's drawer is closed by sliding it off-screen
  // (`transform: translateX(-101%)`), which left every control inside it —
  // session rows, the filter input, the per-row kebab menus — focusable and
  // in the accessibility tree while they sat off-screen. A keyboard user
  // tabbing through the app landed on controls they could not see, and a
  // screen reader read the whole hidden tree.
  //
  // `inert` takes the whole subtree out of both. It is applied only on the
  // compact tier: the desktop sidebar is permanently visible, so making it
  // inert while the (desktop-default) `sidebarOpen` is false would hide a
  // visible panel.
  it.each([
    ["tablet", true],
    ["desktop", false],
  ] as const)("marks the drawer inert while it is closed on %s", (tier, inertWhenClosed) => {
    stubWidth(tier);
    const { container } = render(<App />);
    const drawer = container.querySelector(".sidebar-wrapper")!;
    expect(drawer.hasAttribute("inert")).toBe(inertWhenClosed);
    if (tier === "desktop") return;
    fireEvent.click(screen.getByTestId("toggle-sidebar"));
    expect(drawer.hasAttribute("inert")).toBe(false);
  });

  // #3014 — the phone has no drawer: no wrapper, no scrim, no toggle in the
  // top bar, no edge swipe, and no back-stack entry for one.
  it("has no drawer on the phone, and nothing can open one", () => {
    stubWidth("phone", true);
    vi.mocked(attachSidebarSwipeGesture).mockClear();
    const { container } = render(<App />);
    expect(container.querySelector(".sidebar-wrapper")).toBeNull();
    // The sidebar still mounts, hidden, for its data loading and subscriptions.
    const host = container.querySelector(".phone-sidebar-host")!;
    expect(host).toHaveAttribute("hidden");
    expect(host.hasAttribute("inert")).toBe(true);
    expect(within(host as HTMLElement).getByTestId("sidebar")).toBeInTheDocument();
    expect(container.querySelector(".cmux-scrim")).toBeNull();
    expect(screen.queryByTestId("toggle-sidebar")).toBeNull();
    expect(screen.queryByTestId("navigator")).toBeNull();
    expect(attachSidebarSwipeGesture).not.toHaveBeenCalled();
    expect(container.querySelector(".app")!.classList.contains("sb-open")).toBe(false);
    expect(vi.mocked(usePhoneBackStack).mock.calls.every(([active]) => active === false)).toBe(
      true,
    );
  });

  // The phone's mode bar (#3014) replaces the drawer; from 700px the rail has
  // the mode switch.
  it.each([
    ["phone", true],
    ["tablet", false],
    ["desktop", false],
  ] as const)("renders the mode bar on %s: %s", (tier, expected) => {
    stubWidth(tier);
    const { container } = render(<App />);
    expect(!!screen.queryByTestId("mode-bar")).toBe(expected);
    expect(container.querySelector(".app")!.classList.contains("mode-bar")).toBe(expected);
  });

  // #3014 — after "Open session in Workspace" from a task, back returns to
  // Tasks mode (and the task); no other back changes mode.
  it("registers the cross-link's way back to Tasks on the phone", () => {
    stubWidth("phone");
    useDashboardStore.setState({ viewMode: "kanban", selectedTaskId: 7 });
    render(<App />);
    const crossLinkEntry = () =>
      vi
        .mocked(usePhoneBackStack)
        .mock.calls.filter(([active]) => active)
        .map(([, close]) => close);
    expect(crossLinkEntry()).toHaveLength(0);
    act(() => useDashboardStore.getState().openSessionInWorkspace(3));
    const entries = crossLinkEntry();
    expect(entries.length).toBeGreaterThan(0);
    act(() => entries.at(-1)!());
    const state = useDashboardStore.getState();
    expect(state.viewMode).toBe("kanban");
    expect(state.selectedTaskId).toBe(7);
    expect(state.rightSidebarView).toBe("tasks");
    expect(state.crossLinkReturn).toBeNull();
    act(() => useDashboardStore.getState().closeRightSidebar());
    act(() => useDashboardStore.getState().setViewMode("list"));
  });

  it("does not register a way back to Tasks after a plain mode switch", () => {
    stubWidth("phone");
    useDashboardStore.setState({ viewMode: "kanban" });
    render(<App />);
    vi.mocked(usePhoneBackStack).mockClear();
    act(() => useDashboardStore.getState().setViewMode("list"));
    expect(vi.mocked(usePhoneBackStack).mock.calls.every(([active]) => active === false)).toBe(
      true,
    );
  });

  // The drawer registers with the back stack on every compact tier that has
  // one, so Android back closes it on the unfolded Fold too.
  it.each([
    ["tablet", true],
    ["desktop", false],
  ] as const)(
    "registers the open drawer with the back stack on %s only when compact",
    (tier, expected) => {
      stubWidth(tier);
      render(<App />);
      // Nothing is registered active while closed: the drawer's entry and the
      // right sidebar's are both inactive.
      const calls = vi.mocked(usePhoneBackStack).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(([active]) => active === false)).toBe(true);
      if (tier === "desktop") return;
      // Not "last called with": the right sidebar registers its own (inactive)
      // entry on the same render, after the drawer's. Only calls made by the
      // click count.
      vi.mocked(usePhoneBackStack).mockClear();
      fireEvent.click(screen.getByTestId("toggle-sidebar"));
      expect(usePhoneBackStack).toHaveBeenCalledWith(expected, expect.any(Function));
    },
  );

  // Notifications render as a bottom sheet on touch tablets (not the popover),
  // but a mouse-driven tablet-width window and desktop keep the popover.
  it.each([
    ["tablet", true, "true"],
    ["tablet", false, "false"],
    ["desktop", true, "false"],
  ] as const)("notificationSheet on %s (coarse=%s) is %s", (tier, coarse, expected) => {
    stubWidth(tier, coarse);
    render(<App />);
    expect(screen.getByTestId("toggle-sidebar")).toHaveAttribute("data-notif-sheet", expected);
  });

  // The session picker lives in the phone's top bar; from 700px there is no
  // top bar (#3009), so no picker either.
  it.each([
    ["phone", true],
    ["tablet", false],
    ["desktop", false],
  ] as const)("renders the session picker on %s: %s", (tier, expected) => {
    stubWidth(tier);
    render(<App />);
    const bar = screen.queryByTestId("session-bar");
    expect(!!bar).toBe(expected);
    if (bar) expect(bar).toHaveAttribute("data-tier", tier);
  });

  it("gives the phone picker no workspace label (phone has no workspaces)", () => {
    stubWidth("phone");
    render(<App />);
    expect(screen.getByTestId("session-bar")).toHaveAttribute("data-context", "");
  });

  // The tablet gets the tabbed navigator in the drawer, with the workspace
  // switcher slot. The phone has neither (#3014).
  it.each([["tablet", true, true]] as const)(
    "renders the navigator on %s (tablet=%s, workspaces slot=%s)",
    (tier, isTablet, hasWs) => {
      stubWidth(tier);
      render(<App />);
      expect(screen.getByTestId("navigator")).toHaveAttribute("data-tablet", String(isTablet));
      expect(!!screen.queryByTestId("workspace-switcher")).toBe(hasWs);
    },
  );

  it("renders the plain sidebar + workspace switcher on desktop (no navigator)", () => {
    stubWidth("desktop");
    render(<App />);
    expect(screen.queryByTestId("navigator")).toBeNull();
    expect(screen.getByTestId("workspace-switcher")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  });

  // Tasks mode is the board over the grid on every tier: #3009 from 700px,
  // #3014 on the phone, where it shows one lane at a time.
  it.each([
    ["desktop", "false"],
    ["tablet", "false"],
    ["phone", "true"],
  ] as const)("Tasks view on %s is the grid overlay (phone layout: %s)", (tier, phone) => {
    stubWidth(tier);
    useDashboardStore.setState({ viewMode: "kanban" });
    render(<App />);
    expect(screen.getByTestId("kanban-overlay")).toHaveAttribute("data-phone", phone);
    useDashboardStore.setState({ viewMode: "list" });
  });

  // #3009 — the top bar is the phone's only; from 700px the left rail
  // replaces it.
  it.each([
    ["phone", true, false],
    ["tablet", false, true],
    ["desktop", false, true],
  ] as const)("on %s renders the top bar: %s, the left rail: %s", (tier, bar, rail) => {
    stubWidth(tier);
    render(<App />);
    expect(!!screen.queryByTestId("toolbar")).toBe(bar);
    expect(!!screen.queryByTestId("left-rail")).toBe(rail);
  });

  it("marks the mode on the shell and drops the Dock in Tasks mode from 700px", () => {
    stubWidth("desktop");
    const { container } = render(<App />);
    const app = container.querySelector(".app")!;
    expect(app.getAttribute("data-mode")).toBe("workspace");
    expect(dockHarness.props).not.toBeNull();
    dockHarness.props = null;
    act(() => useDashboardStore.setState({ viewMode: "kanban" }));
    expect(app.getAttribute("data-mode")).toBe("tasks");
    expect(dockHarness.props).toBeNull();
    act(() => useDashboardStore.setState({ viewMode: "list" }));
  });

  it("drops the Dock on the phone in Tasks mode too, where the board takes the grid", () => {
    stubWidth("phone");
    dockHarness.props = null;
    useDashboardStore.setState({ viewMode: "kanban" });
    render(<App />);
    expect(dockHarness.props).toBeNull();
    useDashboardStore.setState({ viewMode: "list" });
  });

  it("closes the tablet drawer when Tasks mode starts from anywhere", () => {
    stubWidth("tablet");
    const { container } = render(<App />);
    const app = container.querySelector(".app")!;
    fireEvent.click(screen.getByTestId("toggle-sidebar"));
    expect(app.classList.contains("sb-open")).toBe(true);
    expect(screen.getByTestId("left-rail")).toHaveAttribute("data-sidebar-shown", "true");
    act(() => useDashboardStore.getState().setViewMode("kanban"));
    expect(app.classList.contains("sb-open")).toBe(false);
    act(() => useDashboardStore.getState().setViewMode("list"));
  });

  it("does not let the tablet drawer be swiped open in Tasks mode", () => {
    stubWidth("tablet");
    useDashboardStore.setState({ viewMode: "kanban" });
    vi.mocked(attachSidebarSwipeGesture).mockClear();
    render(<App />);
    expect(attachSidebarSwipeGesture).not.toHaveBeenCalled();
    act(() => useDashboardStore.getState().setViewMode("list"));
    expect(attachSidebarSwipeGesture).toHaveBeenCalled();
  });

  it("tells the rail whether the docked sidebar shows on desktop", () => {
    stubWidth("desktop");
    useDashboardStore.setState({ sidebarCollapsed: false });
    render(<App />);
    const rail = screen.getByTestId("left-rail");
    expect(rail).toHaveAttribute("data-sidebar-shown", "true");
    act(() => {
      fireEvent.click(screen.getByTestId("toggle-sidebar"));
    });
    expect(rail).toHaveAttribute("data-sidebar-shown", "false");
    act(() => useDashboardStore.setState({ sidebarCollapsed: false }));
  });

  it("collapses (rather than opens) the docked sidebar on desktop", () => {
    stubWidth("desktop");
    const { container } = render(<App />);
    const app = container.querySelector(".app")!;
    act(() => {
      fireEvent.click(screen.getByTestId("toggle-sidebar"));
    });
    expect(app.classList.contains("sb-open")).toBe(false);
    expect(useDashboardStore.getState().sidebarCollapsed).toBe(true);
  });
});

// Issue #1618 — the mount-time workspace load retries a bounded number of
// times, and a failed "Default" bootstrap is handled instead of latching.
describe("App workspace bootstrap", () => {
  const workspace = {
    id: 7,
    name: "Default",
    layout: null,
    groupId: null,
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    stubWidth("desktop");
    useDashboardStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      hydrateSettings: vi.fn(),
      startThemeWatch: vi.fn(() => () => {}),
    });
    setLayoutMode("auto");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("retries a failed initial load, then bootstraps once it succeeds", async () => {
    const refreshWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const createWorkspace = vi.fn().mockResolvedValue(workspace);
    useDashboardStore.setState({ refreshWorkspaces, createWorkspace });

    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(1);
    expect(createWorkspace).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(3);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledWith("Default");
    expect(useDashboardStore.getState().activeWorkspaceId).toBe(workspace.id);
  });

  it("gives up after the bounded number of attempts without bootstrapping", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const refreshWorkspaces = vi.fn().mockRejectedValue(new Error("offline"));
    const createWorkspace = vi.fn().mockResolvedValue(workspace);
    useDashboardStore.setState({ refreshWorkspaces, createWorkspace });

    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(5);
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[workspace] failed to load workspaces, giving up",
      expect.any(Error),
    );

    // Coming back online starts a fresh round, which now succeeds and
    // bootstraps — the give-up isn't terminal for the session.
    refreshWorkspaces.mockResolvedValue(undefined);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(6);
    expect(createWorkspace).toHaveBeenCalledTimes(1);

    // Disarmed after re-arming once: a second event doesn't reload again.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(6);
  });

  it("ignores a hidden-tab visibilitychange and stops listening after unmount", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refreshWorkspaces = vi.fn().mockRejectedValue(new Error("offline"));
    useDashboardStore.setState({ refreshWorkspaces, createWorkspace: vi.fn() });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    const { unmount } = render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(5);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(5);

    visibility.mockReturnValue("visible");
    unmount();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(5);
  });

  it("handles a failed Default bootstrap instead of leaving an unhandled rejection", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const refreshWorkspaces = vi.fn().mockResolvedValue(undefined);
    const createWorkspace = vi.fn().mockRejectedValue(new Error("boom"));
    useDashboardStore.setState({ refreshWorkspaces, createWorkspace });

    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[workspace] failed to create the default workspace",
      expect.any(Error),
    );
  });

  it("surfaces a given-up workspace load and clears it from Retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refreshWorkspaces = vi.fn().mockRejectedValue(new Error("offline"));
    const createWorkspace = vi.fn().mockResolvedValue(workspace);
    useDashboardStore.setState({ refreshWorkspaces, createWorkspace });

    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load workspaces");
    expect(createWorkspace).not.toHaveBeenCalled();

    refreshWorkspaces.mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(6);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("App explicit split on the tablet", () => {
  function referenceSession(id: number): Session {
    return {
      id,
      projectId: 7,
      name: null,
      nameLocked: false,
      lastTitle: null,
      command: "bash",
      status: "active",
      attention: false,
    } as Session;
  }

  function makeApi() {
    const panels = [
      {
        id: "session-1",
        params: { sessionId: 1 },
        api: { location: { type: "grid" }, setActive: vi.fn(), close: vi.fn() },
        group: { id: "g1" },
      },
      {
        id: "session-2",
        params: { sessionId: 2 },
        api: { location: { type: "grid" }, setActive: vi.fn(), close: vi.fn() },
        group: { id: "g2" },
      },
    ];
    return {
      panels,
      activePanel: null,
      getPanel: (id: string) => panels.find((panel) => panel.id === id) ?? null,
      addPanel: vi.fn((opts: { id: string; params?: { sessionId?: number } }) => {
        panels.push({
          id: opts.id,
          params: { sessionId: opts.params?.sessionId ?? 0 },
          api: { location: { type: "grid" }, setActive: vi.fn(), close: vi.fn() },
          group: { id: `g${panels.length + 1}` },
        });
      }),
      onDidActivePanelChange: () => ({ dispose: vi.fn() }),
      onDidAddPanel: () => ({ dispose: vi.fn() }),
      onWillMutateLayout: () => ({ dispose: vi.fn() }),
      onDidMutateLayout: () => ({ dispose: vi.fn() }),
    };
  }

  beforeEach(() => {
    stubWidth("tablet");
    splitHarness.announced = false;
    splitHarness.api = makeApi();
    splitHarness.launch = {
      id: 9,
      projectId: 7,
      name: null,
      nameLocked: false,
      lastTitle: null,
      command: "bash",
    };
    useDashboardStore.setState({
      refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
      hydrateSettings: vi.fn(),
      startThemeWatch: vi.fn(() => () => {}),
      showWorkspace: vi.fn(),
      workspaces: [
        {
          id: 1,
          name: "Default",
          layout: null,
          groupId: null,
          position: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      activeWorkspaceId: 1,
      sessions: [referenceSession(1), referenceSession(2)],
      projects: [],
      splitRequest: { referencePanelId: "session-1", direction: "right" },
      settings: {
        ...useDashboardStore.getState().settings,
        layoutMode: "tablet",
      },
    });
  });

  afterEach(() => {
    splitHarness.api = null;
    splitHarness.launch = null;
    splitHarness.announced = false;
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // #3010 removed the tablet pane cap and its notice: an explicit split
  // still adds the session, and nothing warns about columns any more.
  it("adds an explicit split's session without a pane-cap notice", async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId("launch-split"));
    expect(splitHarness.api?.addPanel).toHaveBeenCalledTimes(1);
    expect(splitHarness.api?.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-9",
        position: expect.objectContaining({ direction: "right" }),
      }),
    );
    expect(screen.queryByText(/pane cap/)).toBeNull();
  });
});

// Issue #1877 — workspaceProjectIdsFromPanels resolves panel sessionIds
// against `sessions`, which is [] until GET /api/sessions lands, while the
// layout restores on its own. Passing that [] scopes both the sidebar and
// the Dock to "nothing" and paints their empty-workspace copy. null is
// unscoped, and both surfaces have to receive that same value.
describe("App sidebar workspace scope", () => {
  function makeApi() {
    const panels = [
      {
        id: "session-10",
        params: { sessionId: 10 },
        api: { location: { type: "grid" }, setActive: vi.fn(), close: vi.fn() },
        group: { id: "g1" },
      },
    ];
    return {
      panels,
      activePanel: null,
      getPanel: (id: string) => panels.find((panel) => panel.id === id) ?? null,
      addPanel: vi.fn(),
      onDidActivePanelChange: () => ({ dispose: vi.fn() }),
      onDidAddPanel: () => ({ dispose: vi.fn() }),
      onWillMutateLayout: () => ({ dispose: vi.fn() }),
      onDidMutateLayout: () => ({ dispose: vi.fn() }),
    };
  }

  beforeEach(() => {
    stubWidth("desktop");
    splitHarness.announced = false;
    splitHarness.api = makeApi();
    splitHarness.launch = null;
    sidebarHarness.props = null;
    dockHarness.props = null;
    persistenceHarness.restoringRef.current = false;
    persistenceHarness.restoredWorkspaceIdRef.current = 1;
    useDashboardStore.setState({
      refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
      hydrateSettings: vi.fn(),
      startThemeWatch: vi.fn(() => () => {}),
      sessions: [],
      sessionsLoaded: false,
      activeWorkspaceId: 1,
      projects: [],
      settings: { ...useDashboardStore.getState().settings, layoutMode: "desktop" },
    });
  });

  afterEach(() => {
    splitHarness.api = null;
    splitHarness.launch = null;
    splitHarness.announced = false;
    persistenceHarness.restoredWorkspaceIdRef.current = null;
    sidebarHarness.props = null;
    dockHarness.props = null;
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("passes null — not an empty scope — until the sessions list has loaded", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    // Panels are already restored and the workspace id matches, but sessions
    // is still []. Without the sessionsLoaded gate this would be [] and the
    // sidebar would render "Nothing tiled in this workspace" while the Dock
    // rendered "No projects tiled in this workspace yet".
    expect(sidebarHarness.props?.workspaceProjectIds).toBeNull();
    expect(dockHarness.props?.workspaceProjectIds).toBeNull();
    expect(dockHarness.props?.workspaceProjectIds).toBe(sidebarHarness.props?.workspaceProjectIds);

    await act(async () => {
      useDashboardStore.setState({ sessionsLoaded: true });
    });
    // Loaded, and the restored panel's session is not in the list: a real
    // empty workspace, which both surfaces are allowed to call empty.
    // Same array, not a second empty list built for the Dock.
    expect(sidebarHarness.props?.workspaceProjectIds).toEqual([]);
    expect(dockHarness.props?.workspaceProjectIds).toBe(sidebarHarness.props?.workspaceProjectIds);
  });
});

// #3009 — the rail's middle region: the workspace chip, and the open panes
// while the left sidebar is not showing.
describe("App left rail middle region", () => {
  const setActive = vi.fn();
  function makeApi() {
    const panels = [
      {
        id: "session-10",
        title: "claude",
        params: { sessionId: 10 },
        api: { location: { type: "grid" }, setActive, close: vi.fn() },
        group: { id: "g1" },
      },
      {
        id: "git-3",
        title: "Git",
        params: {},
        api: { location: { type: "grid" }, setActive, close: vi.fn() },
        group: { id: "g1" },
      },
    ];
    return {
      panels,
      activePanel: null,
      getPanel: (id: string) => panels.find((panel) => panel.id === id) ?? null,
      addPanel: vi.fn(),
      onDidActivePanelChange: () => ({ dispose: vi.fn() }),
      onDidAddPanel: () => ({ dispose: vi.fn() }),
      onWillMutateLayout: () => ({ dispose: vi.fn() }),
      onDidMutateLayout: () => ({ dispose: vi.fn() }),
    };
  }

  beforeEach(() => {
    railHarness.props = null;
    splitHarness.announced = false;
    splitHarness.launch = null;
    setLayoutMode("auto");
    useDashboardStore.setState({
      viewMode: "list",
      sidebarCollapsed: false,
      refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
      hydrateSettings: vi.fn(),
      startThemeWatch: vi.fn(() => () => {}),
    });
  });

  afterEach(() => {
    splitHarness.api = null;
    splitHarness.announced = false;
    railHarness.props = null;
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    useDashboardStore.setState({ sidebarCollapsed: false });
  });

  it("lists the panes on desktop only while the docked sidebar is collapsed", () => {
    stubWidth("desktop");
    render(<App />);
    expect(railHarness.props?.showPanes).toBe(false);
    expect(railHarness.props?.sheet).toBe(false);
    act(() => {
      fireEvent.click(screen.getByTestId("toggle-sidebar"));
    });
    expect(railHarness.props?.showPanes).toBe(true);
  });

  it("lists the panes below 1280px while the drawer is closed, with the list as a sheet on touch", () => {
    stubWidth("tablet", true);
    render(<App />);
    expect(railHarness.props?.showPanes).toBe(true);
    expect(railHarness.props?.sheet).toBe(true);
    act(() => {
      fireEvent.click(screen.getByTestId("toggle-sidebar"));
    });
    expect(railHarness.props?.showPanes).toBe(false);
  });

  it("hands the rail every open pane and focuses the one tapped", async () => {
    stubWidth("tablet");
    splitHarness.api = makeApi();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(railHarness.props?.panes).toEqual([
      { id: "session-10", title: "claude", sessionId: 10 },
      { id: "git-3", title: "Git", sessionId: undefined },
    ]);
    act(() => railHarness.props?.onFocusPane("git-3"));
    expect(setActive).toHaveBeenCalledTimes(1);
    act(() => railHarness.props?.onFocusPane("gone"));
    expect(setActive).toHaveBeenCalledTimes(1);
  });

  it("starts a new session from the rail's + through the launcher (#3013)", () => {
    stubWidth("desktop");
    useDashboardStore.setState({ launcherRequest: null });
    render(<App />);
    act(() => railHarness.props?.onNewSession());
    expect(useDashboardStore.getState().launcherRequest).toMatchObject({ target: null });
    // The launcher, not the command palette.
    expect(screen.queryByTestId("palette")).toBeNull();
    act(() => useDashboardStore.setState({ launcherRequest: null }));
  });

  it("does not render the rail on the phone", () => {
    stubWidth("phone");
    render(<App />);
    expect(screen.queryByTestId("rail-middle")).toBeNull();
  });
});

// #3011 — from 700px the right sidebar's detail is the one task detail. A
// task notification (here its cold-start `?task=<id>`) at the fold's 851px
// selects the task in the sidebar and never asks for the docked panel; the
// phone, which has no right sidebar, still does.
describe("App task opening by tier (#3011)", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
      hydrateSettings: vi.fn(),
      startThemeWatch: vi.fn(() => () => {}),
      openTaskRequest: null,
      selectedTaskId: null,
      viewMode: "list",
      rightSidebarOpen: false,
    });
    setLayoutMode("auto");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("at 851px a task link opens in the sidebar, never the docked panel", () => {
    stubWidth("tablet");
    window.history.replaceState({}, "", "/?task=9");
    render(<App />);
    const state = useDashboardStore.getState();
    expect(state.openTaskRequest).toBeNull();
    expect(state.selectedTaskId).toBe(9);
    expect(state.rightSidebarView).toBe("tasks");
    expect(state.viewMode).toBe("kanban");
  });

  // #3014 — the phone shows the sidebar's detail full screen, and a cold
  // start with ?task= keeps it open (the "not at start" close is for the
  // docked sidebar's persisted state only).
  it("on the phone a task link opens the full-screen task over the board", () => {
    stubWidth("phone");
    // A view left open by the docked sidebar is closed at start; the link's
    // task then opens in the same flush and must stay open.
    useDashboardStore.setState({ rightSidebarOpen: true, rightSidebarView: "git" });
    window.history.replaceState({}, "", "/?task=9");
    const { container } = render(<App />);
    const state = useDashboardStore.getState();
    expect(state.openTaskRequest).toBeNull();
    expect(state.selectedTaskId).toBe(9);
    expect(state.rightSidebarOpen).toBe(true);
    expect(state.viewMode).toBe("kanban");
    expect(container.querySelector(".right-sidebar-panel.phone")).toBeTruthy();
    act(() => useDashboardStore.getState().closeRightSidebar());
  });
});
