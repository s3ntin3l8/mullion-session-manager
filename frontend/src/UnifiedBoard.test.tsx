// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedBoard } from "./UnifiedBoard.js";
import type {
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  NotificationEvent,
  Project,
  Session,
  Task,
} from "./api.js";

// Merges KanbanBoard.test.tsx's and TasksPanel.test.tsx's own store mocks —
// UnifiedBoard destructures the whole store (no selector, same call shape
// Sidebar.tsx/KanbanBoard.tsx used) while the SessionRows it mounts in the
// ad-hoc lane use individual selectors, and TaskDetail (stubbed below) would
// otherwise need its own claim/approve/reject/retry/give-up surface. The
// mock below handles both call shapes the way the real zustand hook does: no
// selector -> whole state, a selector -> selector(state).
let sessions: Session[];
let projects: Project[];
let tasks: Task[];
let taskMasterEnabled: boolean;
let kanbanOrder: Record<string, number[]>;
let events: Record<number, NotificationEvent[]>;
let sessionGitStatuses: Record<number, GitStatus | null>;
let gitDiffStats: Record<number, GitDiffStats | null>;
let gitBranchesByProject: Record<number, GitBranchesResult | undefined>;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;
let hideEndedSessions: boolean;

const setKanbanColumnOrder = vi.fn((columnId: string, order: number[]) => {
  kanbanOrder = { ...kanbanOrder, [columnId]: order };
});
const setViewMode = vi.fn();
const deleteSession = vi.fn(async () => {});
const refreshTasks = vi.fn(async () => {});
const updateTask = vi.fn(async () => makeTask({}));
const createTask = vi.fn(async () => makeTask({}));

function storeState() {
  return {
    sessions,
    projects,
    tasks,
    taskMasterEnabled,
    kanbanOrder,
    setKanbanColumnOrder,
    deleteSession,
    setViewMode,
    hideEndedSessions,
    refreshTasks,
    updateTask,
    createTask,
    settings: { sessions: { confirmBeforeKill: false } },
    theme: "dark",
    events,
    sessionGitStatuses,
    gitDiffStats,
    gitBranchesByProject,
    prsByProject,
  };
}

vi.mock("./store.js", () => ({
  useDashboardStore: (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  },
}));

// TaskDetail.test.tsx (546 lines) already covers TaskDetail comprehensively;
// stubbing it here keeps this file's mock from also having to grow
// claimTask/approveTask/rejectTask/retryTask/giveUpTask plus SessionTimeline's
// own reads. Only the drawer wiring (which taskId, does it open/close) is
// this file's concern.
vi.mock("./TaskDetail.js", () => ({
  TaskDetail: ({ params }: { params: { taskId: number } }) => (
    <div data-testid="task-detail-stub" data-task-id={params.taskId} />
  ),
}));

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    parentSessionId: null,
    name: null,
    nameLocked: false,
    command: "claude code",
    cwd: null,
    liveCwd: null,
    previewBranch: null,
    kind: "terminal",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "working",
    lastActivityAt: Date.now(),
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    permissionState: "idle",
    planState: "idle",
    errorState: "idle",
    endedReason: null,
    liveBranch: null,
    exitCode: null,
    attentionKind: null,
    errorDetail: null,
    lastAssistantMessage: null,
    compactState: "idle",
    subagentCount: 0,
    subagents: [],
    elicitationState: "idle",
    elicitationServer: null,
    lastTurnEndedAt: null,
    stateRestored: true,
    staleHooks: false,
    restoredVersion: null,
    sessionStatus: "working",
    sessionStatusSeverity: "busy",
    sessionStatusDetail: null,
    sessionStatusAttentionRequired: false,
    hookEmits: [],
    pendingDevServerPort: null,
    outstandingBackgroundTasks: [],
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
    seedDelivered: null,
    reviewSessionId: null,
    reviewSeedDelivered: null,
    worktreePath: null,
    branchName: null,
    agentCommand: null,
    prUrl: null,
    assignee: null,
    failureReason: null,
    githubSyncError: null,
    baseSha: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    reviewingAt: null,
    completedAt: null,
    ...overrides,
  };
}

// jsdom doesn't implement DataTransfer/DragEvent — mirrors KanbanBoard.test.tsx's
// and TasksPanel.test.tsx's own stub.
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
  sessions = [];
  projects = [makeProject({ id: 1, name: "demo" }), makeProject({ id: 2, name: "other" })];
  tasks = [];
  taskMasterEnabled = true;
  kanbanOrder = {};
  events = {};
  sessionGitStatuses = {};
  gitDiffStats = {};
  gitBranchesByProject = {};
  prsByProject = {};
  hideEndedSessions = false;
  setKanbanColumnOrder.mockClear();
  setViewMode.mockClear();
  deleteSession.mockClear();
  refreshTasks.mockClear();
  updateTask.mockClear();
  createTask.mockClear();
});

