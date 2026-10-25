// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LayoutMode, Session } from "./api/index.js";

// Set by the pane-cap test before render. Null keeps every other test on the
// old path: DockviewReact never reports an api, and the palette stays empty.
const { splitHarness } = vi.hoisted(() => ({
  splitHarness: {
    api: null as {
      panels: unknown[];
      activePanel: null;
      getPanel: (id: string) => unknown;
      addPanel: (opts: { id: string; params?: { sessionId?: number } }) => void;
      onDidActivePanelChange: () => { dispose: () => void };
      onDidAddPanel: () => { dispose: () => void };
    } | null,
    launch: null as {
      id: number;
      projectId: number;
      name: string | null;
      nameLocked: boolean;
      lastTitle: string | null;
      command: string;
    } | null,
    announced: false,
  },
}));

// App is the integration seam for every layout tier, and nothing mounted it
// before the tablet-tier carry-over series. This is a deliberately shallow
// smoke harness: every child component and network-touching hook is stubbed,
// so what's under test is App's OWN tier wiring (initial tier seeding, the
// `data-tier` attribute, compact-vs-desktop sidebar semantics) — not the
// children, which have their own suites. jsdom does no layout, so geometry
// is out of scope here.

vi.mock("dockview-react", () => ({
  DockviewReact: (props: { onReady?: (event: { api: unknown }) => void }) => {
    if (splitHarness.api && !splitHarness.announced) {
      splitHarness.announced = true;
      queueMicrotask(() => props.onReady?.({ api: splitHarness.api }));
    }
    return <div data-testid="dockview" />;
  },
}));
vi.mock("dockview-react/dist/styles/dockview.css", () => ({}));
vi.mock("./Sidebar.js", () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
vi.mock("./WorkspaceSwitcher.js", () => ({
  WorkspaceSwitcher: ({ onSelectWorkspace }: { onSelectWorkspace?: (id: number) => void }) => (
    <span data-testid="workspace-switcher">
      {splitHarness.launch ? (
        <button type="button" data-testid="show-workspace" onClick={() => onSelectWorkspace?.(2)} />
      ) : null}
    </span>
  ),
}));
vi.mock("./PhoneNavigator.js", () => ({
  PhoneNavigatorPanel: ({
    tablet,
    workspaces,
  }: {
    tablet?: boolean;
    workspaces?: React.ReactNode;
  }) => (
    <div data-testid="navigator" data-tablet={String(!!tablet)}>
      {workspaces}
    </div>
  ),
}));
vi.mock("./Toolbar.js", () => ({
  Toolbar: ({
    onToggleSidebar,
    notificationSheet,
    mobileSessionSlot,
  }: {
    onToggleSidebar: () => void;
    notificationSheet?: boolean;
    mobileSessionSlot?: React.ReactNode;
  }) => (
    <div>
      <button
        data-testid="toggle-sidebar"
        data-notif-sheet={String(!!notificationSheet)}
        onClick={onToggleSidebar}
      />
      {mobileSessionSlot}
    </div>
  ),
}));
vi.mock("./MobileKeyBar.js", () => ({ MobileKeyBar: () => null }));
vi.mock("./MobileSessionBar.js", () => ({
  MobileSessionBar: ({ tier, contextLabel }: { tier: string; contextLabel?: string }) => (
    <span data-testid="session-bar" data-tier={tier} data-context={contextLabel ?? ""} />
  ),
}));
vi.mock("./PaneHeaderActions.js", () => ({ PaneHeaderActions: () => null }));
vi.mock("./CommandPalette.js", () => ({
  CommandPalette: (props: {
    onLaunched?: (session: NonNullable<typeof splitHarness.launch>) => void;
  }) =>
    splitHarness.launch ? (
      <button
        type="button"
        data-testid="launch-split"
        onClick={() => props.onLaunched?.(splitHarness.launch!)}
      />
    ) : null,
}));
vi.mock("./Dock.js", () => ({ Dock: () => null }));
vi.mock("./ResourceAlertBanner.js", () => ({ ResourceAlertBanner: () => null }));
vi.mock("./panels/registry.js", () => ({
  components: {},
  tabComponents: {},
  KanbanBoardOverlay: () => <div data-testid="kanban-overlay" />,
}));
vi.mock("./Settings.js", () => ({ Settings: () => null }));
vi.mock("./terminalRepaintRegistry.js", () => ({ repaintAllTerminals: vi.fn() }));
vi.mock("./pushClient.js", () => ({ ensurePushSubscribed: vi.fn().mockResolvedValue(undefined) }));

// Hooks that talk to the network, the DOM globally, or dockview.
vi.mock("./hooks/useAppStreams.js", () => ({ useAppStreams: vi.fn() }));
vi.mock("./hooks/usePolling.js", () => ({ usePolling: vi.fn() }));
vi.mock("./hooks/useAttentionNotifications.js", () => ({ useAttentionNotifications: vi.fn() }));
vi.mock("./hooks/useSessionDeepLink.js", () => ({ useSessionDeepLink: vi.fn() }));
vi.mock("./hooks/useOpenSessionRequest.js", () => ({ useOpenSessionRequest: vi.fn() }));
vi.mock("./hooks/useGlobalShortcuts.js", () => ({ useGlobalShortcuts: vi.fn() }));
vi.mock("./hooks/useDockviewDrop.js", () => ({
  useDockviewDrop: () => ({ dockviewRef: { current: null } }),
}));
vi.mock("./hooks/useWorkspacePersistence.js", () => ({
  useWorkspacePersistence: () => ({
    restoringRef: { current: false },
    restoredWorkspaceIdRef: { current: null },
  }),
}));
vi.mock("./hooks/useLayoutPresentation.js", () => ({ useLayoutPresentation: vi.fn() }));
vi.mock("./hooks/useVisualViewportInset.js", () => ({ useVisualViewportInset: vi.fn() }));
vi.mock("./hooks/usePanelOpener.js", () => ({ usePanelOpener: () => ({}) }));
vi.mock("./hooks/usePhoneTasksNavigator.js", () => ({ usePhoneTasksNavigator: vi.fn() }));
vi.mock("./hooks/usePhoneBackStack.js", () => ({ usePhoneBackStack: vi.fn() }));
vi.mock("./lib/sidebarSwipeGesture.js", () => ({
  attachSidebarSwipeGesture: vi.fn(() => () => {}),
}));

import { App } from "./App.js";
import { useDashboardStore } from "./store/index.js";
import { attachSidebarSwipeGesture } from "./lib/sidebarSwipeGesture.js";
import { usePhoneBackStack } from "./hooks/usePhoneBackStack.js";

function setLayoutMode(layoutMode: LayoutMode) {
  useDashboardStore.setState({
    settings: { ...useDashboardStore.getState().settings, layoutMode },
  });
}

// matchMedia stub keyed on the width tier the test wants to simulate.
function stubWidth(tier: "phone" | "tablet" | "desktop", coarse = false) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches:
        (tier === "phone" && query.includes("max-width: 699.98px")) ||
        (tier === "tablet" && query.includes("min-width: 700px")) ||
        (tier === "desktop" && query.includes("min-width: 1280px")) ||
        (coarse && query === "(pointer: coarse)"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

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
    ["phone", true],
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

  // The drawer registers with the back stack on every compact tier (not just
  // phone), so Android back closes it on the unfolded Fold too.
  it.each([
    ["phone", true],
    ["tablet", true],
    ["desktop", false],
  ] as const)(
    "registers the open drawer with the back stack on %s only when compact",
    (tier, expected) => {
      stubWidth(tier);
      render(<App />);
      expect(usePhoneBackStack).toHaveBeenLastCalledWith(false, expect.any(Function));
      if (tier === "desktop") return;
      fireEvent.click(screen.getByTestId("toggle-sidebar"));
      expect(usePhoneBackStack).toHaveBeenLastCalledWith(expected, expect.any(Function));
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

  // The session picker takes over the toolbar centre on every compact tier;
  // only tablet (where workspaces exist) labels it with the workspace name.
  it.each([
    ["phone", true],
    ["tablet", true],
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

  // Compact tiers get the tabbed navigator in the drawer; only tablet has
  // workspaces, so only tablet passes the switcher slot.
  it.each([
    ["phone", false, false],
    ["tablet", true, true],
  ] as const)(
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

  // Tasks: the grid overlay is desktop-only; compact tiers keep the board in
  // the navigator, which widens (nav-tasks) while it's showing.
  it.each([
    ["desktop", true, false],
    ["tablet", false, true],
    ["phone", false, true],
  ] as const)("Tasks view on %s: overlay=%s, nav-tasks class=%s", (tier, overlay, navTasks) => {
    stubWidth(tier);
    useDashboardStore.setState({ viewMode: "kanban" });
    const { container } = render(<App />);
    expect(!!screen.queryByTestId("kanban-overlay")).toBe(overlay);
    expect(container.querySelector(".app")!.classList.contains("nav-tasks")).toBe(navTasks);
    useDashboardStore.setState({ viewMode: "list" });
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

describe("App tablet pane-cap notice", () => {
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
        tabletPaneCap: 2,
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

  it("warns once for an explicit split past the cap, and clears on a workspace switch", async () => {
    render(<App />);
    const launch = await screen.findByTestId("launch-split");
    fireEvent.click(launch);
    // Scoped to the app's OWN notice rather than "any role=status" — the
    // app also mounts the app-wide toast host, which is a role=status
    // region that is always present (the global toast slice).
    const notice = await screen.findByText(/This split is past the tablet pane cap/);
    expect(notice).toHaveAttribute("role", "status");
    expect(splitHarness.api?.addPanel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("show-workspace"));
    expect(screen.queryByText(/This split is past the tablet pane cap/)).toBeNull();

    useDashboardStore.setState({
      splitRequest: { referencePanelId: "session-1", direction: "right" },
    });
    // A second split of the same session only focuses the panel already
    // added. A new session is what can add another column.
    splitHarness.launch = { ...splitHarness.launch!, id: 10 };
    fireEvent.click(await screen.findByTestId("launch-split"));
    expect(screen.queryByText(/This split is past the tablet pane cap/)).toBeNull();
    expect(splitHarness.api?.addPanel).toHaveBeenCalledTimes(2);
  });
});
