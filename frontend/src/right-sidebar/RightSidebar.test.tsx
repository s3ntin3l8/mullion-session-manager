// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RightSidebar } from "./RightSidebar.js";
import { resetPhoneBackStackForTests } from "../hooks/usePhoneBackStack.js";
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

const actions = {
  onOpenGit: vi.fn(),
  onOpenGitHub: vi.fn(),
  onOpenFileEditor: vi.fn(),
  onOpenFile: vi.fn(),
};

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
    prsByProject: {},
  });
});

afterEach(() => {
  resetPhoneBackStackForTests();
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

  it("badges the GitHub rail icon only while PR checks are failing", () => {
    const failing = (n: number) => ({
      prs: [],
      prSummary: { total: n, pass: 0, fail: n, pending: 0, unknown: 0 },
    });
    renderSidebar();
    const github = () => screen.getByRole("button", { name: "GitHub" });
    expect(github().querySelector(".right-rail-badge")).toBeNull();

    act(() => useDashboardStore.setState({ prsByProject: { 1: failing(2) } }));
    expect(github().querySelector(".right-rail-badge.alert")).toBeTruthy();
    expect(github().title).toBe("GitHub — 2 PR checks failing");

    act(() => useDashboardStore.setState({ prsByProject: { 1: failing(1) } }));
    expect(github().title).toBe("GitHub — 1 PR check failing");

    act(() => useDashboardStore.setState({ prsByProject: {} }));
    expect(github().querySelector(".right-rail-badge")).toBeNull();
  });

  it("switches views from the rail", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ rightSidebarOpen: true });
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "GitHub" }));

    expect(screen.getByRole("complementary", { name: "GitHub sidebar" })).toBeTruthy();
    expect(useDashboardStore.getState().rightSidebarView).toBe("github");
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

  it("leaves an Escape that came from inside a terminal (or was already handled) alone", () => {
    useDashboardStore.setState({ rightSidebarOpen: true });
    renderSidebar();
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const textarea = document.createElement("textarea");
    xterm.appendChild(textarea);
    document.body.appendChild(xterm);

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);

    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);

    xterm.remove();
  });

  it("follows an external change to the stored width", () => {
    useDashboardStore.setState({ rightSidebarOpen: true });
    const { container } = renderSidebar();
    const panel = container.querySelector(".right-sidebar-panel") as HTMLElement;
    expect(panel.style.width).toBe("340px");

    act(() => useDashboardStore.getState().setRightSidebarWidth(420));

    expect(panel.style.width).toBe("420px");
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

  it("tablet: a rightward swipe on the open drawer dismisses it", () => {
    useDashboardStore.setState({ rightSidebarOpen: true });
    const { container } = renderSidebar("tablet");
    const panel = container.querySelector(".right-sidebar-panel") as HTMLElement;
    const touch = (type: string, x: number) =>
      panel.dispatchEvent(
        Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
          touches: [{ clientX: x, clientY: 0 }],
        }),
      );

    touch("touchstart", 100);
    touch("touchmove", 200);

    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("desktop: the drawer has no swipe gesture", () => {
    useDashboardStore.setState({ rightSidebarOpen: true });
    const { container } = renderSidebar("desktop");
    const panel = container.querySelector(".right-sidebar-panel") as HTMLElement;
    const touch = (type: string, x: number) =>
      panel.dispatchEvent(
        Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
          touches: [{ clientX: x, clientY: 0 }],
        }),
      );

    touch("touchstart", 100);
    touch("touchmove", 200);

    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);
  });

  it("tablet: the back gesture closes the floating drawer", () => {
    useDashboardStore.setState({ rightSidebarOpen: true });
    renderSidebar("tablet");

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("closes the drawer when the tier changes to phone, or a floating one goes tablet → desktop", () => {
    useDashboardStore.setState({ rightSidebarOpen: true });
    const { rerender } = renderSidebar("tablet");
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);

    rerender(<RightSidebar tier="desktop" actions={actions} />);
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);

    act(() => useDashboardStore.setState({ rightSidebarOpen: true }));
    rerender(<RightSidebar tier="phone" actions={actions} />);
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("keeps a pinned drawer open when going tablet → desktop (it docks)", () => {
    useDashboardStore.setState({ rightSidebarOpen: true, rightSidebarPinned: true });
    const { rerender, container } = renderSidebar("tablet");

    rerender(<RightSidebar tier="desktop" actions={actions} />);

    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);
    expect(container.querySelector(".right-sidebar-panel.docked")).toBeTruthy();
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
