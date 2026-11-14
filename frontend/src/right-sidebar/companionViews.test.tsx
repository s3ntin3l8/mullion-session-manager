// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { RightRail } from "./RightRail.js";
import { RightSidebar } from "./RightSidebar.js";
import { RIGHT_SIDEBAR_VIEWS } from "./views-registry.js";
import { COMPANION_BANDS, viewInBand } from "./viewBands.js";
import { DESKTOP_NARROW_BAND_QUERY, RAILS_FULL_BAND_QUERY } from "../lib/layoutTier.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import { useDashboardStore } from "../store/index.js";
import type { Project } from "../api/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";

// Browser and Dock are right-sidebar views only below 1100px (#3012): on the
// rail of the rails layouts (700 to 1099.98px), and on the phone through the
// "more" sheet, full screen. From 1100px they are a grid pane and the bottom
// Dock.

vi.mock("./BrowserSidebarView.js", () => ({
  BrowserSidebarView: () => <div data-testid="browser-view" />,
}));
vi.mock("./DockSidebarView.js", () => ({
  DockSidebarView: () => <div data-testid="dock-view" />,
}));

const PROJECT = { id: 1, name: "demo", cwd: "/x/demo", hostId: "local" } as Project;
const actions = {
  onOpenGit: vi.fn(),
  onOpenGitHub: vi.fn(),
  onOpenFileEditor: vi.fn(),
  onOpenFile: vi.fn(),
  onOpenAgentRules: vi.fn(),
  onOpenProjectBriefing: vi.fn(),
  onOpenProjectSetup: vi.fn(),
  onOpenDockConfig: vi.fn(),
  onOpenSkills: vi.fn(),
  onOpenTasks: vi.fn(),
  onOpenDevice: vi.fn(),
};

function matchQueries(...queries: string[]) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: queries.includes(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function setLayoutMode(layoutMode: "auto" | LayoutTier) {
  useDashboardStore.setState({ settings: { ...DEFAULT_SETTINGS, layoutMode } });
}

beforeEach(() => {
  localStorage.clear();
  useDashboardStore.setState({
    projects: [PROJECT],
    sessions: [],
    activePanelId: null,
    gitStatuses: {},
    rightSidebarView: "git",
    rightSidebarOpen: false,
    rightSidebarProjectRequest: null,
    prsByProject: {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLayoutMode("auto");
});

describe("Browser and Dock registration (#3012)", () => {
  it("are per-project registry entries that carry their label, icon and bands", () => {
    for (const id of ["browser", "dock"]) {
      const view = RIGHT_SIDEBAR_VIEWS.find((v) => v.id === id)!;
      expect(view.hostGlobal).not.toBe(true);
      expect(view.label).toBe(id === "browser" ? "Browser" : "Dock");
      expect(view.icon).toBeTypeOf("function");
      expect(view.bands).toEqual(COMPANION_BANDS);
    }
    expect(COMPANION_BANDS).toEqual(["phone", "rails-full", "rails-halves"]);
  });

  it("viewInBand reads the bands; a view without bands is in every band", () => {
    expect(viewInBand({ bands: COMPANION_BANDS }, "rails-halves")).toBe(true);
    expect(viewInBand({ bands: COMPANION_BANDS }, "phone")).toBe(true);
    expect(viewInBand({ bands: COMPANION_BANDS }, "desktop-narrow")).toBe(false);
    expect(viewInBand({}, "desktop")).toBe(true);
  });

  it("are on the rail in the two-halves band", () => {
    setLayoutMode("tablet");
    render(<RightRail projectId={1} />);
    expect(screen.getByRole("button", { name: "Browser" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dock" })).toBeInTheDocument();
  });

  it("are on the rail in the full-width rails band (700 to 799px)", () => {
    matchQueries(RAILS_FULL_BAND_QUERY);
    render(<RightRail projectId={1} />);
    expect(screen.getByRole("button", { name: "Browser" })).toBeInTheDocument();
  });

  it("are not registered from 1100px", () => {
    matchQueries(DESKTOP_NARROW_BAND_QUERY);
    const { unmount } = render(<RightRail projectId={1} />);
    expect(screen.queryByRole("button", { name: "Browser" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dock" })).toBeNull();
    // Git and the rest are still there.
    expect(screen.getByRole("button", { name: "Git" })).toBeInTheDocument();
    unmount();
    setLayoutMode("desktop");
    render(<RightRail projectId={1} />);
    expect(screen.queryByRole("button", { name: "Dock" })).toBeNull();
  });

  it("render in the panel in their band", () => {
    setLayoutMode("tablet");
    useDashboardStore.setState({ rightSidebarOpen: true, rightSidebarView: "dock" });
    render(<RightSidebar tier="tablet" actions={actions} />);
    expect(screen.getByTestId("dock-view")).toBeInTheDocument();
  });

  it("close instead of rendering when persisted open from 1100px", async () => {
    setLayoutMode("desktop");
    useDashboardStore.setState({ rightSidebarOpen: true, rightSidebarView: "browser" });
    render(<RightSidebar tier="desktop" actions={actions} />);
    expect(screen.queryByTestId("browser-view")).toBeNull();
    await waitFor(() => expect(useDashboardStore.getState().rightSidebarOpen).toBe(false));
    // The sidebar toggle must not reopen on a view that is not here.
    expect(useDashboardStore.getState().rightSidebarView).toBe("git");
    expect(localStorage.getItem("crs.rightSidebarView")).toContain("git");
  });

  it.each(["browser", "dock"] as const)(
    "%s opens full screen on the phone and stays open",
    async (id) => {
      setLayoutMode("phone");
      useDashboardStore.setState({ followedProjectId: 1 });
      render(<RightSidebar tier="phone" actions={actions} />);
      // Opened after landing, as the "more" sheet's row does: the panel
      // closes a view that was already open when the phone layout landed.
      act(() => useDashboardStore.getState().openRightSidebarView(id));
      const name = id === "browser" ? "Browser view" : "Dock view";
      expect(screen.getByRole("dialog", { name })).toBeInTheDocument();
      expect(screen.getByTestId(`${id}-view`)).toBeInTheDocument();
      // The out-of-band close does not fire in the phone band.
      await new Promise((r) => setTimeout(r, 0));
      expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);
      expect(useDashboardStore.getState().rightSidebarView).toBe(id);
    },
  );
});