describe("UnifiedBoard task columns", () => {
  it("renders one column per TaskStatus with correct counts", () => {
    tasks = [
      makeTask({ id: 1, status: "backlog" }),
      makeTask({ id: 2, status: "ready" }),
      makeTask({ id: 3, status: "ready" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

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

  it("shows the project name, issue number, and agent on a card", () => {
    tasks = [
      makeTask({
        id: 1,
        status: "in_progress",
        issueNumber: 42,
        htmlUrl: "https://github.com/o/r/issues/42",
        agentCommand: "claude code --dangerously-skip-permissions",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getAllByText("demo").length).toBeGreaterThan(0);
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();
  });

  it("shows a disabled-claim hint on a ready card when taskMasterEnabled is off", () => {
    taskMasterEnabled = false;
    tasks = [makeTask({ id: 1, status: "ready" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText(/Task Master is off/)).toBeInTheDocument();
  });

  it("shows 'No tasks yet.' with the mullion-task hint when there are no tasks", () => {
    tasks = [];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("No tasks yet.")).toBeInTheDocument();
    expect(screen.getByText(/mullion-task/)).toBeInTheDocument();
  });

  it("calls refreshTasks on mount", () => {
    tasks = [makeTask({ id: 1 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(refreshTasks).toHaveBeenCalled();
  });
});

describe("UnifiedBoard task create form", () => {
  it("creates a task via the toolbar form", async () => {
    tasks = [makeTask({ id: 1 })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /New task/ }));
    await user.type(screen.getByPlaceholderText("Task title"), "New local task");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(createTask).toHaveBeenCalledWith(1, "New local task");
  });

  it("shows an error and re-enables Create when createTask rejects", async () => {
    createTask.mockRejectedValueOnce(new Error("network down"));
    tasks = [makeTask({ id: 1 })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /New task/ }));
    await user.type(screen.getByPlaceholderText("Task title"), "New local task");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByText("Failed to create task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled();
    expect(screen.getByPlaceholderText("Task title")).toHaveValue("New local task");
  });

  it("disables Create and shows 'Creating…' while the request is in flight", async () => {
    let resolveCreate: (() => void) | undefined;
    createTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = () => resolve(makeTask({}));
        }),
    );
    tasks = [makeTask({ id: 1 })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /New task/ }));
    await user.type(screen.getByPlaceholderText("Task title"), "New local task");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Creating…" }));
    expect(createTask).toHaveBeenCalledTimes(1);

    resolveCreate!();
    await vi.waitFor(() => expect(screen.queryByPlaceholderText("Task title")).toBeNull());
  });
});

describe("UnifiedBoard task drag-and-drop", () => {
  it("persists a same-column reorder via updateTask boardOrder, no status change", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", boardOrder: 0, title: "first" }),
      makeTask({ id: 2, status: "ready", boardOrder: 1, title: "second" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    const cards = readyColumn.querySelectorAll(".task-card");
    expect(cards).toHaveLength(2);

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => cards[0].dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 0 });
  });

  it("persists a cross-column drag between backlog and ready with a status patch", () => {
    tasks = [makeTask({ id: 1, status: "backlog", boardOrder: 0, title: "solo" })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const backlogCard = screen
      .getByText("Backlog", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".task-card")!;
    const readyColumnBody = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => backlogCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    readyColumnBody.dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 0, status: "ready" });
  });

  it("does not persist a drop into a non-drag-editable column (e.g. Done)", () => {
    tasks = [makeTask({ id: 1, status: "ready", boardOrder: 0 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const readyCard = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".task-card")!;
    const doneColumnBody = screen
      .getByText("Done", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => readyCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    doneColumnBody.dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).not.toHaveBeenCalled();
  });

  it("does not persist a drop FROM a non-drag-editable column into ready (source-side guard)", () => {
    tasks = [makeTask({ id: 1, status: "done", boardOrder: 0 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const doneCard = screen
      .getByText("Done", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".task-card")!;
    const readyColumnBody = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => doneCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));
    readyColumnBody.dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).not.toHaveBeenCalled();
  });

  it("does nothing when the dragged payload isn't a mullion task id", () => {
    tasks = [
      makeTask({ id: 1, status: "ready", boardOrder: 0, title: "first" }),
      makeTask({ id: 2, status: "ready", boardOrder: 1, title: "second" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const readyColumn = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!;
    const cards = readyColumn.querySelectorAll(".task-card");

    const dataTransfer = createDataTransfer({ "text/plain": "not a task" });
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(updateTask).not.toHaveBeenCalled();
  });

  it("only highlights a column as a drop target when the drag is actually valid there", () => {
    tasks = [makeTask({ id: 1, status: "ready", boardOrder: 0 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const readyCard = screen
      .getByText("Ready", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".task-card")!;
    const doneColumnBody = screen
      .getByText("Done", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;
    const backlogColumnBody = screen
      .getByText("Backlog", { selector: ".kanban-column-title" })
      .closest(".kanban-column")!
      .querySelector(".kanban-column-body")!;

    const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
    act(() => readyCard.dispatchEvent(createDragEvent("dragstart", dataTransfer)));

    act(() => doneColumnBody.dispatchEvent(createDragEvent("dragover", dataTransfer)));
    expect(doneColumnBody.classList.contains("kanban-card-drop-target")).toBe(false);

    act(() => backlogColumnBody.dispatchEvent(createDragEvent("dragover", dataTransfer)));
    expect(backlogColumnBody.classList.contains("kanban-card-drop-target")).toBe(true);
  });
});

describe("UnifiedBoard nested task session strip", () => {
  it("renders a live worker strip for task.sessionId and excludes it from the ad-hoc lane", () => {
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude", sessionStatus: "working" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getByText("Working")).toBeInTheDocument();
    // Ad-hoc lane must report no sessions — the linked one is nested on its
    // task's card instead.
    expect(screen.getByText("No sessions without a task.")).toBeInTheDocument();
  });

  it("renders a distinct review strip for task.reviewSessionId", () => {
    sessions = [
      makeSession({ id: 7, projectId: 1, command: "claude", sessionStatus: "working" }),
      makeSession({ id: 8, projectId: 1, command: "codex", sessionStatus: "idle" }),
    ];
    tasks = [makeTask({ id: 1, status: "reviewing", sessionId: 7, reviewSessionId: 8 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const strips = document.querySelectorAll(".task-card-session-strip");
    expect(strips).toHaveLength(2);
  });

  it("renders a muted 'ended' chip when the linked session is no longer in sessions", () => {
    sessions = [];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 999 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const strip = document.querySelector(".task-card-session-strip.is-gone");
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("ended");
  });

  it("clicking the strip switches to list view and opens the session, not the drawer", async () => {
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={onOpenSession} onSessionEnded={vi.fn()} />);

    const strip = document.querySelector(".task-card-session-strip")!;
    await user.click(strip);

    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
  });

  it("dragging the strip sets the session MIME, not the task MIME, on the same dataTransfer", () => {
    sessions = [makeSession({ id: 7, projectId: 1, command: "claude" })];
    tasks = [makeTask({ id: 1, status: "in_progress", sessionId: 7 })];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const strip = document.querySelector(".task-card-session-strip")!;
    const dataTransfer = createDataTransfer();
    strip.dispatchEvent(createDragEvent("dragstart", dataTransfer));

    expect(dataTransfer.types).toContain("application/x-mullion-session");
    expect(dataTransfer.types).not.toContain("application/x-mullion-task");
  });
});

describe("UnifiedBoard detail drawer", () => {
  it("opens the drawer with the right taskId when a card body is clicked, and closes it", async () => {
    tasks = [makeTask({ id: 5, status: "ready", title: "Open me" })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
    await user.click(screen.getByText("Open me"));

    const stub = screen.getByTestId("task-detail-stub");
    expect(stub.dataset.taskId).toBe("5");

    await user.click(screen.getByLabelText("Close task detail"));
    expect(screen.queryByTestId("task-detail-stub")).toBeNull();
  });
});

describe("UnifiedBoard ad-hoc session lane", () => {
  it("groups unlinked sessions into severity sub-groups", () => {
    sessions = [
      makeSession({ id: 1, projectId: 1, command: "working-one" }),
      makeSession({
        id: 2,
        projectId: 1,
        command: "attn-one",
        sessionStatus: "needs_input",
        sessionStatusSeverity: "waiting",
      }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.getByText("working-one")).toBeInTheDocument();
    expect(screen.getByText("attn-one")).toBeInTheDocument();
    expect(screen.getByText("Needs Attention")).toBeInTheDocument();
  });

  it("shows the lane empty state when every sub-group is empty", () => {
    sessions = [];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("No sessions without a task.")).toBeInTheDocument();
  });

  it("excludes dock sessions and honors hideEndedSessions", () => {
    hideEndedSessions = true;
    sessions = [
      makeSession({ id: 1, kind: "dock", command: "dock-monitor" }),
      makeSession({
        id: 2,
        status: "exited",
        sessionStatus: "exited",
        sessionStatusSeverity: "gone",
        command: "should-be-hidden",
      }),
      makeSession({ id: 3, command: "still-here" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    expect(screen.queryByText("dock-monitor")).toBeNull();
    expect(screen.queryByText("should-be-hidden")).toBeNull();
    expect(screen.getByText("still-here")).toBeInTheDocument();
  });

  it("reorders lane cards within a severity sub-group via setKanbanColumnOrder", () => {
    sessions = [
      makeSession({ id: 1, projectId: 1, command: "first" }),
      makeSession({ id: 2, projectId: 1, command: "second" }),
    ];
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    const cards = document.querySelectorAll(".kanban-lane-group .kanban-card");
    expect(cards).toHaveLength(2);

    const dataTransfer = createDataTransfer({ "application/x-mullion-session": "1" });
    cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));

    expect(setKanbanColumnOrder).toHaveBeenCalledWith("working", [2, 1]);
  });

  it("switches to list view and opens the session on a lane card click", async () => {
    sessions = [makeSession({ id: 1, projectId: 1, command: "click-me" })];
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={onOpenSession} onSessionEnded={vi.fn()} />);

    await user.click(screen.getByText("click-me"));

    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
  });
});
