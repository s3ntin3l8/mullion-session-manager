// @vitest-environment jsdom
//
// The bell's Tasks section (#3459), on the real store: its count is
// needsYouTasks over the same `tasks` the rail's badge reads, a task leaves
// when its state clears, and a row opens through useOpenTask.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NotificationBell } from "./NotificationBell.js";
import { needsYouTasks } from "./github/taskMasterSummary.js";
import { useDashboardStore } from "./store/index.js";
import { api } from "./api/index.js";
import { makeSession, makeTask } from "./test/fixtures.js";
import { resetStore } from "./test/resetStore.js";
import type { NotificationEvent, Task } from "./api/index.js";

const ask: NotificationEvent = {
  seq: 1,
  sessionId: 1,
  kind: "attention",
  ts: 1_700_000_000_001,
  payload: { attention: true, signal: "hookNotification", title: "Heads up", body: "push?" },
};
const asking = makeSession({ id: 1, attention: true, attentionKind: "hookNotification" });

const failed = makeTask({
  id: 11,
  title: "Fix login",
  status: "failed",
  failureReason: "tests red",
});
const awaiting = makeTask({
  id: 12,
  title: "Add health check",
  status: "reviewing",
  approvalState: "awaiting-human",
});
const capped = makeTask({
  id: 13,
  title: "Refactor auth",
  status: "reviewing",
  autoReturnCapped: true,
});
const fine = makeTask({ id: 14, title: "Running along", status: "in_progress" });

const bell = () => screen.getByRole("button", { name: /^Notifications,/ });
const section = (name: "Sessions" | "Tasks") =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });
const setTasks = (tasks: Task[]) =>
  act(() => {
    useDashboardStore.setState({ tasks });
  });

function openBell(page = true) {
  render(<NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} page={page} />);
  act(() => {
    fireEvent.click(bell());
  });
}

describe("the bell's Tasks section (#3459)", () => {
  beforeEach(() => {
    resetStore();
    vi.spyOn(api, "ackAttention").mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts needsYouTasks in its segment, and the badge is the sum of both sections", () => {
    useDashboardStore.setState({
      sessions: [asking],
      events: { 1: [ask] },
      tasks: [failed, awaiting, capped, fine],
    });
    expect(needsYouTasks(useDashboardStore.getState().tasks)).toHaveLength(3);
    openBell();
    expect(bell()).toHaveAccessibleName("Notifications, 4 need you");
    expect(section("Sessions")).toHaveTextContent("Sessions 1");
    expect(section("Tasks")).toHaveTextContent("Tasks 3");
    // The segments are named by what they show, count included.
    expect(section("Sessions")).toHaveAccessibleName("Sessions 1");
    // The Sessions section's own "Needs you" counts sessions, not tasks.
    expect(screen.getByRole("button", { name: "Needs you 1" })).toBeInTheDocument();
  });

  it("lists one row per task with its kind, title, reason and project", () => {
    useDashboardStore.setState({ tasks: [failed, awaiting, capped, fine] });
    openBell();
    const rows = document.querySelectorAll(".notif-task-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Failed");
    expect(rows[0]).toHaveTextContent("Fix login");
    expect(rows[0]).toHaveTextContent("tests red");
    expect(rows[0]).toHaveTextContent(failed.projectName);
    expect(rows[1]).toHaveTextContent("Review");
    expect(rows[2]).toHaveTextContent("Stopped");
    expect(screen.queryByText("Running along")).toBeNull();
  });

  it("drops a task when its state clears, without any read state", () => {
    useDashboardStore.setState({ tasks: [failed, awaiting] });
    openBell();
    expect(document.querySelectorAll(".notif-task-row")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    setTasks([{ ...failed, status: "ready", failureReason: null }, awaiting]);
    expect(document.querySelectorAll(".notif-task-row")).toHaveLength(1);
    expect(section("Tasks")).toHaveTextContent("Tasks 1");
    setTasks([]);
    expect(screen.getByText("No task needs you")).toBeInTheDocument();
  });

  it("opens on the section with something to decide: Sessions first, Sessions when both are empty", () => {
    useDashboardStore.setState({ tasks: [failed] });
    const view = render(
      <NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} page />,
    );
    act(() => {
      fireEvent.click(bell());
    });
    expect(section("Tasks")).toHaveAttribute("aria-pressed", "true");
    view.unmount();

    useDashboardStore.setState({ sessions: [asking], events: { 1: [ask] }, tasks: [failed] });
    openBell();
    expect(section("Sessions")).toHaveAttribute("aria-pressed", "true");
  });

  it("opens on Sessions when nothing needs you anywhere", () => {
    openBell(false);
    expect(section("Sessions")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(section("Tasks"));
    expect(screen.getByText("No task needs you")).toBeInTheDocument();
  });

  it("a row opens the task through useOpenTask and closes the panel", () => {
    useDashboardStore.setState({ tasks: [awaiting] });
    // The desktop popover: useOpenTask selects the task in the right
    // sidebar's Tasks view there.
    openBell(false);
    fireEvent.click(screen.getByRole("button", { name: /^Review: Add health check/ }));
    expect(useDashboardStore.getState().selectedTaskId).toBe(12);
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
  });
});
