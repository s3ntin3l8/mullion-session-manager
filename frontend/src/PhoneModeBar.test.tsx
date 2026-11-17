// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhoneModeBar } from "./PhoneModeBar.js";
import { useVisualViewportInset } from "./hooks/useVisualViewportInset.js";
import { resetPhoneBackStackForTests } from "./hooks/usePhoneBackStack.js";
import { RIGHT_SIDEBAR_VIEWS } from "./right-sidebar/views-registry.js";
import { useDashboardStore } from "./store/index.js";
import { DEFAULT_SETTINGS } from "./api/index.js";
import type { NotificationEvent } from "./api/index.js";
import { makeSession, makeTask } from "./test/fixtures.js";
import {
  FakeVisualViewport,
  flushRaf,
  uninstallFakeVisualViewport,
} from "./test/fakeVisualViewport.js";
import { expectNameHasVisibleText } from "./test/a11y.js";

// The app shell mounts the keyboard detector once; the bar only reads it.
function Harness({
  onOpenSettings = vi.fn(),
  onNewSession = vi.fn(),
}: {
  onOpenSettings?: () => void;
  onNewSession?: () => void;
}) {
  useVisualViewportInset();
  return (
    <PhoneModeBar
      onOpenSettings={onOpenSettings}
      onNewSession={onNewSession}
      onOpenSession={vi.fn()}
      onOpenBrowser={vi.fn()}
    />
  );
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
    newTaskFormOpen: false,
    sessions: [],
    projects: [],
    events: {},
    lastSeenSeq: {},
    dismissedEventKeys: {},
    mutedSessionIds: [],
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
  it("has five entries, in order, each an icon over its label", () => {
    render(<Harness />);
    const bar = screen.getByRole("navigation", { name: "Mode" });
    const buttons = within(bar).getAllByRole("button");
    expect(buttons.map((b) => b.querySelector(".phone-mode-label")?.textContent)).toEqual([
      "Workspace",
      "Tasks",
      "New",
      "Inbox",
      "More",
    ]);
    for (const button of buttons) {
      expect(button).toHaveClass("phone-mode-btn");
      expect(button.querySelector("svg")).not.toBeNull();
      expectNameHasVisibleText(button);
    }
  });

  it("New opens the new-session launcher in Workspace mode", async () => {
    const onNewSession = vi.fn();
    render(<Harness onNewSession={onNewSession} />);
    const newBtn = screen.getByRole("button", { name: "New session" });
    expect(newBtn).toHaveAttribute("aria-haspopup", "dialog");
    // fireEvent: a click with no focus change, as on iOS; the launcher
    // returns focus to what was focused when it opened.
    fireEvent.click(newBtn);
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(newBtn);
    expect(useDashboardStore.getState().newTaskFormOpen).toBe(false);
  });

  it("New opens the new-task form in Tasks mode, and toggles it", async () => {
    const onNewSession = vi.fn();
    useDashboardStore.setState({ viewMode: "kanban" });
    render(<Harness onNewSession={onNewSession} />);
    const newBtn = screen.getByRole("button", { name: "New task" });
    expect(newBtn).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(newBtn);
    expect(useDashboardStore.getState().newTaskFormOpen).toBe(true);
    expect(newBtn).toHaveAttribute("aria-expanded", "true");
    expect(onNewSession).not.toHaveBeenCalled();
    await userEvent.click(newBtn);
    expect(useDashboardStore.getState().newTaskFormOpen).toBe(false);
  });

  it("New closes an open sidebar view, so what it makes shows", async () => {
    useDashboardStore.setState({ viewMode: "kanban" });
    render(<Harness />);
    act(() => useDashboardStore.getState().openRightSidebarView("git"));
    await userEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
    expect(useDashboardStore.getState().newTaskFormOpen).toBe(true);
  });

  it("returns focus to New once the task form it opened closes", async () => {
    useDashboardStore.setState({ viewMode: "kanban" });
    render(
      <>
        <Harness />
        <input aria-label="Task title" />
      </>,
    );
    const newBtn = screen.getByRole("button", { name: "New task" });
    fireEvent.click(newBtn);
    // The form's title field takes focus as it opens.
    screen.getByRole("textbox", { name: "Task title" }).focus();
    // Created: the board closes the form.
    act(() => useDashboardStore.getState().setNewTaskFormOpen(false));
    expect(document.activeElement).toBe(newBtn);
  });

  it("does not take focus when the form closes without New having opened it", () => {
    useDashboardStore.setState({ viewMode: "kanban", newTaskFormOpen: true });
    render(
      <>
        <Harness />
        <input aria-label="Elsewhere" />
      </>,
    );
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    elsewhere.focus();
    act(() => useDashboardStore.getState().setNewTaskFormOpen(false));
    expect(document.activeElement).toBe(elsewhere);
  });

  it("Inbox opens the notification feed as a sheet and returns focus to it", async () => {
    render(<Harness />);
    const inbox = screen.getByRole("button", { name: "Inbox, none unread" });
    expect(inbox).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(inbox);
    const sheet = screen.getByRole("dialog", { name: "Notifications" });
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(document.activeElement).toBe(inbox);
  });

  it("carries the bell's unread count on Inbox", () => {
    useDashboardStore.setState({
      sessions: [makeSession({ id: 1, name: "one" })],
      events: {
        1: [
          {
            seq: 1,
            sessionId: 1,
            ts: Date.now(),
            kind: "attention",
            payload: { attention: true, signal: "bell" },
          },
          {
            seq: 2,
            sessionId: 1,
            ts: Date.now(),
            kind: "status_change",
            payload: { reason: "exited" },
          },
        ] as NotificationEvent[],
      },
      lastSeenSeq: {},
    });
    render(<Harness />);
    const inbox = screen.getByRole("button", { name: "Inbox, 2 unread" });
    expect(inbox.querySelector(".attention-badge")).toHaveTextContent("2");
    // Exactly one bell: the bar's Inbox is the phone's only notifications trigger.
    expect(screen.getAllByRole("button", { name: /^(Inbox|Notifications),/ })).toHaveLength(1);
    expectNameHasVisibleText(inbox);
  });

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
    // "Tasks" and the badge read as two words, both in the name (#2886).
    expectNameHasVisibleText(tasks);
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

  it("keeps Inbox's sheet open while the keyboard is up (the bar hides, it does not unmount)", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(800, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    render(<Harness />);
    await act(flushRaf);
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
    stubClientHeight(450);
    act(() => vv.resizeTo(450, 0));
    await act(flushRaf);
    expect(screen.queryByRole("navigation", { name: "Mode" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
  });

  it("returns focus to New only once the keyboard is down and the bar shows again", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(800, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    useDashboardStore.setState({ viewMode: "kanban" });
    render(
      <>
        <Harness />
        <input aria-label="Task title" />
      </>,
    );
    await act(flushRaf);
    const newBtn = screen.getByRole("button", { name: "New task" });
    fireEvent.click(newBtn);
    // The form's title field raises the keyboard; the bar hides.
    stubClientHeight(450);
    act(() => vv.resizeTo(450, 0));
    await act(flushRaf);
    screen.getByRole("textbox", { name: "Task title" }).focus();
    act(() => useDashboardStore.getState().setNewTaskFormOpen(false));
    expect(document.activeElement).not.toBe(newBtn);
    stubClientHeight(800);
    act(() => vv.resizeTo(800, 0));
    await act(flushRaf);
    expect(document.activeElement).toBe(newBtn);
  });

  it("carries the class the safe-area rule targets", () => {
    render(<Harness />);
    expect(screen.getByRole("navigation", { name: "Mode" })).toHaveClass("phone-mode-bar");
  });
});

// #3216 — a right-sidebar view ends above the bar, and the bar is the way out.
describe("PhoneModeBar with a sidebar view open", () => {
  const openView = (view: string) =>
    act(() => useDashboardStore.getState().openRightSidebarView(view));

  it("marks More as the active entry, not the mode under the view", () => {
    render(<Harness />);
    openView("git");
    const bar = screen.getByRole("navigation", { name: "Mode" });
    const more = within(bar).getByRole("button", { name: "More" });
    expect(more).toHaveClass("active");
    expect(more).toHaveAttribute("aria-current", "true");
    expect(within(bar).getByRole("button", { name: "Workspace" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(bar).getByRole("button", { name: "Tasks" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    act(() => useDashboardStore.getState().closeRightSidebar());
    expect(more).not.toHaveClass("active");
    expect(more).not.toHaveAttribute("aria-current");
  });

  it("Workspace closes the view, also when Workspace is already the mode", async () => {
    render(<Harness />);
    openView("git");
    await userEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const state = useDashboardStore.getState();
    expect(state.rightSidebarOpen).toBe(false);
    expect(state.viewMode).toBe("list");
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("focuses the tapped mode button, which iOS does not do by itself", () => {
    render(<Harness />);
    openView("git");
    const tasks = screen.getByRole("button", { name: "Tasks" });
    // fireEvent: a click with no focus change, as on iOS.
    fireEvent.click(tasks);
    expect(document.activeElement).toBe(tasks);
  });

  it("Tasks closes the view and shows Tasks mode, also when it is already the mode", async () => {
    render(<Harness />);
    openView("files");
    await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
    openView("github");
    await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
  });

  it("More opens the sheet, and another view from it replaces the open one", async () => {
    render(<Harness />);
    openView("git");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByRole("dialog", { name: "More" });
    await userEvent.click(within(sheet).getByRole("button", { name: /^GitHub/ }));
    const state = useDashboardStore.getState();
    expect(state.rightSidebarOpen).toBe(true);
    expect(state.rightSidebarView).toBe("github");
    expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
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
