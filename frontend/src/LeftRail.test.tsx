// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LeftRail } from "./LeftRail.js";
import type { LeftRailProps } from "./LeftRail.js";
import { useDashboardStore } from "./store/index.js";
import { makeTask } from "./test/fixtures.js";
import railCss from "./styles/left-rail.css?raw";

// The bell has its own suite; here it only has to show where it was mounted
// and with which presentation.
vi.mock("./NotificationBell.js", () => ({
  NotificationBell: (p: { placement?: string; sheet?: boolean; triggerClassName?: string }) => (
    <button
      data-testid="bell"
      data-placement={p.placement}
      data-sheet={String(!!p.sheet)}
      className={p.triggerClassName}
    />
  ),
}));

function renderRail(overrides: Partial<LeftRailProps> = {}) {
  const props: LeftRailProps = {
    onToggleSidebar: vi.fn(),
    sidebarShown: true,
    onOpenLauncher: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenSession: vi.fn(),
    onOpenBrowser: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<LeftRail {...props} />) };
}

const modeButton = (name: RegExp) =>
  within(screen.getByRole("group", { name: "Mode" })).getByRole("button", { name });

beforeEach(() => {
  localStorage.clear();
  useDashboardStore.setState({ viewMode: "list", tasks: [] });
});
afterEach(() => useDashboardStore.setState({ viewMode: "list", tasks: [] }));

