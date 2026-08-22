// @vitest-environment jsdom
// Tasks-as-a-destination (issue #211's ViewModeToggle.tsx retired) — the
// toolbar's own center summary and its "Back to workspace" button both
// switch on viewMode, which used to live entirely inside the now-deleted
// ViewModeToggle. No Toolbar test file existed before this: NotificationBell
// (mounted unconditionally in .toolbar-lead) needs a much larger store-mock
// surface than this file cares about — see ViewModeToggle.tsx's own removed
// header comment on exactly that — so it's stubbed out below, same posture
// UnifiedBoard.test.tsx takes with TaskDetail.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toolbar } from "./Toolbar.js";

let viewMode: string;
const setViewMode = vi.fn();
const toggleTheme = vi.fn();

function storeState() {
  return { theme: "dark", viewMode, setViewMode, toggleTheme };
}

vi.mock("./store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

vi.mock("./NotificationBell.js", () => ({
  NotificationBell: () => null,
}));

const NOOP_PROPS = {
  onToggleSidebar: vi.fn(),
  onOpenSession: vi.fn(),
  onOpenBrowser: vi.fn(),
  onOpenLauncher: vi.fn(),
  onOpenSettings: vi.fn(),
  activeWorkspaceName: "My Workspace",
  paneCount: 3,
  currentVersion: null,
};

beforeEach(() => {
  viewMode = "list";
  setViewMode.mockClear();
  toggleTheme.mockClear();
});

describe("Toolbar — workspace view (viewMode !== kanban)", () => {
  it("shows the active workspace name and pane count, and no back button", () => {
    render(<Toolbar {...NOOP_PROPS} />);
    expect(screen.getByText("My Workspace")).toBeInTheDocument();
    expect(screen.getByText("3 panes")).toBeInTheDocument();
    expect(screen.queryByText("Tasks")).toBeNull();
    expect(screen.queryByTitle("Back to workspace")).toBeNull();
  });

  it("renders nothing in the center when there is no active workspace", () => {
    render(<Toolbar {...NOOP_PROPS} activeWorkspaceName={null} />);
    expect(screen.queryByText("My Workspace")).toBeNull();
    expect(screen.queryByText(/panes?$/)).toBeNull();
  });
});

describe("Toolbar — Tasks view (viewMode === kanban)", () => {
  beforeEach(() => {
    viewMode = "kanban";
  });

  it("shows a Tasks label instead of the workspace name/pane count", () => {
    render(<Toolbar {...NOOP_PROPS} />);
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.queryByText("My Workspace")).toBeNull();
    expect(screen.queryByText("3 panes")).toBeNull();
  });

  it('shows a Back to workspace button that calls setViewMode("list")', async () => {
    const user = userEvent.setup();
    render(<Toolbar {...NOOP_PROPS} />);
    const back = screen.getByTitle("Back to workspace");
    await user.click(back);
    expect(setViewMode).toHaveBeenCalledWith("list");
  });

  it("disables the New-session and Command-palette buttons (issue #730 — no launch from Task view)", () => {
    render(<Toolbar {...NOOP_PROPS} />);
    expect(screen.getByTitle("New session (unavailable in Task view)")).toBeDisabled();
    expect(screen.getByTitle("Command palette (unavailable in Task view)")).toBeDisabled();
  });

  it("does not call onOpenLauncher when the disabled New-session button is clicked", async () => {
    const user = userEvent.setup();
    render(<Toolbar {...NOOP_PROPS} />);
    await user.click(screen.getByTitle("New session (unavailable in Task view)"));
    expect(NOOP_PROPS.onOpenLauncher).not.toHaveBeenCalled();
  });
});
