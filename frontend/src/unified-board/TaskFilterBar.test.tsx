// @vitest-environment jsdom
// The Task Master board's filter bar (epic #2847, #2840) — the former TasksToolbar.test.tsx
// (New task form, Clear done) plus the project picker, quick views, Filter and Display
// menus, the facets panel and the legacy-key migration. Still mounts the full
// `<UnifiedBoard>`: the bar's props are threaded down from the board's own state, so a full
// mount is the simplest way to exercise the real wiring (and the reorder invariant, #610,
// which is a property of the board + filters together).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedBoard } from "../UnifiedBoard.js";
import type {
  ClearDoneResult,
  GitBranchesResult,
  GitDiffStats,
  GitHubPRsStatus,
  GitStatus,
  NotificationEvent,
  Project,
  Session,
  Task,
} from "../api/index.js";
import { makeProject, makeTask } from "../test/fixtures.js";

// Merges KanbanBoard.test.tsx's and TasksPanel.test.tsx's own store mocks —
// UnifiedBoard reads value fields via a useShallow-grouped selector (the P1
// perf fix that replaced its old whole-store destructure) and calls its
// actions via useDashboardStore.getState() at each call site, while the
// SessionRows it mounts in the ad-hoc lane use individual selectors, and
// TaskDetail (stubbed below) would otherwise need its own
// claim/approve/reject/retry/give-up surface. The mock below serves all
// three call shapes the way the real zustand hook does: no selector ->
// whole state, a selector -> selector(state), .getState() -> whole state.
let sessions: Session[];
let projects: Project[];
let tasks: Task[];
let tasksLoaded: boolean;
let taskMasterEnabled: boolean;
let kanbanOrder: Record<string, number[]>;
let events: Record<number, NotificationEvent[]>;
let sessionGitStatuses: Record<number, GitStatus | null>;
let gitDiffStats: Record<number, GitDiffStats | null>;
let gitBranchesByProject: Record<number, GitBranchesResult | undefined>;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;
let hideEndedSessions: boolean;
let followedProjectId: number | null = null;

const setKanbanColumnOrder = vi.fn((columnId: string, order: number[]) => {
  kanbanOrder = { ...kanbanOrder, [columnId]: order };
});
const setViewMode = vi.fn();
const deleteSession = vi.fn(async () => {});
const refreshTasks = vi.fn(async () => {});
const updateTask = vi.fn(async () => makeTask({}));
const createTask = vi.fn(async () => makeTask({}));
const clearDoneTasks = vi.fn(async (): Promise<ClearDoneResult> => ({
  deleted: [],
  failed: [],
  branches: [],
  remaining: 0,
}));

function storeState() {
  return {
    pendingOpenTaskId: null,
    setPendingOpenTaskId: vi.fn(),
    followedProjectId,
    sessions,
    projects,
    tasks,
    tasksLoaded,
    taskMasterEnabled,
    kanbanOrder,
    setKanbanColumnOrder,
    deleteSession,
    setViewMode,
    hideEndedSessions,
    refreshTasks,
    updateTask,
    createTask,
    clearDoneTasks,
    settings: { sessions: { confirmBeforeKill: false } },
    theme: "dark",
    events,
    sessionGitStatuses,
    gitDiffStats,
    gitBranchesByProject,
    prsByProject,
  };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  // P1 perf fix moved UnifiedBoard's action call sites off this whole-store
  // subscription and onto useDashboardStore.getState() — the mock needs to
  // serve that call shape too, same as ProjectSection.test.tsx's own fix.
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

// TaskDetail.test.tsx (546 lines) already covers TaskDetail comprehensively;
// stubbing it here keeps this file's mock from also having to grow
// claimTask/approveTask/rejectTask/retryTask/giveUpTask plus SessionTimeline's
// own reads.
vi.mock("../TaskDetail.js", () => ({
  TaskDetail: ({
    params,
    onOpenSession,
  }: {
    params: { taskId: number };
    onOpenSession: (session: Session) => void;
  }) => (
    <div data-testid="task-detail-stub" data-task-id={params.taskId}>
      <button onClick={() => onOpenSession({ id: params.taskId } as Session)}>
        stub open session
      </button>
      <button disabled>disabled stub action</button>
    </div>
  ),
}));

beforeEach(() => {
  sessions = [];
  projects = [makeProject({ id: 1, name: "demo" }), makeProject({ id: 2, name: "other" })];
  tasks = [];
  tasksLoaded = true;
  taskMasterEnabled = true;
  kanbanOrder = {};
  events = {};
  sessionGitStatuses = {};
  gitDiffStats = {};
  gitBranchesByProject = {};
  prsByProject = {};
  hideEndedSessions = false;
  followedProjectId = null;
  setKanbanColumnOrder.mockClear();
  setViewMode.mockClear();
  deleteSession.mockClear();
  refreshTasks.mockClear();
  updateTask.mockClear();
  createTask.mockClear();
  clearDoneTasks.mockReset();
  clearDoneTasks.mockResolvedValue({ deleted: [], failed: [], branches: [], remaining: 0 });
  localStorage.clear();
});

// jsdom has no DataTransfer/DragEvent — same stub as UnifiedBoard.test.tsx.
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

type User = ReturnType<typeof userEvent.setup>;

/** Opens one of the bar's menus (Projects, Filter, Display) unless it is already open. */
async function openMenu(user: User, name: string) {
  if (screen.queryByRole("group", { name })) return;
  await user.click(screen.getByRole("button", { name: new RegExp(`^${name}\\b`) }));
}
async function pickProject(user: User, name: string) {
  await openMenu(user, "Projects");
  await user.click(screen.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) }));
}
async function clickClearDone(user: User) {
  await openMenu(user, "Display");
  await user.click(screen.getByRole("button", { name: "Clear done" }));
}
function readyColumn() {
  return screen.getByText("Ready", { selector: ".kanban-column-title" }).closest(".kanban-column")!;
}
/** Drags the first card in the Ready column onto the second and returns nothing. */
function dragFirstOntoSecond() {
  const cards = readyColumn().querySelectorAll(".task-card");
  const dataTransfer = createDataTransfer({ "application/x-mullion-task": "1" });
  act(() => cards[0].dispatchEvent(createDragEvent("dragstart", dataTransfer)));
  cards[1].dispatchEvent(createDragEvent("drop", dataTransfer));
}

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

