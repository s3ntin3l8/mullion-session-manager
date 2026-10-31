// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task } from "../api/types.js";
import { useDashboardStore } from "../store/index.js";
import { TasksSidebarView } from "./TasksSidebarView.js";
import type { RightSidebarActions } from "./views.js";

const task = (o: Partial<Task>): Task =>
  ({
    id: 1,
    projectId: 4,
    issueNumber: null,
    prNumber: null,
    title: "A task",
    status: "ready",
    approvalState: null,
    archivedAt: null,
    failureReason: null,
    ...o,
  }) as Task;

const actions = { onOpenTasks: vi.fn() } as unknown as RightSidebarActions;
const renderView = () => render(<TasksSidebarView projectId={4} actions={actions} />);

beforeEach(() => {
  useDashboardStore.setState({
    taskMasterEnabled: true,
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    tasks: [
      task({ id: 1, title: "Fresh work", status: "ready", issueNumber: 11 }),
      task({
        id: 2,
        title: "Broken job",
        status: "failed",
        failureReason: "budget exceeded",
        prNumber: 22,
      }),
      task({
        id: 3,
        title: "Old failure",
        status: "failed",
        failureReason: "stale",
        archivedAt: "2026-10-01T00:00:00Z",
      }),
      task({ id: 4, title: "Finished", status: "done" }),
      task({ id: 5, title: "Other project", status: "failed", projectId: 9 }),
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

describe("TasksSidebarView", () => {
  it("lists this project's active tasks only: no archived, done or other-project tasks", () => {
    renderView();
    expect(screen.getByText(/Fresh work/)).toBeTruthy();
    expect(screen.getByText(/Broken job/)).toBeTruthy();
    expect(screen.queryByText(/Old failure/)).toBeNull();
    expect(screen.queryByText(/Finished/)).toBeNull();
    expect(screen.queryByText(/Other project/)).toBeNull();
  });

  it("puts tasks that need you first, with the reason", () => {
    renderView();
    const titles = screen.getAllByText(/Fresh work|Broken job/).map((e) => e.textContent);
    expect(titles[0]).toContain("Broken job");
    expect(screen.getByText("budget exceeded")).toBeTruthy();
    expect(document.querySelector(".sb-strip")).toHaveTextContent("1 needs you");
  });

  it("filters by status chip and toggles back", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "1 ready" }));
    expect(screen.queryByText(/Broken job/)).toBeNull();
    expect(screen.getByText(/Fresh work/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "1 ready" }));
    expect(screen.getByText(/Broken job/)).toBeTruthy();
  });

  it("expands a row to the task panel's own actions", async () => {
    const user = userEvent.setup();
    renderView();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Broken job/ }));
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("opens the linked PR and issue in the GitHub view", async () => {
    const user = userEvent.setup();
    const openPr = vi.fn();
    const openView = vi.fn();
    const setIssue = vi.fn();
    useDashboardStore.setState({
      openRightSidebarPr: openPr,
      openRightSidebarView: openView,
      setGithubOpenIssue: setIssue,
    });
    renderView();
    await user.click(screen.getByRole("button", { name: "PR #22" }));
    expect(openPr).toHaveBeenCalledWith(4, 22);
    await user.click(screen.getByRole("button", { name: "Issue #11" }));
    expect(openView).toHaveBeenCalledWith("github", 4);
    expect(setIssue).toHaveBeenCalledWith(4, 11);
  });

  it("opens a task and the board from the row action and the ⋯ menu", async () => {
    const user = userEvent.setup();
    const requestOpenTask = vi.fn();
    useDashboardStore.setState({ requestOpenTask });
    renderView();
    await user.click(screen.getAllByRole("button", { name: "Open task" })[0]);
    expect(requestOpenTask).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Open task board" }));
    expect(actions.onOpenTasks).toHaveBeenCalled();
  });

  it("refreshes tasks from the header", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useDashboardStore.setState({ refreshTasks: refresh });
    renderView();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("explains an empty list and a disabled Task Master", () => {
    useDashboardStore.setState({ tasks: [] });
    const { unmount } = renderView();
    expect(screen.getByText("No active tasks.")).toBeTruthy();
    unmount();
    useDashboardStore.setState({ taskMasterEnabled: false });
    renderView();
    expect(
      screen.getByText(/Task Master is off/, { selector: ".ui-empty-state-note" }),
    ).toBeTruthy();
  });

  it("lists a finished task whose merge failed, so the rail badge and the list agree", () => {
    useDashboardStore.setState({
      tasks: [task({ id: 8, title: "Merge stuck", status: "done", mergeError: "conflict" })],
    });
    renderView();
    expect(screen.getByText(/Merge stuck/)).toBeTruthy();
    expect(screen.getByText("merge failed: conflict")).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 needs attention" })).toBeTruthy();
  });

  it("tells assistive tech which row is expanded", async () => {
    const user = userEvent.setup();
    renderView();
    const title = screen.getByRole("button", { name: /Broken job/ });
    expect(title.getAttribute("aria-expanded")).toBe("false");
    await user.click(title);
    expect(title.getAttribute("aria-expanded")).toBe("true");
  });
});
