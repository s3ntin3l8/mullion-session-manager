// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RightSidebar } from "./RightSidebar.js";
import { COARSE_POINTER_QUERY, RIGHT_SIDEBAR_FULL_WIDTH_QUERY } from "../lib/layoutTier.js";
import { resetPhoneBackStackForTests } from "../hooks/usePhoneBackStack.js";
import { useDashboardStore } from "../store/index.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import type { GitStatus, Project } from "../api/index.js";
import type { GitHubPrPhase } from "../api/types.js";

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
  onOpenAgentRules: vi.fn(),
  onOpenProjectBriefing: vi.fn(),
  onOpenProjectSetup: vi.fn(),
  onOpenDockConfig: vi.fn(),
  onOpenSkills: vi.fn(),
  onOpenTasks: vi.fn(),
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
    // A request left by an earlier test would make a repeated nonce look already handled.
    rightSidebarProjectRequest: null,
    followedProjectId: null,
    rightSidebarOpen: false,
    rightSidebarWidth: 340,
    prsByProject: {},
    defaultBranchCiByProject: {},
  });
});

// Make exactly these media queries match. narrowWindow: a window too narrow
// to dock the panel.
function matchQueries(...queries: string[]) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: queries.includes(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}
const narrowWindow = () => matchQueries(RIGHT_SIDEBAR_FULL_WIDTH_QUERY);

afterEach(() => {
  vi.unstubAllGlobals();
  resetPhoneBackStackForTests();
  vi.clearAllMocks();
  useDashboardStore.setState({ projects: [], gitStatuses: {} });
});

