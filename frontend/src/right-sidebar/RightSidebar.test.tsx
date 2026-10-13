// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RightSidebar } from "./RightSidebar.js";
import { useDashboardStore } from "../store/index.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import type { GitStatus, Project } from "../api/index.js";

const PROJECT = { id: 1, name: "demo", cwd: "/x/demo", hostId: "local" } as Project;

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    hash: "abc",
    ahead: 0,
    behind: 0,
    files: [],
    isClean: true,
    hasConflicts: false,
    ...overrides,
  };
}

const actions = { onOpenGit: vi.fn() };

function renderSidebar(tier: LayoutTier = "desktop") {
  return render(<RightSidebar tier={tier} actions={actions} />);
}

beforeEach(() => {
  localStorage.clear();
  useDashboardStore.setState({
    projects: [PROJECT],
    sessions: [],
    activePanelId: null,
    gitStatuses: { 1: status() },
    rightSidebarView: "git",
    rightSidebarOpen: false,
    rightSidebarPinned: false,
    rightSidebarWidth: 340,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  useDashboardStore.setState({ projects: [], gitStatuses: {} });
});

describe("RightSidebar", () => {
  it("renders nothing on phone", () => {
    const { container } = renderSidebar("phone");
    expect(container.firstChild).toBeNull();
  });

  it("shows only the rail while closed", () => {
    renderSidebar();
    expect(screen.getByRole("navigation", { name: "Right sidebar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Git" })).toBeTruthy();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("opens the view from the rail and closes it on a second click", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "Git" }));
    expect(screen.getByRole("complementary", { name: "Git sidebar" })).toBeTruthy();
    expect(screen.getByText("Working tree clean")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Git" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("shows a changed-file count badge on the rail", () => {
    useDashboardStore.setState({
      gitStatuses: {
        1: status({
          isClean: false,
          files: [
            { path: "a.ts", status: "M" },
            { path: "b.ts", status: "A" },
          ],
        }),
      },
    });
    renderSidebar();
    expect(screen.getByRole("button", { name: "Git" }).textContent).toContain("2");
  });

  it("shows an alert badge, not a count, on conflicts", () => {
    useDashboardStore.setState({
      gitStatuses: {
        1: status({ isClean: false, hasConflicts: true, files: [{ path: "a.ts", status: "U" }] }),
      },
    });
    renderSidebar();
    const btn = screen.getByRole("button", { name: "Git" });
    expect(btn.querySelector(".right-rail-badge.alert")).toBeTruthy();
    expect(btn.title).toContain("conflicts");
  });

  it("floats unpinned over the grid: scrim click and Escape both dismiss it", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ rightSidebarOpen: true });
    const { container } = renderSidebar();
    expect(container.querySelector(".right-sidebar-panel.overlay")).toBeTruthy();

    await user.click(container.querySelector(".right-sidebar-scrim") as HTMLElement);
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);

    act(() => useDashboardStore.setState({ rightSidebarOpen: true }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("docks when pinned on desktop: no scrim, and Escape leaves it open", () => {
    useDashboardStore.setState({ rightSidebarOpen: true, rightSidebarPinned: true });
    const { container } = renderSidebar("desktop");

    expect(container.querySelector(".right-sidebar-panel.docked")).toBeTruthy();
    expect(container.querySelector(".right-sidebar-scrim")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);
  });

  it("ignores a saved pin on tablet: overlay, no pin button, no resize handle", () => {
    useDashboardStore.setState({ rightSidebarOpen: true, rightSidebarPinned: true });
    const { container } = renderSidebar("tablet");

    expect(container.querySelector(".right-sidebar-panel.overlay")).toBeTruthy();
    expect(container.querySelector(".right-sidebar-scrim")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pin sidebar/i })).toBeNull();
    expect(container.querySelector(".right-sidebar-resize-handle")).toBeNull();
    // The saved preference itself is untouched.
    expect(useDashboardStore.getState().rightSidebarPinned).toBe(true);
  });

  it("the pin button toggles and persists the pinned flag", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ rightSidebarOpen: true });
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "Pin sidebar" }));
    expect(useDashboardStore.getState().rightSidebarPinned).toBe(true);
    expect(localStorage.getItem("crs.rightSidebarPinned")).toBe("1");

    await user.click(screen.getByRole("button", { name: "Unpin sidebar" }));
    expect(useDashboardStore.getState().rightSidebarPinned).toBe(false);
  });

  it("the close button closes the drawer", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ rightSidebarOpen: true });
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("the Git view's open-full button calls the injected opener with the project", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ rightSidebarOpen: true });
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "Open Git Panel" }));
    expect(actions.onOpenGit).toHaveBeenCalledWith(1);
  });

  it("shows an empty state instead of a view when there are no projects", () => {
    useDashboardStore.setState({ projects: [], rightSidebarOpen: true });
    renderSidebar();
    expect(screen.getByText("No projects yet.")).toBeTruthy();
  });

  it("falls back to the first registered view when the stored view id is unknown", () => {
    useDashboardStore.setState({ rightSidebarOpen: true, rightSidebarView: "gone" });
    renderSidebar();
    expect(screen.getByRole("complementary", { name: "Git sidebar" })).toBeTruthy();
  });

  it("dragging the left handle resizes (inverted) and commits a clamped width", () => {
    useDashboardStore.setState({ rightSidebarOpen: true, rightSidebarPinned: true });
    const { container } = renderSidebar("desktop");
    const handle = container.querySelector(".right-sidebar-resize-handle") as HTMLElement;
    const panel = container.querySelector(".right-sidebar-panel") as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 750 });
    expect(panel.style.width).toBe("390px");
    fireEvent.mouseUp(window);

    expect(useDashboardStore.getState().rightSidebarWidth).toBe(390);
    expect(localStorage.getItem("crs.rightSidebarWidth")).toBe("390");
  });
});
