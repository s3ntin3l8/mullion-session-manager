// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LayoutMode } from "./api/index.js";

// App is the integration seam for every layout tier, and nothing mounted it
// before the tablet-tier carry-over series. This is a deliberately shallow
// smoke harness: every child component and network-touching hook is stubbed,
// so what's under test is App's OWN tier wiring (initial tier seeding, the
// `data-tier` attribute, compact-vs-desktop sidebar semantics) — not the
// children, which have their own suites. jsdom does no layout, so geometry
// is out of scope here.

vi.mock("dockview-react", () => ({ DockviewReact: () => <div data-testid="dockview" /> }));
vi.mock("dockview-react/dist/styles/dockview.css", () => ({}));
vi.mock("./Sidebar.js", () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
vi.mock("./WorkspaceSwitcher.js", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("./PhoneNavigator.js", () => ({
  PhoneNavigatorPanel: () => <div data-testid="navigator" />,
}));
vi.mock("./Toolbar.js", () => ({
  Toolbar: ({
    onToggleSidebar,
    notificationSheet,
  }: {
    onToggleSidebar: () => void;
    notificationSheet?: boolean;
  }) => (
    <button
      data-testid="toggle-sidebar"
      data-notif-sheet={String(!!notificationSheet)}
      onClick={onToggleSidebar}
    />
  ),
}));
vi.mock("./MobileKeyBar.js", () => ({ MobileKeyBar: () => null }));
vi.mock("./MobileSessionBar.js", () => ({ MobileSessionBar: () => null }));
vi.mock("./PaneHeaderActions.js", () => ({ PaneHeaderActions: () => null }));
vi.mock("./CommandPalette.js", () => ({ CommandPalette: () => null }));
vi.mock("./Dock.js", () => ({ Dock: () => null }));
vi.mock("./ResourceAlertBanner.js", () => ({ ResourceAlertBanner: () => null }));
vi.mock("./panels/registry.js", () => ({
  components: {},
  tabComponents: {},
  KanbanBoardOverlay: () => null,
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
