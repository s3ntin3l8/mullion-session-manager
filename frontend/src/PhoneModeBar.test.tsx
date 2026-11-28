// @vitest-environment jsdom
import { useState } from "react";
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
  settingsOpen,
  onCloseSettings,
}: {
  onOpenSettings?: () => void;
  onNewSession?: () => void;
  settingsOpen?: boolean;
  onCloseSettings?: () => void;
}) {
  useVisualViewportInset();
  return (
    <PhoneModeBar
      onOpenSettings={onOpenSettings}
      settingsOpen={settingsOpen}
      onCloseSettings={onCloseSettings}
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
    const bar = screen.getByRole("navigation", { name: "Primary" });
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

  it("leaves focus on Workspace when a mode switch closes the form New opened", async () => {
    useDashboardStore.setState({ viewMode: "kanban" });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(useDashboardStore.getState().newTaskFormOpen).toBe(true);
    const workspace = screen.getByRole("button", { name: "Workspace" });
    fireEvent.click(workspace);
    expect(useDashboardStore.getState().newTaskFormOpen).toBe(false);
    expect(document.activeElement).toBe(workspace);
    // Back in Tasks, a later close does not pull focus to New either.
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    act(() => useDashboardStore.getState().setNewTaskFormOpen(true));
    act(() => useDashboardStore.getState().setNewTaskFormOpen(false));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Tasks" }));
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

  it("Inbox opens the notification feed as a page and returns focus to it", async () => {
    render(<Harness />);
    const inbox = screen.getByRole("button", { name: "Inbox, nothing needs you" });
    expect(inbox).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(inbox);
    const sheet = screen.getByRole("region", { name: "Notifications" });
    // Beside the bar, not over it: mounted in the bar's host, outside <nav>.
    expect(document.querySelector(".phone-inbox-host")).toContainElement(sheet);
    expect(screen.getByRole("navigation", { name: "Primary" })).not.toContainElement(sheet);
    expect(document.querySelector(".mobile-session-backdrop")).toBeNull();
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    expect(document.activeElement).toBe(inbox);
  });

  it("carries the bell's needs-you count on Inbox", () => {
    // Two sessions waiting on a decision; an exit and a bell need no one.
    const ask = (sessionId: number) =>
      ({
        seq: 1,
        sessionId,
        ts: Date.now(),
        kind: "attention",
        payload: { attention: true, signal: "hookNotification", title: "Heads up", body: "x" },
      }) as NotificationEvent;
    useDashboardStore.setState({
      sessions: [
        makeSession({ id: 1, name: "one", attention: true, attentionKind: "hookNotification" }),
        makeSession({ id: 2, name: "two", attention: true, attentionKind: "hookNotification" }),
        makeSession({ id: 3, name: "three" }),
      ],
      events: {
        1: [ask(1)],
        2: [ask(2)],
        3: [
          {
            seq: 1,
            sessionId: 3,
            ts: Date.now(),
            kind: "attention",
            payload: { attention: true, signal: "bell" },
          },
          {
            seq: 2,
            sessionId: 3,
            ts: Date.now(),
            kind: "status_change",
            payload: { reason: "exited" },
          },
        ] as NotificationEvent[],
      },
      lastSeenSeq: {},
    });
    render(<Harness />);
    const inbox = screen.getByRole("button", { name: "Inbox, 2 need you" });
    expect(inbox.querySelector(".attention-badge")).toHaveTextContent("2");
    // Exactly one bell: the bar's Inbox is the phone's only notifications trigger.
    expect(screen.getAllByRole("button", { name: /^(Inbox|Notifications),/ })).toHaveLength(1);
    expectNameHasVisibleText(inbox);
  });

  it("switches between the two modes", async () => {
    render(<Harness />);
    const bar = screen.getByRole("navigation", { name: "Primary" });
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
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    // Android with resizes-content: the layout viewport shrinks with it.
    stubClientHeight(450);
    act(() => vv.resizeTo(450, 0));
    await act(flushRaf);
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    stubClientHeight(800);
    act(() => vv.resizeTo(800, 0));
    await act(flushRaf);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("keeps Inbox's page open while the keyboard is up (the bar hides, it does not unmount)", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(800, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    render(<Harness />);
    await act(flushRaf);
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
    stubClientHeight(450);
    act(() => vv.resizeTo(450, 0));
    await act(flushRaf);
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(screen.getByRole("region", { name: "Notifications" })).toBeInTheDocument();
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

  it("returns focus to Inbox when its page closed while the keyboard hid the bar", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(800, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    render(<Harness />);
    await act(flushRaf);
    const inbox = screen.getByRole("button", { name: /^Inbox/ });
    fireEvent.click(inbox);
    // A field in the page raises the keyboard; the bar hides.
    stubClientHeight(450);
    act(() => vv.resizeTo(450, 0));
    await act(flushRaf);
    fireEvent.keyDown(screen.getByRole("region", { name: "Notifications" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    // The page's own restore cannot reach the trigger inside the hidden bar
    // (jsdom refuses it too), so focus is on <body> now.
    expect(document.activeElement).toBe(document.body);
    stubClientHeight(800);
    act(() => vv.resizeTo(800, 0));
    await act(flushRaf);
    expect(document.activeElement).toBe(inbox);
  });

  it("leaves focus where it is when the bar returns after Inbox closed and focus moved on", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(800, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    render(
      <>
        <Harness />
        <input aria-label="Elsewhere" />
      </>,
    );
    await act(flushRaf);
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
    stubClientHeight(450);
    act(() => vv.resizeTo(450, 0));
    await act(flushRaf);
    fireEvent.keyDown(screen.getByRole("region", { name: "Notifications" }), { key: "Escape" });
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    elsewhere.focus();
    stubClientHeight(800);
    act(() => vv.resizeTo(800, 0));
    await act(flushRaf);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("carries the class the safe-area rule targets", () => {
    render(<Harness />);
    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveClass("phone-mode-bar");
  });
});

// #3216 — a right-sidebar view ends above the bar, and the bar is the way out.
describe("PhoneModeBar with a sidebar view open", () => {
  const openView = (view: string) =>
    act(() => useDashboardStore.getState().openRightSidebarView(view));

  it("marks More as the active entry, not the mode under the view", () => {
    render(<Harness />);
    openView("git");
    const bar = screen.getByRole("navigation", { name: "Primary" });
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

  // The Inbox and Settings are pages above the bar, as a view is: exactly one
  // entry is current, and tapping another one leaves the page.
  describe("the Inbox page and Settings", () => {
    const inbox = () => screen.getByRole("button", { name: /^Inbox/ });
    const page = () => screen.queryByRole("region", { name: "Notifications" });
    const bar = () => within(screen.getByRole("navigation", { name: "Primary" }));
    const pressed = () =>
      bar()
        .queryAllByRole("button", { pressed: true })
        .map((b) => b.textContent?.trim())
        .concat(
          screen.getByRole("button", { name: "More" }).getAttribute("aria-current") ? ["More"] : [],
        );

    it("marks Inbox as the one current entry while its page shows, over a view too", async () => {
      render(<Harness />);
      openView("git");
      expect(pressed()).toEqual(["More"]);
      await userEvent.click(inbox());
      expect(page()).not.toBeNull();
      expect(pressed()).toEqual(["Inbox"]);
      expect(inbox()).toHaveClass("active");
      // Tapped again, it closes, and the view under it is current again.
      await userEvent.click(inbox());
      expect(page()).toBeNull();
      expect(pressed()).toEqual(["More"]);
    });

    it.each(["Workspace", "Tasks"])("%s closes the Inbox page and takes focus", async (name) => {
      render(<Harness />);
      await userEvent.click(inbox());
      // In the bar: the page has a Tasks section button of its own.
      const entry = bar().getByRole("button", { name });
      // fireEvent: a click with no focus change, as on iOS.
      fireEvent.click(entry);
      expect(page()).toBeNull();
      expect(pressed()).toEqual([name]);
      expect(document.activeElement).toBe(entry);
    });

    it("New and More close the Inbox page", async () => {
      const onNewSession = vi.fn();
      render(<Harness onNewSession={onNewSession} />);
      await userEvent.click(inbox());
      await userEvent.click(screen.getByRole("button", { name: "New session" }));
      expect(page()).toBeNull();
      expect(onNewSession).toHaveBeenCalledTimes(1);

      await userEvent.click(inbox());
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      expect(page()).toBeNull();
      expect(screen.getByRole("dialog", { name: "More" })).toBeInTheDocument();
    });

    it("marks More as current while Settings shows, and no mode", () => {
      render(<Harness settingsOpen />);
      expect(pressed()).toEqual(["More"]);
      expect(screen.getByRole("button", { name: "More" })).toHaveClass("active");
    });

    it.each(["Workspace", "Tasks", "New session", "More"])("%s closes Settings", async (name) => {
      const onCloseSettings = vi.fn();
      render(<Harness settingsOpen onCloseSettings={onCloseSettings} />);
      await userEvent.click(screen.getByRole("button", { name }));
      expect(onCloseSettings).toHaveBeenCalledTimes(1);
    });

    it("the Inbox takes Settings' place, and closing it does not ask again", async () => {
      const onCloseSettings = vi.fn();
      render(<Harness settingsOpen onCloseSettings={onCloseSettings} />);
      await userEvent.click(inbox());
      expect(onCloseSettings).toHaveBeenCalledTimes(1);
      expect(page()).not.toBeNull();
    });

    it("gives way to Settings or a view opened from elsewhere", async () => {
      const { rerender } = render(<Harness />);
      await userEvent.click(inbox());
      // A banner's link opens Settings (App's own state).
      rerender(<Harness settingsOpen />);
      expect(page()).toBeNull();
      expect(pressed()).toEqual(["More"]);

      rerender(<Harness />);
      await userEvent.click(inbox());
      // A task notification's tap opens the task in the sidebar.
      openView("tasks");
      expect(page()).toBeNull();
      expect(pressed()).toEqual(["More"]);

      // Opened over a view that is already there, the page stays.
      await userEvent.click(inbox());
      expect(page()).not.toBeNull();
    });

    it("stays open when it took Settings' place over a view", async () => {
      // More → Git, More → Settings, then Inbox: Settings closes as the page
      // opens, which leaves the view under it as it was.
      function Shell() {
        const [settingsOpen, setSettingsOpen] = useState(true);
        return (
          <Harness settingsOpen={settingsOpen} onCloseSettings={() => setSettingsOpen(false)} />
        );
      }
      render(<Shell />);
      openView("git");
      await userEvent.click(inbox());
      expect(page()).not.toBeNull();
      expect(pressed()).toEqual(["Inbox"]);
    });

    it("asks nothing of Settings while it is closed", async () => {
      const onCloseSettings = vi.fn();
      render(<Harness onCloseSettings={onCloseSettings} />);
      await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
      await userEvent.click(inbox());
      await userEvent.click(screen.getByRole("button", { name: "More" }));
      expect(onCloseSettings).not.toHaveBeenCalled();
    });
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
