// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook } from "@testing-library/react";
import { TaskMasterSection } from "./TaskMasterSection.js";
import { RIGHT_SIDEBAR_VIEWS } from "./views.js";
import { countTasks } from "../github/taskMasterSummary.js";
import { useDashboardStore } from "../store/index.js";
import type { Task } from "../api/types.js";

const task = (id: number, over: Partial<Task> = {}): Task =>
  ({
    id,
    projectId: 4,
    issueNumber: id,
    title: `Task ${id}`,
    status: "backlog",
    failureReason: null,
    approvalState: null,
    autoReturnCapped: false,
    autoReturnRounds: 0,
    needsHumanReason: null,
    mergeError: null,
    releaseError: null,
    ...over,
  }) as Task;

const requestOpenTask = vi.fn();
const set = (tasks: Task[], enabled = true) =>
  useDashboardStore.setState({ tasks, taskMasterEnabled: enabled, requestOpenTask });

beforeEach(() => vi.clearAllMocks());

describe("countTasks", () => {
  it("separates waiting (claimed + failureReason) from running", () => {
    const c = countTasks([
      task(1, { status: "ready" }),
      task(2, { status: "claimed" }),
      task(3, { status: "in_progress" }),
      task(4, { status: "claimed", failureReason: "host offline" }),
      task(5, { status: "reviewing", approvalState: "awaiting-human" }),
      task(6, { status: "failed" }),
    ]);
    expect(c).toEqual({
      ready: 1,
      running: 2,
      reviewing: 1,
      awaitingApproval: 1,
      waiting: 1,
      failed: 1,
    });
  });
});

describe("TaskMasterSection", () => {
  it("is hidden when Task Master is disabled", () => {
    set([task(1, { status: "ready" })], false);
    const { container } = render(<TaskMasterSection projectId={4} onOpenTasks={vi.fn()} />);
    expect(container.textContent).toBe("");
  });

  it("scopes to the project, hides zero counts and opens the board from a count", async () => {
    const onOpenTasks = vi.fn();
    set([task(1, { status: "ready" }), task(2, { status: "ready", projectId: 9 })]);
    render(<TaskMasterSection projectId={4} onOpenTasks={onOpenTasks} />);
    expect(screen.queryByText(/failed/)).toBeNull();
    await userEvent.click(screen.getByText("1 ready"));
    expect(onOpenTasks).toHaveBeenCalled();
  });

  it("lists needs-you rows with reasons, opens a task, and caps at 5", async () => {
    const onOpenTasks = vi.fn();
    set([
      task(1, { status: "reviewing", autoReturnCapped: true, needsHumanReason: "no-progress" }),
      task(2, { status: "done", mergeError: "conflict" }),
      ...[3, 4, 5, 6, 7].map((n) => task(n, { status: "failed", failureReason: "boom" })),
    ]);
    render(<TaskMasterSection projectId={4} onOpenTasks={onOpenTasks} />);
    expect(screen.getByText("worker returned without a change")).toBeTruthy();
    expect(screen.getByText("merge failed: conflict")).toBeTruthy();
    expect(screen.queryByText("#7 Task 7")).toBeNull();
    await userEvent.click(screen.getByText("#1 Task 1"));
    expect(requestOpenTask).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByText("+2 more"));
    expect(onOpenTasks).toHaveBeenCalled();
  });
});

describe("GitHub rail badge", () => {
  const useBadge = RIGHT_SIDEBAR_VIEWS.find((v) => v.id === "github")!.useBadge;
  it("lights for a needs-human task and not otherwise", () => {
    useDashboardStore.setState({ prsByProject: {}, defaultBranchCiByProject: {} });
    set([task(1, { status: "ready" })]);
    expect(renderHook(() => useBadge(4)).result.current).toBeNull();
    set([task(1, { status: "failed" })]);
    expect(renderHook(() => useBadge(4)).result.current).toEqual({
      kind: "alert",
      title: "1 task need you",
    });
  });
});
