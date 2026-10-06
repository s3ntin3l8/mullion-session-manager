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
let themePreference: string;
const setViewMode = vi.fn();
const cycleTheme = vi.fn();

function storeState() {
  return { settings: { theme: themePreference }, viewMode, setViewMode, cycleTheme };
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
  NotificationBell: ({ sheet, sheetClassName }: { sheet?: boolean; sheetClassName?: string }) => (
    <span data-testid="bell" data-sheet={String(!!sheet)} data-sheet-class={sheetClassName ?? ""} />
  ),
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
  themePreference = "dark";
  setViewMode.mockClear();
  cycleTheme.mockClear();
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

  it('shows a single Back to workspace button that calls setViewMode("list")', async () => {
    const user = userEvent.setup();
    render(<Toolbar {...NOOP_PROPS} />);
    const backs = screen.getAllByTitle("Back to workspace");
    expect(backs.length).toBe(1);
    await user.click(backs[0]!);
    expect(setViewMode).toHaveBeenCalledWith("list");
  });

  it("on phone keeps the session switcher and has no phone Tasks title", () => {
    render(<Toolbar {...NOOP_PROPS} phone mobileSessionSlot={<span>switcher</span>} />);
    expect(screen.getByText("switcher")).toBeInTheDocument();
    expect(document.querySelector(".toolbar-mobile-title")).toBeNull();
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

describe("Toolbar — phone session switcher slot and app menu", () => {
  it("renders the mobile session slot outside Task view", () => {
    render(<Toolbar {...NOOP_PROPS} mobileSessionSlot={<span>switcher</span>} />);
    expect(screen.getByText("switcher")).toBeInTheDocument();
  });

  it("keeps the mobile session slot in Task view (the board lives in the navigator there)", () => {
    viewMode = "kanban";
    render(<Toolbar {...NOOP_PROPS} mobileSessionSlot={<span>switcher</span>} />);
    expect(screen.getByText("switcher")).toBeInTheDocument();
  });

  it("offers new session, theme and settings from the ⋯ app menu", async () => {
    const onOpenLauncher = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <Toolbar
        {...NOOP_PROPS}
        currentVersion="0.3.29"
        onOpenLauncher={onOpenLauncher}
        onOpenSettings={onOpenSettings}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTitle("Menu"));
    await user.click(screen.getByText("New session"));
    expect(onOpenLauncher).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTitle("Menu"));
    await user.click(screen.getByText("Theme: Dark"));
    expect(cycleTheme).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTitle("Menu"));
    await user.click(screen.getByText("Settings · v0.3.29"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("cycles the theme button through dark -> light -> system, never getting stuck", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Toolbar {...NOOP_PROPS} />);

    expect(screen.getByTitle(/^Theme: Dark/)).toBeInTheDocument();
    await user.click(screen.getByTitle(/^Theme: Dark/));
    expect(cycleTheme).toHaveBeenCalledTimes(1);

    themePreference = "light";
    rerender(<Toolbar {...NOOP_PROPS} />);
    expect(screen.getByTitle(/^Theme: Light/)).toBeInTheDocument();

    themePreference = "system";
    rerender(<Toolbar {...NOOP_PROPS} />);
    expect(screen.getByTitle("Theme: System (click for Dark)")).toBeInTheDocument();
  });
});

describe("Toolbar — phone tier", () => {
  it("puts the bell at the right edge and drops the ⋯ menu", () => {
    const { container } = render(<Toolbar {...NOOP_PROPS} phone />);
    const bell = screen.getByTestId("bell");
    expect(bell.closest(".toolbar-actions")).not.toBeNull();
    expect(container.querySelector(".toolbar-lead")?.contains(bell)).toBe(false);
    expect(bell).toHaveAttribute("data-sheet", "true");
    expect(container.querySelector(".toolbar-app-menu")).toBeNull();
  });

  it("on a touch tablet keeps the lead bell but renders it as a width-capped sheet", () => {
    const { container } = render(<Toolbar {...NOOP_PROPS} notificationSheet />);
    const bell = screen.getByTestId("bell");
    expect(container.querySelector(".toolbar-lead")?.contains(bell)).toBe(true);
    expect(bell).toHaveAttribute("data-sheet", "true");
    expect(bell).toHaveAttribute("data-sheet-class", "mobile-notif-sheet--tablet");
  });

  it("marks the toolbar as compact-picker off phone when the session slot is shown", () => {
    const { container } = render(
      <Toolbar {...NOOP_PROPS} mobileSessionSlot={<span>switcher</span>} />,
    );
    expect(container.querySelector(".toolbar")).toHaveClass("toolbar--compact-picker");
  });

  it("keeps the compact picker marker in Tasks view on a compact tier", () => {
    viewMode = "kanban";
    const { container } = render(
      <Toolbar {...NOOP_PROPS} mobileSessionSlot={<span>switcher</span>} />,
    );
    expect(container.querySelector(".toolbar")).toHaveClass("toolbar--compact-picker");
  });

  it("does not mark phone (its own CSS owns that layout) or slot-less desktop", () => {
    const phone = render(<Toolbar {...NOOP_PROPS} phone mobileSessionSlot={<span>s</span>} />);
    expect(phone.container.querySelector(".toolbar")).not.toHaveClass("toolbar--compact-picker");
    phone.unmount();
    const desktop = render(<Toolbar {...NOOP_PROPS} />);
    expect(desktop.container.querySelector(".toolbar")).not.toHaveClass("toolbar--compact-picker");
  });

  it("on phone the sheet takes no tablet width-cap class", () => {
    render(<Toolbar {...NOOP_PROPS} phone notificationSheet />);
    expect(screen.getByTestId("bell")).toHaveAttribute("data-sheet-class", "");
  });

  it("keeps the bell in the lead and the ⋯ menu when not phone", () => {
    const { container } = render(<Toolbar {...NOOP_PROPS} />);
    const bell = screen.getByTestId("bell");
    expect(container.querySelector(".toolbar-lead")?.contains(bell)).toBe(true);
    expect(bell).toHaveAttribute("data-sheet", "false");
    expect(container.querySelector(".toolbar-app-menu")).not.toBeNull();
  });
});
