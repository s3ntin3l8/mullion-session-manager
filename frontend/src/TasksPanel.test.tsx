// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TasksPanel } from "./TasksPanel.js";
import type { Project, Task } from "./api.js";

let tasks: Task[];
let projects: Project[];
let taskMasterEnabled: boolean;

const refreshTasks = vi.fn(async () => {});
const updateTask = vi.fn(async () => makeTask({}));
const createTask = vi.fn(async () => makeTask({}));

function storeState() {
  return { tasks, projects, taskMasterEnabled, refreshTasks, updateTask, createTask };
}

vi.mock("./store.js", () => ({
  useDashboardStore: (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  },
}));

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 1,
    projectId: 1,
    projectName: "demo",
    issueNumber: null,
    title: "Fix the thing",
    body: null,
    htmlUrl: null,
    status: "ready",
    boardOrder: 0,
    sessionId: null,
    reviewSessionId: null,
    worktreePath: null,
    branchName: null,
    agentCommand: null,
    prUrl: null,
    assignee: null,
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    reviewingAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: 1,
    name: "demo",
    cwd: "/home/x/demo",
    hostId: "local",
    devServerUrl: null,
    detectedDevServerPort: null,
    currentBranch: null,
    autoFetch: null,
    ruleFiles: [],
    defaultAgent: null,
    defaultReviewAgent: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// jsdom doesn't implement DataTransfer/DragEvent — mirrors KanbanBoard.test.tsx's
// own stub.
function createDataTransfer(data: Record<string, string> = {}): DataTransfer {
  const map = new Map<string, string>(Object.entries(data));
  return {
    setData(type, val) {
      map.set(type, val);
    },
    getData(type) {
      return map.get(type) ?? "";
    },
    get types() {
      return Array.from(map.keys());
    },
    effectAllowed: "none" as DataTransfer["effectAllowed"],
    dropEffect: "none" as DataTransfer["dropEffect"],
    clearData(format) {
      if (format) map.delete(format);
      else map.clear();
    },
    setDragImage() {},
    items: {} as DataTransfer["items"],
    files: {} as FileList,
  } as DataTransfer;
}

function createDragEvent(type: string, dataTransfer: DataTransfer): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

beforeEach(() => {
  projects = [makeProject({ id: 1, name: "demo" })];
  taskMasterEnabled = true;
  refreshTasks.mockClear();
  updateTask.mockClear();
  createTask.mockClear();
});

describe("TasksPanel empty state", () => {
  it("shows both the GitHub-issue and local-creation hints when there are no tasks", () => {
    tasks = [];
    render(<TasksPanel onOpenTask={vi.fn()} />);
    expect(screen.getByText("No tasks yet.")).toBeInTheDocument();
    expect(screen.getByText(/mullion-task/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New task/ })).toBeInTheDocument();
  });
});

describe("TasksPanel column placement", () => {
  it("renders one column per TaskStatus with correct counts", () => {
    tasks = [
      makeTask({ id: 1, status: "backlog" }),
      makeTask({ id: 2, status: "ready" }),
      makeTask({ id: 3, status: "ready" }),
    ];
    render(<TasksPanel onOpenTask={vi.fn()} />);

    const columns = screen.getAllByText(
      /^Backlog$|^Ready$|^Claimed$|^In Progress$|^Reviewing$|^Done$|^Failed$/,
      { selector: ".kanban-column-title" },
    );
    expect(columns).toHaveLength(7);

    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    expect(readyColumn.querySelector(".kanban-column-count")?.textContent).toBe("2");
  });

  it("shows the project name, issue number, agent, and session indicator on a card", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "in_progress",
        issueNumber: 42,
        htmlUrl: "https://github.com/o/r/issues/42",
        agentCommand: "claude code --dangerously-skip-permissions",
        sessionId: 7,
      }),
    ];
    render(<TasksPanel onOpenTask={vi.fn()} />);

    expect(screen.getByText("demo")).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
  });

  it("shows a disabled-claim hint on a ready card when taskMasterEnabled is off", () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "ready" })];
    render(<TasksPanel onOpenTask={vi.fn()} />);
    expect(screen.getByText(/Task Master is off/)).toBeInTheDocument();
  });

  it("calls onOpenTask when a card is clicked", async () => {
    tasks = [makeTask({ id: 1, status: "ready", title: "Fix the thing" })];
    const onOpenTask = vi.fn();
    const user = userEvent.setup();
    render(<TasksPanel onOpenTask={onOpenTask} />);

    await user.click(screen.getByText("Fix the thing"));
    expect(onOpenTask).toHaveBeenCalledWith(tasks[0]);
  });
});

describe("TasksPanel local-board CRUD", () => {
  it("creates a task via the toolbar form", async () => {
    tasks = [makeTask({ id: 1 })];
    const user = userEvent.setup();
    render(<TasksPanel onOpenTask={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /New task/ }));
    await user.type(screen.getByPlaceholderText("Task title"), "New local task");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(createTask).toHaveBeenCalledWith(1, "New local task");
  });
});

describe("TasksPanel drag-and-drop", () => {
  it("persists a same-column reorder via updateTask boardOrder, no status change", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", boardOrder: 0, title: "first" }),
      makeTask({ id: 2, status: "ready", boardOrder: 1, title: "second" }),
    ];
    render(<TasksPanel onOpenTask={vi.fn()} />);

    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    const cards = readyColumn.querySelectorAll(".task-card");
    expect(cards).toHaveLength(2);

    // Drag task 1 ("first", index 0) onto task 2 ("second", index 1).
    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 0 });
  });

  it("persists a cross-column drag between backlog and ready with a status patch", () => {
    tasks = [makeTask({ id: 1, status: "backlog", boardOrder: 0, title: "solo" })];
    render(<TasksPanel onOpenTask={vi.fn()} />);

    const readyColumnBody = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    readyColumnBody.dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 0, status: "ready" });
  });

  it("does not persist a drop into a non-drag-editable column (e.g. Done)", () => {
    tasks = [makeTask({ id: 1, status: "ready", boardOrder: 0 })];
    render(<TasksPanel onOpenTask={vi.fn()} />);

    const doneColumnBody = screen
      .getByText("Done", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    doneColumnBody.dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).not.toHaveBeenCalled();
  });

  it("does nothing when the dragged payload isn't a mullion task id", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", boardOrder: 0, title: "first" }),
      makeTask({ id: 2, status: "ready", boardOrder: 1, title: "second" }),
    ];
    render(<TasksPanel onOpenTask={vi.fn()} />);

    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    const cards = readyColumn.querySelectorAll(".task-card");

    const dataTransfer = createDataTransfer({ "text/plain": "not a task" });
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).not.toHaveBeenCalled();
  });
});
