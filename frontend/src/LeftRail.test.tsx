// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LeftRail } from "./LeftRail.js";
import type { LeftRailProps } from "./LeftRail.js";
import { useDashboardStore } from "./store/index.js";
import { makeTask } from "./test/fixtures.js";
import { expectNameHasVisibleText } from "./test/a11y.js";
import railCss from "./styles/left-rail.css?raw";

// The bell has its own suite; here it only has to show where it was mounted
// and with which presentation.
vi.mock("./NotificationBell.js", () => ({
  NotificationBell: (p: { sheet?: boolean; touch?: boolean; triggerClassName?: string }) => (
    <button
      data-testid="bell"
      data-sheet={String(!!p.sheet)}
      data-touch={String(!!p.touch)}
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
    expect(modeButton(/^Work$/)).toHaveAttribute("aria-pressed", "true");
    expect(modeButton(/^Tasks/)).toHaveAttribute("aria-pressed", "false");
    // Each mode is named by what it shows ("Work", not "Workspace", #2886).
    expectNameHasVisibleText(modeButton(/^Work$/));
    expectNameHasVisibleText(modeButton(/^Tasks/));
    expect(screen.getByRole("button", { name: "Sidebar" })).toBeInTheDocument();
    const middle = container.querySelector('[data-rail-region="middle"]');
    expect(middle).not.toBeNull();
    expect(middle).toHaveTextContent("CHIP");
    expect(screen.getByRole("button", { name: "Command palette" })).toBeEnabled();
    // The rail's bell is never the phone's sheet: it opens the side panel.
    expect(screen.getByTestId("bell")).toHaveAttribute("data-sheet", "false");
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

  // #3041 — from 700 to 1099px there is no left sidebar, so no button for it.
  it("renders no sidebar toggle when there is no sidebar to toggle", () => {
    renderRail({ onToggleSidebar: undefined });
    expect(screen.queryByRole("button", { name: "Sidebar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Command palette" })).toBeInTheDocument();
  });

  it("switches to Tasks mode from the mode switch, and remembers it", async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(modeButton(/^Tasks/));
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
    expect(localStorage.getItem("crs.viewMode")).toBe("kanban");
  });

  it("passes the touch tablet's panel variant through to the bell", () => {
    renderRail({ notificationTouch: true });
    expect(screen.getByTestId("bell")).toHaveAttribute("data-touch", "true");
    expect(screen.getByTestId("bell")).toHaveAttribute("data-sheet", "false");
  });
});

describe("LeftRail in Tasks mode", () => {
  beforeEach(() => useDashboardStore.setState({ viewMode: "kanban" }));

  it("shows the same separator under the mode switch as Workspace mode (#3055)", () => {
    const sepAfterModes = (c: HTMLElement) => {
      const nav = c.querySelector("nav.left-rail")!;
      const kids = [...nav.children];
      const at = kids.findIndex((el) => el.classList.contains("left-rail-modes"));
      return kids[at + 1];
    };
    const tasks = renderRail({ middle: <span>CHIP</span> });
    expect(sepAfterModes(tasks.container)).toHaveClass("left-rail-sep");
    tasks.unmount();
    useDashboardStore.setState({ viewMode: "list" });
    const work = renderRail({ middle: <span>CHIP</span> });
    expect(sepAfterModes(work.container)).toHaveClass("left-rail-sep");
  });

  it("holds the mode switch, the statuses region and the bottom cluster", () => {
    const { container } = renderRail({ middle: <span>CHIP</span> });
    expect(modeButton(/^Tasks/)).toHaveAttribute("aria-pressed", "true");
    expect(modeButton(/^Work$/)).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "Sidebar" })).toBeNull();
    // The middle region is the board's statuses; Workspace mode's entries stay out.
    expect(screen.queryByText("CHIP")).toBeNull();
    expect(container.querySelector('[data-rail-region="middle"]')).not.toHaveTextContent("CHIP");
    // The palette only launches into a workspace (issue #730).
    expect(screen.getByRole("button", { name: "Command palette" })).toBeDisabled();
    expect(screen.getByTestId("bell")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled();
  });

  describe("status list", () => {
    const entries = [
      { id: "reviewing", title: "Reviewing", count: 2, needsYou: true, needsYouCount: 1 },
      { id: "ready", title: "Ready", count: 1, needsYou: false, needsYouCount: 0 },
      { id: "in_progress", title: "In progress", count: 3, needsYou: false, needsYouCount: 0 },
      { id: "done", title: "Done", count: 0, needsYou: false, needsYouCount: 0 },
    ] as const;
    beforeEach(() =>
      useDashboardStore.setState({ boardStatuses: [...entries], statusJumpRequest: null }),
    );
    afterEach(() => useDashboardStore.setState({ boardStatuses: [], statusJumpRequest: null }));

    it("lists the board's statuses with counts, names and a dot for the ones needing the owner", () => {
      renderRail();
      const list = screen.getByRole("group", { name: "Task statuses" });
      expect(
        within(list).getByRole("button", { name: "2 Review (Reviewing), 1 needs you" }),
      ).toBeInTheDocument();
      expect(within(list).getByRole("button", { name: "1 Ready" })).toBeInTheDocument();
      expect(within(list).getByRole("button", { name: "0 Done" })).toBeInTheDocument();
      expect(within(list).getByRole("button", { name: /In progress/ })).toHaveTextContent(
        /^3 Active$/,
      );
      expect(list.querySelectorAll(".rail-status-dot")).toHaveLength(1);
      // The long titles get a shorter visible word; the name starts with it and
      // carries the whole title after it.
      expect(within(list).getByRole("button", { name: /Reviewing/ })).toHaveTextContent(
        /^2 Review$/,
      );
      for (const button of within(list).getAllByRole("button")) expectNameHasVisibleText(button);
    });

    it("a tap raises a jump request, again for the same status", async () => {
      const user = userEvent.setup();
      renderRail();
      await user.click(screen.getByRole("button", { name: /Ready/ }));
      expect(useDashboardStore.getState().statusJumpRequest).toEqual({ status: "ready", nonce: 1 });
      await user.click(screen.getByRole("button", { name: /Ready/ }));
      expect(useDashboardStore.getState().statusJumpRequest?.nonce).toBe(2);
    });

    it("lists nothing in Workspace mode", () => {
      useDashboardStore.setState({ viewMode: "list" });
      renderRail({ middle: <span>CHIP</span> });
      expect(screen.queryByRole("group", { name: "Task statuses" })).toBeNull();
      expect(screen.getByText("CHIP")).toBeInTheDocument();
    });

    it("is empty before the board has published", () => {
      useDashboardStore.setState({ boardStatuses: [] });
      const { container } = renderRail();
      expect(screen.queryByRole("group", { name: "Task statuses" })).toBeNull();
      expect(container.querySelector('[data-rail-region="middle"]')).toBeEmptyDOMElement();
    });

    it("is at least 44px tall under a coarse pointer", () => {
      expect(railCss).toMatch(
        /@media \(pointer: coarse\)\s*\{\s*\.rail-status-entry\s*\{\s*min-height:\s*44px/,
      );
    });
  });

  it("switches back to Workspace mode", async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(modeButton(/^Work$/));
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
    // The name starts with the visible "Tasks" and its badge, then says
    // what the count means (#2886).
    expect(tasks).toHaveAccessibleName("Tasks, 2 need you");
    expect(tasks).toHaveAttribute("title", expect.stringContaining("2 need you"));
    expect(container.querySelector(".left-rail-badge")).toHaveTextContent("2");
    expectNameHasVisibleText(tasks);
  });

  it("shows no count when nothing needs the owner, and follows the store", () => {
    useDashboardStore.setState({ tasks: [makeTask({ id: 3, status: "in_progress" })] });
    const { container } = renderRail();
    expect(modeButton(/^Tasks/)).toHaveAccessibleName("Tasks");
    expect(container.querySelector(".left-rail-badge")).toBeNull();
    act(() =>
      useDashboardStore.setState({
        tasks: [makeTask({ id: 3, status: "failed", failureReason: "boom" })],
      }),
    );
    expect(modeButton(/^Tasks/)).toHaveAccessibleName("Tasks, 1 needs you");
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