describe("RightSidebar", () => {
  it("publishes the followed project for the Task Master board, and clears it on unmount (#2858)", () => {
    const view = renderSidebar();
    expect(useDashboardStore.getState().followedProjectId).toBe(1);
    view.unmount();
    expect(useDashboardStore.getState().followedProjectId).toBeNull();
  });

  it("publishes the focused panel's project on phone too, where the sidebar renders nothing, and clears it on unmount (#2864)", () => {
    // Two projects with the focus on the second, so the first-project fallback cannot pass.
    useDashboardStore.setState({
      projects: [PROJECT, { ...PROJECT, id: 2, name: "two" } as Project],
      activePanelId: "git-2",
    });
    const view = renderSidebar("phone");
    expect(view.container).toBeEmptyDOMElement();
    expect(useDashboardStore.getState().followedProjectId).toBe(2);
    view.unmount();
    expect(useDashboardStore.getState().followedProjectId).toBeNull();
  });

  it("publishes nothing on phone while no panel has focus, though a visible sidebar publishes its fallback project (#2864)", () => {
    const phone = renderSidebar("phone");
    expect(useDashboardStore.getState().followedProjectId).toBeNull();
    phone.unmount();
    renderSidebar("desktop");
    expect(useDashboardStore.getState().followedProjectId).toBe(1);
  });

  it("writes the store once per project switch, not null in between", () => {
    const writes: Array<number | null> = [];
    const unsub = useDashboardStore.subscribe((s, prev) => {
      if (s.followedProjectId !== prev.followedProjectId) writes.push(s.followedProjectId);
    });
    renderSidebar();
    useDashboardStore.setState({
      projects: [PROJECT, { ...PROJECT, id: 2, name: "two" } as Project],
    });
    act(() =>
      useDashboardStore.setState({ rightSidebarProjectRequest: { projectId: 2, nonce: 1 } }),
    );
    unsub();
    expect(writes).not.toContain(null);
  });

  it("renders nothing on phone", () => {
    const { container } = renderSidebar("phone");
    expect(container.firstChild).toBeNull();
  });

  it("clears a selected task when the followed project changes while the drawer is collapsed", () => {
    const other = { id: 2, name: "other", cwd: "/x/other", hostId: "local" } as Project;
    useDashboardStore.setState({
      projects: [PROJECT, other],
      gitStatuses: { 1: status(), 2: status() },
    });
    renderSidebar();
    act(() => useDashboardStore.getState().selectTask(5));
    expect(useDashboardStore.getState().selectedTaskId).toBe(5);
    // Another project is requested (and so pinned) with the drawer still closed.
    act(() =>
      useDashboardStore.setState({ rightSidebarProjectRequest: { projectId: 2, nonce: 1 } }),
    );
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
    expect(useDashboardStore.getState().selectedTaskId).toBeNull();
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

  it("puts the project picker in the single header row, with pin and close", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: "Git" }));

    const header = document.querySelector(".right-sidebar-header")!;
    expect(header.contains(screen.getByRole("combobox", { name: "Project" }))).toBe(true);
    expect(header.contains(screen.getByRole("button", { name: "Close sidebar" }))).toBe(true);
    expect(document.querySelector(".right-sidebar-subbar")).toBeNull();
    expect(header.contains(screen.getByRole("img", { name: "Following the active panel" }))).toBe(
      true,
    );
    // The view label is the panel's accessible name, not a rendered title.
    expect(screen.getByRole("complementary", { name: "Git sidebar" })).toBeTruthy();
    expect(screen.getByText("Source Control")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fetch" })).toBeTruthy();
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

  const prWith = (number: number, prPhase: GitHubPrPhase) => ({
    number,
    title: `PR ${number}`,
    htmlUrl: "",
    author: "a",
    headSha: "s",
    headBranch: `b${number}`,
    baseBranch: "main",
    ciStatus: null,
    actionsRuns: [],
    prPhase,
  });
  const withPrs = (...phases: GitHubPrPhase[]) => ({
    prs: phases.map((p, i) => prWith(i + 1, p)),
    prSummary: { total: phases.length, pass: 0, fail: 0, pending: 0, unknown: 0 },
  });

  it("badges the GitHub rail icon only while a PR needs attention", () => {
    renderSidebar();
    const github = () => screen.getByRole("button", { name: "GitHub" });
    expect(github().querySelector(".right-rail-badge")).toBeNull();

    act(() =>
      useDashboardStore.setState({ prsByProject: { 1: withPrs("ci_failing", "ci_failing") } }),
    );
    expect(github().querySelector(".right-rail-badge.alert")).toBeTruthy();
    expect(github().title).toBe("GitHub — 2 PRs: ci failing");

    act(() =>
      useDashboardStore.setState({
        prsByProject: {
          1: withPrs("ci_failing", "changes_requested", "conflicts", "ready_to_merge"),
        },
      }),
    );
    expect(github().title).toBe(
      "GitHub — 1 PR: ci failing, 1 PR: changes requested, 1 PR: conflicts",
    );

    // Open conversations need the user too, and read last.
    act(() =>
      useDashboardStore.setState({
        prsByProject: { 1: withPrs("threads_unresolved", "ci_failing") },
      }),
    );
    expect(github().title).toBe("GitHub — 1 PR: ci failing, 1 PR: unresolved conversations");

    // A behind head (strict protection) needs the user's click and reads last.
    act(() =>
      useDashboardStore.setState({
        prsByProject: { 1: withPrs("behind", "threads_unresolved") },
      }),
    );
    expect(github().title).toBe("GitHub — 1 PR: unresolved conversations, 1 PR: behind base");

    // Waiting or ready PRs are not attention.
    act(() =>
      useDashboardStore.setState({
        prsByProject: { 1: withPrs("review_pending", "ready_to_merge") },
      }),
    );
    expect(github().querySelector(".right-rail-badge")).toBeNull();

    act(() => useDashboardStore.setState({ prsByProject: {} }));
    expect(github().querySelector(".right-rail-badge")).toBeNull();
  });

  it("badges the GitHub rail icon when the default branch CI is failing, alone or with PRs", () => {
    renderSidebar();
    const github = () => screen.getByRole("button", { name: "GitHub" });

    act(() => useDashboardStore.setState({ defaultBranchCiByProject: { 1: "success" } }));
    expect(github().querySelector(".right-rail-badge")).toBeNull();

    act(() => useDashboardStore.setState({ defaultBranchCiByProject: { 1: "failure" } }));
    expect(github().querySelector(".right-rail-badge.alert")).toBeTruthy();
    expect(github().title).toBe("GitHub — default branch CI failing");

    act(() => useDashboardStore.setState({ prsByProject: { 1: withPrs("ci_failing") } }));
    expect(github().title).toBe("GitHub — 1 PR: ci failing, default branch CI failing");
  });

  it("switches views from the rail", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ rightSidebarOpen: true });
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "GitHub" }));

    expect(screen.getByRole("complementary", { name: "GitHub sidebar" })).toBeTruthy();
    expect(useDashboardStore.getState().rightSidebarView).toBe("github");
  });

  it("is docked at every width where it renders: no scrim, and Escape leaves it open (#3006)", () => {
    for (const tier of ["desktop", "tablet"] as const) {
      useDashboardStore.setState({ rightSidebarOpen: true });
      const { container, unmount } = renderSidebar(tier);

      expect(container.querySelector(".right-sidebar-panel.docked")).toBeTruthy();
      expect(container.querySelector(".right-sidebar-panel.full")).toBeNull();
      expect(container.querySelector(".right-sidebar-scrim")).toBeNull();
      expect(container.querySelector(".right-sidebar-resize-handle")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /pin sidebar/i })).toBeNull();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);
      unmount();
    }
  });

  it("covers the workspace where the window is too narrow to dock, and Escape closes it there", () => {
    narrowWindow();
    useDashboardStore.setState({ rightSidebarOpen: true });
    const { container } = renderSidebar("tablet");
    const panel = container.querySelector(".right-sidebar-panel") as HTMLElement;

    expect(panel.classList.contains("full")).toBe(true);
    // No inline width: the stylesheet stretches it to the rail.
    expect(panel.style.width).toBe("");
    expect(container.querySelector(".right-sidebar-resize-handle")).toBeNull();
    expect(container.querySelector(".right-sidebar-scrim")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("leaves an Escape that came from inside a terminal (or was already handled) alone", () => {
    narrowWindow();
    useDashboardStore.setState({ rightSidebarOpen: true });
    renderSidebar("tablet");
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

  it("tablet: a swipe on the open panel does not close it (#3006)", () => {
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

    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);
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

  it("the back gesture leaves a docked panel alone and closes one that covers the workspace", () => {
    useDashboardStore.setState({ rightSidebarOpen: true });
    const docked = renderSidebar("tablet");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);
    docked.unmount();

    narrowWindow();
    renderSidebar("tablet");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("closes the panel when the tier changes to phone, and keeps it through tablet → desktop", () => {
    useDashboardStore.setState({ rightSidebarOpen: true });
    const { rerender, container } = renderSidebar("tablet");

    rerender(<RightSidebar tier="desktop" actions={actions} />);
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);
    expect(container.querySelector(".right-sidebar-panel.docked")).toBeTruthy();

    rerender(<RightSidebar tier="phone" actions={actions} />);
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("has no resize handle under a touch pointer, which could not drag it", () => {
    matchQueries(COARSE_POINTER_QUERY);
    useDashboardStore.setState({ rightSidebarOpen: true });
    const { container } = renderSidebar("tablet");

    expect(container.querySelector(".right-sidebar-panel.docked")).toBeTruthy();
    expect(container.querySelector(".right-sidebar-resize-handle")).toBeNull();
  });

  it("a forced desktop tier on a narrow window keeps Escape but stays off the back stack", () => {
    narrowWindow();
    useDashboardStore.setState({ rightSidebarOpen: true });
    renderSidebar("desktop");

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("the close button closes the drawer", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ rightSidebarOpen: true });
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("a project request from the store pins the drawer to that project", () => {
    useDashboardStore.setState({
      rightSidebarOpen: true,
      rightSidebarView: "git",
      projects: [
        { id: 1, name: "alpha", cwd: "/a", hostId: "local" },
        { id: 2, name: "beta", cwd: "/b", hostId: "local" },
      ] as never,
    });
    renderSidebar();
    act(() => useDashboardStore.getState().openRightSidebarView("git", 2));
    expect(screen.getByText("beta")).toBeTruthy();
  });

  it("a repeat request for the same project re-pins after the user switched away", async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({
      rightSidebarOpen: true,
      rightSidebarView: "git",
      projects: [
        { id: 1, name: "alpha", cwd: "/a", hostId: "local" },
        { id: 2, name: "beta", cwd: "/b", hostId: "local" },
      ] as never,
    });
    renderSidebar();
    // The Git view's History section has its own scope <select>; the project
    // picker is the first combobox in the sidebar.
    const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    act(() => useDashboardStore.getState().openRightSidebarView("git", 2));
    expect(select.value).toBe("2");

    await user.selectOptions(select, "__follow__");
    expect(select.value).toBe("__follow__");

    act(() => useDashboardStore.getState().openRightSidebarView("git", 2));
    expect(select.value).toBe("2");
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
    useDashboardStore.setState({ rightSidebarOpen: true });
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