// #746 — bulk "Clear done" affordance in the same toolbar.
describe("UnifiedBoard clear-done", () => {
  it("shows a confirm step before calling clearDoneTasks", async () => {
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await clickClearDone(user);
    expect(screen.getByText(/can't be undone/)).toBeInTheDocument();
    expect(clearDoneTasks).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm clear" }));
    expect(clearDoneTasks).toHaveBeenCalledWith({
      projectIds: undefined,
      deleteBranches: false,
    });
  });

  it("cancels back to the Clear done button without calling clearDoneTasks", async () => {
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await clickClearDone(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Clear done" })).toBeInTheDocument();
    expect(clearDoneTasks).not.toHaveBeenCalled();
  });

  it("passes deleteBranches: true when the checkbox is checked", async () => {
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await clickClearDone(user);
    await user.click(screen.getByRole("checkbox", { name: /Also delete local branches/ }));
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(clearDoneTasks).toHaveBeenCalledWith({
      projectIds: undefined,
      deleteBranches: true,
    });
  });

  it("scopes projectIds to the active project filter", async () => {
    tasks = [makeTask({ id: 1, projectId: 1, status: "ready" })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await pickProject(user, "demo");
    await clickClearDone(user);
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(clearDoneTasks).toHaveBeenCalledWith({ projectIds: [1], deleteBranches: false });
  });

  it("loops until remaining is 0, accumulating results across calls", async () => {
    clearDoneTasks
      .mockResolvedValueOnce({ deleted: [1, 2], failed: [], branches: [], remaining: 1 })
      .mockResolvedValueOnce({ deleted: [3], failed: [], branches: [], remaining: 0 });
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await clickClearDone(user);
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    await vi.waitFor(() => expect(clearDoneTasks).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Cleared 3 done task(s).")).toBeInTheDocument();
  });

  it("stops looping after a batch that deletes nothing, even if remaining stays positive", async () => {
    // Regression for a dead-code guard: every candidate in a batch failing
    // (e.g. rate-limited, or a relabeled GitHub issue that conflicts every
    // pass) must not spin the client in an infinite re-POST loop.
    clearDoneTasks.mockResolvedValue({
      deleted: [],
      failed: [{ id: 2, error: "GitHub rate limit in effect" }],
      branches: [],
      remaining: 5,
    });
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await clickClearDone(user);
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(await screen.findByText("Cleared 0 done task(s).")).toBeInTheDocument();
    expect(clearDoneTasks).toHaveBeenCalledTimes(1);
  });

  it("renders the per-row failure list on partial failure, without discarding successes", async () => {
    clearDoneTasks.mockResolvedValue({
      deleted: [1],
      failed: [{ id: 2, error: "still open and labeled" }],
      branches: [],
      remaining: 0,
    });
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await clickClearDone(user);
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(await screen.findByText("Cleared 1 done task(s).")).toBeInTheDocument();
    expect(screen.getByText(/Task #2: still open and labeled/)).toBeInTheDocument();
  });

  it("renders skipped-branch reasons alongside a successful row deletion", async () => {
    clearDoneTasks.mockResolvedValue({
      deleted: [1],
      failed: [],
      branches: [{ id: 1, branch: "mullion/task-1", deleted: false, reason: "not-merged" }],
      remaining: 0,
    });
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await clickClearDone(user);
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(
      await screen.findByText(/Branch mullion\/task-1 not deleted: not-merged/),
    ).toBeInTheDocument();
  });

  it("shows an unknown branch-delete outcome as the host's sentence, not the raw reason (#2723)", async () => {
    clearDoneTasks.mockResolvedValue({
      deleted: [1],
      failed: [],
      branches: [
        {
          id: 1,
          branch: "mullion/task-1",
          deleted: false,
          reason: "outcome-unknown",
          detail: "Host connection lost mid-request: the branch delete MAY HAVE BEEN DELIVERED",
        },
      ],
      remaining: 0,
    });
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await clickClearDone(user);
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(
      await screen.findByText(/the branch delete MAY HAVE BEEN DELIVERED/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not deleted: outcome-unknown/)).toBeNull();
  });

  it("shows a generic error when clearDoneTasks rejects", async () => {
    clearDoneTasks.mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

    await clickClearDone(user);
    await user.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(await screen.findByText("Failed to clear done tasks")).toBeInTheDocument();
  });
});

describe("awaiting-merge filter and Clear done warning", () => {
  const open = (id: number) =>
    makeTask({ id, status: "done", prNumber: id, mergedAt: null, title: `open-${id}` });

  it("filters the board to done tasks with an open PR", async () => {
    tasks = [
      open(1),
      makeTask({
        id: 2,
        status: "done",
        prNumber: 2,
        mergedAt: "2026-01-01T00:00:00.000Z",
        title: "merged-2",
      }),
      makeTask({ id: 3, status: "ready", title: "ready-3" }),
    ];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /^Awaiting merge/ }));
    expect(screen.getByText("open-1")).toBeInTheDocument();
    expect(screen.queryByText("merged-2")).toBeNull();
    expect(screen.queryByText("ready-3")).toBeNull();
    expect(localStorage.getItem("crs.taskQuickView")).toBe("awaiting-merge");
  });

  it("Clear done confirmation names the awaiting-merge tasks", async () => {
    tasks = [open(1), open(2)];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    await clickClearDone(user);
    expect(screen.getByText(/2 of them still have open PRs awaiting merge/)).toBeInTheDocument();
  });

  it("omits the warning when none are awaiting merge", async () => {
    tasks = [makeTask({ id: 1, status: "done", prNumber: null })];
    const user = userEvent.setup();
    render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    await clickClearDone(user);
    expect(screen.queryByText(/awaiting merge/)).toBeNull();
  });
});

const renderBoard = () => render(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);

describe("project picker", () => {
  it("is not shown with a single project", () => {
    projects = [makeProject({ id: 1, name: "demo" })];
    tasks = [makeTask({ id: 1, projectId: 1, status: "ready" })];
    renderBoard();
    expect(screen.queryByRole("button", { name: /^Projects/ })).toBeNull();
  });

  it("hides tasks from unselected projects, names the selection on its button, and clears", async () => {
    tasks = [
      makeTask({ id: 1, projectId: 1, status: "ready", title: "demo task" }),
      makeTask({ id: 2, projectId: 2, status: "ready", title: "other task" }),
    ];
    const user = userEvent.setup();
    renderBoard();
    expect(screen.getByRole("button", { name: /^Projects/ })).toHaveTextContent("All projects");

    await pickProject(user, "demo");
    expect(screen.getByText("demo task")).toBeInTheDocument();
    expect(screen.queryByText("other task")).toBeNull();
    expect(screen.getByRole("button", { name: /^Projects/ })).toHaveTextContent("demo");

    await user.click(screen.getByRole("button", { name: "Show every project" }));
    expect(screen.getByText("other task")).toBeInTheDocument();
  });

  it("shows how many tasks each project has, and filters the list by the search box", async () => {
    tasks = [
      makeTask({ id: 1, projectId: 1, status: "ready" }),
      makeTask({ id: 2, projectId: 1, status: "ready" }),
      makeTask({ id: 3, projectId: 2, status: "ready" }),
    ];
    const user = userEvent.setup();
    renderBoard();
    await openMenu(user, "Projects");
    expect(screen.getByRole("checkbox", { name: "demo 2" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "other 1" })).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search projects" }), "oth");
    expect(screen.queryByRole("checkbox", { name: "demo 2" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "other 1" })).toBeInTheDocument();
  });

  it("persists the selection and restores it on remount", async () => {
    tasks = [
      makeTask({ id: 1, projectId: 1, status: "ready", title: "demo task" }),
      makeTask({ id: 2, projectId: 2, status: "ready", title: "other task" }),
    ];
    const user = userEvent.setup();
    const first = renderBoard();
    await pickProject(user, "demo");
    expect(JSON.parse(localStorage.getItem("crs.taskProjectFilter")!)).toEqual([1]);
    first.unmount();

    renderBoard();
    expect(screen.getByText("demo task")).toBeInTheDocument();
    expect(screen.queryByText("other task")).toBeNull();
  });

  it("drops an id belonging to a since-deleted project rather than blanking the board", () => {
    localStorage.setItem("crs.taskProjectFilter", JSON.stringify([1, 999]));
    projects = [makeProject({ id: 1, name: "demo" }), makeProject({ id: 2, name: "other" })];
    tasks = [makeTask({ id: 1, projectId: 1, status: "ready", title: "demo task" })];
    renderBoard();
    expect(screen.getByText("demo task")).toBeInTheDocument();
  });

  it("lists recently picked projects first once the list is long", async () => {
    projects = Array.from({ length: 10 }, (_, i) =>
      makeProject({ id: i + 1, name: `proj-${i + 1}` }),
    );
    tasks = [makeTask({ id: 1, projectId: 9, status: "ready" })];
    const user = userEvent.setup();
    renderBoard();
    await pickProject(user, "proj-9");
    expect(JSON.parse(localStorage.getItem("crs.taskRecentProjects")!)).toEqual([9]);
    expect(screen.getByText("Recent")).toBeInTheDocument();
  });

  it("shows a distinct empty state when the filter hides every task, with a one-click clear", async () => {
    tasks = [makeTask({ id: 1, projectId: 2, status: "ready", title: "other task" })];
    const user = userEvent.setup();
    renderBoard();
    await pickProject(user, "demo");
    expect(screen.getByText("No tasks in the selected projects.")).toBeInTheDocument();
    expect(screen.queryByText("No tasks yet.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear the project filter" }));
    expect(screen.getByText("other task")).toBeInTheDocument();
  });

  it("reorders identically inside a project-filtered column — boardOrder must stay correct (#610)", async () => {
    // A hidden other-project task sits between the two visible ones in boardOrder.
    tasks = [
      makeTask({ id: 1, projectId: 1, status: "ready", boardOrder: 0, title: "first" }),
      makeTask({ id: 3, projectId: 2, status: "ready", boardOrder: 1, title: "hidden" }),
      makeTask({ id: 2, projectId: 1, status: "ready", boardOrder: 2, title: "second" }),
    ];
    const user = userEvent.setup();
    renderBoard();
    await pickProject(user, "demo");
    expect(readyColumn().querySelectorAll(".task-card")).toHaveLength(2);

    dragFirstOntoSecond();

    expect(updateTask).toHaveBeenCalledWith(3, { boardOrder: 0 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 2 });
    expect(updateTask).toHaveBeenCalledTimes(3);
  });
});

describe("follow the sidebar's project (#2858)", () => {
  const followRow = (name = "demo") =>
    screen.getByRole("checkbox", {
      name: new RegExp(`^Follow the sidebar's project \\(${name}\\)`),
    });
  const twoProjectTasks = () => [
    makeTask({ id: 1, projectId: 1, status: "ready", title: "demo task" }),
    makeTask({ id: 2, projectId: 2, status: "ready", title: "other task" }),
  ];

  it("offers nothing to follow while no sidebar project is known", async () => {
    tasks = twoProjectTasks();
    const user = userEvent.setup();
    renderBoard();
    await openMenu(user, "Projects");
    expect(screen.queryByRole("checkbox", { name: /Follow the sidebar/ })).toBeNull();
  });

  it("narrows the board to the followed project, names it on the button, and tracks changes", async () => {
    tasks = twoProjectTasks();
    followedProjectId = 1;
    const user = userEvent.setup();
    const view = renderBoard();
    await openMenu(user, "Projects");
    await user.click(followRow());
    expect(localStorage.getItem("crs.taskFollowSidebar")).toBe("1");
    expect(screen.getByText("demo task")).toBeInTheDocument();
    expect(screen.queryByText("other task")).toBeNull();
    expect(screen.getByRole("button", { name: /^Projects/ })).toHaveTextContent("demo");

    // The sidebar moves to another project: the board follows it.
    followedProjectId = 2;
    view.rerender(<UnifiedBoard onOpenSession={vi.fn()} onSessionEnded={vi.fn()} />);
    expect(screen.getByText("other task")).toBeInTheDocument();
    expect(screen.queryByText("demo task")).toBeNull();
    expect(screen.getByRole("button", { name: /^Projects/ })).toHaveTextContent("other");
  });

  it("ignores the saved selection while on and restores it when switched off", async () => {
    tasks = twoProjectTasks();
    localStorage.setItem("crs.taskProjectFilter", JSON.stringify([2]));
    followedProjectId = 1;
    const user = userEvent.setup();
    renderBoard();
    expect(screen.getByText("other task")).toBeInTheDocument();
    await openMenu(user, "Projects");
    await user.click(followRow());
    expect(screen.getByText("demo task")).toBeInTheDocument();
    expect(screen.queryByText("other task")).toBeNull();
    expect(JSON.parse(localStorage.getItem("crs.taskProjectFilter")!)).toEqual([2]);

    await user.click(followRow());
    expect(localStorage.getItem("crs.taskFollowSidebar")).toBe("0");
    expect(screen.getByText("other task")).toBeInTheDocument();
    expect(screen.queryByText("demo task")).toBeNull();
  });

  it("ends following when any project is picked, keeping the resulting selection", async () => {
    tasks = twoProjectTasks();
    followedProjectId = 1;
    localStorage.setItem("crs.taskFollowSidebar", "1");
    const user = userEvent.setup();
    renderBoard();
    expect(screen.queryByText("other task")).toBeNull();
    await openMenu(user, "Projects");
    await user.click(screen.getByRole("checkbox", { name: /^other\b/ }));
    expect(localStorage.getItem("crs.taskFollowSidebar")).toBe("0");
    expect(JSON.parse(localStorage.getItem("crs.taskProjectFilter")!)).toEqual([1, 2]);
    expect(screen.getByText("demo task")).toBeInTheDocument();
    expect(screen.getByText("other task")).toBeInTheDocument();
  });

  it("persists across a remount", () => {
    tasks = twoProjectTasks();
    followedProjectId = 2;
    localStorage.setItem("crs.taskFollowSidebar", "1");
    const first = renderBoard();
    expect(screen.getByText("other task")).toBeInTheDocument();
    first.unmount();
    renderBoard();
    expect(screen.getByText("other task")).toBeInTheDocument();
    expect(screen.queryByText("demo task")).toBeNull();
  });

  it("falls back to the saved selection while there is nothing to follow (unknown id or none)", async () => {
    tasks = twoProjectTasks();
    localStorage.setItem("crs.taskProjectFilter", JSON.stringify([2]));
    localStorage.setItem("crs.taskFollowSidebar", "1");
    const user = userEvent.setup();
    for (const id of [999, null]) {
      followedProjectId = id;
      const view = renderBoard();
      expect(screen.getByText("other task")).toBeInTheDocument();
      expect(screen.queryByText("demo task")).toBeNull();
      // Nothing is being followed, so the button is not marked as following and the row is not offered.
      expect(screen.getByRole("button", { name: /^Projects/ })).not.toHaveTextContent("◎");
      await openMenu(user, "Projects");
      expect(screen.queryByRole("checkbox", { name: /Follow the sidebar/ })).toBeNull();
      view.unmount();
    }
  });

  it("reorders identically under Follow — boardOrder must stay correct (#610)", async () => {
    // A hidden other-project task sits between the two visible ones in boardOrder.
    tasks = [
      makeTask({ id: 1, projectId: 1, status: "ready", boardOrder: 0, title: "first" }),
      makeTask({ id: 3, projectId: 2, status: "ready", boardOrder: 1, title: "hidden" }),
      makeTask({ id: 2, projectId: 1, status: "ready", boardOrder: 2, title: "second" }),
    ];
    followedProjectId = 1;
    localStorage.setItem("crs.taskFollowSidebar", "1");
    renderBoard();
    expect(readyColumn().querySelectorAll(".task-card")).toHaveLength(2);

    dragFirstOntoSecond();

    expect(updateTask).toHaveBeenCalledWith(3, { boardOrder: 0 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 2 });
    expect(updateTask).toHaveBeenCalledTimes(3);
  });
});

const blocker = [{ owner: "acme", repo: "widgets", number: 12, title: "x", htmlUrl: null }];

describe("quick views", () => {
  const mixed = () => [
    makeTask({ id: 1, status: "ready", title: "plain" }),
    makeTask({
      id: 2,
      status: "ready",
      title: "stuck",
      blockedState: "blocked",
      blockers: blocker,
    }),
    makeTask({ id: 3, status: "in_progress", title: "busy" }),
    makeTask({ id: 4, status: "reviewing", title: "approve-me", approvalState: "awaiting-human" }),
    makeTask({ id: 5, status: "done", title: "unmerged", prNumber: 5, mergedAt: null }),
  ];

  it("counts each view over the scoped tasks", () => {
    tasks = mixed();
    renderBoard();
    const views = screen.getByRole("group", { name: "Quick views" });
    expect(within(views).getByRole("button", { name: /^All/ })).toHaveTextContent("5");
    expect(within(views).getByRole("button", { name: /^Needs me/ })).toHaveTextContent("1");
    expect(within(views).getByRole("button", { name: /^Running/ })).toHaveTextContent("1");
    expect(within(views).getByRole("button", { name: /^Blocked/ })).toHaveTextContent("1");
    expect(within(views).getByRole("button", { name: /^Awaiting merge/ })).toHaveTextContent("1");
  });

  it.each([
    ["Needs me", "approve-me"],
    ["Running", "busy"],
    ["Blocked", "stuck"],
    ["Awaiting merge", "unmerged"],
  ])("%s narrows the board to its tasks, and All restores it", async (tab, title) => {
    tasks = mixed();
    const user = userEvent.setup();
    renderBoard();
    const views = screen.getByRole("group", { name: "Quick views" });

    await user.click(within(views).getByRole("button", { name: new RegExp(`^${tab}`) }));
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.queryByText("plain")).toBeNull();
    expect(within(views).getByRole("button", { name: new RegExp(`^${tab}`) })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(within(views).getByRole("button", { name: /^All/ }));
    expect(screen.getByText("plain")).toBeInTheDocument();
  });

  it("persists the view and restores it on remount", async () => {
    tasks = mixed();
    const user = userEvent.setup();
    const first = renderBoard();
    await user.click(screen.getByRole("button", { name: /^Blocked/ }));
    expect(localStorage.getItem("crs.taskQuickView")).toBe("blocked");
    first.unmount();

    renderBoard();
    expect(screen.queryByText("plain")).toBeNull();
    expect(screen.getByText("stuck")).toBeInTheDocument();
  });

  it("counts respect the other filters (here the project), not the view itself", async () => {
    tasks = [
      makeTask({
        id: 1,
        projectId: 1,
        status: "ready",
        blockedState: "blocked",
        blockers: blocker,
      }),
      makeTask({
        id: 2,
        projectId: 2,
        status: "ready",
        blockedState: "blocked",
        blockers: blocker,
      }),
    ];
    const user = userEvent.setup();
    renderBoard();
    expect(screen.getByRole("button", { name: /^Blocked/ })).toHaveTextContent("2");
    await pickProject(user, "demo");
    expect(screen.getByRole("button", { name: /^Blocked/ })).toHaveTextContent("1");
  });

  it("shows a distinct empty state when a view hides every task, with a one-click way back", async () => {
    tasks = [makeTask({ id: 1, status: "ready", blockedState: "clear" })];
    const user = userEvent.setup();
    renderBoard();
    await user.click(screen.getByRole("button", { name: /^Blocked/ }));
    expect(screen.getByText("No blocked tasks.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show every task" }));
    expect(screen.queryByText("No blocked tasks.")).toBeNull();
  });

  it("reorders identically inside the Blocked view — boardOrder must stay correct (#610)", async () => {
    tasks = [
      makeTask({
        id: 1,
        status: "ready",
        boardOrder: 0,
        title: "first",
        blockedState: "blocked",
        blockers: blocker,
      }),
      makeTask({ id: 3, status: "ready", boardOrder: 1, title: "hidden", blockedState: "clear" }),
      makeTask({
        id: 2,
        status: "ready",
        boardOrder: 2,
        title: "second",
        blockedState: "blocked",
        blockers: blocker,
      }),
    ];
    const user = userEvent.setup();
    renderBoard();
    await user.click(screen.getByRole("button", { name: /^Blocked/ }));
    expect(readyColumn().querySelectorAll(".task-card")).toHaveLength(2);

    dragFirstOntoSecond();

    expect(updateTask).toHaveBeenCalledWith(3, { boardOrder: 0 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 2 });
    expect(updateTask).toHaveBeenCalledTimes(3);
  });

  it("keeps Done visible in the Awaiting merge view even under Hide done", async () => {
    tasks = [makeTask({ id: 1, status: "done", prNumber: 1, mergedAt: null, title: "unmerged" })];
    localStorage.setItem("crs.taskHideDone", "1");
    const user = userEvent.setup();
    renderBoard();
    const done = () =>
      screen.getByText("Done", { selector: ".kanban-column-title" }).closest(".kanban-column")!;
    expect(done().querySelector(".task-card")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Awaiting merge/ }));
    expect(done().querySelector(".task-card")).not.toBeNull();
  });
});

