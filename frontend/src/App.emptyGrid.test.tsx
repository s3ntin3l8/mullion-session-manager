// @vitest-environment jsdom
// #2978 — the empty workspace told touch users to press ⌘K. Under a coarse
// pointer it offers the launcher and the sidebar as buttons instead; a fine
// pointer keeps the keyboard hint.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// The mocks live in the shared harness; import it before App.
import { setLayoutMode, stubWidth } from "./test/appHarness.js";
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

  it("offers the launcher and the sidebar under a coarse pointer, with no ⌘K", async () => {
    stubWidth("tablet", true);
    const { container } = render(<App />);
    expect(screen.queryByText(/⌘K/)).toBeNull();
    const launch = screen.getByRole("button", { name: "Launch a session" });
    await userEvent.click(launch);
    expect(openLauncher).toHaveBeenCalledTimes(1);
    // The tablet's drawer starts closed, so the sidebar is one tap away here.
    await userEvent.click(screen.getByRole("button", { name: "Show the sidebar" }));
    expect(container.querySelector(".app")).toHaveClass("sb-open");
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
