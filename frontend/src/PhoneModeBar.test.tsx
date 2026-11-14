// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhoneModeBar } from "./PhoneModeBar.js";
import { useVisualViewportInset } from "./hooks/useVisualViewportInset.js";
import { resetPhoneBackStackForTests } from "./hooks/usePhoneBackStack.js";
import { RIGHT_SIDEBAR_VIEWS } from "./right-sidebar/views-registry.js";
import { useDashboardStore } from "./store/index.js";
import { DEFAULT_SETTINGS } from "./api/index.js";
import { makeTask } from "./test/fixtures.js";
import {
  FakeVisualViewport,
  flushRaf,
  uninstallFakeVisualViewport,
} from "./test/fakeVisualViewport.js";

// The app shell mounts the keyboard detector once; the bar only reads it.
function Harness({ onOpenSettings = vi.fn() }: { onOpenSettings?: () => void }) {
  useVisualViewportInset();
  return <PhoneModeBar onOpenSettings={onOpenSettings} />;
}

function stubClientHeight(value: number) {
  Object.defineProperty(document.documentElement, "clientHeight", { value, configurable: true });
}

beforeEach(() => {
  resetPhoneBackStackForTests();
  useDashboardStore.setState({
    viewMode: "list",
    tasks: [],
    taskMasterEnabled: true,
    followedProjectId: null,
    rightSidebarOpen: false,
    rightSidebarView: "git",
    crossLinkReturn: null,
    // The phone band: the sheet lists what the registry enables there.
    settings: { ...DEFAULT_SETTINGS, layoutMode: "phone" },
  });
});

afterEach(() => {
  cleanup();
  uninstallFakeVisualViewport();
  // @ts-expect-error — removes the per-test shadow of the prototype getter.
  delete document.documentElement.clientHeight;
});

describe("PhoneModeBar", () => {
  it("switches between the two modes", async () => {
    render(<Harness />);
    const bar = screen.getByRole("navigation", { name: "Mode" });
    const workspace = within(bar).getByRole("button", { name: "Workspace" });
    const tasks = within(bar).getByRole("button", { name: "Tasks" });
    expect(workspace).toHaveAttribute("aria-pressed", "true");
    expect(tasks).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(tasks);
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
    expect(tasks).toHaveAttribute("aria-pressed", "true");
    expect(workspace).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(workspace);
    expect(useDashboardStore.getState().viewMode).toBe("list");
  });

  it("counts the tasks that need you on the Tasks button, as the rail does", () => {
    useDashboardStore.setState({
      tasks: [
        makeTask({ id: 1, status: "failed" }),
        makeTask({ id: 2, status: "reviewing", approvalState: "awaiting-human", projectId: 2 }),
        makeTask({ id: 3, status: "in_progress" }),
        // Archived tasks never need you.
        makeTask({ id: 4, status: "failed", archivedAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });
    render(<Harness />);
    const tasks = screen.getByRole("button", { name: "Tasks, 2 need you" });
    expect(tasks.querySelector(".phone-mode-badge")).toHaveTextContent("2");
  });

  it("shows no count when nothing needs you", () => {
    render(<Harness />);
    const tasks = screen.getByRole("button", { name: "Tasks" });
    expect(tasks.querySelector(".phone-mode-badge")).toBeNull();
  });

  it("hides while the on-screen keyboard is up and returns when it closes", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(800, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    render(<Harness />);
    await act(flushRaf);
    expect(screen.getByRole("navigation", { name: "Mode" })).toBeInTheDocument();
    // Android with resizes-content: the layout viewport shrinks with it.
    stubClientHeight(450);
    act(() => vv.resizeTo(450, 0));
    await act(flushRaf);
    expect(screen.queryByRole("navigation", { name: "Mode" })).toBeNull();
    stubClientHeight(800);
    act(() => vv.resizeTo(800, 0));
    await act(flushRaf);
    expect(screen.getByRole("navigation", { name: "Mode" })).toBeInTheDocument();
  });

  it("carries the class the safe-area rule targets", () => {
    render(<Harness />);
    expect(screen.getByRole("navigation", { name: "Mode" })).toHaveClass("phone-mode-bar");
  });
});

describe("PhoneModeBar's more sheet", () => {
  const openMore = async () => {
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    return screen.getByRole("dialog", { name: "More" });
  };

  it("lists the right sidebar's views from its registry, in its order, then Settings", async () => {
    render(<Harness />);
    const sheet = await openMore();
    const labels = within(sheet)
      .getAllByRole("button")
      .filter((b) => b.classList.contains("phone-more-row"))
      .map((b) => b.textContent);
    expect(labels).toEqual([...RIGHT_SIDEBAR_VIEWS.map((v) => v.label), "Settings"]);
    expect(labels).toContain("Devices");
  });

  it("lists Browser and Dock, which the registry enables in the phone band (design 9.4)", async () => {
    render(<Harness />);
    const sheet = await openMore();
    expect(within(sheet).getByRole("button", { name: /^Browser/ })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: /^Dock/ }));
    const state = useDashboardStore.getState();
    expect(state.rightSidebarOpen).toBe(true);
    expect(state.rightSidebarView).toBe("dock");
  });

  it("leaves Browser and Dock out where the registry does not enable them (from 1100px)", async () => {
    useDashboardStore.setState({ settings: { ...DEFAULT_SETTINGS, layoutMode: "desktop" } });
    render(<Harness />);
    const sheet = await openMore();
    expect(within(sheet).queryByRole("button", { name: /^Browser/ })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /^Dock/ })).toBeNull();
    expect(within(sheet).getByRole("button", { name: /^Git$/ })).toBeInTheDocument();
  });

  it("leaves out a view the registry disables (Tasks with Task Master off)", async () => {
    useDashboardStore.setState({ taskMasterEnabled: false });
    render(<Harness />);
    const sheet = await openMore();
    expect(within(sheet).queryByRole("button", { name: /^Tasks/ })).toBeNull();
    expect(within(sheet).getByRole("button", { name: /^Git$/ })).toBeInTheDocument();
  });

  it("opens a view full screen and closes the sheet", async () => {
    render(<Harness />);
    const sheet = await openMore();
    await userEvent.click(within(sheet).getByRole("button", { name: /^GitHub/ }));
    const state = useDashboardStore.getState();
    expect(state.rightSidebarOpen).toBe(true);
    expect(state.rightSidebarView).toBe("github");
    expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
  });

  it("opens Settings from its last row", async () => {
    const onOpenSettings = vi.fn();
    render(<Harness onOpenSettings={onOpenSettings} />);
    const sheet = await openMore();
    await userEvent.click(within(sheet).getByRole("button", { name: /^Settings/ }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
  });

  it("shows a view's badge on its row", async () => {
    useDashboardStore.setState({
      followedProjectId: 1,
      tasks: [makeTask({ id: 1, status: "failed", projectId: 1 })],
    });
    render(<Harness />);
    const sheet = await openMore();
    expect(within(sheet).getByRole("button", { name: /^Tasks/ })).toHaveTextContent("Tasks1");
  });
});