const epicA = {
  parentIssueNumber: 10,
  parentIssueRepo: "acme/widgets",
  parentIssueTitle: "Parent A",
  subIssueTotal: 4,
  subIssueCompleted: 1,
};
const epicB = {
  parentIssueNumber: 20,
  parentIssueRepo: "acme/widgets",
  parentIssueTitle: "Parent B",
  subIssueTotal: null,
  subIssueCompleted: null,
};

describe("Filter menu", () => {
  const epicTasks = () => [
    makeTask({ id: 1, status: "ready", title: "in A", ...epicA }),
    makeTask({ id: 2, status: "ready", title: "in B", ...epicB }),
    makeTask({ id: 3, status: "ready", title: "no epic" }),
  ];

  it("lists epics as '#N title' with sub-issue progress, and filters to the checked one", async () => {
    tasks = epicTasks();
    const user = userEvent.setup();
    renderBoard();
    await openMenu(user, "Filter");
    const a = screen.getByRole("checkbox", { name: "#10 Parent A 1/4" });
    expect(screen.getByRole("checkbox", { name: "#20 Parent B 1" })).toBeInTheDocument();

    await user.click(a);
    expect(screen.getByText("in A")).toBeInTheDocument();
    expect(screen.queryByText("in B")).toBeNull();
    expect(screen.queryByText("no epic")).toBeNull();
    expect(screen.getByText(/Epic: #10 Parent A/)).toBeInTheDocument();
  });

  it("supports several epics and 'No epic' at once", async () => {
    tasks = epicTasks();
    const user = userEvent.setup();
    renderBoard();
    await openMenu(user, "Filter");
    await user.click(screen.getByRole("checkbox", { name: "#10 Parent A 1/4" }));
    await user.click(screen.getByRole("checkbox", { name: "No epic 1" }));
    expect(screen.getByText("in A")).toBeInTheDocument();
    expect(screen.getByText("no epic")).toBeInTheDocument();
    expect(screen.queryByText("in B")).toBeNull();
  });

  it("removes an epic from its token, persists, and restores on remount", async () => {
    tasks = epicTasks();
    const user = userEvent.setup();
    const first = renderBoard();
    await openMenu(user, "Filter");
    await user.click(screen.getByRole("checkbox", { name: "#10 Parent A 1/4" }));
    expect(JSON.parse(localStorage.getItem("crs.taskEpicFilter")!)).toEqual(["acme/widgets#10"]);
    first.unmount();

    renderBoard();
    expect(screen.queryByText("in B")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Remove epic filter #10 Parent A/ }));
    expect(screen.getByText("in B")).toBeInTheDocument();
  });

  it("ignores a saved epic that is no longer on the board instead of blanking it", () => {
    localStorage.setItem("crs.taskEpicFilter", JSON.stringify(["acme/widgets#999"]));
    tasks = epicTasks();
    renderBoard();
    expect(screen.getByText("in A")).toBeInTheDocument();
    expect(screen.getByText("no epic")).toBeInTheDocument();
  });

  it("matches the search box against title, issue number and PR number", async () => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "alpha", issueNumber: 111, prNumber: null }),
      makeTask({ id: 2, status: "ready", title: "beta", issueNumber: null, prNumber: 222 }),
      makeTask({ id: 3, status: "ready", title: "gamma #333", issueNumber: null, prNumber: null }),
    ];
    const user = userEvent.setup();
    renderBoard();
    await openMenu(user, "Filter");
    const box = screen.getByRole("searchbox", { name: "Search tasks" });

    await user.type(box, "alp");
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.queryByText("beta")).toBeNull();

    await user.clear(box);
    await user.type(box, "#222");
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).toBeNull();

    await user.clear(box);
    await user.type(box, "111");
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("filters by agent", async () => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "by claude", agentCommand: "claude --model x" }),
      makeTask({ id: 2, status: "ready", title: "by nobody", agentCommand: null, agent: null }),
    ];
    const user = userEvent.setup();
    renderBoard();
    await openMenu(user, "Filter");
    await user.click(screen.getByRole("checkbox", { name: "claude 1" }));
    expect(screen.getByText("by claude")).toBeInTheDocument();
    expect(screen.queryByText("by nobody")).toBeNull();
    expect(screen.getByText(/Agent: claude/)).toBeInTheDocument();
  });

  it("Clear all resets the project, view, epic, agent and text filters", async () => {
    tasks = epicTasks();
    const user = userEvent.setup();
    renderBoard();
    await openMenu(user, "Filter");
    await user.click(screen.getByRole("checkbox", { name: "#10 Parent A 1/4" }));
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText("in B")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
  });

  it("shows a distinct empty state when the epic filter hides every task", async () => {
    tasks = [
      makeTask({ id: 1, projectId: 2, status: "ready", title: "other", ...epicA }),
      makeTask({ id: 2, projectId: 1, status: "ready", title: "mine", ...epicB }),
    ];
    const user = userEvent.setup();
    renderBoard();
    await pickProject(user, "demo");
    await openMenu(user, "Filter");
    await user.click(screen.getByRole("checkbox", { name: "#10 Parent A 1/4" }));
    expect(
      screen.getByText("No tasks match the selected epic in the selected projects."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear the epic filter" }));
    expect(screen.getByText("mine")).toBeInTheDocument();
  });

  it("'Clear the epic filter' clears every selected epic, not just one", async () => {
    tasks = [
      makeTask({ id: 1, projectId: 2, status: "ready", title: "in A", ...epicA }),
      makeTask({ id: 2, projectId: 2, status: "ready", title: "in B", ...epicB }),
      makeTask({ id: 3, projectId: 1, status: "ready", title: "mine" }),
    ];
    const user = userEvent.setup();
    renderBoard();
    await pickProject(user, "demo");
    await openMenu(user, "Filter");
    await user.click(screen.getByRole("checkbox", { name: "#10 Parent A 1/4" }));
    await user.click(screen.getByRole("checkbox", { name: "#20 Parent B 1" }));
    expect(
      screen.getByText("No tasks match the selected epics in the selected projects."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear the epic filter" }));
    expect(screen.getByText("mine")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("crs.taskEpicFilter")!)).toEqual([]);
  });

  it("reorders identically inside an epic-filtered column — boardOrder must stay correct (#610)", async () => {
    tasks = [
      makeTask({ id: 1, status: "ready", boardOrder: 0, title: "first", ...epicA }),
      makeTask({ id: 3, status: "ready", boardOrder: 1, title: "hidden", ...epicB }),
      makeTask({ id: 2, status: "ready", boardOrder: 2, title: "second", ...epicA }),
    ];
    const user = userEvent.setup();
    renderBoard();
    await openMenu(user, "Filter");
    await user.click(screen.getByRole("checkbox", { name: "#10 Parent A 1/4" }));
    expect(readyColumn().querySelectorAll(".task-card")).toHaveLength(2);

    dragFirstOntoSecond();

    expect(updateTask).toHaveBeenCalledWith(3, { boardOrder: 0 });
    expect(updateTask).toHaveBeenCalledWith(2, { boardOrder: 1 });
    expect(updateTask).toHaveBeenCalledWith(1, { boardOrder: 2 });
    expect(updateTask).toHaveBeenCalledTimes(3);
  });
});

describe("Display menu", () => {
  const doneTask = () =>
    makeTask({ id: 1, status: "done", title: "finished", prNumber: null, mergedAt: null });
  const doneColumn = () =>
    screen.getByText("Done", { selector: ".kanban-column-title" }).closest(".kanban-column")!;

  it("Hide Done & Failed collapses the columns' cards, keeps the count, and persists", async () => {
    tasks = [doneTask()];
    const user = userEvent.setup();
    renderBoard();
    expect(doneColumn().querySelector(".task-card")).not.toBeNull();

    await openMenu(user, "Display");
    await user.click(screen.getByRole("checkbox", { name: "Hide Done & Failed" }));
    expect(doneColumn().querySelector(".task-card")).toBeNull();
    expect(doneColumn()).toHaveTextContent("1");
    expect(localStorage.getItem("crs.taskHideDone")).toBe("1");

    await user.click(screen.getByRole("checkbox", { name: "Hide Done & Failed" }));
    expect(doneColumn().querySelector(".task-card")).not.toBeNull();
  });

  it("Show archived reveals archived tasks and their count, and persists", async () => {
    tasks = [
      makeTask({ id: 1, status: "done", title: "live" }),
      makeTask({ id: 2, status: "done", title: "old", archivedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const user = userEvent.setup();
    renderBoard();
    expect(screen.queryByText("old")).toBeNull();

    await openMenu(user, "Display");
    await user.click(screen.getByRole("checkbox", { name: "Show archived" }));
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(localStorage.getItem("crs.taskShowArchived")).toBe("1");
  });

  it("says Hide Done & Failed is not applied while the Awaiting merge view is active", async () => {
    tasks = [makeTask({ id: 1, status: "done", prNumber: 1, mergedAt: null })];
    localStorage.setItem("crs.taskHideDone", "1");
    const user = userEvent.setup();
    renderBoard();
    await openMenu(user, "Display");
    expect(screen.queryByText(/not applied in the Awaiting merge view/)).toBeNull();

    // A click outside closes the menu, so reopen it once the view is switched.
    await user.click(screen.getByRole("button", { name: /^Awaiting merge/ }));
    await openMenu(user, "Display");
    expect(screen.getByText(/not applied in the Awaiting merge view/)).toBeInTheDocument();
    // The preference itself is untouched: it applies again once the view is left.
    expect(localStorage.getItem("crs.taskHideDone")).toBe("1");
  });

  it("closes on Escape and on a click outside", async () => {
    const user = userEvent.setup();
    renderBoard();
    await openMenu(user, "Display");
    expect(screen.getByRole("group", { name: "Display" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Display" })).toBeNull();

    await openMenu(user, "Display");
    await user.click(document.body);
    expect(screen.queryByRole("group", { name: "Display" })).toBeNull();
  });
});

describe("facets panel", () => {
  it("is off by default, toggles from the bar, and persists the setting", async () => {
    tasks = [makeTask({ id: 1, status: "ready", ...epicA })];
    const user = userEvent.setup();
    renderBoard();
    expect(screen.queryByRole("complementary", { name: "Task facets" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Facets panel" }));
    const panel = screen.getByRole("complementary", { name: "Task facets" });
    expect(panel).toBeInTheDocument();
    expect(localStorage.getItem("crs.taskFacets")).toBe("on");
    expect(within(panel).getByRole("checkbox", { name: "#10 Parent A 1/4" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Facets panel" }));
    expect(screen.queryByRole("complementary", { name: "Task facets" })).toBeNull();
    expect(localStorage.getItem("crs.taskFacets")).toBe("off");
  });

  it("edits the same filter state as the bar", async () => {
    tasks = [
      makeTask({ id: 1, status: "ready", title: "in A", ...epicA }),
      makeTask({ id: 2, status: "ready", title: "no epic" }),
    ];
    localStorage.setItem("crs.taskFacets", "on");
    const user = userEvent.setup();
    renderBoard();
    const panel = screen.getByRole("complementary", { name: "Task facets" });

    await user.click(within(panel).getByRole("checkbox", { name: "#10 Parent A 1/4" }));
    expect(screen.queryByText("no epic")).toBeNull();
    // The bar shows it as a token: one state, two views of it.
    expect(screen.getByText(/Epic: #10 Parent A/)).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: /^All/ }));
    await user.click(within(panel).getByRole("button", { name: /^Needs me/ }));
    expect(localStorage.getItem("crs.taskQuickView")).toBe("needs-me");
  });

  it("opens by itself with 'Auto' once there are many projects", () => {
    projects = Array.from({ length: 9 }, (_, i) =>
      makeProject({ id: i + 1, name: `proj-${i + 1}` }),
    );
    tasks = [makeTask({ id: 1, projectId: 1, status: "ready" })];
    localStorage.setItem("crs.taskFacets", "auto");
    renderBoard();
    expect(screen.getByRole("complementary", { name: "Task facets" })).toBeInTheDocument();
  });

  it("stays closed with 'Auto' on a narrow window with few projects", () => {
    tasks = [makeTask({ id: 1, status: "ready" })];
    localStorage.setItem("crs.taskFacets", "auto");
    renderBoard();
    expect(screen.queryByRole("complementary", { name: "Task facets" })).toBeNull();
  });
});

describe("legacy filter keys", () => {
  it("migrates 'Blocked only' into the Blocked view and removes the old key", async () => {
    localStorage.setItem("crs.taskBlockedOnlyFilter", "1");
    tasks = [
      makeTask({ id: 1, status: "ready", title: "plain" }),
      makeTask({
        id: 2,
        status: "ready",
        title: "stuck",
        blockedState: "blocked",
        blockers: blocker,
      }),
    ];
    renderBoard();
    expect(screen.queryByText("plain")).toBeNull();
    expect(screen.getByText("stuck")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Blocked/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await vi.waitFor(() => expect(localStorage.getItem("crs.taskQuickView")).toBe("blocked"));
    expect(localStorage.getItem("crs.taskBlockedOnlyFilter")).toBeNull();
  });

  it("migrates 'Awaiting merge' into the Awaiting merge view", async () => {
    localStorage.setItem("crs.taskAwaitingMergeOnly", "1");
    tasks = [
      makeTask({ id: 1, status: "ready", title: "plain" }),
      makeTask({ id: 2, status: "done", title: "unmerged", prNumber: 2, mergedAt: null }),
    ];
    renderBoard();
    expect(screen.queryByText("plain")).toBeNull();
    expect(screen.getByText("unmerged")).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(localStorage.getItem("crs.taskQuickView")).toBe("awaiting-merge"),
    );
    expect(localStorage.getItem("crs.taskAwaitingMergeOnly")).toBeNull();
  });

  it("migrates the 'Phase' selection into the epic filter, including '(no parent)'", async () => {
    localStorage.setItem("crs.taskParentFilter", "acme/widgets#10");
    tasks = [
      makeTask({ id: 1, status: "ready", title: "in A", ...epicA }),
      makeTask({ id: 2, status: "ready", title: "in B", ...epicB }),
    ];
    const first = renderBoard();
    expect(screen.getByText("in A")).toBeInTheDocument();
    expect(screen.queryByText("in B")).toBeNull();
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem("crs.taskEpicFilter")!)).toEqual(["acme/widgets#10"]),
    );
    expect(localStorage.getItem("crs.taskParentFilter")).toBeNull();
    first.unmount();

    localStorage.clear();
    localStorage.setItem("crs.taskParentFilter", "__none__");
    tasks = [
      makeTask({ id: 1, status: "ready", title: "in A", ...epicA }),
      makeTask({ id: 3, status: "ready", title: "no epic" }),
    ];
    renderBoard();
    expect(screen.getByText("no epic")).toBeInTheDocument();
    expect(screen.queryByText("in A")).toBeNull();
  });

  it("prefers the new keys when both generations are present", () => {
    localStorage.setItem("crs.taskBlockedOnlyFilter", "1");
    localStorage.setItem("crs.taskQuickView", "all");
    tasks = [
      makeTask({ id: 1, status: "ready", title: "plain" }),
      makeTask({
        id: 2,
        status: "ready",
        title: "stuck",
        blockedState: "blocked",
        blockers: blocker,
      }),
    ];
    renderBoard();
    expect(screen.getByText("plain")).toBeInTheDocument();
  });
});
