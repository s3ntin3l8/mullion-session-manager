// @vitest-environment jsdom
// #2978 — the empty workspace told touch users to press ⌘K. Under a coarse
// pointer it offers the launcher and the sidebar as buttons instead; a fine
// pointer keeps the keyboard hint.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// The mocks live in the shared harness; import it before App.
import { setLayoutMode, stubPxWidth, stubWidth } from "./test/appHarness.js";
import { App } from "./App.js";
import { useDashboardStore } from "./store/index.js";

describe("App empty workspace", () => {
  const openLauncher = vi.fn();
  beforeEach(() => {
    useDashboardStore.setState({
      refreshWorkspaces: vi.fn().mockResolvedValue(undefined),
      hydrateSettings: vi.fn(),
      startThemeWatch: vi.fn(() => () => {}),
      openLauncher,
      viewMode: "list",
    });
    setLayoutMode("auto");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("keeps the ⌘K hint for a fine pointer", () => {
    stubWidth("desktop");
    render(<App />);
    expect(screen.getByText("Nothing tiled here yet")).toBeInTheDocument();
    expect(screen.getByText(/⌘K to launch/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Launch a session" })).toBeNull();
  });

  it("points a fine pointer below 1100px at ⌘K alone, with no sidebar to pick from", () => {
    stubPxWidth(1000);
    render(<App />);
    expect(screen.getByText("⌘K to launch or find a session")).toBeInTheDocument();
    expect(screen.queryByText(/pick a session from the sidebar/)).toBeNull();
  });

  it("offers only the launcher under a coarse pointer below 1100px, with no ⌘K", async () => {
    stubWidth("tablet", true);
    render(<App />);
    expect(screen.queryByText(/⌘K/)).toBeNull();
    const launch = screen.getByRole("button", { name: "Launch a session" });
    await userEvent.click(launch);
    expect(openLauncher).toHaveBeenCalledTimes(1);
    // No left sidebar from 700 to 1099px (#3041), so nothing to show.
    expect(screen.queryByRole("button", { name: "Show the sidebar" })).toBeNull();
  });

  it("offers the collapsed docked sidebar under a coarse pointer at 1200px", async () => {
    stubPxWidth(1200, true);
    const { container } = render(<App />);
    expect(container.querySelector(".app")).toHaveClass("sidebar-collapsed");
    await userEvent.click(screen.getByRole("button", { name: "Show the sidebar" }));
    expect(container.querySelector(".app")).not.toHaveClass("sidebar-collapsed");
    expect(screen.queryByRole("button", { name: "Show the sidebar" })).toBeNull();
  });

  it("drops the sidebar button when the sidebar already shows", () => {
    // The docked desktop sidebar is open by default.
    useDashboardStore.setState({ sidebarCollapsed: false });
    stubWidth("desktop", true);
    render(<App />);
    expect(screen.getByRole("button", { name: "Launch a session" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show the sidebar" })).toBeNull();
  });
});