describe("LeftRail in Workspace mode", () => {
  it("marks Workspace pressed and shows the sidebar toggle, the middle region and the bottom cluster", () => {
    const { container } = renderRail({ middle: <span>CHIP</span> });
    expect(modeButton(/^Workspace$/)).toHaveAttribute("aria-pressed", "true");
    expect(modeButton(/^Tasks/)).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Sidebar" })).toBeInTheDocument();
    const middle = container.querySelector('[data-rail-region="middle"]');
    expect(middle).not.toBeNull();
    expect(middle).toHaveTextContent("CHIP");
    expect(screen.getByRole("button", { name: "Command palette" })).toBeEnabled();
    expect(screen.getByTestId("bell")).toHaveAttribute("data-placement", "beside");
    expect(screen.getByTestId("bell")).toHaveClass("left-rail-btn");
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("wires the sidebar toggle, the command box and settings", async () => {
    const user = userEvent.setup();
    const { props } = renderRail({ sidebarShown: false });
    const toggle = screen.getByRole("button", { name: "Sidebar" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("title", "Show sidebar");
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Command palette" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(props.onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(props.onOpenLauncher).toHaveBeenCalledTimes(1);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("switches to Tasks mode from the mode switch, and remembers it", async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(modeButton(/^Tasks/));
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
    expect(localStorage.getItem("crs.viewMode")).toBe("kanban");
  });

  it("passes the touch-tablet sheet through to the bell", () => {
    renderRail({ notificationSheet: true });
    expect(screen.getByTestId("bell")).toHaveAttribute("data-sheet", "true");
  });
});

describe("LeftRail in Tasks mode", () => {
  beforeEach(() => useDashboardStore.setState({ viewMode: "kanban" }));

  it("holds only the mode switch and the bottom cluster", () => {
    const { container } = renderRail({ middle: <span>CHIP</span> });
    expect(modeButton(/^Tasks/)).toHaveAttribute("aria-pressed", "true");
    expect(modeButton(/^Workspace$/)).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "Sidebar" })).toBeNull();
    expect(container.querySelector('[data-rail-region="middle"]')).toBeNull();
    expect(screen.queryByText("CHIP")).toBeNull();
    // The palette only launches into a workspace (issue #730).
    expect(screen.getByRole("button", { name: "Command palette" })).toBeDisabled();
    expect(screen.getByTestId("bell")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled();
  });

  it("switches back to Workspace mode", async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(modeButton(/^Workspace$/));
    expect(useDashboardStore.getState().viewMode).toBe("list");
  });
});

describe("LeftRail needs-you count", () => {
  it("counts only the tasks that need the owner, install-wide", () => {
    useDashboardStore.setState({
      tasks: [
        makeTask({ id: 1, projectId: 1, status: "failed", failureReason: "boom" }),
        makeTask({ id: 2, projectId: 2, status: "reviewing", approvalState: "awaiting-human" }),
        makeTask({ id: 3, projectId: 1, status: "in_progress" }),
        makeTask({ id: 4, projectId: 3, status: "ready" }),
        makeTask({
          id: 5,
          projectId: 1,
          status: "failed",
          archivedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });
    const { container } = renderRail();
    const tasks = modeButton(/^Tasks/);
    expect(tasks).toHaveAccessibleName("Tasks");
    expect(tasks).toHaveAccessibleDescription("2 need you");
    expect(tasks).toHaveAttribute("title", expect.stringContaining("2 need you"));
    expect(container.querySelector(".left-rail-badge")).toHaveTextContent("2");
  });

  it("shows no count when nothing needs the owner, and follows the store", () => {
    useDashboardStore.setState({ tasks: [makeTask({ id: 3, status: "in_progress" })] });
    const { container } = renderRail();
    expect(modeButton(/^Tasks/)).toHaveAccessibleName("Tasks");
    expect(modeButton(/^Tasks/)).not.toHaveAttribute("aria-describedby");
    expect(container.querySelector(".left-rail-badge")).toBeNull();
    act(() =>
      useDashboardStore.setState({
        tasks: [makeTask({ id: 3, status: "failed", failureReason: "boom" })],
      }),
    );
    expect(modeButton(/^Tasks/)).toHaveAccessibleDescription("1 needs you");
    expect(modeButton(/^Tasks/)).toHaveAttribute("title", expect.stringContaining("1 needs you"));
  });

  it("caps the badge at 99+", () => {
    useDashboardStore.setState({
      tasks: Array.from({ length: 120 }, (_, i) =>
        makeTask({ id: i + 1, status: "failed", failureReason: "boom" }),
      ),
    });
    const { container } = renderRail();
    expect(container.querySelector(".left-rail-badge")).toHaveTextContent("99+");
  });
});

// #3009 — on a short window only the middle region scrolls: the mode switch
// and the bottom cluster stay put.
describe("LeftRail scroll region", () => {
  const block = (selector: string) => {
    const start = railCss.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return railCss.slice(start, railCss.indexOf("}", start));
  };

  it("puts the middle region between the fixed mode switch and bottom cluster", () => {
    const { container } = renderRail({ middle: <span>CHIP</span> });
    const nav = container.querySelector("nav.left-rail")!;
    const children = [...nav.children].map((el) => el.className);
    const middleAt = children.findIndex((c) => c.includes("left-rail-middle"));
    expect(children.findIndex((c) => c.includes("left-rail-modes"))).toBeLessThan(middleAt);
    expect(children.findIndex((c) => c.includes("left-rail-bottom"))).toBeGreaterThan(middleAt);
    const middle = nav.children[middleAt];
    expect(middle).toHaveTextContent("CHIP");
    expect(middle.querySelector(".left-rail-bottom, .left-rail-modes")).toBeNull();
  });

  it("scrolls the middle region and not the rail", () => {
    // The rail itself only scrolls as a last resort, once the middle has
    // shrunk to nothing (flex 1 1 auto, min-height 0).
    expect(block(".left-rail")).toMatch(/overflow-x:\s*hidden/);
    const middle = block(".left-rail-middle");
    expect(middle).toMatch(/overflow-y:\s*auto/);
    expect(middle).toMatch(/min-height:\s*0/);
    expect(middle).toMatch(/flex:\s*1 1 auto/);
    expect(block(".left-rail > .left-rail-sep")).toMatch(/flex-shrink:\s*0/);
  });
});
